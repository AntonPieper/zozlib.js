/// <reference lib="webworker" />

import { SharedBinaryChannel } from "./channel.js";
import {
    BridgeResponseType,
    decodeBridgeResponse,
    decodeMainCommand,
    encodeBridgeRequestLoadImage,
    MainCommandType,
} from "./raylib-protocol.js";

/** @typedef {import("./raylib-protocol.js").WorkerMessage} WorkerMessage */

/**
 * @typedef {WebAssembly.Exports & {
 *   memory: WebAssembly.Memory,
 *   main: () => void,
 *   __indirect_function_table: WebAssembly.Table
 * }} WasmInstanceExports
 */

/**
 * @typedef {Object} InitMessage
 * @property {"init"} type
 * @property {string} wasmPath
 * @property {number} canvasWidth
 * @property {number} canvasHeight
 * @property {SharedArrayBuffer} commandSab
 * @property {SharedArrayBuffer} bridgeReqSab
 * @property {SharedArrayBuffer} bridgeResSab
 */
/** @enum {number} */
const LogLevel = {
    LOG_ALL: 0,
    LOG_TRACE: 1,
    LOG_DEBUG: 2,
    LOG_INFO: 3,
    LOG_WARNING: 4,
    LOG_ERROR: 5,
    LOG_FATAL: 6,
    LOG_NONE: 7,
};
const FONT_SCALE_MAGIC = 0.65;
class FrameClock {
    #previous = NaN;
    #dt = 0;
    targetFPS = 60;
    /** @param {number} timestamp */
    begin(timestamp) {
        this.#previous = timestamp;
        this.#dt = 0;
    }
    /** @param {number} timestamp */
    tick(timestamp) {
        this.#dt = (timestamp - this.#previous) / 1000.0;
        this.#previous = timestamp;
    }
    getFrameTime() {
        return Math.min(this.#dt, 1.0 / this.targetFPS);
    }
}
class InputState {
    #prevPressedKeys = new Set();
    #currentPressedKeys = new Set();
    #currentMouseWheelMove = 0;
    #currentMousePosition = { x: 0, y: 0 };
    /** @param {number} key */
    keyDown(key) {
        this.#currentPressedKeys.add(key);
    }
    /** @param {number} key */
    keyUp(key) {
        this.#currentPressedKeys.delete(key);
    }
    /** @param {number} delta */
    wheel(delta) {
        this.#currentMouseWheelMove = delta;
    }
    /** @param {number} x @param {number} y */
    mouseMove(x, y) {
        this.#currentMousePosition = { x, y };
    }
    endFrame() {
        this.#prevPressedKeys = new Set(this.#currentPressedKeys);
        this.#currentMouseWheelMove = 0;
    }
    /** @param {number} key */
    isKeyPressed(key) {
        return !this.#prevPressedKeys.has(key) && this.#currentPressedKeys.has(key);
    }
    /** @param {number} key */
    isKeyDown(key) {
        return this.#currentPressedKeys.has(key);
    }
    getMouseWheelMove() {
        return this.#currentMouseWheelMove;
    }
    getMousePosition() {
        return this.#currentMousePosition;
    }
}
class ResourceStore {
    /** @type {(OffscreenCanvas | null)[]} */
    #images = [];
    /** @type {(source: string) => OffscreenCanvas} */
    #loadImageSync;

    /** @param {(source: string) => OffscreenCanvas} loadImageSync */
    constructor(loadImageSync) {
        this.#loadImageSync = loadImageSync;
    }

    /** @param {string} source */
    loadImage(source) {
        const id = this.#images.length;
        this.#images.push(this.#loadImageSync(source));
        return id;
    }
    /** @param {number} id */
    getImage(id) {
        return this.#images[id];
    }
}
class RaylibBridge {
    /** @type {OffscreenCanvasRenderingContext2D} */
    ctx;
    /** @type {FrameClock} */
    clock;
    /** @type {InputState} */
    input;
    /** @type {ResourceStore} */
    resources;
    /** @type {(message: WorkerMessage) => void} */
    emit;
    /** @type {WasmInstanceExports | null} */
    exportsRef = null;
    /** @type {(() => void) | null} */
    entryFunction = null;
    /** @type {SharedBinaryChannel} */
    commandChannel;
    #started = false;
    #shouldClose = false;
    #waitForFrameSignalInEndDrawing = true;
    /**
     * @param {OffscreenCanvasRenderingContext2D} ctx
     * @param {FrameClock} clock
     * @param {InputState} input
     * @param {ResourceStore} resources
     * @param {SharedBinaryChannel} commandChannel
     * @param {(message: WorkerMessage) => void} emit
     */
    constructor(ctx, clock, input, resources, commandChannel, emit) {
        this.ctx = ctx;
        this.clock = clock;
        this.input = input;
        this.resources = resources;
        this.commandChannel = commandChannel;
        this.emit = emit;
    }
    /** @param {WasmInstanceExports} exports */
    setWasmExports(exports) {
        this.exportsRef = exports;
    }

    /** @returns {WasmInstanceExports} */
    get wasm() {
        if (this.exportsRef === null) {
            throw new Error("WASM exports are not initialized");
        }
        return this.exportsRef;
    }
    get memoryBuffer() {
        return this.wasm.memory.buffer;
    }
    /** @param {number} color_ptr */
    readColor(color_ptr) {
        return getColorFromMemory(this.memoryBuffer, color_ptr);
    }
    /** @param {number} width @param {number} height @param {number} title_ptr */
    InitWindow(width, height, title_ptr) {
        this.ctx.canvas.width = width;
        this.ctx.canvas.height = height;
        this.emit({ type: "title", value: readCString(this.memoryBuffer, title_ptr) });
    }
    WindowShouldClose() {
        return this.#shouldClose;
    }
    CloseWindow() {
        this.#shouldClose = true;
    }
    /** @param {number} fps */
    SetTargetFPS(fps) {
        this.clock.targetFPS = fps;
    }
    GetScreenWidth() {
        return this.ctx.canvas.width;
    }
    GetScreenHeight() {
        return this.ctx.canvas.height;
    }
    GetFrameTime() {
        return this.clock.getFrameTime();
    }
    BeginDrawing() {}
    EndDrawing() {
        this.input.endFrame();
        const bitmap = this.ctx.canvas.transferToImageBitmap();
        self.postMessage({ type: "frame", bitmap }, [bitmap]);
        if (this.#waitForFrameSignalInEndDrawing && !this.#shouldClose) {
            this.waitForNextFrameSignal();
        }
    }
    hasEntryFunction() {
        return this.entryFunction !== null;
    }
    /** @param {boolean} enabled */
    setFrameSyncInEndDrawing(enabled) {
        this.#waitForFrameSignalInEndDrawing = enabled;
    }
    waitForNextFrameSignal() {
        while (!this.#shouldClose) {
            const command = decodeMainCommand(this.commandChannel.read());
            const commandType = this.applyCommand(command);
            if (commandType === MainCommandType.Frame || commandType === MainCommandType.Stop) {
                return;
            }
        }
    }
    /** @param {import("./raylib-protocol.js").MainCommand} command */
    applyCommand(command) {
        switch (command.type) {
            case MainCommandType.Frame:
                if (!this.#started) {
                    this.clock.begin(command.timestamp);
                    this.#started = true;
                } else {
                    this.clock.tick(command.timestamp);
                }
                break;
            case MainCommandType.KeyDown:
                this.input.keyDown(command.key);
                break;
            case MainCommandType.KeyUp:
                this.input.keyUp(command.key);
                break;
            case MainCommandType.MouseWheel:
                this.input.wheel(command.delta);
                break;
            case MainCommandType.MouseMove:
                this.input.mouseMove(command.x, command.y);
                break;
            case MainCommandType.Stop:
                this.#shouldClose = true;
                break;
            default:
                throw new Error("Unsupported command type");
        }
        return command.type;
    }
    /** @param {number} center_ptr @param {number} radius @param {number} color_ptr */
    DrawCircleV(center_ptr, radius, color_ptr) {
        const [x, y] = new Float32Array(this.memoryBuffer, center_ptr, 2);
        this.ctx.beginPath();
        this.ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
        this.ctx.fillStyle = this.readColor(color_ptr);
        this.ctx.fill();
    }
    /** @param {number} color_ptr */
    ClearBackground(color_ptr) {
        this.ctx.fillStyle = this.readColor(color_ptr);
        this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    }
    /** @param {number} text_ptr @param {number} posX @param {number} posY @param {number} fontSize @param {number} color_ptr */
    DrawText(text_ptr, posX, posY, fontSize, color_ptr) {
        const text = readCString(this.memoryBuffer, text_ptr);
        const scaledFontSize = fontSize * FONT_SCALE_MAGIC;
        this.ctx.fillStyle = this.readColor(color_ptr);
        this.ctx.font = `${scaledFontSize}px sans-serif`;
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index++) {
            this.ctx.fillText(lines[index], posX, posY + scaledFontSize + index * scaledFontSize);
        }
    }
    /** @param {number} posX @param {number} posY @param {number} width @param {number} height @param {number} color_ptr */
    DrawRectangle(posX, posY, width, height, color_ptr) {
        this.ctx.fillStyle = this.readColor(color_ptr);
        this.ctx.fillRect(posX, posY, width, height);
    }
    /** @param {number} position_ptr @param {number} size_ptr @param {number} color_ptr */
    DrawRectangleV(position_ptr, size_ptr, color_ptr) {
        const [x, y] = new Float32Array(this.memoryBuffer, position_ptr, 2);
        const [w, h] = new Float32Array(this.memoryBuffer, size_ptr, 2);
        this.ctx.fillStyle = this.readColor(color_ptr);
        this.ctx.fillRect(x, y, w, h);
    }
    /** @param {number} key */
    IsKeyPressed(key) {
        return this.input.isKeyPressed(key);
    }
    /** @param {number} key */
    IsKeyDown(key) {
        return this.input.isKeyDown(key);
    }
    GetMouseWheelMove() {
        return this.input.getMouseWheelMove();
    }
    IsGestureDetected() {
        return false;
    }
    /** @param {...number} args */
    TextFormat(...args) {
        return args[0];
    }
    /** @param {number} logLevel @param {number} text_ptr @param {...number} args */
    TraceLog(logLevel, text_ptr, ...args) {
        const text = readCString(this.memoryBuffer, text_ptr);
        const prefixByLevel = {
            [LogLevel.LOG_ALL]: "ALL",
            [LogLevel.LOG_TRACE]: "TRACE",
            [LogLevel.LOG_DEBUG]: "DEBUG",
            [LogLevel.LOG_INFO]: "INFO",
            [LogLevel.LOG_WARNING]: "WARNING",
            [LogLevel.LOG_ERROR]: "ERROR",
            [LogLevel.LOG_NONE]: "NONE",
        };
        if (logLevel === LogLevel.LOG_FATAL) {
            throw new Error(`FATAL: ${text}`);
        }
        const prefix = prefixByLevel[logLevel] ?? "UNKNOWN";
        console.log(`${prefix}: ${text} ${args}`);
    }
    /** @param {number} result_ptr */
    GetMousePosition(result_ptr) {
        const mouse = this.input.getMousePosition();
        new Float32Array(this.memoryBuffer, result_ptr, 2).set([mouse.x, mouse.y]);
    }
    /** @param {number} point_ptr @param {number} rec_ptr */
    CheckCollisionPointRec(point_ptr, rec_ptr) {
        const [x, y] = new Float32Array(this.memoryBuffer, point_ptr, 2);
        const [rx, ry, rw, rh] = new Float32Array(this.memoryBuffer, rec_ptr, 4);
        return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
    }
    /** @param {number} result_ptr @param {number} color_ptr @param {number} alpha */
    Fade(result_ptr, color_ptr, alpha) {
        const [r, g, b] = new Uint8Array(this.memoryBuffer, color_ptr, 4);
        const newAlpha = Math.max(0, Math.min(255, 255.0 * alpha));
        new Uint8Array(this.memoryBuffer, result_ptr, 4).set([r, g, b, newAlpha]);
    }
    /** @param {number} rec_ptr @param {number} color_ptr */
    DrawRectangleRec(rec_ptr, color_ptr) {
        const [x, y, w, h] = new Float32Array(this.memoryBuffer, rec_ptr, 4);
        this.ctx.fillStyle = this.readColor(color_ptr);
        this.ctx.fillRect(x, y, w, h);
    }
    /** @param {number} rec_ptr @param {number} lineThick @param {number} color_ptr */
    DrawRectangleLinesEx(rec_ptr, lineThick, color_ptr) {
        const [x, y, w, h] = new Float32Array(this.memoryBuffer, rec_ptr, 4);
        this.ctx.strokeStyle = this.readColor(color_ptr);
        this.ctx.lineWidth = lineThick;
        this.ctx.strokeRect(x + lineThick / 2, y + lineThick / 2, w - lineThick, h - lineThick);
    }
    /** @param {number} text_ptr @param {number} fontSize */
    MeasureText(text_ptr, fontSize) {
        const text = readCString(this.memoryBuffer, text_ptr);
        const scaledFontSize = fontSize * FONT_SCALE_MAGIC;
        this.ctx.font = `${scaledFontSize}px sans-serif`;
        return this.ctx.measureText(text).width;
    }
    /** @param {number} text_ptr @param {number} position @param {number} length */
    TextSubtext(text_ptr, position, length) {
        const text = readCString(this.memoryBuffer, text_ptr);
        const subtext = text.substring(position, length);
        const bytes = new Uint8Array(this.memoryBuffer, 0, subtext.length + 1);
        for (let index = 0; index < subtext.length; index++) {
            bytes[index] = subtext.charCodeAt(index);
        }
        bytes[subtext.length] = 0;
        return bytes;
    }
    /** @param {number} result_ptr @param {number} filename_ptr */
    LoadTexture(result_ptr, filename_ptr) {
        const filename = readCString(this.memoryBuffer, filename_ptr);
        const imageId = this.resources.loadImage(filename);
        const image = this.resources.getImage(imageId);
        const width = image?.width ?? 0;
        const height = image?.height ?? 0;
        const result = new Uint32Array(this.memoryBuffer, result_ptr, 5);
        result[0] = imageId;
        result[1] = width;
        result[2] = height;
        result[3] = 1;
        result[4] = 7;
        return result;
    }
    /** @param {number} texture_ptr @param {number} posX @param {number} posY @param {number} _color_ptr */
    DrawTexture(texture_ptr, posX, posY, _color_ptr) {
        const [id] = new Uint32Array(this.memoryBuffer, texture_ptr, 5);
        const image = this.resources.getImage(id);
        if (image !== null && image !== undefined) {
            this.ctx.drawImage(image, posX, posY);
        }
    }
    LoadFontEx() {}
    GenTextureMipmaps() {}
    SetTextureFilter() {}
    /**
     * @param {number} result_ptr
     * @param {number} _font
     * @param {number} text_ptr
     * @param {number} fontSize
     * @param {number} _spacing
     */
    MeasureTextEx(result_ptr, _font, text_ptr, fontSize, _spacing) {
        const text = readCString(this.memoryBuffer, text_ptr);
        const result = new Float32Array(this.memoryBuffer, result_ptr, 2);
        this.ctx.font = `${fontSize}px sans-serif`;
        const metrics = this.ctx.measureText(text);
        result[0] = metrics.width;
        result[1] = fontSize;
    }
    /**
     * @param {number} _font
     * @param {number} text_ptr
     * @param {number} position_ptr
     * @param {number} fontSize
     * @param {number} _spacing
     * @param {number} tint_ptr
     */
    DrawTextEx(_font, text_ptr, position_ptr, fontSize, _spacing, tint_ptr) {
        const text = readCString(this.memoryBuffer, text_ptr);
        const [x, y] = new Float32Array(this.memoryBuffer, position_ptr, 2);
        this.ctx.fillStyle = this.readColor(tint_ptr);
        this.ctx.font = `${fontSize}px sans-serif`;
        this.ctx.fillText(text, x, y + fontSize);
    }
    /** @param {number} min @param {number} max */
    GetRandomValue(min, max) {
        return min + Math.floor(Math.random() * (max - min + 1));
    }
    /** @param {number} result_ptr @param {number} hue @param {number} saturation @param {number} value */
    ColorFromHSV(result_ptr, hue, saturation, value) {
        const result = new Uint8Array(this.memoryBuffer, result_ptr, 4);
        let k = (5.0 + hue / 60.0) % 6;
        let t = 4.0 - k;
        k = t < k ? t : k;
        k = Math.max(0, Math.min(1, k));
        result[0] = Math.floor((value - value * saturation * k) * 255.0);
        k = (3.0 + hue / 60.0) % 6;
        t = 4.0 - k;
        k = t < k ? t : k;
        k = Math.max(0, Math.min(1, k));
        result[1] = Math.floor((value - value * saturation * k) * 255.0);
        k = (1.0 + hue / 60.0) % 6;
        t = 4.0 - k;
        k = t < k ? t : k;
        k = Math.max(0, Math.min(1, k));
        result[2] = Math.floor((value - value * saturation * k) * 255.0);
        result[3] = 255;
    }
    /** @param {number} entry */
    raylib_js_set_entry(entry) {
        const fn = this.wasm.__indirect_function_table.get(entry);
        if (typeof fn !== "function") {
            throw new Error(`Invalid entry function index: ${entry}`);
        }
        this.entryFunction = fn;
    }
}
/** @param {object} env */
function makeEnvironment(env) {
    return new Proxy(
        {},
        {
            get(_target, prop) {
                const value = Reflect.get(env, prop);
                if (typeof value !== "function") {
                    throw new Error(`Property ${String(prop)} does not exist`);
                }
                return value.bind(env);
            },
        }
    );
}
/** @param {WebAssembly.Exports} exports @returns {WasmInstanceExports} */
function validateWasmExports(exports) {
    const maybe = exports;
    if (!(maybe.memory instanceof WebAssembly.Memory)) {
        throw new Error("The wasm module does not export memory");
    }
    if (typeof maybe.main !== "function") {
        throw new Error("The wasm module does not export main");
    }
    if (!(maybe.__indirect_function_table instanceof WebAssembly.Table)) {
        throw new Error("The wasm module does not export __indirect_function_table");
    }
    return /** @type {WasmInstanceExports} */ (maybe);
}
/** @param {ArrayBuffer} buffer @param {number} ptr */
function readCString(buffer, ptr) {
    const mem = new Uint8Array(buffer);
    let len = 0;
    while (mem[ptr + len] !== 0) {
        len++;
    }
    return new TextDecoder().decode(new Uint8Array(buffer, ptr, len));
}
/** @param {number} r @param {number} g @param {number} b @param {number} a */
function colorHexUnpacked(r, g, b, a) {
    const rgba =
        ((r & 0xff) << (3 * 8)) |
        ((g & 0xff) << (2 * 8)) |
        ((b & 0xff) << (1 * 8)) |
        ((a & 0xff) << (0 * 8));
    return `#${(rgba >>> 0).toString(16).padStart(8, "0")}`;
}
/** @param {ArrayBuffer} buffer @param {number} color_ptr */
function getColorFromMemory(buffer, color_ptr) {
    const [r, g, b, a] = new Uint8Array(buffer, color_ptr, 4);
    return colorHexUnpacked(r, g, b, a);
}
/** @param {InitMessage} init */
async function run(init) {
    const canvas = new OffscreenCanvas(init.canvasWidth, init.canvasHeight);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
        throw new Error("Could not create 2d offscreen context");
    }
    const clock = new FrameClock();
    const input = new InputState();
    const commandChannel = new SharedBinaryChannel({
        sab: init.commandSab,
        role: "reader",
    });
    const bridgeReqChannel = new SharedBinaryChannel({
        sab: init.bridgeReqSab,
        role: "writer",
    });
    const bridgeResChannel = new SharedBinaryChannel({
        sab: init.bridgeResSab,
        role: "reader",
    });
    const resources = new ResourceStore((source) => {
        bridgeReqChannel.write(encodeBridgeRequestLoadImage(source));
        const response = decodeBridgeResponse(bridgeResChannel.read());
        switch (response.type) {
            case BridgeResponseType.LoadImageOk: {
                const canvas = new OffscreenCanvas(response.width, response.height);
                const context = canvas.getContext("2d");
                if (context === null) {
                    throw new Error("Could not create image decode context in worker");
                }
                const pixels = new Uint8ClampedArray(response.pixels);
                const imageData = new ImageData(pixels, response.width, response.height);
                context.putImageData(imageData, 0, 0);
                return canvas;
            }
            case BridgeResponseType.Error:
                throw new Error(response.message);
        }
        throw new Error("Unsupported bridge response type");
    });
    const bridge = new RaylibBridge(ctx, clock, input, resources, commandChannel, (message) => {
        self.postMessage(message);
    });
    const wasm = await WebAssembly.instantiateStreaming(fetch(init.wasmPath), {
        env: makeEnvironment(bridge),
    });
    const exports = validateWasmExports(wasm.instance.exports);
    bridge.setWasmExports(exports);
    self.postMessage({ type: "ready" });
    exports.main();

    // Legacy support
    const entryFunction = bridge.entryFunction?.bind(bridge);
    if (entryFunction !== undefined) {
        while (!bridge.WindowShouldClose()) {
            const command = decodeMainCommand(commandChannel.read());
            const commandType = bridge.applyCommand(command);
            if (commandType === MainCommandType.Frame && !bridge.WindowShouldClose()) {
                entryFunction();
            }
        }
    }

    self.close();
}

/** @param {MessageEvent<InitMessage>} event */
self.onmessage = (event) => {
    if (event.data.type !== "init") {
        return;
    }
    void run(event.data).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        /** @type {WorkerMessage} */
        self.postMessage({ type: "error", value: message });
    });
};
