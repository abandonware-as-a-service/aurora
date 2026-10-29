// Stateful Practice / Sandbox Dusk Node for Aurora.
// Runs the actual compiled `dusk-aurora.wasm` and `transfer-mock.wasm` inside `DuskWasmVm`
// and serves Dusk Connect's HTTP endpoints (`GET /drivers/aurora.wasm` and
// `POST /on/contracts:<id>/<fn>`) so `dusk.readContract` and `dusk.prepareContractCall`
// behave identically in Practice Mode and Live Network Mode.
import {
  DuskWasmVm,
  TRANSFER_CONTRACT_ID,
  AURORA_CONTRACT_ID,
} from './dusk-vm.js';
import {
  hashAnswer,
  hashCommitment,
  bytesToHex,
  hexToBytes,
  LUX_SCALE,
} from './crypto.js';

export const PRACTICE_NODE_URL = 'https://practice.aurora.local';
export const OFFLINE_NODE_URL = 'https://offline.aurora.local';
export const DRIVER_PATH = '/drivers/aurora.wasm';
export {TRANSFER_CONTRACT_ID, AURORA_CONTRACT_ID};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const rawU64 = n => JSON.rawJSON(BigInt(n).toString());

export function instantiateDriverFromBytes(wasmBytes) {
  const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
  const mod = new WebAssembly.Module(bytes);
  const e = new WebAssembly.Instance(mod, {env: {}}).exports;
  e.init?.();
  const put = data => {
    const p = e.alloc(data.length);
    new Uint8Array(e.memory.buffer, p, data.length).set(data);
    return [p, data.length];
  };
  const call = (fn, ...inputs) => {
    const size = 1 << 16;
    const out = e.alloc(size);
    const ptrs = inputs.map(put);
    try {
      const code = e[fn](...ptrs.flat(), out, size);
      const read = at => new Uint8Array(e.memory.buffer).slice(
        at + 4,
        at + 4 + new DataView(e.memory.buffer).getUint32(at, true)
      );
      if (code !== 0) {
        e.get_last_error(out, size);
        throw new Error(textDecoder.decode(read(out)));
      }
      return read(out);
    } finally {
      for (const [p, len] of ptrs) {
        try { e.dealloc(p, len); } catch {}
      }
      try { e.dealloc(out, size); } catch {}
    }
  };
  return {
    encodeInput: (fn, jsonText) => call('encode_input_fn', textEncoder.encode(fn), textEncoder.encode(jsonText)),
    decodeInput: (fn, rkyvBytes) => JSON.parse(textDecoder.decode(call('decode_input_fn', textEncoder.encode(fn), rkyvBytes))),
    decodeOutput: (fn, rkyvBytes) => JSON.parse(textDecoder.decode(call('decode_output_fn', textEncoder.encode(fn), rkyvBytes))),
    decodeEvent: (topic, rkyvBytes) => JSON.parse(textDecoder.decode(call('decode_event', textEncoder.encode(topic), rkyvBytes))),
    schema: () => JSON.parse(textDecoder.decode(call('get_schema'))),
  };
}

export const PERSONA_METADATA = {
  you: {
    id: 'you',
    label: 'You (Vesper)',
    role: 'Moonlight Explorer',
    badge: 'Active Wallet',
  },
  rook: {
    id: 'rook',
    label: 'Rook',
    role: 'Cipher Hunter (Prefers Shadow Mode)',
    badge: 'Anon Solver',
  },
  fen: {
    id: 'fen',
    label: 'Archivist Fen',
    role: 'ZK Scholar (Disclosed Winner)',
    badge: 'Public Solver',
  },
  wick: {
    id: 'wick',
    label: 'Wick',
    role: 'Mempool Sniper Bot Operator',
    badge: 'MEV / Bot',
  },
};

export async function createPracticeNode({
  auroraWasmBytes,
  auroraDriverBytes,
  transferWasmBytes,
  transferDriverBytes,
  keepersJson,
}) {
  const auroraDriver = instantiateDriverFromBytes(auroraDriverBytes);
  const transferDriver = instantiateDriverFromBytes(transferDriverBytes);
  const keys = keepersJson.keys;

  const keepersRkyv = {};
  if (keepersJson.rkyv_some) {
    for (const [name, hexStr] of Object.entries(keepersJson.rkyv_some)) {
      keepersRkyv[keys[name]] = hexToBytes(hexStr);
    }
  }

  const vm = new DuskWasmVm({
    auroraDriver,
    transferDriver,
    keepersRkyv,
  });

  vm.deploy(TRANSFER_CONTRACT_ID, transferWasmBytes);
  vm.deploy(AURORA_CONTRACT_ID, auroraWasmBytes);

  let blockHeight = 1;
  let txCounter = 1;
  const eventLog = [];
  const queryLog = [];
  const botIntercepts = [];

  function recordEvents(rawEvents, height, txHash, fnName) {
    const decoded = [];
    for (const ev of rawEvents) {
      let payload = null;
      try {
        payload = auroraDriver.decodeEvent(ev.topic, ev.rawBytes);
      } catch {
        payload = {rawHex: ev.data};
      }
      const entry = {
        id: `${txHash}:${decoded.length}`,
        txHash,
        blockHeight: height,
        topic: ev.topic,
        fnName,
        payload,
      };
      decoded.push(entry);
      eventLog.unshift(entry);
    }
    return decoded;
  }

  function execInternal(contractId, driver, fn, argVal, senderName, height = blockHeight) {
    const argBytes = driver.encodeInput(fn, JSON.stringify(argVal));
    const txHash = bytesToHex(new Uint8Array(32).map((_, i) => (txCounter * 31 + i * 17 + height) & 0xff));
    txCounter++;
    const res = vm.callRaw({
      contract: contractId,
      fn,
      argBytes,
      sender: senderName ? keys[senderName] : null,
      height,
      query: false,
    });
    if (!res.ok) {
      throw new Error(res.error);
    }
    const events = contractId === AURORA_CONTRACT_ID
      ? recordEvents(res.events, height, txHash, fn)
      : [];
    return {
      txHash,
      output: driver.decodeOutput(fn, res.rawBytes),
      events,
    };
  }

  // --- Seed Genesis State ---
  // 1. Seed 1,500 DUSK for each Moonlight persona
  for (const name of ['you', 'rook', 'fen', 'wick']) {
    execInternal(TRANSFER_CONTRACT_ID, transferDriver, 'seed_balance', [
      keys[name],
      rawU64(1500n * LUX_SCALE),
    ], name, 1);
  }

  // 2. Vault #0: Open Riddle Vault created by Rook (250 DUSK bounty)
  blockHeight = 2;
  const ans0 = await hashAnswer('silence');
  execInternal(AURORA_CONTRACT_ID, auroraDriver, 'create_vault', [
    'The Whispering Arch',
    'I speak without a mouth and hear without ears. I have no body, yet the wind wakes me, and the moment you speak my true name I am broken. What am I?',
    'Riddle',
    'Seven letters. The quietest thing in a cathedral.',
    ans0,
    rawU64(250n * LUX_SCALE),
    rawU64(60),
  ], 'rook', blockHeight);

  // 3. Vault #1: Open Cryptography Vault created by Fen (420 DUSK bounty)
  blockHeight = 3;
  const ans1 = await hashAnswer('witness');
  execInternal(AURORA_CONTRACT_ID, auroraDriver, 'create_vault', [
    'The Plonk Gate',
    'In a Dusk circuit, I am a private value appended by the prover so the verifier can check a gate constraint without ever learning my secret value. What single word am I?',
    'Cryptography',
    'Think of composer.append_... in dusk-plonk.',
    ans1,
    rawU64(420n * LUX_SCALE),
    rawU64(80),
  ], 'fen', blockHeight);

  // 4. Vault #2: Cracked Anonymously by Rook (shows Shadow #xxxxxx on leaderboard)
  blockHeight = 4;
  const ans2 = await hashAnswer('nullifier');
  execInternal(AURORA_CONTRACT_ID, auroraDriver, 'create_vault', [
    'The Nullifier’s Shadow',
    'In Dusk’s protocol history, each spent note reveals a unique cryptographic tag that the transfer contract records to prevent double-spending without linking which note was spent. What is this tag called?',
    'Dusk Lore',
    'Nine letters, starts with N.',
    ans2,
    rawU64(180n * LUX_SCALE),
    rawU64(50),
  ], 'you', blockHeight);

  const commitRook2 = await hashCommitment(2, keys.rook, ans2, 'rook-genesis-salt');
  execInternal(AURORA_CONTRACT_ID, auroraDriver, 'commit_solution', [rawU64(2), commitRook2], 'rook', 5);
  execInternal(
    AURORA_CONTRACT_ID,
    auroraDriver,
    'reveal_solution',
    [rawU64(2), 'nullifier', 'rook-genesis-salt', false, 'Rook'],
    'rook',
    6
  );

  // 5. Vault #3: Cracked Publicly by Fen (shows "Archivist Fen" + BlsPublicKey on leaderboard)
  blockHeight = 7;
  const ans3 = await hashAnswer('ratification');
  execInternal(AURORA_CONTRACT_ID, auroraDriver, 'create_vault', [
    'The Succinct Committee',
    'In Dusk’s Succinct Attestation consensus, a block goes through three steps in each iteration: proposal by a provisioner, validation by a committee, and finally what third phase by a second committee?',
    'Consensus',
    'Starts with R (12 letters).',
    ans3,
    rawU64(310n * LUX_SCALE),
    rawU64(50),
  ], 'rook', blockHeight);

  const commitFen3 = await hashCommitment(3, keys.fen, ans3, 'fen-genesis-salt');
  execInternal(AURORA_CONTRACT_ID, auroraDriver, 'commit_solution', [rawU64(3), commitFen3], 'fen', 8);
  execInternal(
    AURORA_CONTRACT_ID,
    auroraDriver,
    'reveal_solution',
    [rawU64(3), 'ratification', 'fen-genesis-salt', true, 'Archivist Fen'],
    'fen',
    9
  );

  // 6. Vault #4: Short-expiry Cipher Vault created by You (expires at block 16, current height = 12)
  blockHeight = 10;
  const ans4 = await hashAnswer('kadcast');
  execInternal(AURORA_CONTRACT_ID, auroraDriver, 'create_vault', [
    'The Forgotten Sundial',
    'Decrypt the Caesar shift (+3): NDGFDVW — the structured overlay broadcast protocol that propagates Dusk blocks across the peer-to-peer network with minimal bandwidth overhead.',
    'Cipher',
    'Shift each letter 3 positions backward in the alphabet (N -> K, D -> A...).',
    ans4,
    rawU64(125n * LUX_SCALE),
    rawU64(6), // expires at block 16
  ], 'you', blockHeight);

  blockHeight = 12;

  // --- Fetch handler for Dusk Connect (`createDuskApp`) ---
  const fetchHandler = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);

    if (url.origin === OFFLINE_NODE_URL) {
      return new Response('Practice node is simulating an offline outage.', {status: 503});
    }
    if (url.origin !== PRACTICE_NODE_URL) {
      throw new TypeError(`Practice transport cannot reach external origin ${url.origin}`);
    }
    if (url.pathname === DRIVER_PATH && request.method === 'GET') {
      return new Response(auroraDriverBytes, {
        status: 200,
        headers: {'Content-Type': 'application/wasm'},
      });
    }

    const match = /^\/on\/contracts:([0-9a-f]{64})\/(\w+)$/i.exec(url.pathname);
    if (!match || request.method !== 'POST') {
      return new Response('Unknown RUES endpoint', {status: 404});
    }

    const [, contractHex, fn] = match;
    const argBytes = new Uint8Array(await request.arrayBuffer());
    queryLog.push({contract: contractHex.toLowerCase(), fn, argHex: bytesToHex(argBytes), blockHeight});

    const res = vm.callRaw({
      contract: contractHex.toLowerCase(),
      fn,
      argBytes,
      sender: null,
      height: blockHeight,
      query: true,
    });

    if (!res.ok) {
      return new Response(res.error, {status: 400});
    }
    return new Response(res.rawBytes, {
      status: 200,
      headers: {'Content-Type': 'application/octet-stream'},
    });
  };

  function getBalanceLux(accountOrPersona) {
    const key = keys[accountOrPersona] || accountOrPersona;
    const argBytes = transferDriver.encodeInput('balance_of', JSON.stringify(key));
    const res = vm.callRaw({
      contract: TRANSFER_CONTRACT_ID,
      fn: 'balance_of',
      argBytes,
      height: blockHeight,
      query: true,
    });
    return res.ok ? BigInt(transferDriver.decodeOutput('balance_of', res.rawBytes)) : 0n;
  }

  function executePreparedCall(preparedTx, {
    persona = 'you',
    simulateFrontRunner = false,
    autoAdvanceBlockOnCommit = false,
  } = {}) {
    const senderKey = keys[persona] || persona;
    const contractId = String(preparedTx.contractId || '').replace(/^0x/i, '').toLowerCase();
    const fnName = preparedTx.fnName;
    const argBytes = hexToBytes(preparedTx.fnArgs);
    const botReport = [];

    // If Mempool Front-Runner Bot is enabled and this is a `reveal_solution` call,
    // Wick's bot spots the plaintext answer & salt in the mempool and attempts to front-run first!
    if (simulateFrontRunner && fnName === 'reveal_solution' && persona !== 'wick') {
      const decodedArgs = auroraDriver.decodeInput('reveal_solution', argBytes);
      const [vaultId, plainAnswer, plainSalt] = decodedArgs;
      const sniperArgs = auroraDriver.encodeInput(
        'reveal_solution',
        JSON.stringify([rawU64(vaultId), plainAnswer, plainSalt, true, 'WickSniperBot'])
      );
      const sniperRes = vm.callRaw({
        contract: contractId,
        fn: 'reveal_solution',
        argBytes: sniperArgs,
        sender: keys.wick,
        height: blockHeight,
        query: false,
      });
      const intercept = {
        blockHeight,
        phase: 'reveal_frontrun_blocked',
        attacker: 'Wick (Mempool Sniper)',
        vaultId,
        stolenAnswer: plainAnswer,
        ok: sniperRes.ok,
        error: sniperRes.error || 'Blocked',
      };
      botReport.push(intercept);
      botIntercepts.unshift(intercept);
    }

    const txHash = bytesToHex(new Uint8Array(32).map((_, i) => (txCounter * 41 + i * 29 + blockHeight) & 0xff));
    txCounter++;

    const res = vm.callRaw({
      contract: contractId,
      fn: fnName,
      argBytes,
      sender: senderKey,
      height: blockHeight,
      query: false,
    });

    if (!res.ok) {
      return {
        ok: false,
        txHash,
        blockHeight,
        error: res.error,
        events: [],
        botReport,
      };
    }

    const events = recordEvents(res.events, blockHeight, txHash, fnName);
    const output = auroraDriver.decodeOutput(fnName, res.rawBytes);

    // If Mempool Front-Runner Bot is enabled and this is a `commit_solution` call,
    // Wick's bot copies the user's commitment hash into the same block!
    if (simulateFrontRunner && fnName === 'commit_solution' && persona !== 'wick') {
      const [vaultId, commitBytes] = auroraDriver.decodeInput('commit_solution', argBytes);
      const copyRes = vm.callRaw({
        contract: contractId,
        fn: 'commit_solution',
        argBytes,
        sender: keys.wick,
        height: blockHeight,
        query: false,
      });
      if (copyRes.ok) {
        recordEvents(copyRes.events, blockHeight, `${txHash.slice(0, 60)}b070`, 'commit_solution');
      }
      const intercept = {
        blockHeight,
        phase: 'commit_copied',
        attacker: 'Wick (Mempool Sniper)',
        vaultId,
        copiedHashHex: bytesToHex(commitBytes).slice(0, 18) + '…',
        note: 'Wick copied your 32-byte commitment hash in the mempool, but it is bound to your BlsPublicKey!',
      };
      botReport.push(intercept);
      botIntercepts.unshift(intercept);
    }

    if (autoAdvanceBlockOnCommit && fnName === 'commit_solution') {
      blockHeight += 1;
    }

    return {
      ok: true,
      txHash,
      blockHeight,
      output,
      events,
      botReport,
    };
  }

  return {
    keys,
    personas: PERSONA_METADATA,
    auroraDriver,
    transferDriver,
    fetch: fetchHandler,
    getBlockHeight: () => blockHeight,
    advanceBlocks: (delta = 1) => {
      blockHeight = Math.max(1, blockHeight + Number(delta));
      return blockHeight;
    },
    getBalanceLux,
    getAllBalances: () => ({
      you: getBalanceLux('you'),
      rook: getBalanceLux('rook'),
      fen: getBalanceLux('fen'),
      wick: getBalanceLux('wick'),
    }),
    getEventLog: () => eventLog.slice(),
    getQueryLog: () => queryLog.slice(),
    getBotIntercepts: () => botIntercepts.slice(),
    executePreparedCall,
  };
}
