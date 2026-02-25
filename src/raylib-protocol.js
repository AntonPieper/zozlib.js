/** @enum {typeof MainCommandType[keyof typeof MainCommandType]} */
export const MainCommandType = /** @type {const} **/ ({
    Frame: 1,
    KeyDown: 2,
    KeyUp: 3,
    MouseWheel: 4,
    MouseMove: 5,
    Stop: 6,
});

/**
 * @typedef {{ type: typeof MainCommandType.Frame, timestamp: number }
 * | { type: typeof MainCommandType.KeyDown, key: number }
 * | { type: typeof MainCommandType.KeyUp, key: number }
 * | { type: typeof MainCommandType.MouseWheel, delta: number }
 * | { type: typeof MainCommandType.MouseMove, x: number, y: number }
 * | { type: typeof MainCommandType.Stop }} MainCommand
 */

/**
 * @typedef {{ type: "ready" }
 *   | { type: "title", value: string }
 *   | { type: "frame", bitmap: ImageBitmap }
 *   | { type: "error", value: string }} WorkerMessage
 */

/** @param {number} timestamp */
export function encodeFrameCommand(timestamp) {
    const bytes = new Uint8Array(1 + 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(0, MainCommandType.Frame);
    view.setFloat64(1, timestamp, true);
    return bytes;
}
/** @param {number} key */
export function encodeKeyDownCommand(key) {
    const bytes = new Uint8Array(1 + 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(0, MainCommandType.KeyDown);
    view.setUint16(1, key, true);
    return bytes;
}
/** @param {number} key */
export function encodeKeyUpCommand(key) {
    const bytes = new Uint8Array(1 + 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(0, MainCommandType.KeyUp);
    view.setUint16(1, key, true);
    return bytes;
}
/** @param {number} delta */
export function encodeMouseWheelCommand(delta) {
    const bytes = new Uint8Array(1 + 1);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(0, MainCommandType.MouseWheel);
    view.setInt8(1, delta);
    return bytes;
}
/** @param {number} x @param {number} y */
export function encodeMouseMoveCommand(x, y) {
    const bytes = new Uint8Array(1 + 4 + 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(0, MainCommandType.MouseMove);
    view.setFloat32(1, x, true);
    view.setFloat32(5, y, true);
    return bytes;
}
export function encodeStopCommand() {
    return new Uint8Array([MainCommandType.Stop]);
}

/** @param {Uint8Array} bytes @returns {MainCommand} */
export function decodeMainCommand(bytes) {
    if (bytes.byteLength < 1) {
        throw new Error("Empty command payload");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint8(0);
    switch (type) {
        case MainCommandType.Frame:
            if (bytes.byteLength !== 9) throw new Error("Invalid frame command size");
            return { type: MainCommandType.Frame, timestamp: view.getFloat64(1, true) };
        case MainCommandType.KeyDown:
            if (bytes.byteLength !== 3) throw new Error("Invalid keydown command size");
            return { type: MainCommandType.KeyDown, key: view.getUint16(1, true) };
        case MainCommandType.KeyUp:
            if (bytes.byteLength !== 3) throw new Error("Invalid keyup command size");
            return { type: MainCommandType.KeyUp, key: view.getUint16(1, true) };
        case MainCommandType.MouseWheel:
            if (bytes.byteLength !== 2) throw new Error("Invalid wheel command size");
            return { type: MainCommandType.MouseWheel, delta: view.getInt8(1) };
        case MainCommandType.MouseMove:
            if (bytes.byteLength !== 9) throw new Error("Invalid mouse move command size");
            return {
                type: MainCommandType.MouseMove,
                x: view.getFloat32(1, true),
                y: view.getFloat32(5, true),
            };
        case MainCommandType.Stop:
            if (bytes.byteLength !== 1) throw new Error("Invalid stop command size");
            return { type: MainCommandType.Stop };
        default:
            throw new Error(`Unknown command type: ${type}`);
    }
}

/** @enum {typeof BridgeRequestType[keyof typeof BridgeRequestType]} */
export const BridgeRequestType = /** @type {const} **/ ({
    LoadImage: 1,
});

/** @enum {typeof BridgeResponseType[keyof typeof BridgeResponseType]} */
export const BridgeResponseType = /** @type {const} **/ ({
    LoadImageOk: 1,
    Error: 255,
});

/**
 * @typedef {{ type: typeof BridgeRequestType.LoadImage, source: string }} BridgeRequest
 */

/**
 * @typedef {{ type: typeof BridgeResponseType.LoadImageOk, width: number, height: number, pixels: Uint8Array }
 *   | { type: typeof BridgeResponseType.Error, message: string }} BridgeResponse
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** @param {string} value */
function encodeUtf8WithLength(value) {
    const bytes = utf8Encoder.encode(value);
    const out = new Uint8Array(4 + bytes.byteLength);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(0, bytes.byteLength, true);
    out.set(bytes, 4);
    return out;
}

/** @param {DataView} view @param {number} offset */
function decodeUtf8WithLength(view, offset) {
    if (offset + 4 > view.byteLength) {
        throw new Error("Invalid UTF-8 field size");
    }
    const length = view.getUint32(offset, true);
    const start = offset + 4;
    const end = start + length;
    if (end > view.byteLength) {
        throw new Error("Invalid UTF-8 field payload");
    }
    const bytes = new Uint8Array(view.buffer, view.byteOffset + start, length);
    return {
        value: utf8Decoder.decode(bytes),
        nextOffset: end,
    };
}

/** @param {string} source */
export function encodeBridgeRequestLoadImage(source) {
    const sourceField = encodeUtf8WithLength(source);
    const bytes = new Uint8Array(1 + sourceField.byteLength);
    bytes[0] = BridgeRequestType.LoadImage;
    bytes.set(sourceField, 1);
    return bytes;
}

/** @param {Uint8Array} bytes @returns {BridgeRequest} */
export function decodeBridgeRequest(bytes) {
    if (bytes.byteLength < 1) {
        throw new Error("Empty bridge request payload");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint8(0);
    switch (type) {
        case BridgeRequestType.LoadImage: {
            const { value: source, nextOffset } = decodeUtf8WithLength(view, 1);
            if (nextOffset !== bytes.byteLength) {
                throw new Error("Unexpected trailing data in bridge load-image request");
            }
            return {
                type: BridgeRequestType.LoadImage,
                source,
            };
        }
        default:
            throw new Error(`Unknown bridge request type: ${type}`);
    }
}

/** @param {number} width @param {number} height @param {Uint8Array} pixels */
export function encodeBridgeResponseLoadImageOk(width, height, pixels) {
    const bytes = new Uint8Array(1 + 4 + 4 + pixels.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint8(0, BridgeResponseType.LoadImageOk);
    view.setUint32(1, width, true);
    view.setUint32(5, height, true);
    bytes.set(pixels, 9);
    return bytes;
}

/** @param {string} message */
export function encodeBridgeResponseError(message) {
    const messageField = encodeUtf8WithLength(message);
    const bytes = new Uint8Array(1 + messageField.byteLength);
    bytes[0] = BridgeResponseType.Error;
    bytes.set(messageField, 1);
    return bytes;
}

/** @param {Uint8Array} bytes @returns {BridgeResponse} */
export function decodeBridgeResponse(bytes) {
    if (bytes.byteLength < 1) {
        throw new Error("Empty bridge response payload");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint8(0);
    switch (type) {
        case BridgeResponseType.LoadImageOk: {
            if (bytes.byteLength < 9) {
                throw new Error("Invalid bridge load-image response size");
            }
            const width = view.getUint32(1, true);
            const height = view.getUint32(5, true);
            const pixels = bytes.subarray(9);
            const expectedPixelsLength = width * height * 4;
            if (pixels.byteLength !== expectedPixelsLength) {
                throw new Error("Invalid bridge load-image response payload length");
            }
            return {
                type: BridgeResponseType.LoadImageOk,
                width,
                height,
                pixels,
            };
        }
        case BridgeResponseType.Error: {
            const { value: message, nextOffset } = decodeUtf8WithLength(view, 1);
            if (nextOffset !== bytes.byteLength) {
                throw new Error("Unexpected trailing data in bridge error response");
            }
            return {
                type: BridgeResponseType.Error,
                message,
            };
        }
        default:
            throw new Error(`Unknown bridge response type: ${type}`);
    }
}
