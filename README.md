# Zozlib.js

Unofficial Implementation of Subset of [Raylib](https://github.com/raysan5/raylib) API in JavaScript so you can use it from WebAssembly. Intended as a simpler Web version of Raylib that _does not require Emscripten_.

> [!WARNING]
> This is a Research Project and not guaranteed to be useful in present or/and future! If you quickly need to port your Raylib game to Web just follow these instructions: [Working for Web (HTML5)](<https://github.com/raysan5/raylib/wiki/Working-for-Web-(HTML5)>)

## Main Idea

The main idea is to enable a very specific style of [Programming in C for WebAssembly without Emscripten](https://surma.dev/things/c-to-webassembly/) but for Raylib. The current limitation is that Zozlib.js is not fully implemented, but it does not mean it is useless! If you have a Game that uses only implemented function you can use Zozlib.js. And if only few needed functions are not implemented you can implement them and submit a PR thus improving the library for future uses.

We have no plans to replace the official Emscripten version of Raylib. This is a Reasearch Project intended to explore how far this approach can be pushed.

## Start Demo Locally

The demo is deployed to GitHub pages: [antonpieper.github.io/zozlib.js](https://antonpieper.github.io/zozlib.js/) But you can run it locally.

```console
$ python3 -m http.server 6969
<browser> http://localhost:6969/
```

The browser entrypoint now runs directly from [src/main.js](src/main.js), and the project no longer requires a TypeScript compile step.

Type safety is enforced via JSDoc + static checking:

```bash
pnpm run typecheck
```

## Build Demos

```bash
clang -o nob nob.c
./nob
```

`./nob` selects compilers this way:

- Native builds use `${CC}` if set, otherwise `clang`.
- WASM builds use `${WASM_CC}` if set; otherwise `${CC}`

On systems where only a versioned clang supports WASM, run for example:

```bash
WASM_CC=clang-21 ./nob
```
