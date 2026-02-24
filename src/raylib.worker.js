// @ts-check

import { SharedBinaryChannel } from "./channel.js";
import { decodeMainCommand } from "./raylib-protocol.js";

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
 * @property {OffscreenCanvas} canvas
 * @property {SharedArrayBuffer} channelSab
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
    /** @type {(ImageBitmap | null)[]} */
    #images = [];
    /** @param {string} source */
    loadImage(source) {
        const id = this.#images.length;
        this.#images.push(null);
        void (async () => {
            const response = await fetch(source);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            this.#images[id] = bitmap;
        })();
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
    /**
     * @param {OffscreenCanvasRenderingContext2D} ctx
     * @param {FrameClock} clock
     * @param {InputState} input
     * @param {ResourceStore} resources
     * @param {(message: WorkerMessage) => void} emit
     */
    constructor(ctx, clock, input, resources, emit) {
        this.ctx = ctx;
        this.clock = clock;
        this.input = input;
        this.resources = resources;
        this.emit = emit;
    }
    /** @param {WasmInstanceExports} exports */
    setWasmExports(exports) {
        this.exportsRef = exports;
    }
    tick() {
        this.entryFunction?.();
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
        return false;
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
        const result = new Uint32Array(this.memoryBuffer, result_ptr, 5);
        result[0] = imageId;
        result[1] = 256;
        result[2] = 256;
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
    const ctx = init.canvas.getContext("2d");
    if (ctx === null) {
        throw new Error("Could not create 2d offscreen context");
    }
    const clock = new FrameClock();
    const input = new InputState();
    const resources = new ResourceStore();
    const bridge = new RaylibBridge(ctx, clock, input, resources, (message) => {
        self.postMessage(message);
    });
    const wasm = await WebAssembly.instantiateStreaming(fetch(init.wasmPath), {
        env: makeEnvironment(bridge),
    });
    const exports = validateWasmExports(wasm.instance.exports);
    bridge.setWasmExports(exports);
    exports.main();
    const channel = new SharedBinaryChannel({
        sab: init.channelSab,
    });
    self.postMessage({ type: "ready" });
    let started = false;
    for (;;) {
        const command = decodeMainCommand(channel.read());
        switch (command.type) {
            case 1: {
                if (!started) {
                    clock.begin(command.timestamp);
                    started = true;
                } else {
                    clock.tick(command.timestamp);
                }
                bridge.tick();
                // FIXME: Make everything work blocking using the channel so this hack is not needed
                await new Promise((resolve) => setTimeout(resolve, 0));
                break;
            }
            case 2:
                input.keyDown(command.key);
                break;
            case 3:
                input.keyUp(command.key);
                break;
            case 4:
                input.wheel(command.delta);
                break;
            case 5:
                input.mouseMove(command.x, command.y);
                break;
            case 6:
                return;
        }
    }
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
