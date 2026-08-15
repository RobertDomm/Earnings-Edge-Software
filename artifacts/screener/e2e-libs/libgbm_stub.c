/*
 * libgbm_stub.c — minimal no-op stub of libgbm.so.1
 *
 * The Replit NixOS sandbox does not expose a system libgbm.so.1, so
 * Chromium's headless-shell fails to dlopen it.  This stub exports every
 * GBM symbol that a recent Chromium headless-shell references, all
 * returning 0 / NULL, which is enough for --disable-gpu mode where the
 * GBM codepath is never actually executed.
 *
 * Build (done automatically by scripts/prepare-e2e.sh):
 *   gcc -shared -fPIC -o libgbm.so.1 libgbm_stub.c \
 *       -Wl,-soname,libgbm.so.1 -nostartfiles
 */

#include <stdint.h>
#include <stddef.h>

/* ── opaque handle types ─────────────────────────────────────────────── */
typedef struct gbm_device  gbm_device;
typedef struct gbm_bo      gbm_bo;
typedef struct gbm_surface gbm_surface;

typedef union {
    void    *ptr;
    uint32_t u32;
    int32_t  s32;
    uint64_t u64;
    int64_t  s64;
    int      fd;
} gbm_bo_handle;

/* ── device ──────────────────────────────────────────────────────────── */
gbm_device *gbm_create_device(int fd)                              { (void)fd;  return NULL; }
void        gbm_device_destroy(gbm_device *gbm)                    { (void)gbm; }
int         gbm_device_get_fd(gbm_device *gbm)                     { (void)gbm; return -1; }
const char *gbm_device_get_backend_name(gbm_device *gbm)           { (void)gbm; return "stub"; }
int         gbm_device_is_format_supported(gbm_device *gbm,
                                            uint32_t fmt, uint32_t usage)
                                                                    { (void)gbm; (void)fmt; (void)usage; return 0; }
int         gbm_device_get_format_modifier_plane_count(gbm_device *gbm,
                                                        uint32_t fmt, uint64_t mod)
                                                                    { (void)gbm; (void)fmt; (void)mod; return 0; }

/* ── buffer objects ──────────────────────────────────────────────────── */
gbm_bo *gbm_bo_create(gbm_device *gbm, uint32_t w, uint32_t h,
                       uint32_t fmt, uint32_t flags)
                                                                    { (void)gbm;(void)w;(void)h;(void)fmt;(void)flags; return NULL; }
gbm_bo *gbm_bo_create_with_modifiers(gbm_device *gbm, uint32_t w, uint32_t h,
                                      uint32_t fmt,
                                      const uint64_t *mods, unsigned int cnt)
                                                                    { (void)gbm;(void)w;(void)h;(void)fmt;(void)mods;(void)cnt; return NULL; }
gbm_bo *gbm_bo_create_with_modifiers2(gbm_device *gbm, uint32_t w, uint32_t h,
                                       uint32_t fmt,
                                       const uint64_t *mods, unsigned int cnt,
                                       uint32_t flags)
                                                                    { (void)gbm;(void)w;(void)h;(void)fmt;(void)mods;(void)cnt;(void)flags; return NULL; }
gbm_bo *gbm_bo_import(gbm_device *gbm, uint32_t type, void *buf, uint32_t usage)
                                                                    { (void)gbm;(void)type;(void)buf;(void)usage; return NULL; }
void    gbm_bo_destroy(gbm_bo *bo)                                  { (void)bo; }

uint32_t        gbm_bo_get_width(gbm_bo *bo)                       { (void)bo; return 0; }
uint32_t        gbm_bo_get_height(gbm_bo *bo)                      { (void)bo; return 0; }
uint32_t        gbm_bo_get_stride(gbm_bo *bo)                      { (void)bo; return 0; }
uint32_t        gbm_bo_get_stride_for_plane(gbm_bo *bo, int plane) { (void)bo;(void)plane; return 0; }
uint32_t        gbm_bo_get_format(gbm_bo *bo)                      { (void)bo; return 0; }
uint32_t        gbm_bo_get_bpp(gbm_bo *bo)                         { (void)bo; return 0; }
uint64_t        gbm_bo_get_offset(gbm_bo *bo, int plane)           { (void)bo;(void)plane; return 0; }
uint64_t        gbm_bo_get_modifier(gbm_bo *bo)                    { (void)bo; return 0; }
int             gbm_bo_get_plane_count(gbm_bo *bo)                 { (void)bo; return 0; }
gbm_device     *gbm_bo_get_device(gbm_bo *bo)                      { (void)bo; return NULL; }
int             gbm_bo_get_fd(gbm_bo *bo)                          { (void)bo; return -1; }
int             gbm_bo_get_fd_for_plane(gbm_bo *bo, int plane)     { (void)bo;(void)plane; return -1; }
gbm_bo_handle   gbm_bo_get_handle(gbm_bo *bo)                      { (void)bo; gbm_bo_handle h = {0}; return h; }
gbm_bo_handle   gbm_bo_get_handle_for_plane(gbm_bo *bo, int plane) { (void)bo;(void)plane; gbm_bo_handle h = {0}; return h; }

void *gbm_bo_map(gbm_bo *bo, uint32_t x, uint32_t y,
                  uint32_t w, uint32_t h, uint32_t flags,
                  uint32_t *stride, void **map_data)
                                                                    { (void)bo;(void)x;(void)y;(void)w;(void)h;(void)flags;(void)stride;(void)map_data; return NULL; }
void  gbm_bo_unmap(gbm_bo *bo, void *map_data)                     { (void)bo;(void)map_data; }
int   gbm_bo_write(gbm_bo *bo, const void *buf, size_t count)      { (void)bo;(void)buf;(void)count; return -1; }
void  gbm_bo_set_user_data(gbm_bo *bo, void *data,
                             void (*destroy)(gbm_bo *, void *))     { (void)bo;(void)data;(void)destroy; }
void *gbm_bo_get_user_data(gbm_bo *bo)                             { (void)bo; return NULL; }

/* ── surfaces ────────────────────────────────────────────────────────── */
gbm_surface *gbm_surface_create(gbm_device *gbm, uint32_t w, uint32_t h,
                                  uint32_t fmt, uint32_t flags)
                                                                    { (void)gbm;(void)w;(void)h;(void)fmt;(void)flags; return NULL; }
gbm_surface *gbm_surface_create_with_modifiers(gbm_device *gbm,
                                                uint32_t w, uint32_t h,
                                                uint32_t fmt,
                                                const uint64_t *mods,
                                                unsigned int cnt)
                                                                    { (void)gbm;(void)w;(void)h;(void)fmt;(void)mods;(void)cnt; return NULL; }
gbm_surface *gbm_surface_create_with_modifiers2(gbm_device *gbm,
                                                 uint32_t w, uint32_t h,
                                                 uint32_t fmt,
                                                 const uint64_t *mods,
                                                 unsigned int cnt,
                                                 uint32_t flags)
                                                                    { (void)gbm;(void)w;(void)h;(void)fmt;(void)mods;(void)cnt;(void)flags; return NULL; }
void    gbm_surface_destroy(gbm_surface *surf)                      { (void)surf; }
gbm_bo *gbm_surface_lock_front_buffer(gbm_surface *surf)           { (void)surf; return NULL; }
void    gbm_surface_release_buffer(gbm_surface *surf, gbm_bo *bo)  { (void)surf;(void)bo; }
int     gbm_surface_has_free_buffers(gbm_surface *surf)            { (void)surf; return 0; }
