import { devices, HID } from "node-hid";

const VID = 0x6602;
const PID = 0x1000;

async function main() {
    const phys = devices().filter((d) => d.vendorId === VID && d.productId === PID);
    console.log("Found", phys.length, "device(s):");
    phys.forEach((d, i) =>
        console.log(
            `  ${i}: iface=${d.interface} usagePage=0x${d.usagePage?.toString(16)} path=${d.path?.substring(0, 40)}`,
        ),
    );

    // Open the screen interface (iface=0, usagePage=0xffa0)
    const dev = phys.find((d) => d.interface === 0 && d.usagePage === 0xffa0);
    if (!dev || !dev.path) {
        console.log("Screen interface not found");
        return;
    }

    const hid = new HID(dev.path);
    console.log("\nOpened:", dev.product);

    // Send V2 wake
    const cmd = Buffer.alloc(1024);
    cmd[0] = 0x00;
    cmd[1] = 0x43;
    cmd[2] = 0x52;
    cmd[3] = 0x54;
    cmd[6] = 0x44;
    cmd[7] = 0x49;
    cmd[8] = 0x53;
    console.log("Sending V2 wake (1024 bytes)...");
    const written = hid.write(cmd);
    console.log(`Wrote ${written} bytes`);

    // Read in a loop (HID reads are synchronous, so poll with timeout)
    console.log("Listening for data (press keys)...\n");
    let count = 0;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        const data = hid.readTimeout(500);
        if (data && data.length > 0) {
            count++;
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const hex = buf.toString("hex");
            console.log(`#${count}: ${hex.substring(0, 80)} (${buf.length}B)`);
        }
    }
    console.log(`\nDone. Received ${count} messages.`);
    hid.close();
}

main().catch(console.error);
