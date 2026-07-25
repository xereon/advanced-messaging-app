// cbor.js — just enough CBOR (RFC 8949) to read WebAuthn structures:
// attestation objects and COSE keys. Decode only; no encoder needed.

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }

  byte() {
    if (this.pos >= this.buf.length) throw new Error('CBOR: unexpected end of input');
    return this.buf[this.pos++];
  }

  take(n) {
    if (this.pos + n > this.buf.length) throw new Error('CBOR: unexpected end of input');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Argument encoded in the low 5 bits of the initial byte. */
  argument(info) {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
    if (info === 26) { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
    if (info === 27) {
      const v = this.buf.readBigUInt64BE(this.pos);
      this.pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: integer too large');
      return Number(v);
    }
    throw new Error(`CBOR: unsupported additional info ${info}`);
  }

  value() {
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case 0: return this.argument(info);
      case 1: return -1 - this.argument(info);
      case 2: return Buffer.from(this.take(this.argument(info)));
      case 3: return this.take(this.argument(info)).toString('utf8');
      case 4: {
        const n = this.argument(info);
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(this.value());
        return arr;
      }
      case 5: {
        const n = this.argument(info);
        // A Map preserves integer keys, which COSE relies on.
        const map = new Map();
        for (let i = 0; i < n; i++) {
          const k = this.value();
          map.set(k, this.value());
        }
        return map;
      }
      case 6: this.argument(info); return this.value();  // tag: pass through
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error(`CBOR: unsupported simple value ${info}`);
      }
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  }
}

export function decode(buf) {
  return new Reader(Buffer.from(buf)).value();
}

/** Decode the first item and report how many bytes it consumed. */
export function decodeWithLength(buf) {
  const r = new Reader(Buffer.from(buf));
  const value = r.value();
  return { value, length: r.pos };
}
