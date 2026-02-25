// @ts-check
import { SharedBinaryChannel } from "./channel.js";
import {
    decodeBridgeRequest,
    BridgeRequestType,
    encodeBridgeResponseError,
    encodeBridgeResponseLoadImageOk,
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
 * @property {number} canvasWidth
 * @property {number} canvasHeight
 * @property {SharedArrayBuffer} commandSab
 * @property {SharedArrayBuffer} bridgeReqSab
 * @property {SharedArrayBuffer} bridgeResSab
 */
/** @typedef {import("./raylib-protocol.js").WorkerMessage} WorkerMessage */

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
    commandChannel = null;
    /** @type {SharedBinaryChannel | null} */
    bridgeReqChannel = null;
    /** @type {SharedBinaryChannel | null} */
    bridgeResChannel = null;
    /** @type {Promise<void>} */
    commandQueue = Promise.resolve();
    /** @type {number | null} */
    rafHandle = null;
    running = false;
    bridgeRunning = false;
    /** @type {(() => void) | null} */
    detachedInputs = null;
    /** @type {ImageBitmapRenderingContext | CanvasRenderingContext2D | null} */
    frameContext = null;
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
        if (typeof OffscreenCanvas === "undefined") {
            throw new Error("OffscreenCanvas is unavailable in this browser");
        }
        const canvas = this.acquireCanvas(canvasId);
        this.frameContext = null;
        const commandSab = new SharedArrayBuffer(128 + CHANNEL_CAPACITY);
        const bridgeReqSab = new SharedArrayBuffer(128 + CHANNEL_CAPACITY);
        const bridgeResSab = new SharedArrayBuffer(128 + CHANNEL_CAPACITY);
        this.commandChannel = new SharedBinaryChannel({
            sab: commandSab,
            role: "writer",
        });
        this.bridgeReqChannel = new SharedBinaryChannel({
            sab: bridgeReqSab,
            role: "reader",
        });
        this.bridgeResChannel = new SharedBinaryChannel({
            sab: bridgeResSab,
            role: "writer",
        });
        const worker = new Worker(new URL("./raylib.worker.js", import.meta.url), {
            type: "module",
        });
        this.worker = worker;
        /** @type {Promise<void>} */
        const workerReady = new Promise((resolve, reject) => {
            let settled = false;
            /** @param {MessageEvent<WorkerMessage>} event */
            const onMessage = (event) => {
                const message = event.data;
                if (message.type === "frame") {
                    this.presentFrame(canvas, message.bitmap);
                    return;
                }
                if (message.type === "ready") {
                    settled = true;
                    resolve();
                    return;
                }
                if (message.type === "title") {
                    document.title = message.value ?? "Raylib.js Example";
                    return;
                }
                if (message.type === "error") {
                    if (settled) {
                        console.error(message.value);
                    } else {
                        reject(new Error(message.value));
                    }
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
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            commandSab,
            bridgeReqSab,
            bridgeResSab,
        };
        worker.postMessage(initMessage);
        await workerReady;
        this.bridgeRunning = true;
        void this.runBridgeLoop(worker);
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
        this.bridgeRunning = false;
        const worker = this.worker;
        const commandChannel = this.commandChannel;
        if (worker !== null && commandChannel !== null) {
            this.commandQueue = this.commandQueue
                .then(() => commandChannel.writeAsync(encodeStopCommand()))
                .catch(() => {
                    worker.terminate();
                });
        } else {
            worker?.terminate();
        }
        this.worker = null;
        this.commandChannel = null;
        this.bridgeReqChannel = null;
        this.bridgeResChannel = null;
        this.frameContext = null;
        this.commandQueue = Promise.resolve();
    }
    /** @param {Uint8Array} command */
    enqueueCommand(command) {
        const commandChannel = this.commandChannel;
        if (commandChannel === null) {
            return Promise.resolve();
        }
        this.commandQueue = this.commandQueue.then(() => commandChannel.writeAsync(command));
        return this.commandQueue;
    }

    /** @param {Worker} worker */
    async runBridgeLoop(worker) {
        const bridgeReqChannel = this.bridgeReqChannel;
        const bridgeResChannel = this.bridgeResChannel;
        if (bridgeReqChannel === null || bridgeResChannel === null) {
            return;
        }
        while (this.bridgeRunning && this.worker === worker) {
            try {
                const requestBytes = await bridgeReqChannel.readAsync();
                const request = decodeBridgeRequest(requestBytes);
                switch (request.type) {
                    case BridgeRequestType.LoadImage: {
                        const response = await fetch(request.source);
                        if (!response.ok) {
                            throw new Error(
                                `Failed to fetch image '${request.source}': ${response.status} ${response.statusText}`
                            );
                        }
                        const blob = await response.blob();
                        const bitmap = await createImageBitmap(blob);
                        try {
                            const width = bitmap.width;
                            const height = bitmap.height;
                            const imageData = this.extractImageData(bitmap, width, height);
                            const pixels = new Uint8Array(imageData.data.buffer.slice(0));
                            await bridgeResChannel.writeAsync(
                                encodeBridgeResponseLoadImageOk(width, height, pixels)
                            );
                        } finally {
                            bitmap.close();
                        }
                        break;
                    }
                    default:
                        throw new Error(`Unsupported bridge request type: ${request.type}`);
                }
            } catch (error) {
                if (!this.bridgeRunning || this.worker !== worker) {
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                await bridgeResChannel.writeAsync(encodeBridgeResponseError(message));
            }
        }
    }

    /** @param {ImageBitmap} bitmap @param {number} width @param {number} height */
    extractImageData(bitmap, width, height) {
        if (typeof OffscreenCanvas !== "undefined") {
            const offscreen = new OffscreenCanvas(width, height);
            const context = offscreen.getContext("2d");
            if (context === null) {
                throw new Error("Could not create offscreen 2d context for image decode");
            }
            context.drawImage(bitmap, 0, 0);
            return context.getImageData(0, 0, width, height);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (context === null) {
            throw new Error("Could not create 2d context for image decode");
        }
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, width, height);
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
        return existing;
    }

    /** @param {HTMLCanvasElement} canvas @param {ImageBitmap} bitmap */
    presentFrame(canvas, bitmap) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            this.frameContext = null;
        }
        if (this.frameContext === null) {
            this.frameContext = canvas.getContext("bitmaprenderer") ?? canvas.getContext("2d");
            if (this.frameContext === null) {
                bitmap.close();
                throw new Error("Could not create a canvas context for frame presentation");
            }
        }
        if ("transferFromImageBitmap" in this.frameContext) {
            this.frameContext.transferFromImageBitmap(bitmap);
            return;
        }
        this.frameContext.drawImage(bitmap, 0, 0);
        bitmap.close();
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
