import { ensureCrossOriginIsolation } from "./coi.js";
import { RaylibJs } from "./raylib.js";

await ensureCrossOriginIsolation();

/** @typedef {Record<string, string[]>} WasmPaths */
/** @type {WasmPaths} */
const wasmPaths = {
    tsoding: ["tsoding_ball", "tsoding_snake"],
    core: [
        "core_basic_window",
        "core_basic_screen_manager",
        "core_input_keys",
        "core_input_mouse_wheel",
    ],
    shapes: ["shapes_colors_palette"],
    text: ["text_writing_anim"],
    textures: ["textures_logo_raylib"],
};
const defaultWasm = Object.values(wasmPaths)[0][0];
const raylibExampleSelectElement = document.getElementById("raylib-example-select");
if (!(raylibExampleSelectElement instanceof HTMLSelectElement)) {
    throw new Error("Expected #raylib-example-select to be a <select>");
}
const raylibExampleSelect = raylibExampleSelectElement;

/** @returns {void} */
function renderExampleOptions() {
    for (const exampleCategory in wasmPaths) {
        raylibExampleSelect.innerHTML += `<optgroup label="${exampleCategory}">`;
        for (const example of wasmPaths[exampleCategory]) {
            raylibExampleSelect.innerHTML += `<option>${example}</option>`;
        }
        raylibExampleSelect.innerHTML += "</optgroup>";
    }
}
function allExamples() {
    return Object.values(wasmPaths).flat();
}
/** @param {string} selectedWasm */
function setQueryExample(selectedWasm) {
    const queryParams = new URLSearchParams(window.location.search);
    queryParams.set("example", selectedWasm);
    history.pushState(null, "", "?" + queryParams.toString());
}
function renderNotHostedMessage() {
    document.body.innerHTML = `
                <div class="not-hosted-msg">
                    <div class="important">
                        <p>Unfortunately, due to CORs restrictions, the wasm assembly cannot be fetched.</p>
                        <p>Please navigate to this location using a web server.</p>
                        <p>If you have Python 3 on your system you can just do:</p>
                    </div>
                    <code>$ python3 -m http.server 6969</code>
                </div>
                `;
}
const { protocol } = window.location;
const isHosted = protocol !== "file:";
const raylibJs = new RaylibJs();
/** @param {string} selectedWasm */
async function startRaylib(selectedWasm) {
    setQueryExample(selectedWasm);
    raylibExampleSelect.value = selectedWasm;
    if (isHosted) {
        await raylibJs.start({
            wasmPath: new URL(`/wasm/${selectedWasm}.wasm`, window.location.href),
            canvasId: "game",
        });
    } else {
        renderNotHostedMessage();
    }
}
function getInitialExample() {
    const queryParams = new URLSearchParams(window.location.search);
    const exampleParam = queryParams.get("example") ?? defaultWasm;
    return allExamples().includes(exampleParam) ? exampleParam : defaultWasm;
}

renderExampleOptions();
raylibExampleSelect.addEventListener("change", (event) => {
    const target = /** @type {HTMLSelectElement} */ (event.target);
    void startRaylib(target.value).catch((error) => {
        console.error(error);
    });
});
void startRaylib(getInitialExample()).catch((error) => {
    console.error(error);
});
