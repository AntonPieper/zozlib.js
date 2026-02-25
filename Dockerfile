# syntax=docker/dockerfile:1

FROM ubuntu:24.04 AS build-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    clang=1:18.0-59~exp2 \
    lld=1:18.0-59~exp2 \
    make=4.3-4.1build2 \
    libc6-dev=2.39-0ubuntu8.7 \
    libasound2-dev=1.2.11-1ubuntu0.2 \
    libgl1-mesa-dev=25.2.8-0ubuntu0.24.04.1 \
    libx11-dev=2:1.8.7-1build1 \
    libxcursor-dev=1:1.2.1-1build1 \
    libxinerama-dev=2:1.1.4-3build1 \
    libxi-dev=2:1.8.1-1build1 \
    libxrandr-dev=2:1.5.2-2build1 \
    && rm -rf /var/lib/apt/lists/*

FROM build-deps AS build

WORKDIR /src
COPY . .

RUN clang -o nob nob.c && ./nob

FROM build-deps AS format-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    clang-format-20=1:20.1.2-0ubuntu1~24.04.2 \
    git=1:2.43.0-1ubuntu7.3 \
    nodejs=18.19.1+dfsg-6ubuntu5 \
    npm=9.2.0~ds1-2 \
    && ln -sf /usr/bin/clang-format-20 /usr/local/bin/clang-format \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@10.30.2 && pnpm install --frozen-lockfile

FROM format-deps AS format-check

WORKDIR /src
COPY . .
RUN git init -b main \
    && git add -A \
    && pnpm run format:check

FROM scratch AS site

COPY --from=build /src/index.html /index.html
COPY --from=build /src/coi.service-worker.js /coi.service-worker.js
COPY --from=build /src/src /src
COPY --from=build /src/wasm /wasm
COPY --from=build /src/fonts /fonts
COPY --from=build /src/resources /resources

FROM nginxinc/nginx-unprivileged:alpine3.23-slim AS runtime

COPY --from=site / /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
