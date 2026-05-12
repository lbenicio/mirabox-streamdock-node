#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <hidapi/hidapi.h>

#define VID 0x6602
#define PID 0x1000
#define PACKET_SIZE 1025
#define MAX_WRITES 64

static unsigned char startup_data[MAX_WRITES][PACKET_SIZE];
static int startup_count = 0;

static int load_startup_data(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "Cannot open %s\n", path); return -1; }
    startup_count = 0;
    while (startup_count < MAX_WRITES) {
        if (fread(startup_data[startup_count], 1, PACKET_SIZE, f) != PACKET_SIZE) break;
        startup_count++;
    }
    fclose(f);
    printf("Loaded %d startup writes from %s\n", startup_count, path);
    return 0;
}

static int send_startup(hid_device *handle) {
    for (int i = 0; i < startup_count; i++) {
        if (hid_write(handle, startup_data[i], PACKET_SIZE) < 0) {
            fprintf(stderr, "Write %d failed\n", i + 1);
            return -1;
        }
        usleep(5000); /* 5ms delay between packets */
    }
    return 0;
}

static void send_off(hid_device *handle) {
    unsigned char cmd[PACKET_SIZE] = {0};
    /* CONNECT */ cmd[0]=0x00; cmd[1]=0x43; cmd[2]=0x52; cmd[3]=0x54;
    cmd[6]=0x43; cmd[7]=0x4F; cmd[8]=0x4E; cmd[9]=0x4E; cmd[10]=0x45; cmd[11]=0x43; cmd[12]=0x54;
    hid_write(handle, cmd, PACKET_SIZE); hid_write(handle, cmd, PACKET_SIZE);
    /* CLE..DC */ memset(cmd, 0, PACKET_SIZE); cmd[0]=0x00; cmd[1]=0x43; cmd[2]=0x52; cmd[3]=0x54;
    cmd[6]=0x43; cmd[7]=0x4C; cmd[8]=0x45; cmd[11]=0x44; cmd[12]=0x43;
    hid_write(handle, cmd, PACKET_SIZE);
    /* HAN */ memset(cmd, 0, PACKET_SIZE); cmd[0]=0x00; cmd[1]=0x43; cmd[2]=0x52; cmd[3]=0x54;
    cmd[6]=0x48; cmd[7]=0x41; cmd[8]=0x4E;
    hid_write(handle, cmd, PACKET_SIZE);
    /* CLE..DC */ memset(cmd, 0, PACKET_SIZE); cmd[0]=0x00; cmd[1]=0x43; cmd[2]=0x52; cmd[3]=0x54;
    cmd[6]=0x43; cmd[7]=0x4C; cmd[8]=0x45; cmd[11]=0x44; cmd[12]=0x43;
    hid_write(handle, cmd, PACKET_SIZE);
    printf("Screen off.\n");
}

static void send_wake(hid_device *handle) {
    unsigned char cmd[PACKET_SIZE] = {0};
    /* DIS */ cmd[0]=0x00; cmd[1]=0x43; cmd[2]=0x52; cmd[3]=0x54; cmd[6]=0x44; cmd[7]=0x49; cmd[8]=0x53;
    hid_write(handle, cmd, PACKET_SIZE); usleep(5000);
    /* LIG */ memset(cmd, 0, PACKET_SIZE); cmd[0]=0x00; cmd[1]=0x43; cmd[2]=0x52; cmd[3]=0x54;
    cmd[6]=0x4C; cmd[7]=0x49; cmd[8]=0x47; cmd[11]=0x64;
    hid_write(handle, cmd, PACKET_SIZE); usleep(5000);
    /* STP */ memset(cmd, 0, PACKET_SIZE); cmd[0]=0x00; cmd[1]=0x43; cmd[2]=0x52; cmd[3]=0x54;
    cmd[6]=0x53; cmd[7]=0x54; cmd[8]=0x50;
    hid_write(handle, cmd, PACKET_SIZE);
    printf("Screen on.\n");
}

int main(int argc, char **argv) {
    if (hid_init() != 0) { fprintf(stderr, "hid_init failed\n"); return 1; }

    struct hid_device_info *devs = hid_enumerate(VID, PID), *dev;
    hid_device *handle = NULL;
    for (dev = devs; dev; dev = dev->next)
        if (dev->usage_page == 0xffa0 && dev->interface_number == 0)
            handle = hid_open_path(dev->path);
    hid_free_enumeration(devs);

    if (!handle) { fprintf(stderr, "Device not found\n"); hid_exit(); return 1; }

    if (argc > 1 && strcmp(argv[1], "--off") == 0)
        send_off(handle);
    else if (argc > 1 && strcmp(argv[1], "--wake") == 0)
        send_wake(handle);
    else if (load_startup_data("startup_blob.bin") == 0)
        { printf("Replaying...\n"); send_startup(handle); printf("Done!\n"); }
    else
        { printf("Falling back to wake-only\n"); send_wake(handle); }

    hid_close(handle);
    hid_exit();
    return 0;
}
