// Pure WebAssembly DuskVM runtime (`piecrust-uplink` host ABI).
// Executes the real compiled Rust smart contracts (`dusk-aurora.wasm` and `transfer-mock.wasm`)
// directly inside WebAssembly in both Node.js and modern browsers, with full atomic state rollback
// on panic, cross-contract calls (`env.c`), event emission (`env.emit`), metadata (`env.hd`),
// and SHA-256 host queries (`env.hq`).
import {sha256Sync, bytesToHex} from './crypto.js';

export const TRANSFER_CONTRACT_ID = '01' + '00'.repeat(31);
export const AURORA_CONTRACT_ID =
  '84b7fea5f89a144d87676fdf27fc2a7b63b8be8b4e24a939db3c29a2b299ccde';

class DuskVmPanic extends Error {
  constructor(message) {
    super(message);
    this.name = 'DuskVmPanic';
  }
}

const textDecoder = new TextDecoder();

export class DuskWasmVm {
  constructor({auroraDriver, transferDriver = null, keepersRkyv = {}}) {
    this.auroraDriver = auroraDriver;
    this.transferDriver = transferDriver;
    this.keepersRkyv = keepersRkyv;
    this.contracts = new Map();
    this.currentSender = null;
    this.currentHeight = 1n;
    this.activeEvents = [];
  }

  encodeSenderOption(senderBase58) {
    if (!senderBase58) {
      return new Uint8Array(208);
    }
    if (this.keepersRkyv[senderBase58]) {
      return this.keepersRkyv[senderBase58];
    }
    if (this.transferDriver) {
      const pkRkyv = this.transferDriver.encodeInput('balance_of', JSON.stringify(senderBase58));
      const out = new Uint8Array(8 + pkRkyv.length);
      out[0] = 1; // Some(...) discriminant in 64-bit aligned rkyv Option<PublicKey>
      out.set(pkRkyv, 8);
      this.keepersRkyv[senderBase58] = out;
      return out;
    }
    throw new DuskVmPanic(`Missing rkyv encoding for sender ${senderBase58}`);
  }

  deploy(contractIdHex, wasmBytes) {
    const id = contractIdHex.toLowerCase().replace(/^0x/, '');
    const mod = wasmBytes instanceof WebAssembly.Module
      ? wasmBytes
      : new WebAssembly.Module(wasmBytes);

    let instanceRef = null;
    const getMem = () => instanceRef.exports.memory;
    const getArgBufOffset = () => {
      const g = instanceRef.exports.A;
      return typeof g === 'number' ? g : g.value;
    };

    const env = {
      panic: (argLen) => {
        const mem = getMem();
        const ofs = getArgBufOffset();
        const msg = textDecoder.decode(new Uint8Array(mem.buffer, ofs, argLen >>> 0));
        throw new DuskVmPanic(msg);
      },
      emit: (topicPtr, topicLen, argLen) => {
        const mem = getMem();
        const ofs = getArgBufOffset();
        const topic = textDecoder.decode(new Uint8Array(mem.buffer, topicPtr >>> 0, topicLen >>> 0));
        const data = new Uint8Array(mem.buffer, ofs, argLen >>> 0).slice();
        this.activeEvents.push({
          source: id,
          topic,
          data: bytesToHex(data),
          rawBytes: data,
        });
      },
      hd: (namePtr, nameLen) => {
        const mem = getMem();
        const ofs = getArgBufOffset();
        const name = textDecoder.decode(new Uint8Array(mem.buffer, namePtr >>> 0, nameLen >>> 0));
        if (name === 'block_height') {
          const view = new DataView(mem.buffer, ofs, 8);
          view.setBigUint64(0, BigInt(this.currentHeight), true);
          return 8;
        }
        if (name === 'chain_id') {
          new Uint8Array(mem.buffer, ofs, 1)[0] = 1;
          return 1;
        }
        if (name === 'public_sender') {
          const encoded = this.encodeSenderOption(this.currentSender);
          new Uint8Array(mem.buffer, ofs, encoded.length).set(encoded);
          return encoded.length;
        }
        return 0;
      },
      hq: (namePtr, nameLen, argLen) => {
        const mem = getMem();
        const ofs = getArgBufOffset();
        const name = textDecoder.decode(new Uint8Array(mem.buffer, namePtr >>> 0, nameLen >>> 0));
        if (name === 'sha256') {
          // `abi::sha256(Vec<u8>)` serializes `Vec<u8>` into A[0..argLen].
          // In 32-bit rkyv, ArchivedVec<u8> is at the last 8 bytes: [rel_ptr: i32, len: u32],
          // and the vector's raw bytes start at A[0..vecLen].
          const len = argLen >>> 0;
          const vecLen = len >= 4
            ? new DataView(mem.buffer, ofs + len - 4, 4).getUint32(0, true)
            : 0;
          const payload = new Uint8Array(mem.buffer, ofs, vecLen);
          const digest = sha256Sync(payload);
          new Uint8Array(mem.buffer, ofs, 32).set(digest);
          return 32;
        }
        throw new DuskVmPanic(`Unsupported host query: ${name}`);
      },
      c: (contractIdPtr, fnNamePtr, fnNameLen, fnArgLen, _gasLimit) => {
        const mem = getMem();
        const ofs = getArgBufOffset();
        const targetId = bytesToHex(new Uint8Array(mem.buffer, contractIdPtr >>> 0, 32));
        const fnName = textDecoder.decode(new Uint8Array(mem.buffer, fnNamePtr >>> 0, fnNameLen >>> 0));
        const callArgs = new Uint8Array(mem.buffer, ofs, fnArgLen >>> 0).slice();
        const retBytes = this._invokeContractRaw(targetId, fnName, callArgs);
        new Uint8Array( getMem().buffer, ofs, retBytes.length).set(retBytes);
        return retBytes.length;
      },
    };

    instanceRef = new WebAssembly.Instance(mod, {env});
    this.contracts.set(id, {
      id,
      instance: instanceRef,
      getMem,
      getArgBufOffset,
    });
  }

  _invokeContractRaw(contractIdHex, fnName, argBytes) {
    const id = contractIdHex.toLowerCase().replace(/^0x/, '');
    const entry = this.contracts.get(id);
    if (!entry) {
      throw new DuskVmPanic(`Unknown contract ID: ${id}`);
    }
    const fn = entry.instance.exports[fnName];
    if (typeof fn !== 'function') {
      throw new DuskVmPanic(`Contract ${id} has no public function "${fnName}"`);
    }
    const ofs = entry.getArgBufOffset();
    const bytes = argBytes instanceof Uint8Array ? argBytes : new Uint8Array(argBytes);
    new Uint8Array(entry.getMem().buffer, ofs, bytes.length).set(bytes);
    const retLen = fn(bytes.length) >>> 0;
    return new Uint8Array(entry.getMem().buffer, entry.getArgBufOffset(), retLen).slice();
  }

  snapshot() {
    const snap = new Map();
    for (const [id, entry] of this.contracts.entries()) {
      snap.set(id, new Uint8Array(entry.getMem().buffer).slice());
    }
    return snap;
  }

  restore(snap) {
    for (const [id, saved] of snap.entries()) {
      const entry = this.contracts.get(id);
      if (entry) {
        new Uint8Array(entry.getMem().buffer).set(saved);
      }
    }
  }

  callRaw({contract, fn, argBytes, sender = null, height = 1, query = false}) {
    const snap = this.snapshot();
    const prevSender = this.currentSender;
    const prevHeight = this.currentHeight;
    this.currentSender = sender;
    this.currentHeight = BigInt(height);
    this.activeEvents = [];

    try {
      const outBytes = this._invokeContractRaw(contract, fn, argBytes);
      const events = this.activeEvents.slice();
      if (query) {
        this.restore(snap);
      }
      return {
        ok: true,
        data: bytesToHex(outBytes),
        rawBytes: outBytes,
        events,
      };
    } catch (err) {
      this.restore(snap);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        events: [],
      };
    } finally {
      this.currentSender = prevSender;
      this.currentHeight = prevHeight;
      this.activeEvents = [];
    }
  }
}
