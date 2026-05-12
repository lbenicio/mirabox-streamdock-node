import * as usb from "usb";

const VID = 0x6602;
const PID = 0x1000;

async function main() {
    const device = usb.findByIds(VID, PID);
    if (!device) {
        console.error("Device not found");
        return;
    }
    device.open();

    const iface = device.interfaces?.[0];
    if (!iface) {
        console.error("No interface 0");
        return;
    }
    if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    iface.claim();

    const inEp = iface.endpoints?.find((e) => e.direction === "in") as usb.InEndpoint;
    const outEp = iface.endpoints?.find((e) => e.direction === "out") as usb.OutEndpoint;
    if (!inEp || !outEp) {
        console.error("Endpoints missing");
        return;
    }
    outEp.transferType = usb.usb.LIBUSB_TRANSFER_TYPE_INTERRUPT;
    inEp.transferType = usb.usb.LIBUSB_TRANSFER_TYPE_INTERRUPT;

    inEp.startPoll(3, 512);
    inEp.on("data", (d: Buffer) => {
        const hex = d.toString("hex");
        const asc = [...d.subarray(0, 40)].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        console.log(`IN ${d.length}B: ${hex.substring(0, 120)}`);
        console.log(`   ASC: ${asc}`);
    });
    inEp.on("error", (e: Error) => console.log("IN err:", e.message));

    // Build 1025-byte packet EXACTLY like the app
    function pkt(hex: string): Buffer {
        const b = Buffer.alloc(1025);
        const raw = Buffer.from(hex, "hex");
        raw.copy(b);
        return b;
    }

    function send(name: string, hex: string) {
        return new Promise<void>((resolve) => {
            outEp.transfer(pkt(hex), (e) => {
                console.log(`${name}: ${e ? "ERR " + e : "OK"}`);
                resolve();
            });
        });
    }

    await new Promise((r) => setTimeout(r, 300));

    // === CORRECT WAKE SEQUENCE ===
    // CONNECT = init handshake (from app capture)
    // DIS = wake screen (from binary)
    // HAN = screen OFF - we SKIP this!

    console.log("\n--- CONNECT ---");
    await send("CONNECT #1", "004352540000434f4e4e454354");
    await send("CONNECT #2", "004352540000434f4e4e454354");

    console.log("\n--- CLE..DC ---");
    await send("CLE..DC", "004352540000434c4500004443");

    console.log("\n--- DIS (wake) ---");
    await send("DIS", "004352540000444953");

    console.log("\n--- STP (refresh) ---");
    await send("STP", "004352540000535450");

    console.log("\n--- Brightness ---");
    await send("LIG", "0043525400004c4947000064");

    console.log("\nDone! Press keys. Screen should be on.\n");
    await new Promise(() => {});
}

main().catch(console.error);
