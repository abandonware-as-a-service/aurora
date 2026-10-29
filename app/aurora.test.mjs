import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  createPracticeNode,
  PRACTICE_NODE_URL,
  DRIVER_PATH,
} from './node-sim.js';
import {
  connectAuroraApp,
  readProtocolStats,
  readAllVaults,
  readVaultById,
  readLeaderboard,
  readSolverCommitment,
  prepareCreateVault,
  prepareFundVault,
  prepareAddHint,
  prepareCommitSolution,
  prepareRevealSolution,
  prepareReclaimExpired,
  prepareSetDisclosure,
} from './client.js';
import {computeShadowTag, LUX_SCALE} from './crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'app', 'vendor');

const auroraWasmBytes = readFileSync(join(VENDOR, 'dusk-aurora.wasm'));
const auroraDriverBytes = readFileSync(join(VENDOR, 'aurora-driver.wasm'));
const transferWasmBytes = readFileSync(join(VENDOR, 'transfer-mock.wasm'));
const transferDriverBytes = readFileSync(join(VENDOR, 'transfer-driver.wasm'));
const keepersJson = JSON.parse(readFileSync(join(VENDOR, 'aurora-keepers.json'), 'utf8'));

test('Dusk Connect client + Practice Node full lifecycle (readContract & prepareContractCall)', async () => {
  const node = await createPracticeNode({
    auroraWasmBytes,
    auroraDriverBytes,
    transferWasmBytes,
    transferDriverBytes,
    keepersJson,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = node.fetch;

  try {
    const dusk = connectAuroraApp({
      nodeUrl: PRACTICE_NODE_URL,
      driverUrl: `${PRACTICE_NODE_URL}${DRIVER_PATH}`,
      waitForProvider: false,
      rememberLastUsedProvider: false,
    });

    // 1. Read genesis stats & vaults via Dusk Connect + aurora-driver.wasm
    const stats0 = await readProtocolStats(dusk);
    assert.equal(stats0.vaultCount, 5);
    assert.equal(stats0.totalCracked, 2);
    assert.equal(stats0.solverCount, 2);
    assert.equal(stats0.totalLockedLux, (250n + 420n + 125n) * LUX_SCALE);
    assert.equal(stats0.totalPaidLux, (180n + 310n) * LUX_SCALE);

    const vaults0 = await readAllVaults(dusk, node.getBlockHeight());
    assert.equal(vaults0.length, 5);
    assert.equal(vaults0[0].title, 'The Whispering Arch');
    assert.equal(vaults0[0].statusLabel, 'Open');

    // 2. Verify Leaderboard privacy: Fen is disclosed, Rook is an anonymous Shadow
    const board0 = await readLeaderboard(dusk);
    assert.equal(board0.length, 2);
    assert.equal(board0[0].displayName, 'Archivist Fen');
    assert.equal(board0[0].disclosed, true);
    assert.equal(board0[0].solverKey, node.keys.fen);

    const rookShadow = await computeShadowTag(node.keys.rook);
    assert.equal(board0[1].displayName, rookShadow);
    assert.equal(board0[1].disclosed, false);
    assert.equal(board0[1].solverKey, null);

    // 3. Crack Vault #0 ("The Whispering Arch", answer "silence") as 'you'
    //    with Mempool Front-Runner Bot simulation active AND anonymous mode (discloseWinner = false)
    const youBalanceBefore = node.getBalanceLux('you');
    const salt = 'vesper-secret-salt-42';

    const {prepared: commitTx, commitmentHex} = await prepareCommitSolution(dusk, {
      vaultId: 0,
      solverAccount: node.keys.you,
      plaintextAnswer: '  Silence ',
      salt,
    });
    assert.equal(commitTx.privacy, 'public');
    assert.equal(commitTx.fnName, 'commit_solution');

    const commitRes = node.executePreparedCall(commitTx, {
      persona: 'you',
      simulateFrontRunner: true,
      autoAdvanceBlockOnCommit: true,
    });
    assert.equal(commitRes.ok, true);
    assert.equal(commitRes.botReport.length, 1);
    assert.equal(commitRes.botReport[0].phase, 'commit_copied');

    const onChainCommit = await readSolverCommitment(dusk, 0, node.keys.you);
    assert.equal(onChainCommit.hashHex, commitmentHex);

    const revealTx = await prepareRevealSolution(dusk, {
      vaultId: 0,
      plaintextAnswer: 'silence',
      salt,
      discloseWinner: false,
      alias: 'HiddenVesper',
    });

    const revealRes = node.executePreparedCall(revealTx, {
      persona: 'you',
      simulateFrontRunner: true,
    });
    assert.equal(revealRes.ok, true);
    assert.equal(revealRes.botReport.length, 1);
    assert.equal(revealRes.botReport[0].phase, 'reveal_frontrun_blocked');
    assert.equal(revealRes.botReport[0].ok, false);

    // Verify 'you' received 250 DUSK and winner key is hidden as null on-chain
    const youBalanceAfter = node.getBalanceLux('you');
    assert.equal(youBalanceAfter - youBalanceBefore, 250n * LUX_SCALE);

    const youShadow = await computeShadowTag(node.keys.you);
    const crackedVault0 = await readVaultById(dusk, 0, node.getBlockHeight());
    assert.equal(crackedVault0.statusLabel, 'Cracked');
    assert.equal(crackedVault0.winnerKey, null);
    assert.equal(crackedVault0.winnerLabel, youShadow);

    // 4. Toggle 'you' disclosure on-chain via `set_disclosure(true, "Captain Vesper")`
    const discloseTx = await prepareSetDisclosure(dusk, {
      disclose: true,
      alias: 'Captain Vesper',
    });
    const discloseRes = node.executePreparedCall(discloseTx, {persona: 'you'});
    assert.equal(discloseRes.ok, true);

    const disclosedVault0 = await readVaultById(dusk, 0, node.getBlockHeight());
    assert.equal(disclosedVault0.winnerKey, node.keys.you);
    assert.equal(disclosedVault0.winnerLabel, 'Captain Vesper');

    // 5. Create a new Vault (#5), fund it, and add a hint
    const {prepared: createTx} = await prepareCreateVault(dusk, {
      title: 'The Moonlight Mirror',
      lore: 'What account model on Dusk uses public BLS keys and visible balances?',
      category: 'Dusk Lore',
      hint: 'Opposite of sunlight.',
      plaintextAnswer: 'moonlight',
      bountyLux: 90n * LUX_SCALE,
      durationBlocks: 30,
    });
    assert.equal(createTx.deposit, (90n * LUX_SCALE).toString());
    const createRes = node.executePreparedCall(createTx, {persona: 'you'});
    assert.equal(createRes.ok, true);
    assert.equal(createRes.output, '5');

    const fundTx = await prepareFundVault(dusk, {vaultId: 5, amountLux: 10n * LUX_SCALE});
    assert.equal(node.executePreparedCall(fundTx, {persona: 'fen'}).ok, true);

    const hintTx = await prepareAddHint(dusk, {vaultId: 5, hint: 'Starts with Moon.'});
    assert.equal(node.executePreparedCall(hintTx, {persona: 'you'}).ok, true);

    const vault5 = await readVaultById(dusk, 5, node.getBlockHeight());
    assert.equal(vault5.bountyLux, 100n * LUX_SCALE);
    assert.equal(vault5.hint, 'Starts with Moon.');

    // 6. Advance block height to 16 so Vault #4 expires, then reclaim its 125 DUSK bounty
    node.advanceBlocks(10);
    const expiredVault4 = await readVaultById(dusk, 4, node.getBlockHeight());
    assert.equal(expiredVault4.statusLabel, 'Expired');

    const reclaimTx = await prepareReclaimExpired(dusk, {vaultId: 4});
    const reclaimRes = node.executePreparedCall(reclaimTx, {persona: 'you'});
    assert.equal(reclaimRes.ok, true);

    const reclaimedVault4 = await readVaultById(dusk, 4, node.getBlockHeight());
    assert.equal(reclaimedVault4.statusLabel, 'Reclaimed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
