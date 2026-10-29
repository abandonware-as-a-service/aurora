// Loads a Dusk Forge WASM data-driver and exposes its encode/decode/schema functions.
import {readFileSync} from 'node:fs';

export function loadDriver(pathOrBytes) {
  const bytes = typeof pathOrBytes === 'string' || pathOrBytes instanceof URL
    ? readFileSync(pathOrBytes)
    : pathOrBytes;
  const e = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
  e.init();
  const put = data => {
    const p = e.alloc(data.length);
    new Uint8Array(e.memory.buffer, p, data.length).set(data);
    return [p, data.length];
  };
  const text = s => new TextEncoder().encode(s);
  const call = (fn, ...inputs) => {
    const size = 1 << 16, out = e.alloc(size);
    const code = e[fn](...inputs.flatMap(put), out, size);
    const read = at => new Uint8Array(e.memory.buffer).slice(
      at + 4,
      at + 4 + new DataView(e.memory.buffer).getUint32(at, true)
    );
    if (code !== 0) {
      e.get_last_error(out, size);
      throw Error(new TextDecoder().decode(read(out)));
    }
    return read(out);
  };
  return {
    encodeInput: (fn, jsonText) => call('encode_input_fn', text(fn), text(jsonText)),
    decodeInput: (fn, rkyvBytes) => JSON.parse(new TextDecoder().decode(call('decode_input_fn', text(fn), rkyvBytes))),
    decodeOutputRaw: (fn, rkyvBytes) => new TextDecoder().decode(call('decode_output_fn', text(fn), rkyvBytes)),
    decodeOutput: (fn, rkyvBytes) => JSON.parse(new TextDecoder().decode(call('decode_output_fn', text(fn), rkyvBytes))),
    decodeEvent: (topic, rkyvBytes) => JSON.parse(new TextDecoder().decode(call('decode_event', text(topic), rkyvBytes))),
    schema: () => JSON.parse(new TextDecoder().decode(call('get_schema'))),
  };
}
