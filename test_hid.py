#!/usr/bin/env python3
"""Replay the EXACT startup bytes captured from the StreamDock app.

This replays writes #1-#33 from the lldb capture:
  DIS -> LIGx2 -> CLE..FF -> 6 keys of BAT+JPEG -> STP
"""

import ctypes
import re
import sys
import time

hidapi = ctypes.CDLL("/opt/homebrew/lib/libhidapi.dylib")


class HidDeviceInfo(ctypes.Structure):
    pass


HidDeviceInfo._fields_ = [
    ("path", ctypes.c_char_p),
    ("vendor_id", ctypes.c_ushort),
    ("product_id", ctypes.c_ushort),
    ("serial_number", ctypes.c_wchar_p),
    ("release_number", ctypes.c_ushort),
    ("manufacturer_string", ctypes.c_wchar_p),
    ("product_string", ctypes.c_wchar_p),
    ("usage_page", ctypes.c_ushort),
    ("usage", ctypes.c_ushort),
    ("interface_number", ctypes.c_int),
    ("next", ctypes.POINTER(HidDeviceInfo)),
]

hidapi.hid_init()
hidapi.hid_enumerate.restype = ctypes.POINTER(HidDeviceInfo)
hidapi.hid_open_path.restype = ctypes.c_void_p
hidapi.hid_write.restype = ctypes.c_int
hidapi.hid_write.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_ubyte),
    ctypes.c_size_t,
]
hidapi.hid_close.argtypes = [ctypes.c_void_p]


def load_captured_writes():
    """Parse hid_all.log and extract all startup writes (#1 through STP)"""
    with open("/tmp/hid_all.log") as f:
        content = f.read()

    writes = []
    for match in re.finditer(r"hid_write len=(\d+):\nHEX: (.+?)\n", content):
        hexstr = match.group(2).replace(" ", "")
        data = bytes.fromhex(hexstr)
        writes.append(data)
        # Stop at STP (write #33 - before the shutdown CONNECT sequence)
        if b"CRT" in data[:8] and b"STP" in data[:12]:
            break
    return writes


# === MAIN ===
writes = load_captured_writes()
print(f"Loaded {len(writes)} captured writes from app startup")

# Show what we're replaying
for i, w in enumerate(writes):
    preview = "".join(chr(b) if 32 <= b < 127 else "." for b in w[:15])
    print(f"  #{i + 1}: {len(w)}B [{preview}]")

info = hidapi.hid_enumerate(0x6602, 0x1000)
while info:
    dev = info.contents
    if dev.usage_page == 0xFFA0 and dev.interface_number == 0:
        print(f"\nOpening device...")
        handle = hidapi.hid_open_path(dev.path)
        if not handle:
            print("Failed to open!")
            break

        print(f"Replaying {len(writes)} writes...")
        for i, data in enumerate(writes):
            cmd = (ctypes.c_ubyte * 1025)()
            for j, b in enumerate(data[:1025]):
                cmd[j] = b
            ret = hidapi.hid_write(handle, cmd, 1025)
            if ret < 0:
                print(f"  #{i + 1}: ERROR (ret={ret})")
                break
            # Progress dots for JPEG chunks
            if b"JFIF" in data[:20]:
                print(f"  #{i + 1}: JPEG chunk")
            elif i < 5:
                preview = "".join(chr(b) if 32 <= b < 127 else "." for b in data[:15])
                print(f"  #{i + 1}: {preview}")
            time.sleep(0.01)

        print(f"\nDone! Screen should show your layout.")
        hidapi.hid_close(handle)
        break
    info = dev.next

if not info:
    print("Device not found. Is keyboard plugged in?")

hidapi.hid_exit()
