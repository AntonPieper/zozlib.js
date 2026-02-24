// @ts-check

/**
 * SharedBinaryChannel
 * -------------------
 * Single-producer / single-consumer (SPSC) byte ring in a SharedArrayBuffer.
 *
 * Message protocol:
 *   message := frame(prefixVarint(totalLen), more = totalLen>0) + frames(payloadChunks..., more flag)
 *
 * Frame encoding in ring (contiguous):
 *   header := uLEB128( (payloadLen << 1) | moreBit )
 *   payload := payloadLen bytes
 *
 * Wrap/padding marker (forces next frame to start at ring index 0):
 *   header value == 1  (payloadLen=0, moreBit=1) written at current position,
 *   and the writer advances W to the next ring boundary (consumes remaining bytes to end).
 *
 * Notes:
 * - "NO LIMITS" here means: no protocol limit vs ring capacity (messages can exceed CAP via chunking).
 *   Practical limits are JS typed array limits and available memory.
 * - Blocking methods (read/write) use Atomics.wait (works in Workers; not on main thread).
 * - Async methods (readAsync/writeAsync) use Atomics.waitAsync if available, else a safe fallback.
 */

/** @typedef {"writer"|"reader"|"both"} ChannelRole */

/**
 * @typedef {object} SharedBinaryChannelOptions
 * @property {SharedArrayBuffer} sab
 * @property {ChannelRole=} role
 * @property {number=} dataOffsetBytes  Byte offset where the ring begins (default: 128)
 * @property {number=} maxChunkBytes    Max payload bytes per frame (default: min(64KiB, cap-32))
 */

/** @typedef {object} FrameView
 * @property {Uint8Array} payload
 * @property {boolean} more
 * @property {number} nextR
 */

const CTRL_BYTES_DEFAULT = 128;
const DATA_OFFSET_DEFAULT = CTRL_BYTES_DEFAULT;

// Int32 indices (padded to reduce false sharing):
const R_IDX = 0; // read cursor (bytes consumed)
const W_IDX = 16; // write cursor (bytes produced)

// Smallest possible prefix varint bytes for uint32 length is <= 5,
// but we allow up to 10 bytes so the encoder can be trivially extended.
const VARINT_SCRATCH_BYTES = 10;

/**
 * @param {number} x
 * @returns {boolean}
 */
function isPowerOfTwo(x) {
    return x > 0 && (x & (x - 1)) === 0;
}

/**
 * uLEB128 size for uint32.
 * @param {number} x
 * @returns {number}
 */
function ulebSize32(x) {
    x >>>= 0;
    let n = 1;
    while (x >= 0x80) {
        x >>>= 7;
        n++;
    }
    return n;
}

/**
 * Encode uint32 uLEB128 into `out[0..]`.
 * @param {number} x
 * @param {Uint8Array} out
 * @returns {number} bytes written
 */
function ulebWrite32(x, out) {
    x >>>= 0;
    let i = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const b = x & 0x7f;
        x >>>= 7;
        if (x === 0) {
            out[i] = b;
            return i + 1;
        }
        out[i] = b | 0x80;
        i++;
    }
}

/**
 * Decode uint32 uLEB128 from a *contiguous* byte slice.
 * @param {Uint8Array} src
 * @returns {{ value: number, bytes: number }}
 */
function ulebRead32(src) {
    let x = 0 >>> 0;
    let shift = 0;
    let i = 0;
    while (i < src.length) {
        const b = src[i];
        x |= ((b & 0x7f) << shift) >>> 0;
        i++;
        if ((b & 0x80) === 0) return { value: x >>> 0, bytes: i };
        shift += 7;
        if (shift > 35) throw new Error("uLEB128 too long");
    }
    throw new Error("uLEB128 truncated");
}

/**
 * A tiny, typed Promise-based tick used only as a fallback
 * when Atomics.waitAsync is unavailable.
 * @returns {Promise<void>}
 */
function tick() {
    /** @type {(resolve: () => void) => void} */
    const exec = (resolve) => {
        setTimeout(resolve, 0);
    };
    return new Promise(exec);
}

/**
 * Await until ctrl[idx] != expected.
 * Uses Atomics.waitAsync if available.
 * @param {Int32Array} ctrl
 * @param {number} idx
 * @param {number} expectedI32
 * @returns {Promise<void>}
 */
async function waitI32NotEqualAsync(ctrl, idx, expectedI32) {
    // Prefer waitAsync if available (no polling, no postMessage).
    const wa = /** @type {unknown} */ (Atomics.waitAsync);
    if (typeof wa === "function") {
        // Different engines historically returned either:
        // - Promise<string>
        // - { async: boolean, value: string | Promise<string> }
        /** @type {any} */
        const res = Atomics.waitAsync(ctrl, idx, expectedI32);

        // Case 1: Promise-like
        if (res && typeof res.then === "function") {
            await /** @type {Promise<unknown>} */ (res);
            return;
        }

        // Case 2: object { async, value }
        if (res && typeof res === "object" && "async" in res && "value" in res) {
            const asyncFlag = /** @type {{async: boolean}} */ (res).async;
            const valueField = /** @type {{value: unknown}} */ (res).value;
            if (asyncFlag) {
                await /** @type {Promise<unknown>} */ (valueField);
            }
            return;
        }

        // If a weird shape: fall through to safe fallback.
    }

    // Fallback: yield until changed (still correct, just less efficient).
    // (No postMessage used; still "SAB + Atomics" for state.)
    // eslint-disable-next-line no-unmodified-loop-condition
    while (Atomics.load(ctrl, idx) === expectedI32) {
        await tick();
    }
}

/**
 * SharedBinaryChannel (SPSC, one direction)
 */
export class SharedBinaryChannel {
    /** @type {ChannelRole} */ #role;
    /** @type {Int32Array} */ #ctrl;
    /** @type {Uint8Array} */ #ring;
    /** @type {number} */ #cap;
    /** @type {number} */ #mask;
    /** @type {number} */ #maxChunk;
    /** @type {Uint8Array} */ #scratchVarint;

    /**
     * Create a SharedArrayBuffer sized for one channel.
     * Control is 128 bytes; ring is `capacityBytes` (must be power of two).
     *
     * @param {number} capacityBytes
     * @returns {SharedArrayBuffer}
     */
    static createSharedBuffer(capacityBytes) {
        if (!isPowerOfTwo(capacityBytes)) {
            throw new Error("capacityBytes must be a power of two");
        }
        if (capacityBytes < 64) {
            throw new Error("capacityBytes too small (need at least 64)");
        }
        return new SharedArrayBuffer(CTRL_BYTES_DEFAULT + capacityBytes);
    }

    /**
     * @param {SharedBinaryChannelOptions} opts
     */
    constructor(opts) {
        const dataOffsetBytes = opts.dataOffsetBytes ?? DATA_OFFSET_DEFAULT;
        if ((dataOffsetBytes & 3) !== 0) {
            throw new Error("dataOffsetBytes must be 4-byte aligned");
        }

        const cap = opts.sab.byteLength - dataOffsetBytes;
        if (!isPowerOfTwo(cap)) {
            throw new Error(
                "Ring capacity (sab.byteLength - dataOffsetBytes) must be power of two"
            );
        }
        if (cap < 64) throw new Error("Ring capacity too small");

        this.#role = opts.role ?? "both";
        this.#ctrl = new Int32Array(opts.sab, 0, dataOffsetBytes >>> 2);
        this.#ring = new Uint8Array(opts.sab, dataOffsetBytes, cap);
        this.#cap = cap >>> 0;
        this.#mask = (cap - 1) >>> 0;
        this.#scratchVarint = new Uint8Array(VARINT_SCRATCH_BYTES);

        const defaultMax = Math.min(64 * 1024, Math.max(1, cap - 32));
        const maxChunk = opts.maxChunkBytes ?? defaultMax;
        if (maxChunk <= 0) throw new Error("maxChunkBytes must be > 0");
        if (maxChunk >= cap) throw new Error("maxChunkBytes must be < ring capacity");
        this.#maxChunk = maxChunk >>> 0;
    }

    /**
     * Blocking write (Worker only): writes one full message (any size) by chunking.
     * @param {Uint8Array} data
     * @returns {void}
     */
    write(data) {
        if (this.#role === "reader") throw new Error("Channel role is reader; cannot write()");
        this.#assertCanBlock();

        const totalLen = data.byteLength >>> 0;

        // Prefix frame: varint(totalLen)
        const prefixN = ulebWrite32(totalLen, this.#scratchVarint);
        const prefixPayload = this.#scratchVarint.subarray(0, prefixN);
        this.#writeFrameSync(prefixPayload, totalLen !== 0);

        // Payload frames
        let off = 0;
        while (off < totalLen) {
            const n = Math.min(this.#maxChunk, totalLen - off) >>> 0;
            const more = off + n < totalLen;
            this.#writeFrameSync(data.subarray(off, off + n), more);
            off += n;
        }
    }

    /**
     * Async write (Main thread friendly): writes one full message (any size) by chunking.
     * @param {Uint8Array} data
     * @returns {Promise<void>}
     */
    async writeAsync(data) {
        if (this.#role === "reader") throw new Error("Channel role is reader; cannot writeAsync()");
        const totalLen = data.byteLength >>> 0;

        // Prefix frame: varint(totalLen)
        const prefixN = ulebWrite32(totalLen, this.#scratchVarint);
        const prefixPayload = this.#scratchVarint.subarray(0, prefixN);
        await this.#writeFrameAsync(prefixPayload, totalLen !== 0);

        // Payload frames
        let off = 0;
        while (off < totalLen) {
            const n = Math.min(this.#maxChunk, totalLen - off) >>> 0;
            const more = off + n < totalLen;
            await this.#writeFrameAsync(data.subarray(off, off + n), more);
            off += n;
        }
    }

    /**
     * Blocking read (Worker only): reads one full message and returns it as a new Uint8Array.
     * @returns {Uint8Array}
     */
    read() {
        if (this.#role === "writer") throw new Error("Channel role is writer; cannot read()");
        this.#assertCanBlock();

        // 1) Read prefix frame and decode total length.
        const prefix = this.#readFrameViewSync();
        const { value: totalLen } = ulebRead32(prefix.payload);
        Atomics.store(this.#ctrl, R_IDX, prefix.nextR | 0);
        Atomics.notify(this.#ctrl, R_IDX, 1);

        const out = new Uint8Array(totalLen);
        if (totalLen === 0) return out;

        // 2) Read payload frames until filled.
        let dstOff = 0;
        while (dstOff < totalLen) {
            const fr = this.#readFrameViewSync();
            const n = fr.payload.byteLength >>> 0;
            if (dstOff + n > totalLen) {
                throw new Error("Protocol error: payload exceeds declared length");
            }

            out.set(fr.payload, dstOff);
            dstOff += n;

            Atomics.store(this.#ctrl, R_IDX, fr.nextR | 0);
            Atomics.notify(this.#ctrl, R_IDX, 1);

            if (!fr.more && dstOff !== totalLen) {
                throw new Error("Protocol error: message ended early");
            }
            if (!fr.more && dstOff === totalLen) break;
        }
        return out;
    }

    /**
     * Async read (Main thread friendly): reads one full message and returns it.
     * @returns {Promise<Uint8Array>}
     */
    async readAsync() {
        if (this.#role === "writer") throw new Error("Channel role is writer; cannot readAsync()");

        // 1) Read prefix frame.
        const prefix = await this.#readFrameViewAsync();
        const { value: totalLen } = ulebRead32(prefix.payload);
        Atomics.store(this.#ctrl, R_IDX, prefix.nextR | 0);
        Atomics.notify(this.#ctrl, R_IDX, 1);

        const out = new Uint8Array(totalLen);
        if (totalLen === 0) return out;

        // 2) Read payload frames until filled.
        let dstOff = 0;
        while (dstOff < totalLen) {
            const fr = await this.#readFrameViewAsync();
            const n = fr.payload.byteLength >>> 0;
            if (dstOff + n > totalLen) {
                throw new Error("Protocol error: payload exceeds declared length");
            }

            out.set(fr.payload, dstOff);
            dstOff += n;

            Atomics.store(this.#ctrl, R_IDX, fr.nextR | 0);
            Atomics.notify(this.#ctrl, R_IDX, 1);

            if (!fr.more && dstOff !== totalLen) {
                throw new Error("Protocol error: message ended early");
            }
            if (!fr.more && dstOff === totalLen) break;
        }
        return out;
    }

    // ------------------------
    // Internal ring primitives
    // ------------------------

    /**
     * @param {number} r
     * @param {number} w
     * @returns {number}
     */
    #freeBytes(r, w) {
        const used = (w - r) >>> 0;
        return (this.#cap - used) >>> 0;
    }

    /**
     * Contiguous bytes from absolute position to ring end.
     * @param {number} pos
     * @returns {number}
     */
    #contiguousToEnd(pos) {
        return (this.#cap - (pos & this.#mask)) >>> 0;
    }

    /**
     * Writes a single frame (payload + header), blocking with Atomics.wait if needed.
     * @param {Uint8Array} payload
     * @param {boolean} more
     * @returns {void}
     */
    #writeFrameSync(payload, more) {
        const len = payload.byteLength >>> 0;
        const headerVal = (((len << 1) >>> 0) | (more ? 1 : 0)) >>> 0;
        const hb = ulebSize32(headerVal) >>> 0;
        const need = (hb + len) >>> 0;

        if (need >= this.#cap) {
            throw new Error("Frame too large for ring; reduce maxChunkBytes or increase capacity");
        }

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const r = Atomics.load(this.#ctrl, R_IDX) >>> 0;
            const w = Atomics.load(this.#ctrl, W_IDX) >>> 0;

            const cte = this.#contiguousToEnd(w);
            if (cte < need) {
                // Need to pad to end with wrap marker; consume `cte` bytes.
                if (this.#freeBytes(r, w) < cte) {
                    Atomics.wait(this.#ctrl, R_IDX, r | 0);
                    continue;
                }
                // Write wrap marker header value == 1 at start of padding.
                this.#ring[w & this.#mask] = 1;
                const newW = (w + cte) >>> 0;
                Atomics.store(this.#ctrl, W_IDX, newW | 0);
                Atomics.notify(this.#ctrl, W_IDX, 1);
                continue;
            }

            if (this.#freeBytes(r, w) < need) {
                Atomics.wait(this.#ctrl, R_IDX, r | 0);
                continue;
            }

            // Write header (contiguous by construction).
            const wp = (w & this.#mask) >>> 0;
            let x = headerVal >>> 0;
            let i = 0;
            while (true) {
                const b = x & 0x7f;
                x >>>= 7;
                if (x === 0) {
                    this.#ring[wp + i] = b;
                    i++;
                    break;
                }
                this.#ring[wp + i] = b | 0x80;
                i++;
            }

            // Write payload
            this.#ring.set(payload, wp + hb);

            const newW = (w + need) >>> 0;
            Atomics.store(this.#ctrl, W_IDX, newW | 0);

            // Notify only if previously empty (micro-opt).
            if (r === w) Atomics.notify(this.#ctrl, W_IDX, 1);
            return;
        }
    }

    /**
     * Writes a single frame (payload + header), awaiting if needed (main-thread friendly).
     * @param {Uint8Array} payload
     * @param {boolean} more
     * @returns {Promise<void>}
     */
    async #writeFrameAsync(payload, more) {
        const len = payload.byteLength >>> 0;
        const headerVal = (((len << 1) >>> 0) | (more ? 1 : 0)) >>> 0;
        const hb = ulebSize32(headerVal) >>> 0;
        const need = (hb + len) >>> 0;

        if (need >= this.#cap) {
            throw new Error("Frame too large for ring; reduce maxChunkBytes or increase capacity");
        }

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const r = Atomics.load(this.#ctrl, R_IDX) >>> 0;
            const w = Atomics.load(this.#ctrl, W_IDX) >>> 0;

            const cte = this.#contiguousToEnd(w);
            if (cte < need) {
                if (this.#freeBytes(r, w) < cte) {
                    await waitI32NotEqualAsync(this.#ctrl, R_IDX, r | 0);
                    continue;
                }
                this.#ring[w & this.#mask] = 1;
                const newW = (w + cte) >>> 0;
                Atomics.store(this.#ctrl, W_IDX, newW | 0);
                Atomics.notify(this.#ctrl, W_IDX, 1);
                continue;
            }

            if (this.#freeBytes(r, w) < need) {
                await waitI32NotEqualAsync(this.#ctrl, R_IDX, r | 0);
                continue;
            }

            const wp = (w & this.#mask) >>> 0;
            let x = headerVal >>> 0;
            let i = 0;
            while (true) {
                const b = x & 0x7f;
                x >>>= 7;
                if (x === 0) {
                    this.#ring[wp + i] = b;
                    i++;
                    break;
                }
                this.#ring[wp + i] = b | 0x80;
                i++;
            }

            this.#ring.set(payload, wp + hb);

            const newW = (w + need) >>> 0;
            Atomics.store(this.#ctrl, W_IDX, newW | 0);
            if (r === w) Atomics.notify(this.#ctrl, W_IDX, 1);
            return;
        }
    }

    /**
     * Reads the next frame view (payload is a view into shared ring),
     * handling wrap marker internally. Blocking (Atomics.wait).
     * The caller must copy payload before advancing R if it needs persistence.
     * @returns {FrameView}
     */
    #readFrameViewSync() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const r = Atomics.load(this.#ctrl, R_IDX) >>> 0;
            const w = Atomics.load(this.#ctrl, W_IDX) >>> 0;
            if (r === w) {
                Atomics.wait(this.#ctrl, W_IDX, w | 0);
                continue;
            }

            const rp = (r & this.#mask) >>> 0;
            const cte = this.#contiguousToEnd(r);

            // Decode header (contiguous; writer guarantees frame fits).
            let hv = 0 >>> 0;
            let shift = 0;
            let hb = 0;
            while (hb < cte) {
                const b = this.#ring[rp + hb];
                hv |= ((b & 0x7f) << shift) >>> 0;
                hb++;
                if ((b & 0x80) === 0) break;
                shift += 7;
                if (shift > 35) throw new Error("Header uLEB too long");
            }

            const payloadLen = (hv >>> 1) >>> 0;
            const more = (hv & 1) !== 0;

            // Wrap marker: hv==1 => payloadLen=0 & more=1
            if (payloadLen === 0 && more) {
                const newR = (r + cte) >>> 0; // skip to next boundary
                Atomics.store(this.#ctrl, R_IDX, newR | 0);
                Atomics.notify(this.#ctrl, R_IDX, 1);
                continue;
            }

            const need = (hb + payloadLen) >>> 0;
            const payloadStart = rp + hb;
            const payload = this.#ring.subarray(payloadStart, payloadStart + payloadLen);
            const nextR = (r + need) >>> 0;

            return { payload, more, nextR };
        }
    }

    /**
     * Reads the next frame view (payload is a view into shared ring),
     * handling wrap marker internally. Async wait (Atomics.waitAsync if available).
     * @returns {Promise<FrameView>}
     */
    async #readFrameViewAsync() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const r = Atomics.load(this.#ctrl, R_IDX) >>> 0;
            const w = Atomics.load(this.#ctrl, W_IDX) >>> 0;
            if (r === w) {
                await waitI32NotEqualAsync(this.#ctrl, W_IDX, w | 0);
                continue;
            }

            const rp = (r & this.#mask) >>> 0;
            const cte = this.#contiguousToEnd(r);

            let hv = 0 >>> 0;
            let shift = 0;
            let hb = 0;
            while (hb < cte) {
                const b = this.#ring[rp + hb];
                hv |= ((b & 0x7f) << shift) >>> 0;
                hb++;
                if ((b & 0x80) === 0) break;
                shift += 7;
                if (shift > 35) throw new Error("Header uLEB too long");
            }

            const payloadLen = (hv >>> 1) >>> 0;
            const more = (hv & 1) !== 0;

            if (payloadLen === 0 && more) {
                const newR = (r + cte) >>> 0;
                Atomics.store(this.#ctrl, R_IDX, newR | 0);
                Atomics.notify(this.#ctrl, R_IDX, 1);
                continue;
            }

            const need = (hb + payloadLen) >>> 0;
            const payloadStart = rp + hb;
            const payload = this.#ring.subarray(payloadStart, payloadStart + payloadLen);
            const nextR = (r + need) >>> 0;

            return { payload, more, nextR };
        }
    }

    /**
     * Throws if Atomics.wait cannot be used (e.g. main thread).
     * @returns {void}
     */
    #assertCanBlock() {
        // Atomics.wait is generally disallowed on the main thread.
        // This runtime check keeps the API honest.
        if (typeof Atomics.wait !== "function") {
            throw new Error("Atomics.wait unavailable; use async methods instead");
        }
        // Heuristic: document exists => likely main thread.
        if (typeof document !== "undefined") {
            throw new Error(
                "Blocking methods not allowed on main thread; use readAsync/writeAsync"
            );
        }
    }
}
