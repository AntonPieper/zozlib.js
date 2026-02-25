const coiReloadFlag = "coi:reloaded";

/** @returns {Promise<void>} */
export async function ensureCrossOriginIsolation() {
    if (window.crossOriginIsolated) {
        sessionStorage.removeItem(coiReloadFlag);
        return;
    }

    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
        return;
    }

    await navigator.serviceWorker.register("/coi.service-worker.js", {
        scope: "/",
    });

    await navigator.serviceWorker.ready;

    if (!sessionStorage.getItem(coiReloadFlag)) {
        sessionStorage.setItem(coiReloadFlag, "1");
        window.location.reload();
    }
}
