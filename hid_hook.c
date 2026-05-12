/*
 * hid_hook.c - Intercept hid_write calls to log USB packets
 * 
 * Compile:
 *   gcc -shared -o hid_hook.dylib hid_hook.c -ldl
 *
 * Usage:
 *   DYLD_INSERT_LIBRARIES=/path/to/hid_hook.dylib /Applications/StreamDock.app/Contents/MacOS/StreamDock
 *
 * Output goes to /tmp/hid_hook.log
 */

#include <stdio.h>
#include <dlfcn.h>
#include <stdint.h>
#include <unistd.h>

static FILE *logfile = NULL;

__attribute__((constructor))
static void init(void) {
    logfile = fopen("/tmp/hid_hook.log", "w");
    if (logfile) {
        fprintf(logfile, "=== HID Hook Started (pid=%d) ===\n", getpid());
        fflush(logfile);
    }
}

__attribute__((destructor))
static void fini(void) {
    if (logfile) {
        fprintf(logfile, "=== HID Hook Stopped ===\n");
        fclose(logfile);
    }
}

// Hook hid_write
int hid_write(void *device, const unsigned char *data, size_t length) {
    static int (*real_hid_write)(void *, const unsigned char *, size_t) = NULL;
    
    if (!real_hid_write) {
        real_hid_write = dlsym(RTLD_NEXT, "hid_write");
    }
    
    // Log the data
    if (logfile) {
        fprintf(logfile, "\nhid_write(len=%zu): ", length);
        for (size_t i = 0; i < length && i < 64; i++) {
            fprintf(logfile, "%02x ", data[i]);
        }
        if (length > 64) fprintf(logfile, "... (%zu more bytes)", length - 64);
        fprintf(logfile, "\n");
        
        // Also show ASCII for first 32 bytes
        fprintf(logfile, "  ASCII: \"");
        for (size_t i = 0; i < length && i < 32; i++) {
            if (data[i] >= 32 && data[i] < 127)
                fprintf(logfile, "%c", data[i]);
            else
                fprintf(logfile, ".");
        }
        fprintf(logfile, "\"\n");
        fflush(logfile);
    }
    
    return real_hid_write(device, data, length);
}

// Hook hid_read  
int hid_read(void *device, unsigned char *data, size_t length) {
    static int (*real_hid_read)(void *, unsigned char *, size_t) = NULL;
    
    if (!real_hid_read) {
        real_hid_read = dlsym(RTLD_NEXT, "hid_read");
    }
    
    int result = real_hid_read(device, data, length);
    
    if (logfile) {
        fprintf(logfile, "hid_read(len=%zu) -> %d: ", length, result);
        if (result > 0) {
            for (int i = 0; i < result && i < 64; i++) {
                fprintf(logfile, "%02x ", data[i]);
            }
            if (result > 64) fprintf(logfile, "... (%d more bytes)", result - 64);
        }
        fprintf(logfile, "\n");
        fflush(logfile);
    }
    
    return result;
}

// Hook hid_send_feature_report
int hid_send_feature_report(void *device, const unsigned char *data, size_t length) {
    static int (*real_fn)(void *, const unsigned char *, size_t) = NULL;
    
    if (!real_fn) {
        real_fn = dlsym(RTLD_NEXT, "hid_send_feature_report");
    }
    
    if (logfile) {
        fprintf(logfile, "\nhid_send_feature_report(len=%zu): ", length);
        for (size_t i = 0; i < length && i < 64; i++) {
            fprintf(logfile, "%02x ", data[i]);
        }
        if (length > 64) fprintf(logfile, "...");
        fprintf(logfile, "\n");
        fflush(logfile);
    }
    
    return real_fn(device, data, length);
}
