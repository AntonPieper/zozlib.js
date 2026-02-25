/// <reference types="serviceworker" />

const coop = "same-origin";
const coep = "require-corp";

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener(
    "activate",
    /** @param {ExtendableEvent} event */
    (event) => {
        event.waitUntil(self.clients.claim());
    }
);

self.addEventListener(
    "fetch",
    /** @param {FetchEvent} event */
    (event) => {
        const { request } = event;

        if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
            return;
        }

        event.respondWith(
            fetch(request).then((response) => {
                if (response.status === 0) {
                    return response;
                }

                const headers = new Headers(response.headers);
                headers.set("Cross-Origin-Embedder-Policy", coep);
                headers.set("Cross-Origin-Opener-Policy", coop);

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                });
            })
        );
    }
);
