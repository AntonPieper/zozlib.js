// @ts-check
import { SharedBinaryChannel } from "./channel.js";
import {
    encodeFrameCommand,
    encodeKeyDownCommand,
    encodeKeyUpCommand,
    encodeMouseMoveCommand,
    encodeMouseWheelCommand,
    encodeStopCommand,
} from "./raylib-protocol.js";

/**
 * @typedef {Object} WorkerInitMessage
 * @property {"init"} type
 * @property {string} wasmPath
 * @property {OffscreenCanvas} canvas
 * @property {SharedArrayBuffer} channelSab
 */

/**
 * @typedef {Object} StartOptions
 * @property {URL} wasmPath
 * @property {string} canvasId
 */

const CHANNEL_CAPACITY = 1 << 20;
export class RaylibJs {
    /** @type {Worker | null} */
    worker = null;
    /** @type {SharedBinaryChannel | null} */
    channel = null;
    /** @type {Promise<void>} */
    commandQueue = Promise.resolve();
    /** @type {number | null} */
    rafHandle = null;
    running = false;
    /** @type {(() => void) | null} */
    detachedInputs = null;
    /** @type {Set<string>} */
    transferredCanvasIds = new Set();
    /** @param {number} timestamp */
    onFrame = (timestamp) => {
        if (!this.running) {
            return;
        }
        void this.enqueueCommand(encodeFrameCommand(timestamp));
        this.rafHandle = window.requestAnimationFrame(this.onFrame);
    };
    /** @param {StartOptions} options */
    async start({ wasmPath, canvasId }) {
        this.stop();
        if (typeof SharedArrayBuffer === "undefined") {
            throw new Error(
                "SharedArrayBuffer is unavailable. Check cross-origin isolation headers."
            );
        }
        const canvas = this.acquireCanvas(canvasId);
        if (typeof canvas.transferControlToOffscreen !== "function") {
            throw new Error("OffscreenCanvas is unavailable in this browser");
        }
        const offscreen = canvas.transferControlToOffscreen();
        this.transferredCanvasIds.add(canvasId);
        const channelSab = new SharedArrayBuffer(128 + CHANNEL_CAPACITY);
        this.channel = new SharedBinaryChannel({
            sab: channelSab,
        });
        const worker = new Worker(new URL("./raylib.worker.js", import.meta.url), {
            type: "module",
        });
        this.worker = worker;
        /** @type {Promise<void>} */
        const workerReady = new Promise((resolve, reject) => {
            /** @param {MessageEvent<{ type: string; value?: string }>} event */
            const onMessage = (event) => {
                const message = event.data;
                if (message.type === "ready") {
                    resolve();
                    return;
                }
                if (message.type === "title") {
                    document.title = message.value ?? "Raylib.js Example";
                    return;
                }
                if (message.type === "error") {
                    reject(new Error(message.value));
                }
            };
            const onError = () => {
                reject(new Error("Worker terminated unexpectedly"));
            };
            worker.addEventListener("message", onMessage);
            worker.addEventListener("error", onError, { once: true });
        });
        /** @type {WorkerInitMessage} */
        const initMessage = {
            type: "init",
            wasmPath: wasmPath.href,
            canvas: offscreen,
            channelSab,
        };
        worker.postMessage(initMessage, [offscreen]);
        await workerReady;
        this.attachInputListeners(canvas);
        this.running = true;
        this.rafHandle = window.requestAnimationFrame(this.onFrame);
    }
    stop() {
        if (!this.worker && !this.running) {
            return;
        }
        this.running = false;
        if (this.rafHandle !== null) {
            window.cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
        this.detachedInputs?.();
        this.detachedInputs = null;
        const worker = this.worker;
        const channel = this.channel;
        if (worker !== null && channel !== null) {
            this.commandQueue = this.commandQueue
                .then(() => channel.writeAsync(encodeStopCommand()))
                .catch(() => undefined)
                .finally(() => {
                    worker.terminate();
                });
        } else {
            worker?.terminate();
        }
        this.worker = null;
        this.channel = null;
        this.commandQueue = Promise.resolve();
    }
    /** @param {Uint8Array} command */
    enqueueCommand(command) {
        const channel = this.channel;
        if (channel === null) {
            return Promise.resolve();
        }
        this.commandQueue = this.commandQueue.then(() => channel.writeAsync(command));
        return this.commandQueue;
    }
    /** @param {HTMLCanvasElement} canvas */
    attachInputListeners(canvas) {
        this.detachedInputs?.();
        /** @param {KeyboardEvent} event */
        const keyDown = (event) => {
            const key = glfwKeyMapping[event.code];
            if (key !== undefined) {
                void this.enqueueCommand(encodeKeyDownCommand(key));
            }
        };
        /** @param {KeyboardEvent} event */
        const keyUp = (event) => {
            const key = glfwKeyMapping[event.code];
            if (key !== undefined) {
                void this.enqueueCommand(encodeKeyUpCommand(key));
            }
        };
        /** @param {WheelEvent} event */
        const wheelMove = (event) => {
            const delta = Math.sign(-event.deltaY);
            if (delta !== 0) {
                void this.enqueueCommand(encodeMouseWheelCommand(delta));
            }
        };
        /** @param {MouseEvent} event */
        const mouseMove = (event) => {
            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            void this.enqueueCommand(encodeMouseMoveCommand(x, y));
        };
        window.addEventListener("keydown", keyDown);
        window.addEventListener("keyup", keyUp);
        window.addEventListener("wheel", wheelMove);
        window.addEventListener("mousemove", mouseMove);
        this.detachedInputs = () => {
            window.removeEventListener("keydown", keyDown);
            window.removeEventListener("keyup", keyUp);
            window.removeEventListener("wheel", wheelMove);
            window.removeEventListener("mousemove", mouseMove);
        };
    }

    /** @param {string} canvasId */
    acquireCanvas(canvasId) {
        const existing = document.getElementById(canvasId);
        if (!(existing instanceof HTMLCanvasElement)) {
            throw new Error(`Canvas with id '${canvasId}' was not found`);
        }
        if (!this.transferredCanvasIds.has(canvasId)) {
            return existing;
        }
        const replacement = existing.cloneNode(false);
        if (!(replacement instanceof HTMLCanvasElement)) {
            throw new Error(`Could not recreate canvas '${canvasId}'`);
        }
        existing.replaceWith(replacement);
        return replacement;
    }
}

/** @type {Record<string, number>} */
const glfwKeyMapping = {
    Space: 32,
    Quote: 39,
    Comma: 44,
    Minus: 45,
    Period: 46,
    Slash: 47,
    Semicolon: 59,
    Equal: 61,
    BracketLeft: 91,
    Backslash: 92,
    BracketRight: 93,
    Backquote: 96,
    Escape: 256,
    Enter: 257,
    Tab: 258,
    Backspace: 259,
    Insert: 260,
    Delete: 261,
    ArrowRight: 262,
    ArrowLeft: 263,
    ArrowDown: 264,
    ArrowUp: 265,
    PageUp: 266,
    PageDown: 267,
    Home: 268,
    End: 269,
    CapsLock: 280,
    ScrollLock: 281,
    NumLock: 282,
    PrintScreen: 283,
    Pause: 284,
    NumpadDecimal: 330,
    NumpadDivide: 331,
    NumpadMultiply: 332,
    NumpadSubtract: 333,
    NumpadAdd: 334,
    NumpadEnter: 335,
    NumpadEqual: 336,
    ShiftLeft: 340,
    ControlLeft: 341,
    AltLeft: 342,
    MetaLeft: 343,
    ShiftRight: 344,
    ControlRight: 345,
    AltRight: 346,
    MetaRight: 347,
    ContextMenu: 348,
};
/** @type {Record<string, number>} */
const glfwKeyMappingTyped = glfwKeyMapping;
for (let digit = 0; digit <= 9; digit++) {
    glfwKeyMappingTyped[`Digit${digit}`] = 48 + digit;
    glfwKeyMappingTyped[`NumPad${digit}`] = 320 + digit;
}
for (let index = 0; index < 26; index++) {
    glfwKeyMappingTyped[`Key${String.fromCharCode(65 + index)}`] = 65 + index;
}
for (let index = 1; index <= 25; index++) {
    glfwKeyMappingTyped[`F${index}`] = 289 + index;
}
