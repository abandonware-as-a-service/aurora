// End-to-end DuskVM WebAssembly integration test suite for Aurora.
// Deploys the compiled Rust WASM contracts (`transfer-mock.wasm` at 0100...00 and
// `dusk-aurora.wasm`) into `DuskWasmVm` and verifies:
//   1. Byte-for-byte parity between JS Web Crypto (hashAnswer, hashCommitment, computeShadowTag)
//      and on-chain `abi::sha256` computations in `dusk-aurora.wasm`.
//   2. Vault creation (`create_vault`) with real Moonlight DUSK bounty deposit + `attempt_fee`.
//   3. Community bounty top-up (`fund_vault`) and creator hint unlock (`add_hint`).
//   4. 2-step Commit-Reveal (`commit_solution` -> `reveal_solution`) with anti-front-running
//      and Solve-to-Unlock Attempt Fee Escrow (80% creator escrow unlocked on crack, 20% jackpot rollover).
//   5. Anonymous solver reveal (`disclose_winner = false`) + on-chain `winning_answer` verification.
//   6. Disclosed solver reveal (`disclose_winner = true`) and live `set_disclosure` toggling.
//   7. Expired vault creator refund (`reclaim_expired`) + automatic refund of solver attempt fees on uncracked expiry.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDriver} from './driver.mjs';
import {
  DuskWasmVm,
  TRANSFER_CONTRACT_ID,
  AURORA_CONTRACT_ID,
} from '../app/dusk-vm.js';
import {
  hashAnswer,
  hashCommitment,
  computeShadowTag,
} from '../app/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DIR = join(ROOT, 'contract');
const VM_DIR = join(ROOT, 'vm-test');
const VENDOR_DIR = join(ROOT, 'app', 'vendor');

const ONE_DUSK = 1_000_000_000n;
const rawU64 = n => JSON.rawJSON(BigInt(n).toString());

function ensureTransferMock() {
  const vendorContract = join(VENDOR_DIR, 'transfer-mock.wasm');
  const vendorDriver = join(VENDOR_DIR, 'transfer-driver.wasm');

  if (!existsSync(vendorContract) || !existsSync(vendorDriver)) {
    const work = join(VM_DIR, 'target', 'mock-crate');
    mkdirSync(join(work, 'src'), {recursive: true});
    copyFileSync(join(CONTRACT_DIR, 'Cargo.toml'), join(work, 'Cargo.toml'));
    copyFileSync(join(CONTRACT_DIR, 'Cargo.lock'), join(work, 'Cargo.lock'));
    copyFileSync(join(CONTRACT_DIR, 'build.rs'), join(work, 'build.rs'));
    copyFileSync(join(VM_DIR, 'transfer_mock.rs'), join(work, 'src', 'lib.rs'));

    const targetContract = join(VM_DIR, 'target', 'mock-wasm-contract');
    const targetDriver = join(VM_DIR, 'target', 'mock-wasm-driver');
    const manifest = join(work, 'Cargo.toml');

    const builtContract = join(targetContract, 'wasm32-unknown-unknown', 'release', 'dusk_aurora.wasm');
    const builtDriver = join(targetDriver, 'wasm32-unknown-unknown', 'release', 'dusk_aurora.wasm');

    if (!existsSync(builtContract)) {
      execFileSync('cargo', [
        '+stable', 'build', '--release',
        '--manifest-path', manifest,
        '--target', 'wasm32-unknown-unknown',
        '--target-dir', targetContract,
        '--features', 'contract',
      ], {stdio: 'inherit'});
    }
    if (!existsSync(builtDriver)) {
      execFileSync('cargo', [
        '+stable', 'build', '--release',
        '--manifest-path', manifest,
        '--target', 'wasm32-unknown-unknown',
        '--target-dir', targetDriver,
        '--features', 'data-driver-js',
      ], {stdio: 'inherit'});
    }

    copyFileSync(builtContract, vendorContract);
    copyFileSync(builtDriver, vendorDriver);
  }

  return {
    wasmBytes: readFileSync(vendorContract),
    driver: loadDriver(vendorDriver),
  };
}

function getKeeperKeys() {
  const exe = process.platform === 'win32' ? 'aurora-keygen.exe' : 'aurora-keygen';
  const binPath = join(VM_DIR, 'target', 'release', exe);
  if (!existsSync(binPath)) {
    execFileSync('cargo', [
      '+stable', 'build', '--release',
      '--manifest-path', join(VM_DIR, 'Cargo.toml'),
    ], {stdio: 'inherit'});
  }
  const out = JSON.parse(execFileSync(binPath, [], {encoding: 'utf8'}));
  return out.keys;
}

console.log('1/3 Loading TransferMock & Aurora WASM + data-drivers...');
const transferMock = ensureTransferMock();
const auroraWasmBytes = readFileSync(join(VENDOR_DIR, 'dusk-aurora.wasm'));
const auroraDriver = loadDriver(join(VENDOR_DIR, 'aurora-driver.wasm'));

console.log('2/3 Loading deterministic BLS12-381 Moonlight keeper accounts...');
const keys = getKeeperKeys();
console.log('Keepers:', Object.keys(keys).map(k => `${k}=${keys[k].slice(0, 10)}...`).join(', '));

const vm = new DuskWasmVm({
  auroraDriver,
  transferDriver: transferMock.driver,
});
vm.deploy(TRANSFER_CONTRACT_ID, transferMock.wasmBytes);
vm.deploy(AURORA_CONTRACT_ID, auroraWasmBytes);

const call = (contract, driver, fn, argValue, {sender = 'you', height = 1, query = false} = {}) => {
  const jsonText = JSON.stringify(argValue);
  const argBytes = driver.encodeInput(fn, jsonText);
  const senderKey = sender ? keys[sender] : null;
  const res = vm.callRaw({
    contract,
    fn,
    argBytes,
    sender: senderKey,
    height,
    query,
  });
  return {
    ...res,
    decode: () => {
      assert.equal(res.ok, true, `Expected ${fn} to succeed, got error: ${res.error}`);
      return driver.decodeOutput(fn, res.rawBytes);
    },
  };
};

console.log('3/3 Executing full Aurora lifecycle in DuskWasmVm...');

// --- Seed Moonlight balances (1,000 DUSK each) ---
for (const name of ['you', 'rook', 'fen', 'wick']) {
  const r = call(TRANSFER_CONTRACT_ID, transferMock.driver, 'seed_balance', [keys[name], rawU64(1000n * ONE_DUSK)], {
    sender: name,
    height: 1,
  });
  assert.equal(r.ok, true);
}

// --- 1. Verify SHA-256 parity between Web Crypto (app/crypto.js) and on-chain `abi::sha256` ---
const secretAnswer0 = '  Silence   ';
const answerHash0 = await hashAnswer(secretAnswer0);
const salt0 = 'moonlight-salt-001';
const commitRook0 = await hashCommitment(0, keys.rook, answerHash0, salt0);
const rookShadowTag = await computeShadowTag(keys.rook);

const onChainAnsHash = call(AURORA_CONTRACT_ID, auroraDriver, 'compute_answer_hash', secretAnswer0, {
  height: 1,
  query: true,
}).decode();
assert.deepEqual(onChainAnsHash, answerHash0, 'compute_answer_hash must match JS hashAnswer');

const onChainCommitHash = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'compute_commitment',
  [rawU64(0), keys.rook, answerHash0, salt0],
  {height: 1, query: true}
).decode();
assert.deepEqual(onChainCommitHash, commitRook0, 'compute_commitment must match JS hashCommitment');
console.log('  ✓ On-chain abi::sha256 matches JS Web Crypto byte-for-byte');

// --- 2. Create Vault #0 by 'you' with 250 DUSK bounty, 5 DUSK attempt fee, duration 50 blocks ---
const vault0Id = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'create_vault',
  [
    'The Whispering Arch',
    'I speak without a mouth and hear without ears, yet the moment you name me I vanish. What am I?',
    'Riddle',
    'Think of what breaks when you speak.',
    answerHash0,
    rawU64(250n * ONE_DUSK),
    rawU64(5n * ONE_DUSK),
    rawU64(50),
  ],
  {sender: 'you', height: 2}
).decode();
assert.equal(vault0Id, '0');

// 'wick' tops up Vault #0 with 50 DUSK (base bounty = 300 DUSK)
assert.equal(
  call(AURORA_CONTRACT_ID, auroraDriver, 'fund_vault', [rawU64(0), rawU64(50n * ONE_DUSK)], {
    sender: 'wick',
    height: 3,
  }).ok,
  true
);

// 'you' updates the hint on Vault #0
assert.equal(
  call(AURORA_CONTRACT_ID, auroraDriver, 'add_hint', [rawU64(0), '7 letters, starts with S.'], {
    sender: 'you',
    height: 3,
  }).ok,
  true
);

// Creator 'you' cannot commit to their own vault -> MUST FAIL
const creatorSelfCommit = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'commit_solution',
  [rawU64(0), commitRook0],
  {sender: 'you', height: 4}
);
assert.equal(creatorSelfCommit.ok, false, 'Creator must not commit to their own vault');
assert.match(creatorSelfCommit.error, /cannot submit solution commitments to their own vault/);

// --- 3. Anti-front-running & Attempt Fee Escrow checks ---
// 'rook' commits solution to Vault #0 at block 4 (pays 5 DUSK attempt fee: 1 DUSK -> jackpot, 4 DUSK -> creator escrow)
assert.equal(
  call(AURORA_CONTRACT_ID, auroraDriver, 'commit_solution', [rawU64(0), commitRook0], {
    sender: 'rook',
    height: 4,
  }).ok,
  true
);

// 'rook' attempts same-block reveal at block 4 -> MUST FAIL
const sameBlockReveal = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'reveal_solution',
  [rawU64(0), 'silence', salt0, false, ''],
  {sender: 'rook', height: 4}
);
assert.equal(sameBlockReveal.ok, false, 'Same-block reveal must fail');
assert.match(sameBlockReveal.error, /Wait at least 1 block/);

// Mempool bot 'wick' copies rook's commitment hash at block 4 (also pays 5 DUSK attempt fee!) and tries to reveal at block 5 -> MUST FAIL
assert.equal(
  call(AURORA_CONTRACT_ID, auroraDriver, 'commit_solution', [rawU64(0), commitRook0], {
    sender: 'wick',
    height: 4,
  }).ok,
  true
);
const wickFrontRun = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'reveal_solution',
  [rawU64(0), 'silence', salt0, true, 'SniperWick'],
  {sender: 'wick', height: 5}
);
assert.equal(wickFrontRun.ok, false, 'Copied commitment by another account must fail on reveal');
assert.match(wickFrontRun.error, /Commitment hash does not match/);
console.log('  ✓ Anti-front-running verified (same-block reveal, self-commit & mempool commitment-copying blocked)');

// --- 4. Anonymous Reveal by 'rook' (disclose_winner = false) + Solve-to-Unlock Creator Fee Payout ---
// Total attempt fees on Vault #0 = 10 DUSK (5 from rook + 5 from wick):
// - Jackpot rollover = 2 DUSK -> total bounty = 302 DUSK
// - Creator fee pool = 8 DUSK -> paid to creator 'you' upon crack!
const rookReveal = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'reveal_solution',
  [rawU64(0), '  SILENCE ', salt0, false, 'RookHiddenAlias'],
  {sender: 'rook', height: 5}
);
assert.equal(rookReveal.ok, true, `Rook reveal failed: ${rookReveal.error}`);

const crackedEventRaw = rookReveal.events.find(e => e.topic === 'vault_cracked');
assert.ok(crackedEventRaw, 'Expected vault_cracked event');
const crackedEvent = auroraDriver.decodeEvent('vault_cracked', crackedEventRaw.rawBytes);
assert.equal(crackedEvent.winner, null, 'Anonymous reveal must hide winner BlsPublicKey in event');
assert.equal(crackedEvent.display_name, rookShadowTag, 'Anonymous reveal must emit deterministic Shadow tag');
assert.equal(crackedEvent.disclosed, false);
assert.equal(crackedEvent.winning_answer, 'silence');
assert.equal(BigInt(crackedEvent.bounty), 302n * ONE_DUSK);
assert.equal(BigInt(crackedEvent.creator_fee_earned), 8n * ONE_DUSK);

const vault0Winner = call(AURORA_CONTRACT_ID, auroraDriver, 'vault_winner', rawU64(0), {
  height: 5,
  query: true,
}).decode();
assert.deepEqual(vault0Winner, [null, rookShadowTag, 'silence']);

const rookEntryAnon = call(AURORA_CONTRACT_ID, auroraDriver, 'solver_entry', rawU64(0), {
  height: 5,
  query: true,
}).decode();
assert.deepEqual(rookEntryAnon, [null, rookShadowTag, 1, 5, false]);

// Verify Rook balance: 1000 - 5 (attempt fee) + 302 (bounty + jackpot rollover) = 1297 DUSK
const rookBalance = call(TRANSFER_CONTRACT_ID, transferMock.driver, 'balance_of', keys.rook, {
  height: 5,
  query: true,
}).decode();
assert.equal(BigInt(rookBalance), 1297n * ONE_DUSK);

// Verify Creator 'you' balance: 1000 - 250 (initial bounty) + 8 (unlocked creator attempt fees) = 758 DUSK
const youBalanceAfterCrack0 = call(TRANSFER_CONTRACT_ID, transferMock.driver, 'balance_of', keys.you, {
  height: 5,
  query: true,
}).decode();
assert.equal(BigInt(youBalanceAfterCrack0), 758n * ONE_DUSK);
console.log(`  ✓ Anonymous reveal & Solve-to-Unlock fee split verified: 302 DUSK to Rook, 8 DUSK fees to creator`);

// --- 5. Disclosed Reveal by 'fen' & live `set_disclosure` toggle by 'rook' ---
const secretAnswer1 = 'zeroknowledge';
const answerHash1 = await hashAnswer(secretAnswer1);
const salt1 = 'fen-salt-777';
const commitFen1 = await hashCommitment(1, keys.fen, answerHash1, salt1);

call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'create_vault',
  [
    'The Plonk Gate',
    'I prove I know the secret witness without ever showing it to the verifier. What am I (two words, no space)?',
    'Cryptography',
    'Starts with zero.',
    answerHash1,
    rawU64(100n * ONE_DUSK),
    rawU64(0),
    rawU64(20),
  ],
  {sender: 'you', height: 6}
).decode();

call(AURORA_CONTRACT_ID, auroraDriver, 'commit_solution', [rawU64(1), commitFen1], {
  sender: 'fen',
  height: 6,
});
assert.equal(
  call(
    AURORA_CONTRACT_ID,
    auroraDriver,
    'reveal_solution',
    [rawU64(1), 'ZeroKnowledge', salt1, true, 'Archivist Fen'],
    {sender: 'fen', height: 7}
  ).ok,
  true
);

const vault1Winner = call(AURORA_CONTRACT_ID, auroraDriver, 'vault_winner', rawU64(1), {
  height: 7,
  query: true,
}).decode();
assert.deepEqual(vault1Winner, [keys.fen, 'Archivist Fen', 'zeroknowledge']);

// Now 'rook' decides to disclose identity on the leaderboard via `set_disclosure`
assert.equal(
  call(AURORA_CONTRACT_ID, auroraDriver, 'set_disclosure', [true, 'Grandmaster Rook'], {
    sender: 'rook',
    height: 8,
  }).ok,
  true
);
const rookEntryDisclosed = call(AURORA_CONTRACT_ID, auroraDriver, 'solver_entry', rawU64(0), {
  height: 8,
  query: true,
}).decode();
assert.deepEqual(rookEntryDisclosed, [keys.rook, 'Grandmaster Rook', 1, 5, true]);

// Verify that a disclosed user CANNOT spoof an anonymous "Shadow #xxxxxx" tag
const spoofShadowAttempt = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'set_disclosure',
  [true, 'Shadow #9c1869'],
  {sender: 'fen', height: 8}
);
assert.equal(spoofShadowAttempt.ok, false, 'Spoofing a Shadow tag must be rejected');
assert.match(spoofShadowAttempt.error, /cannot impersonate anonymous Shadow tags/);
console.log('  ✓ Disclosed winner, live set_disclosure toggle & Shadow-tag anti-spoofing verified');

// --- 6. Expired Vault Creator Refund (`reclaim_expired`) + Solver Attempt Fee Refund & Grace Period ---
const answerHash2 = await hashAnswer('dusk-fortress');
call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'create_vault',
  [
    'Unsolved Citadel',
    'No one will crack this before expiry.',
    'Cipher',
    '',
    answerHash2,
    rawU64(80n * ONE_DUSK),
    rawU64(10n * ONE_DUSK), // 10 DUSK attempt fee
    rawU64(5), // created at height 9 + 5 = expires at height 14
  ],
  {sender: 'wick', height: 9}
).decode();

// 'fen' makes a failed commit attempt at block 9 (paying 10 DUSK attempt fee)
const wrongHash = await hashAnswer('wrong-guess');
const commitFenWrong = await hashCommitment(2, keys.fen, wrongHash, 'fen-wrong');
const fenBalBeforeAttempt = BigInt(
  call(TRANSFER_CONTRACT_ID, transferMock.driver, 'balance_of', keys.fen, {height: 9, query: true}).decode()
);
assert.equal(
  call(AURORA_CONTRACT_ID, auroraDriver, 'commit_solution', [rawU64(2), commitFenWrong], {
    sender: 'fen',
    height: 9,
  }).ok,
  true
);

const earlyReclaim = call(AURORA_CONTRACT_ID, auroraDriver, 'reclaim_expired', rawU64(2), {
  sender: 'wick',
  height: 12,
});
assert.equal(earlyReclaim.ok, false, 'Reclaim before expires_at must fail');
assert.match(earlyReclaim.error, /not expired yet/);

// Reclaim after expiry (block 16 > 9 + 5 grace window):
// Creator 'wick' gets back only their 80 DUSK principal, and 'fen' is automatically refunded their 10 DUSK attempt fee!
const validReclaim = call(AURORA_CONTRACT_ID, auroraDriver, 'reclaim_expired', rawU64(2), {
  sender: 'wick',
  height: 16,
});
assert.equal(validReclaim.ok, true, `Reclaim at/after expires_at must succeed: ${validReclaim.error}`);
const fenBalAfterRefund = BigInt(
  call(TRANSFER_CONTRACT_ID, transferMock.driver, 'balance_of', keys.fen, {height: 16, query: true}).decode()
);
assert.equal(fenBalAfterRefund, fenBalBeforeAttempt, 'Solver attempt fee must be refunded when vault expires unsolved');

// Test Last-Block Commit Grace Period (Creator cannot rug-pull a solver who committed at expires_at - 1)
const answerHash3 = await hashAnswer('last-second-save');
call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'create_vault',
  [
    'The Final Hourglass',
    'Committed at block 18, expires at block 19.',
    'Riddle',
    '',
    answerHash3,
    rawU64(50n * ONE_DUSK),
    rawU64(0),
    rawU64(3), // created at height 16 + 3 = expires at height 19
  ],
  {sender: 'wick', height: 16}
).decode();

const commitYou3 = await hashCommitment(3, keys.you, answerHash3, 'grace-salt');
assert.equal(
  call(AURORA_CONTRACT_ID, auroraDriver, 'commit_solution', [rawU64(3), commitYou3], {
    sender: 'you',
    height: 18, // 1 block before expiry (19)
  }).ok,
  true
);

// Creator 'wick' tries to rug-pull/reclaim at block 19 while 'you' is waiting for the 1-block reveal delay -> MUST FAIL!
const rugPullAttempt = call(AURORA_CONTRACT_ID, auroraDriver, 'reclaim_expired', rawU64(3), {
  sender: 'wick',
  height: 19,
});
assert.equal(rugPullAttempt.ok, false, 'Creator must not rug-pull an active last-block commitment');
assert.match(rugPullAttempt.error, /grace window/);

// 'you' reveals at block 19 (within the 5-block grace window) -> SUCCEEDS!
const graceReveal = call(
  AURORA_CONTRACT_ID,
  auroraDriver,
  'reveal_solution',
  [rawU64(3), 'last-second-save', 'grace-salt', true, 'Vesper'],
  {sender: 'you', height: 19}
);
assert.equal(graceReveal.ok, true, `Grace period reveal failed: ${graceReveal.error}`);

// Wick seeded 1000 DUSK, funded 50 DUSK to Vault #0, paid 5 DUSK attempt fee on Vault #0,
// locked 80 DUSK in Vault #2 (reclaimed), locked 50 DUSK in Vault #3 (won by 'you') => 895 DUSK
const wickBalance = call(TRANSFER_CONTRACT_ID, transferMock.driver, 'balance_of', keys.wick, {
  height: 19,
  query: true,
}).decode();
assert.equal(BigInt(wickBalance), 895n * ONE_DUSK);

const poolBalance = call(TRANSFER_CONTRACT_ID, transferMock.driver, 'pool_balance', null, {
  height: 19,
  query: true,
}).decode();
assert.equal(BigInt(poolBalance), 0n, 'All locked contract DUSK should be settled');
console.log('  ✓ Uncracked attempt-fee refund, last-block commit grace period & zero-sum Moonlight accounting verified');

console.log('\nALL DUSK-VM INTEGRATION TESTS PASSED!');
