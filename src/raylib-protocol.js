// @ts-check

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
