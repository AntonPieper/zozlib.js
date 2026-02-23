FROM ubuntu:24.04 AS build-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    clang \
    lld \
    make \
    libc6-dev \
    libasound2-dev \
    libgl1-mesa-dev \
    libx11-dev \
    libxcursor-dev \
    libxinerama-dev \
    libxi-dev \
    libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*

FROM build-deps AS build

WORKDIR /src
COPY . .

RUN clang -o nob nob.c && ./nob

FROM build-deps AS format-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    clang-format-20 \
    git \
    nodejs \
    npm \
    && ln -sf /usr/bin/clang-format-20 /usr/local/bin/clang-format \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@10 && pnpm install --frozen-lockfile

FROM format-deps AS format-check

WORKDIR /src
COPY . .
RUN git init -b main \
    && git add -A \
    && pnpm run format:check

FROM scratch AS site

COPY --from=build /src/index.html /index.html
COPY --from=build /src/raylib.js /raylib.js
COPY --from=build /src/wasm /wasm
COPY --from=build /src/fonts /fonts
COPY --from=build /src/resources /resources

FROM nginx:alpine3.23-slim AS runtime

COPY --from=site / /usr/share/nginx/html/

EXPOSE 80
