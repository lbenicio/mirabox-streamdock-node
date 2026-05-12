import * as usb from "usb";
import { StreamDock } from "./streamdock";
import path from "path";

const VID = 0x6602;
const PID = 0x1000;

const imagesPath = path.join(process.cwd(), "images");

async function main() {
    const device = usb.findByIds(VID, PID);
    if (!device) {
        console.error("Device not found (VID=0x6602, PID=0x1000)");
        return;
    }
    device.open();

    const iface = device.interfaces?.[0];
    if (!iface) {
        console.error("Interface not found");
        return;
    }

    if (iface.isKernelDriverActive()) {
        console.log("Detaching kernel driver...");
        iface.detachKernelDriver();
    }

    iface.claim();
    console.log("Interface claimed");

    const inEndpoint: usb.InEndpoint = iface.endpoints?.find((ep) => ep.direction === "in") as usb.InEndpoint;
    const outEndpoint: usb.OutEndpoint = iface.endpoints?.find((ep) => ep.direction === "out") as usb.OutEndpoint;

    if (!inEndpoint || !outEndpoint) {
        console.error("Endpoints not found");
        return;
    }

    outEndpoint.transferType = usb.usb.LIBUSB_TRANSFER_TYPE_INTERRUPT;
    inEndpoint.transferType = usb.usb.LIBUSB_TRANSFER_TYPE_INTERRUPT;

    // Debug: show endpoint info
    console.log("Out endpoint:", {
        address: outEndpoint.descriptor.bEndpointAddress?.toString(16),
        maxPacketSize: outEndpoint.descriptor.wMaxPacketSize,
        pollInterval: outEndpoint.descriptor.bInterval,
    });
    console.log("In endpoint:", {
        address: inEndpoint.descriptor.bEndpointAddress?.toString(16),
        maxPacketSize: inEndpoint.descriptor.wMaxPacketSize,
        pollInterval: inEndpoint.descriptor.bInterval,
    });

    // Use out endpoint max packet size
    const packetSize = outEndpoint.descriptor.wMaxPacketSize;
    console.log("Using packet size:", packetSize);

    const sd = new StreamDock(
        {
            send(data: Buffer) {
                return new Promise<void>((resolve, reject) => {
                    console.log("TX:", [...data.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
                    outEndpoint.transfer(data, (error) => {
                        if (error) {
                            console.error("Error sending data", error);
                            reject();
                            return;
                        }
                        resolve();
                    });
                });
            },
            receive(byteSize = 512) {
                return new Promise<Buffer>((resolve, reject) => {
                    inEndpoint.transfer(byteSize, (error, data) => {
                        if (error) {
                            console.error("Error reading data", error);
                            reject();
                            return;
                        }
                        const buf = data ?? Buffer.alloc(0);
                        console.log(
                            "RX:",
                            [...buf.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
                        );
                        resolve(buf);
                    });
                });
            },
            controlTransfer(bmRequestType: number, bRequest: number, wValue: number, wIndex: number, wLength: number) {
                return new Promise<Buffer | number | undefined>((resolve, reject) => {
                    console.log(
                        `CTRL: bmReq=0x${bmRequestType.toString(16)} bReq=0x${bRequest.toString(16)} wVal=0x${wValue.toString(16)} wIdx=${wIndex} wLen=${wLength}`,
                    );
                    device.controlTransfer(bmRequestType, bRequest, wValue, wIndex, wLength, (error, data) => {
                        if (error) {
                            console.error("Control transfer error:", error);
                            reject();
                            return;
                        }
                        if (Buffer.isBuffer(data)) {
                            console.log(
                                "CTRL_RX:",
                                [...data.subarray(0, Math.min(32, data.length))]
                                    .map((b) => b.toString(16).padStart(2, "0"))
                                    .join(" "),
                            );
                        }
                        resolve(data);
                    });
                });
            },
        },
        packetSize,
    );

    // ========== STEP 0: Check HID report sizes ==========
    console.log("\n=== STEP 0: HID Report Info ===");
    try {
        // Try to read an input report directly (non-blocking, with timeout)
        const inputReport = await Promise.race([
            sd.receive(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
        if (inputReport) {
            console.log(
                "Got spontaneous input report:",
                [...inputReport.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
            );
        } else {
            console.log("No spontaneous input (device is quiet)");
        }
    } catch (e) {
        console.log("Read error:", e);
    }

    // ========== STEP 1: Get firmware version ==========
    console.log("\n=== STEP 1: Get Firmware Version ===");
    try {
        const version = await sd.getFirmwareVersion();
        console.log(`Firmware version: ${version}`);
    } catch (e) {
        console.log("Could not get firmware version:", e);
    }

    // ========== STEP 1.5: Send GET_INPUT_REPORT (like isOld293Version) ==========
    console.log("\n=== STEP 1.5: GET_INPUT_REPORT handshake ===");
    try {
        // isOld293Version() does this:
        // 1. Gets input report length
        // 2. Allocates and zeros buffer
        // 3. Sets byte 0 = report ID (from device config)
        // 4. Calls hid_get_input_report() which is GET_REPORT with wVal=0x0100
        // bmReq=0xa1 (device-to-host, class, interface)
        // bReq=0x01 (GET_REPORT)
        // wVal=0x0100 (report type 1=input, report ID 0)
        const inputData = await new Promise<Buffer>((resolve, reject) => {
            device.controlTransfer(0xa1, 0x01, 0x0100, 0, 512, (error, data) => {
                if (error) {
                    console.log("GET_INPUT_REPORT error:", error);
                    reject(error);
                    return;
                }
                console.log(
                    "GET_INPUT_REPORT raw:",
                    data ? [...data.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join(" ") : "empty",
                );
                resolve(data ?? Buffer.alloc(0));
            });
        });
        console.log("GET_INPUT_REPORT response length:", inputData.length);
    } catch (e) {
        console.log("GET_INPUT_REPORT failed:", e);
    }

    // ========== STEP 2: Try V2 wake ==========
    console.log("\n=== STEP 2: Wake Screen (V2 protocol) ===");
    try {
        await sd.wakeScreen();
        console.log("V2 wake sent");
        // Try to read response immediately
        const resp = await Promise.race([
            sd.receive(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);
        if (resp) {
            console.log(
                "Response after V2 wake:",
                [...resp.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
            );
        }
    } catch (e) {
        console.log("V2 wake error:", e);
    }

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // ========== STEP 3: Try V1 wake as fallback ==========
    console.log("\n=== STEP 3: Wake Screen (V1 protocol - fallback) ===");
    try {
        await sd.wakeScreenV1();
        console.log("V1 wake sent");
        const resp = await Promise.race([
            sd.receive(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);
        if (resp) {
            console.log(
                "Response after V1 wake:",
                [...resp.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
            );
        }
    } catch (e) {
        console.log("V1 wake error:", e);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    // ========== STEP 3.5: Try GET_INPUT_REPORT handshake ==========
    console.log("\n=== STEP 3.5: Try GET_INPUT_REPORT (like isOld293Version does) ===");
    try {
        // This is what isOld293Version() does - sends a zeroed input report request
        // bmReq=0xa1 (device-to-host, class, interface), bReq=0x01 (GET_REPORT)
        // wVal=0x0100 (report type 1=input, report ID 0)
        const data = await sd.getFeatureReport(0, 512); // Actually get input report
        if (data) {
            console.log(
                "Input report response:",
                [...data.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
            );
        }
    } catch (e) {
        console.log("Input report error:", e);
    }

    // ========== STEP 4: Clear and Refresh ==========
    console.log("\n=== STEP 4: Clear Screen & Refresh ===");
    await sd.clearScreen();
    console.log("Clear sent (V2)");
    await sd.refresh();
    console.log("Refresh sent (V2)");

    // ========== STEP 5: Set brightness ==========
    console.log("\n=== STEP 5: Set Brightness ===");
    await sd.setBrightness(0x64);
    console.log("Brightness set to 100 (V2)");

    // ========== STEP 6: Listen for key presses ==========
    console.log("\n=== Listening for key presses... ===");
    while (true) {
        try {
            const { keyId, state } = await sd.receiveKeyPress();
            console.log("Key", keyId, "state", state);
        } catch (e) {
            console.log("Receive error:", e);
            break;
        }
    }
}

main().catch(console.error);
