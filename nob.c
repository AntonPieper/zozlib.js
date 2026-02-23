#define NOB_IMPLEMENTATION
#include "nob.h"

typedef struct {
    const char *src_path;
    const char *bin_path;
    const char *wasm_path;
} Example;

typedef struct {
    const char *native_cc;
    const char *wasm_cc;
} Toolchain;

Example examples[] = {
    {
        .src_path = "./examples/core_basic_window.c",
        .bin_path = "./build/core_basic_window",
        .wasm_path = "./wasm/core_basic_window.wasm",
    },
    {
        .src_path = "./examples/core_basic_screen_manager.c",
        .bin_path = "./build/core_basic_screen_manager",
        .wasm_path = "./wasm/core_basic_screen_manager.wasm",
    },
    {
        .src_path = "./examples/core_input_keys.c",
        .bin_path = "./build/core_input_keys",
        .wasm_path = "./wasm/core_input_keys.wasm",
    },
    {
        .src_path = "./examples/shapes_colors_palette.c",
        .bin_path = "./build/shapes_colors_palette",
        .wasm_path = "./wasm/shapes_colors_palette.wasm",
    },
    {
        .src_path = "./examples/tsoding_ball.c",
        .bin_path = "./build/tsoding_ball",
        .wasm_path = "./wasm/tsoding_ball.wasm",
    },
    {
        .src_path = "./examples/tsoding_snake/tsoding_snake.c",
        .bin_path = "./build/tsoding_snake",
        .wasm_path = "./wasm/tsoding_snake.wasm",
    },
    {
        .src_path = "./examples/core_input_mouse_wheel.c",
        .bin_path = "./build/core_input_mouse_wheel",
        .wasm_path = "./wasm/core_input_mouse_wheel.wasm",
    },
    {
        .src_path = "./examples/text_writing_anim.c",
        .bin_path = "./build/text_writing_anim",
        .wasm_path = "./wasm/text_writing_anim.wasm",
    },
    {
        .src_path = "./examples/textures_logo_raylib.c",
        .bin_path = "./build/textures_logo_raylib",
        .wasm_path = "./wasm/textures_logo_raylib.wasm",
    },
};

static const char *env_or_default(const char *name, const char *default_value)
{
    const char *value = getenv(name);
    if (value == NULL || *value == '\0') return default_value;
    return value;
}

static Toolchain resolve_toolchain()
{
    Toolchain toolchain = {
        .native_cc = env_or_default("CC", "clang"),
        .wasm_cc = env_or_default("WASM_CC", NULL),
    };

    if (toolchain.wasm_cc == NULL) {
        toolchain.wasm_cc = toolchain.native_cc;
    }

    nob_log(NOB_INFO, "Native compiler: %s", toolchain.native_cc);
    nob_log(NOB_INFO, "WASM compiler:   %s", toolchain.wasm_cc);
    return toolchain;
}

#define RAYLIB_SRC_DIR "./thirdparty/raylib/src"
static const char *raylib_src[] = {
    "raudio",
    "rcore",
    "rglfw",
    "rmodels",
    "rshapes",
    "rtext",
    "rtextures",
    "utils",
};

static const char *raylib_public_headers[] = {
    "raylib.h",
    "rcamera.h",
    "rlgl.h",
    "raymath.h",
};

static void cmd_append_all(Cmd *cmd, const char **items, size_t count)
{
    for (size_t i = 0; i < count; ++i) {
        cmd_append(cmd, items[i]);
    }
}

static void append_native_platform_libs(Cmd *cmd)
{
#if defined(__linux__)
    static const char *libs[] = {
        "-lGL",
        "-lX11",
        "-lXrandr",
        "-lXinerama",
        "-lXi",
        "-lXcursor",
        "-lpthread",
        "-ldl",
        "-lrt",
        "-latomic",
    };
#elif defined(__APPLE__)
    static const char *libs[] = {
        "-framework",
        "OpenGL",
        "-framework",
        "Cocoa",
        "-framework",
        "IOKit",
        "-framework",
        "CoreAudio",
        "-framework",
        "CoreVideo",
    };
#elif defined(_WIN32)
    static const char *libs[] = {
        "-lgdi32",
        "-lwinmm",
        "-lshell32",
        "-lole32",
        "-luuid",
        "-lcomdlg32",
    };
#else
    static const char *libs[] = {0};
#endif
    cmd_append_all(cmd, libs, ARRAY_LEN(libs));
}

static void append_wasm_flags(Cmd *cmd)
{
    static const char *flags[] = {
        "--target=wasm32",
        "-I./build/raylib/include",
        "-I./include",
        "--no-standard-libraries",
        "-Wl,--export-table",
        "-Wl,--no-entry",
        "-Wl,--allow-undefined",
        "-Wl,--export=main",
        "-DPLATFORM_WEB",
    };
    cmd_append_all(cmd, flags, ARRAY_LEN(flags));
}

bool build_raylib(Procs *procs, const char *cc, const char *build_dir)
{
    Cmd cmd = {0};
    if (!mkdir_if_not_exists(build_dir)) return true;
    if (!mkdir_if_not_exists(temp_sprintf("%s/include", build_dir))) return true;
    if (!mkdir_if_not_exists(temp_sprintf("%s/lib", build_dir))) return true;

    for (size_t i = 0; i < ARRAY_LEN(raylib_src); ++i) {
        cmd_append(&cmd, cc, "-I" RAYLIB_SRC_DIR);
        cmd_append(&cmd, "-I" RAYLIB_SRC_DIR "/external/glfw/include");
        cmd_append(&cmd, "-DPLATFORM_DESKTOP", "-DGRAPHICS_API_OPENGL_21");
#if defined(__APPLE__)
        if (strcmp(raylib_src[i], "rglfw") == 0) {
            cmd_append(&cmd, "-x", "objective-c");
        }
#endif
#if defined(__linux__)
        cmd_append(&cmd, "-D_GLFW_X11");
#elif defined(_WIN32)
        cmd_append(&cmd, "-D_GLFW_WIN32");
#endif
        cmd_append(&cmd,
                   "-c",
                   temp_sprintf(RAYLIB_SRC_DIR "/%s.c", raylib_src[i]),
                   "-o",
                   temp_sprintf("%s/%s.o", build_dir, raylib_src[i]));
        if (!cmd_run(&cmd, .async = procs)) return true;
    }

    if (!procs_flush(procs)) return true;

    for (size_t i = 0; i < ARRAY_LEN(raylib_public_headers); ++i) {
        if (!copy_file(temp_sprintf(RAYLIB_SRC_DIR "/%s", raylib_public_headers[i]),
                       temp_sprintf("%s/include/%s", build_dir, raylib_public_headers[i]))) {
            return true;
        }
    }

#if defined(__APPLE__)
    cmd_append(&cmd, "libtool", "-static", "-o", temp_sprintf("%s/lib/libraylib.a", build_dir));
#else
    cmd_append(&cmd, "ar", "rcs", temp_sprintf("%s/lib/libraylib.a", build_dir));
#endif
    for (size_t i = 0; i < ARRAY_LEN(raylib_src); ++i) {
        cmd_append(&cmd, temp_sprintf("%s/%s.o", build_dir, raylib_src[i]));
    }
    if (!cmd_run(&cmd)) return true;
    return false;
}

bool build_native(Procs *procs, const Toolchain *toolchain)
{
    Cmd cmd = {0};
    for (size_t i = 0; i < ARRAY_LEN(examples); ++i) {
        cmd_append(&cmd, toolchain->native_cc, "-I./build/raylib/include");
        cmd_append(&cmd, "-o", examples[i].bin_path, examples[i].src_path);
        cmd_append(&cmd, "./build/raylib/lib/libraylib.a", "-lm");
        append_native_platform_libs(&cmd);
        if (!cmd_run(&cmd, .async = procs)) return true;
    }
    return false;
}

bool build_wasm(Procs *procs, const Toolchain *toolchain)
{
    Cmd cmd = {0};
    if (!mkdir_if_not_exists("wasm/")) return true;
    for (size_t i = 0; i < ARRAY_LEN(examples); ++i) {
        cmd_append(&cmd, toolchain->wasm_cc);
        append_wasm_flags(&cmd);
        cmd_append(&cmd, "-o");
        cmd_append(&cmd, examples[i].wasm_path);
        cmd_append(&cmd, examples[i].src_path);
        if (!cmd_run(&cmd, .async = procs)) return true;
    }
    return false;
}

int main(int argc, char **argv)
{
    GO_REBUILD_URSELF(argc, argv);
    if (!mkdir_if_not_exists("build/")) return 1;
    Toolchain toolchain = resolve_toolchain();
    Procs procs = {0};
    if (build_raylib(&procs, toolchain.native_cc, "build/raylib")) return 1;
    if (build_native(&procs, &toolchain)) return 1;
    if (build_wasm(&procs, &toolchain)) return 1;
    if (!procs_flush(&procs)) return 1;
    return 0;
}
