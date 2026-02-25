#include <string.h>
#define NOB_IMPLEMENTATION
#include "nob.h"

#define RAYLIB_SRC_DIR "./thirdparty/raylib/src"
#define RAYLIB_BUILD "./build/raylib"
#define RAYLIB_INC RAYLIB_BUILD "/include"
#define RAYLIB_LIB RAYLIB_BUILD "/lib/libraylib.a"

#ifdef _WIN32
#define EXE_EXT ".exe"
#else
#define EXE_EXT ""
#endif

typedef struct {
    const char *native_cc;
    const char *wasm_cc;
} Toolchain;

static const char *examples[] = {
    "core_basic_window",
    "core_basic_screen_manager",
    "core_input_keys",
    "shapes_colors_palette",
    "tsoding_ball",
    "tsoding_snake/tsoding_snake",
    "core_input_mouse_wheel",
    "text_writing_anim",
    "textures_logo_raylib",
};

static const char *raylib_units[] = {
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

static const char *env_or(const char *name, const char *fallback)
{
    const char *v = getenv(name);
    return (v && *v) ? v : fallback;
}

static Toolchain resolve_toolchain(void)
{
    Toolchain tc = {0};
    tc.native_cc = env_or("CC", "clang");
    tc.wasm_cc = env_or("WASM_CC", NULL);
    if (!tc.wasm_cc) tc.wasm_cc = tc.native_cc;

    nob_log(NOB_INFO, "Native compiler: %s", tc.native_cc);
    nob_log(NOB_INFO, "WASM compiler:   %s", tc.wasm_cc);
    return tc;
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
    da_append_many(cmd, libs, ARRAY_LEN(libs));
}

static void append_wasm_flags(Cmd *cmd)
{
    static const char *flags[] = {
        "--target=wasm32",
        ("-I" RAYLIB_INC),
        "-I./include",
        "--no-standard-libraries",
        "-Wl,--export-table",
        "-Wl,--no-entry",
        "-Wl,--allow-undefined",
        "-Wl,--export=main",
        // "-DPLATFORM_WEB",
    };
    da_append_many(cmd, flags, ARRAY_LEN(flags));
}

static bool build_raylib(Procs *procs, const char *cc)
{
    if (!mkdir_if_not_exists("./build")) return false;
    if (!mkdir_if_not_exists(RAYLIB_BUILD)) return false;
    if (!mkdir_if_not_exists(RAYLIB_INC)) return false;
    if (!mkdir_if_not_exists(RAYLIB_BUILD "/lib")) return false;

    size_t mark = temp_save();

    const char *objs[ARRAY_LEN(raylib_units)] = {0};

    // Compile objects if stale
    for (size_t i = 0; i < ARRAY_LEN(raylib_units); ++i) {
        const char *unit = raylib_units[i];
        const char *src = temp_sprintf(RAYLIB_SRC_DIR "/%s.c", unit);
        const char *obj = temp_sprintf(RAYLIB_BUILD "/%s.o", unit);
        objs[i] = obj;

        int r = needs_rebuild1(obj, src);
        if (r < 0) {
            temp_rewind(mark);
            return false;
        }
        if (r == 0) continue;

        Cmd cmd = {0};
        cmd_append(&cmd, cc, "-I" RAYLIB_SRC_DIR, "-I" RAYLIB_SRC_DIR "/external/glfw/include");
        cmd_append(&cmd, "-DPLATFORM_DESKTOP", "-DGRAPHICS_API_OPENGL_21");

#if defined(__APPLE__)
        if (strcmp(unit, "rglfw") == 0) cmd_append(&cmd, "-x", "objective-c");
#endif
#if defined(__linux__)
        cmd_append(&cmd, "-D_GLFW_X11");
#elif defined(_WIN32)
        cmd_append(&cmd, "-D_GLFW_WIN32");
#endif

        cmd_append(&cmd, "-c", src, "-o", obj);
        if (!cmd_run(&cmd, .async = procs)) {
            temp_rewind(mark);
            return false;
        }
    }

    if (!procs_flush(procs)) {
        temp_rewind(mark);
        return false;
    }

    // Copy public headers if stale/missing
    for (size_t i = 0; i < ARRAY_LEN(raylib_public_headers); ++i) {
        const char *h = raylib_public_headers[i];
        const char *src = temp_sprintf(RAYLIB_SRC_DIR "/%s", h);
        const char *dst = temp_sprintf(RAYLIB_INC "/%s", h);

        int r = needs_rebuild1(dst, src);
        if (r < 0) {
            temp_rewind(mark);
            return false;
        }
        if (r == 0) continue;

        if (!copy_file(src, dst)) {
            temp_rewind(mark);
            return false;
        }
    }

    // Archive library if stale
    {
        int r = needs_rebuild(RAYLIB_LIB, objs, ARRAY_LEN(objs));
        if (r < 0) {
            temp_rewind(mark);
            return false;
        }
        if (r == 1) {
            Cmd cmd = {0};
#if defined(__APPLE__)
            cmd_append(&cmd, "libtool", "-static", "-o", RAYLIB_LIB);
#else
            cmd_append(&cmd, "ar", "rcs", RAYLIB_LIB);
#endif
            for (size_t i = 0; i < ARRAY_LEN(objs); ++i) cmd_append(&cmd, objs[i]);
            if (!cmd_run(&cmd)) {
                temp_rewind(mark);
                return false;
            }
        }
    }

    temp_rewind(mark);
    return true;
}

static const char *path_base(const char *p)
{
    const char *s = strrchr(p, '/');
    return s ? s + 1 : p;
}

static bool build_native(Procs *procs, const Toolchain *tc)
{
    if (!mkdir_if_not_exists("./build/examples")) return false;
    for (size_t i = 0; i < ARRAY_LEN(examples); ++i) {
        size_t mark = temp_save();

        const char *example = examples[i];
        const char *basename = path_base(example);
        const char *src = temp_sprintf("./examples/%s.c", example);
        const char *out = temp_sprintf("./build/examples/%s%s", basename, EXE_EXT);

        const char *inputs[] = {src, RAYLIB_LIB};
        int r = needs_rebuild(out, inputs, ARRAY_LEN(inputs));
        if (r < 0) {
            temp_rewind(mark);
            return false;
        }
        if (r == 0) {
            temp_rewind(mark);
            continue;
        }

        Cmd cmd = {0};
        cmd_append(&cmd, tc->native_cc, "-I" RAYLIB_INC);
        cmd_append(&cmd, "-o", out, src);
        cmd_append(&cmd, RAYLIB_LIB, "-lm");
        append_native_platform_libs(&cmd);

        if (!cmd_run(&cmd, .async = procs)) {
            temp_rewind(mark);
            return false;
        }
        temp_rewind(mark);
    }
    return true;
}

static bool build_wasm(Procs *procs, const Toolchain *tc)
{
    if (!mkdir_if_not_exists("./wasm")) return false;
    for (size_t i = 0; i < ARRAY_LEN(examples); ++i) {
        size_t mark = temp_save();

        const char *example = examples[i];
        const char *basename = path_base(example);
        const char *src = temp_sprintf("./examples/%s.c", example);
        const char *out = temp_sprintf("./wasm/%s.wasm", basename);

        int r = needs_rebuild1(out, src);
        if (r < 0) {
            temp_rewind(mark);
            return false;
        }
        if (r == 0) {
            temp_rewind(mark);
            continue;
        }

        Cmd cmd = {0};
        cmd_append(&cmd, tc->wasm_cc);
        append_wasm_flags(&cmd);
        cmd_append(&cmd, "-o", out, src);

        if (!cmd_run(&cmd, .async = procs)) {
            temp_rewind(mark);
            return false;
        }
        temp_rewind(mark);
    }
    return true;
}

int main(int argc, char **argv)
{
    GO_REBUILD_URSELF(argc, argv);

    Toolchain tc = resolve_toolchain();
    Procs procs = {0};

    if (!build_raylib(&procs, tc.native_cc)) return 1;
    if (!build_native(&procs, &tc)) return 1;
    if (!build_wasm(&procs, &tc)) return 1;

    if (!procs_flush(&procs)) return 1;
    return 0;
}
