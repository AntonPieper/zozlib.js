FROM ubuntu:24.04 AS builder

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

WORKDIR /src
COPY . .

RUN clang -o nob nob.c && ./nob

FROM scratch AS site

COPY --from=builder /src/index.html /index.html
COPY --from=builder /src/raylib.js /raylib.js
COPY --from=builder /src/wasm /wasm
COPY --from=builder /src/fonts /fonts
COPY --from=builder /src/resources /resources

FROM nginx:alpine3.23-slim

COPY --from=site / /usr/share/nginx/html/

EXPOSE 80
