// Dusk Connect client layer for the Aurora dApp.
// Uses `@dusk-network/connect` (`createDuskApp`, `readContract`, `prepareContractCall`)
// against a Dusk node and Dusk Wallet.
import {createDuskApp} from './vendor/dusk-connect.js';
import {
  DEFAULT_CONTRACT_ID,
  DRIVER_URL,
  NETWORK_PRESETS,
} from './config.js';
import {
  hashAnswer,
  hashCommitment,
  bytesToHex,
  formatLuxToDusk,
  shortKey,
} from './crypto.js';

const rawU64 = n => JSON.rawJSON(BigInt(n).toString());

export const STATUS_OPEN = 0;
export const STATUS_CRACKED = 1;
export const STATUS_RECLAIMED = 2;

export function connectAuroraApp({
  nodeUrl = NETWORK_PRESETS.testnet.nodeUrl,
  contractId = DEFAULT_CONTRACT_ID,
  driverUrl = DRIVER_URL,
  autoConnect = true,
  waitForProvider = true,
  rememberLastUsedProvider = true,
} = {}) {
  return createDuskApp({
    pinnedNodeUrl: nodeUrl,
    autoConnect,
    wallet: {
      waitForProvider,
      rememberLastUsedProvider,
    },
    contracts: {
      aurora: {
        contractId,
        driverUrl,
        name: 'Aurora',
      },
    },
  });
}

export async function readProtocolStats(dusk) {
  const [vaultCount, totalLocked, totalPaid, totalCracked, solverCount, totalCreatorFees] = await Promise.all([
    dusk.readContract({contract: 'aurora', functionName: 'vault_count'}),
    dusk.readContract({contract: 'aurora', functionName: 'total_bounty_locked'}),
    dusk.readContract({contract: 'aurora', functionName: 'total_bounty_paid'}),
    dusk.readContract({contract: 'aurora', functionName: 'total_cracked'}),
    dusk.readContract({contract: 'aurora', functionName: 'solver_count'}),
    dusk.readContract({contract: 'aurora', functionName: 'total_creator_fees_paid'}).catch(() => 0),
  ]);
  return {
    vaultCount: Number(vaultCount),
    totalLockedLux: BigInt(totalLocked),
    totalPaidLux: BigInt(totalPaid),
    totalCracked: Number(totalCracked),
    solverCount: Number(solverCount),
    totalCreatorFeesLux: BigInt(totalCreatorFees || 0),
  };
}

export async function readVaultById(dusk, id, currentBlockHeight = 0) {
  const u64Id = rawU64(id);
  const [meta, state, bountyRaw, economicsRaw, creator, answerHash, winnerTuple] = await Promise.all([
    dusk.readContract({contract: 'aurora', functionName: 'vault_meta', args: u64Id}),
    dusk.readContract({contract: 'aurora', functionName: 'vault_state', args: u64Id}),
    dusk.readContract({contract: 'aurora', functionName: 'vault_bounty', args: u64Id}),
    dusk.readContract({contract: 'aurora', functionName: 'vault_economics', args: u64Id}).catch(() => [0, 0, 0]),
    dusk.readContract({contract: 'aurora', functionName: 'vault_creator', args: u64Id}),
    dusk.readContract({contract: 'aurora', functionName: 'vault_answer_hash', args: u64Id}),
    dusk.readContract({contract: 'aurora', functionName: 'vault_winner', args: u64Id}),
  ]);

  if (!meta || !state) return null;

  const [title, lore, category, hint] = meta;
  const [status, createdAt, expiresAt, crackedAt, attempts, disclosed] = state;
  const bountyLux = BigInt(bountyRaw);
  const [attemptFeeRaw = 0, creatorFeePoolRaw = 0, solverJackpotAddedRaw = 0] = economicsRaw || [];
  const attemptFeeLux = BigInt(attemptFeeRaw);
  const creatorFeePoolLux = BigInt(creatorFeePoolRaw);
  const solverJackpotAddedLux = BigInt(solverJackpotAddedRaw);

  const winnerKey = winnerTuple ? winnerTuple[0] : null;
  const winnerLabel = winnerTuple ? winnerTuple[1] : null;
  const winningAnswer = winnerTuple && winnerTuple.length > 2 ? winnerTuple[2] : '';

  const isExpired =
    status === STATUS_OPEN &&
    expiresAt > 0 &&
    currentBlockHeight > 0 &&
    currentBlockHeight >= expiresAt;

  const statusLabel = status === STATUS_CRACKED
    ? 'Cracked'
    : status === STATUS_RECLAIMED
      ? 'Reclaimed'
      : isExpired
        ? 'Expired'
        : 'Open';

  return {
    id: Number(id),
    title,
    lore,
    category,
    hint,
    creator,
    creatorShort: shortKey(creator),
    bountyLux,
    bountyDusk: formatLuxToDusk(bountyLux),
    attemptFeeLux,
    attemptFeeDusk: formatLuxToDusk(attemptFeeLux),
    creatorFeePoolLux,
    creatorFeePoolDusk: formatLuxToDusk(creatorFeePoolLux),
    solverJackpotAddedLux,
    solverJackpotAddedDusk: formatLuxToDusk(solverJackpotAddedLux),
    status,
    statusLabel,
    isExpired,
    createdAt: Number(createdAt),
    expiresAt: Number(expiresAt),
    crackedAt: Number(crackedAt),
    attempts: Number(attempts),
    disclosed: Boolean(disclosed),
    winnerKey,
    winnerLabel,
    winningAnswer,
    answerHashHex: answerHash ? bytesToHex(answerHash) : '',
  };
}

export async function readAllVaults(dusk, currentBlockHeight = 0) {
  const countRaw = await dusk.readContract({contract: 'aurora', functionName: 'vault_count'});
  const count = Number(countRaw);
  const ids = Array.from({length: count}, (_, i) => i);
  const vaults = await Promise.all(ids.map(id => readVaultById(dusk, id, currentBlockHeight)));
  return vaults.filter(Boolean);
}

export async function readSolverCommitment(dusk, vaultId, solverAccount) {
  if (!solverAccount) return null;
  const res = await dusk.readContract({
    contract: 'aurora',
    functionName: 'commitment_of',
    args: [rawU64(vaultId), solverAccount],
  });
  if (!res) return null;
  const [hashBytes, committedAt] = res;
  return {
    hashBytes,
    hashHex: bytesToHex(hashBytes),
    committedAt: Number(committedAt),
  };
}

export async function readLeaderboard(dusk) {
  const countRaw = await dusk.readContract({contract: 'aurora', functionName: 'solver_count'});
  const count = Number(countRaw);
  const indices = Array.from({length: count}, (_, i) => i);

  const entries = await Promise.all(
    indices.map(async idx => {
      const u64Idx = rawU64(idx);
      const [tuple, bountyRaw] = await Promise.all([
        dusk.readContract({contract: 'aurora', functionName: 'solver_entry', args: u64Idx}),
        dusk.readContract({contract: 'aurora', functionName: 'solver_bounty_won', args: u64Idx}),
      ]);
      if (!tuple) return null;
      const [solverKey, displayName, cracks, lastCrackAt, disclosed] = tuple;
      const bountyLux = BigInt(bountyRaw);
      return {
        index: idx,
        solverKey, // null when undisclosed!
        solverShort: solverKey ? shortKey(solverKey) : 'Hidden (Moonlight Privacy)',
        displayName,
        cracks: Number(cracks),
        lastCrackAt: Number(lastCrackAt),
        disclosed: Boolean(disclosed),
        bountyLux,
        bountyDusk: formatLuxToDusk(bountyLux),
      };
    })
  );

  return entries
    .filter(Boolean)
    .sort((a, b) => {
      if (b.bountyLux !== a.bountyLux) return b.bountyLux > a.bountyLux ? 1 : -1;
      return b.cracks - a.cracks;
    })
    .map((entry, idx) => ({...entry, rank: idx + 1}));
}

// ---- Transaction Preparation (`prepareContractCall`) --------------------------------------

export async function prepareCreateVault(dusk, {
  title,
  lore,
  category = 'Riddle',
  hint = '',
  plaintextAnswer,
  bountyLux,
  attemptFeeLux = 0n,
  durationBlocks = 0,
}) {
  const answerHash = await hashAnswer(plaintextAnswer);
  const bountyBig = BigInt(bountyLux);
  const attemptFeeBig = BigInt(attemptFeeLux);
  const prepared = await dusk.prepareContractCall({
    contract: 'aurora',
    functionName: 'create_vault',
    args: [
      String(title ?? '').trim(),
      String(lore ?? '').trim(),
      String(category ?? 'Riddle').trim(),
      String(hint ?? '').trim(),
      answerHash,
      rawU64(bountyBig),
      rawU64(attemptFeeBig),
      rawU64(durationBlocks),
    ],
    privacy: 'public',
    amount: '0',
    deposit: bountyBig.toString(),
  });
  return {
    prepared,
    answerHash,
    answerHashHex: bytesToHex(answerHash),
  };
}

export async function prepareFundVault(dusk, {vaultId, amountLux}) {
  const amountBig = BigInt(amountLux);
  return await dusk.prepareContractCall({
    contract: 'aurora',
    functionName: 'fund_vault',
    args: [rawU64(vaultId), rawU64(amountBig)],
    privacy: 'public',
    amount: '0',
    deposit: amountBig.toString(),
  });
}

export async function prepareAddHint(dusk, {vaultId, hint}) {
  return await dusk.prepareContractCall({
    contract: 'aurora',
    functionName: 'add_hint',
    args: [rawU64(vaultId), String(hint ?? '').trim()],
    privacy: 'public',
    amount: '0',
    deposit: '0',
  });
}

export async function prepareCommitSolution(dusk, {
  vaultId,
  solverAccount,
  plaintextAnswer,
  salt,
  attemptFeeLux = 0n,
}) {
  const answerHash = await hashAnswer(plaintextAnswer);
  const commitmentBytes = await hashCommitment(vaultId, solverAccount, answerHash, salt);
  const attemptFeeBig = BigInt(attemptFeeLux);
  const prepared = await dusk.prepareContractCall({
    contract: 'aurora',
    functionName: 'commit_solution',
    args: [rawU64(vaultId), commitmentBytes],
    privacy: 'public',
    amount: '0',
    deposit: attemptFeeBig.toString(),
  });
  return {
    prepared,
    answerHash,
    commitmentBytes,
    commitmentHex: bytesToHex(commitmentBytes),
  };
}

export async function prepareRevealSolution(dusk, {
  vaultId,
  plaintextAnswer,
  salt,
  discloseWinner = false,
  alias = '',
}) {
  return await dusk.prepareContractCall({
    contract: 'aurora',
    functionName: 'reveal_solution',
    args: [
      rawU64(vaultId),
      String(plaintextAnswer ?? ''),
      String(salt ?? '').trim(),
      Boolean(discloseWinner),
      String(alias ?? '').trim(),
    ],
    privacy: 'public',
    amount: '0',
    deposit: '0',
  });
}

export async function prepareReclaimExpired(dusk, {vaultId}) {
  return await dusk.prepareContractCall({
    contract: 'aurora',
    functionName: 'reclaim_expired',
    args: rawU64(vaultId),
    privacy: 'public',
    amount: '0',
    deposit: '0',
  });
}

export async function prepareSetDisclosure(dusk, {disclose, alias = ''}) {
  return await dusk.prepareContractCall({
    contract: 'aurora',
    functionName: 'set_disclosure',
    args: [Boolean(disclose), String(alias ?? '').trim()],
    privacy: 'public',
    amount: '0',
    deposit: '0',
  });
}
