import { readFile } from "fs/promises";
import { intToRGBA, Jimp } from "jimp";

function sizeBytes(size: number, bytes = 4) {
    const sizeBytes = size.toString(16).padStart(bytes * 2, "0");
    return Buffer.from(sizeBytes, "hex");
}

export interface USBBackend {
    send(data: Buffer): Promise<void>;
    receive(byteSize?: number): Promise<Buffer>;
    controlTransfer(
        bmRequestType: number,
        bRequest: number,
        wValue: number,
        wIndex: number,
        wLength: number,
    ): Promise<Buffer | number | undefined>;
}

class SimpleMutex {
    private mutex = false;
    private _unlock?: () => void;
    private _currentPromise?: Promise<void>;

    async lock() {
        if (this.mutex) {
            await this._currentPromise;
        }
        this.mutex = true;
        this._currentPromise = new Promise((resolve) => (this._unlock = resolve));
    }

    unlock() {
        this.mutex = false;
        this._unlock?.();
    }
}

export class StreamDock {
    // ---- OLD protocol (v1) ----
    // Prefix: [0x00, 0x43, 0x52, 0x54] = "\0CRT"
    // Commands follow after the prefix
    private static CMD_PREFIX_V1 = [0x0, 0x43, 0x52, 0x54];
    private static CRT_LIG_V1 = (value: number) => [0x4c, 0x49, 0x47, 0x00, 0x00, value];
    private static CRT_CLE_V1 = (target: number) => [0x43, 0x4c, 0x45, 0x00, 0x00, 0x00, target];
    private static CRT_DIS2_V1 = () => [0x28, 0x43, 0x52, 0x54, 0x44, 0x49, 0x53];
    private static CRT_DIS_V1 = () => [0x28, 0x44, 0x49, 0x53];
    private static CRT_STP_V1 = () => [0x53, 0x54, 0x50];
    private static CRT_BAT_V1 = (size: number, keyId: number) => [0x42, 0x41, 0x54, ...sizeBytes(size, 4), keyId];
    private static CRT_LOG_V1 = () => [0x4c, 0x4f, 0x47, 0x00, 0x11, 0x94, 0x00, 0x01];

    // ---- NEW protocol (v2) - reverse engineered from libSDLibrary 1.0.25 ----
    // Commands embed "CRT" at the beginning:
    // Format: [0x43, 0x52, 0x54, 0x00, 0x00, CMD1, CMD2, CMD3, ...data...]
    // The full packet is padded to 512 bytes (or whatever getMaxPacket returns)
    private static CRT_HEADER = [0x43, 0x52, 0x54, 0x00, 0x00];

    // V2 Commands (CRT is embedded at offset 0, command at offset 5):
    private static CMD_STP_V2 = () => [...StreamDock.CRT_HEADER, 0x53, 0x54, 0x50]; // CRT\0\0STP = refresh
    private static CMD_CLE_V2 = (keyIndex: number) => [
        ...StreamDock.CRT_HEADER,
        0x43,
        0x4c,
        0x45,
        0x00,
        0x00,
        0x00,
        keyIndex,
    ]; // CRT\0\0CLE\0\0\0<K>
    private static CMD_QUC_V2 = (p1: number, p2: number, p3: number, p4: number, p5: number) => [
        ...StreamDock.CRT_HEADER,
        0x51,
        0x55,
        0x43,
        p1,
        p2,
        p3,
        p4,
        p5,
    ]; // CRT\0\0QUC + 5 bytes
    private static CMD_UL_V2 = () => [...StreamDock.CRT_HEADER, 0x55, 0x4c, 0x00]; // CRT\0\0UL\0 = upload finished

    // V2 wake command: CRT\0\0DIS = wake screen
    // Decoded from addWakeUpScreenPack() in libSDLibrary
    private static CMD_WAKE_V2 = () => [0x43, 0x52, 0x54, 0x00, 0x00, 0x44, 0x49, 0x53]; // CRT\0\0DIS

    // V2 screen-off command: CRT..HAN = hibernate/sleep screen
    // Decoded from sendScreenOffPack() in libSDLibrary
    private static CMD_SLEEP_V2 = () => [0x43, 0x52, 0x54, 0x00, 0x00, 0x48, 0x41, 0x4e]; // CRT\0\0HAN

    // Legacy brightness command (may still work with V1 prefix)
    private static CRT_LIG_V2 = (value: number) => [...StreamDock.CRT_HEADER, 0x4c, 0x49, 0x47, 0x00, 0x00, value]; // CRT\0\0LIG\0\0<V>

    // Legacy BAT command (for image transfer)
    private static CMD_BAT_V2 = (size: number, keyId: number) => [
        ...StreamDock.CRT_HEADER,
        0x42,
        0x41,
        0x54,
        ...sizeBytes(size, 4),
        keyId,
    ]; // CRT\0\0BAT<size><key>

    // Legacy LOG command (for boot image)
    private static CMD_LOG_V2 = () => [...StreamDock.CRT_HEADER, 0x4c, 0x4f, 0x47, 0x00, 0x11, 0x94, 0x00, 0x01]; // CRT\0\0LOG...
    private static KEY_MAP = {
        0x1: 0x0b,
        0x2: 0x0c,
        0x3: 0x0d,
        0x4: 0x0e,
        0x5: 0x0f,
        0x6: 0x06,
        0x7: 0x07,
        0x8: 0x08,
        0x9: 0x09,
        0xa: 0x0a,
        0xb: 0x01,
        0xc: 0x02, //
        0xd: 0x03,
        0xe: 0x04,
        0xf: 0x05,
    };

    private packetSize: number;

    private mutex = new SimpleMutex();

    private backend: USBBackend;
    constructor(backend: USBBackend, packetSize = 1024) {
        this.backend = backend;
        this.packetSize = packetSize;
    }

    async receive(): Promise<Buffer> {
        // Device sends 512-byte input reports (per HID report descriptor)
        return this.backend.receive(512);
    }

    async send2(data: Buffer | Array<number>): Promise<void> {
        await this.mutex.lock();
        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data);
        }

        // pad with zeros to fill the packet.
        data = Buffer.concat([data, Buffer.alloc(this.packetSize - data.length)]);

        await this.backend.send(Buffer.from([...data]));
        this.mutex.unlock();
    }

    // V1 send: prepends the \0CRT prefix and pads
    async sendV1(data: Buffer | Array<number>): Promise<void> {
        return this.sendRaw(data, StreamDock.CMD_PREFIX_V1);
    }

    // V2 send: commands contain CRT header, prepend report ID [0x00]
    private static REPORT_ID = [0x00];
    async sendV2(data: Buffer | Array<number>): Promise<void> {
        return this.sendRaw(data, StreamDock.REPORT_ID); // [0x00] + CRT\0\0XXX
    }

    // Send with explicit prefix (for protocol experimentation)
    async send(data: Buffer | Array<number>, prefix = StreamDock.CMD_PREFIX_V1): Promise<void> {
        return this.sendRaw(data, prefix);
    }

    private async sendRaw(data: Buffer | Array<number>, prefix: Array<number>): Promise<void> {
        await this.mutex.lock();
        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data);
        }

        // Build packet: prefix + data, then pad with zeros to fill the packet.
        const packet = Buffer.from([...prefix, ...data]);
        const fullPacket = Buffer.concat([packet, Buffer.alloc(this.packetSize - packet.length)]);

        await this.backend.send(fullPacket);
        this.mutex.unlock();
    }

    async getFirmwareVersion(): Promise<string | undefined> {
        // Feature report: bmRequestType=0xA1 (device-to-host, class, interface)
        // bRequest=0x01 (GET_REPORT), wValue=0x0100 (report ID 0, report type 1=feature)
        const data = await this.backend.controlTransfer(0xa1, 0x01, 0x0300, 0, 512);

        if (!Buffer.isBuffer(data)) {
            console.error("Invalid firmware version data");
            return;
        }

        return data.toString("utf-8");
    }

    /**
     * Send a feature report to the device (control transfer).
     * The report data should include a report ID byte as the first byte.
     * Newer firmware versions use feature reports for handshaking.
     */
    async sendFeatureReport(reportId: number, data: Buffer | Array<number>): Promise<number | undefined> {
        const buf = Buffer.from([reportId, ...(Array.isArray(data) ? data : [...data])]);
        const result = await this.backend.controlTransfer(0x21, 0x09, reportId | 0x0300, 0, buf.length);
        // Send the actual data as well
        await this.backend.send(buf);
        return typeof result === "number" ? result : undefined;
    }

    /**
     * Get a feature report from the device.
     */
    async getFeatureReport(reportId: number, length = 512): Promise<Buffer | undefined> {
        const data = await this.backend.controlTransfer(0xa1, 0x01, reportId | 0x0300, 0, length);
        if (!Buffer.isBuffer(data)) {
            console.error("Invalid feature report data");
            return;
        }
        return data;
    }

    async sendBytes(
        data: Buffer | Array<number>,
        prefix: Array<number> = StreamDock.CMD_PREFIX_V1,
        chunkSize?: number,
    ): Promise<void> {
        if (chunkSize === undefined) chunkSize = this.packetSize;
        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data);
        }

        let offset = 0;
        while (offset < data.length) {
            const max = Math.min(offset + chunkSize, data.length);
            const chunk = data.subarray(offset, max);

            await this.sendRaw(chunk, prefix);

            offset += chunkSize;
        }
    }

    async wakeScreen(): Promise<any> {
        // Try V2 wake command first: (CRT\0DIS
        await this.sendV2(StreamDock.CMD_WAKE_V2());
    }

    async wakeScreenV1(): Promise<any> {
        // Original V1 wake command
        await this.sendV1(StreamDock.CRT_DIS2_V1());
    }

    async clearScreen(): Promise<void> {
        // V2 clear all command: CRT\0\0CLE...0xFF
        await this.sendV2(StreamDock.CMD_CLE_V2(0xff));
    }

    async clearScreenV1(): Promise<void> {
        await this.sendV1(StreamDock.CRT_CLE_V1(0xff));
    }

    async refresh(): Promise<void> {
        // V2 refresh: CRT\0\0STP
        await this.sendV2(StreamDock.CMD_STP_V2());
    }

    async refreshV1(): Promise<void> {
        await this.sendV1(StreamDock.CRT_STP_V1());
    }

    async setBrightness(value: number): Promise<void> {
        // Try V2 brightness command
        await this.sendV2(StreamDock.CRT_LIG_V2(value));
    }

    async setBrightnessV1(value: number): Promise<void> {
        await this.sendV1(StreamDock.CRT_LIG_V1(value));
    }

    private getImageBuffer(image: string | Buffer): Buffer | Promise<Buffer> {
        if (typeof image === "string") {
            return readFile(image);
        }
        return image;
    }

    async setKeyImage(key: number, image: string | Buffer): Promise<void> {
        const imgBuffer = await this.getImageBuffer(image);
        const img = (await Jimp.fromBuffer(imgBuffer))
            .resize({
                w: 100,
                h: 100,
            })
            .rotate(180);

        const imgData = await img.getBuffer("image/jpeg", {
            quality: 100,
        });

        // Try V2 BAT command
        await this.sendV2(StreamDock.CMD_BAT_V2(imgData.length, key));
        await this.sendBytes(imgData, StreamDock.REPORT_ID); // V2: report ID prefix on data chunks
        await this.refresh();
    }

    async setKeyImageV1(key: number, image: string | Buffer): Promise<void> {
        const imgBuffer = await this.getImageBuffer(image);
        const img = (await Jimp.fromBuffer(imgBuffer))
            .resize({
                w: 100,
                h: 100,
            })
            .rotate(180);

        const imgData = await img.getBuffer("image/jpeg", {
            quality: 100,
        });

        await this.sendV1(StreamDock.CRT_BAT_V1(imgData.length, key));
        await this.sendBytes(imgData);
        await this.refreshV1();
    }

    async clearKeyImage(key: number): Promise<void> {
        // V2 clear single key: CRT\0\0CLE...<key>
        await this.sendV2(StreamDock.CMD_CLE_V2(key));
    }

    async clearKeyImageV1(key: number): Promise<void> {
        await this.sendV1(StreamDock.CRT_CLE_V1(key));
    }

    async receiveKeyPress() {
        const res = await this.receive();

        // Debug: log raw packet to see if format changed
        console.log(
            "Raw input:",
            [...res.subarray(0, 16)].map((b) => "0x" + b.toString(16).padStart(2, "0")).join(" "),
        );

        return {
            keyId: StreamDock.KEY_MAP[res[9] as keyof typeof StreamDock.KEY_MAP],
            state: res[10],
        };
    }

    /**
     * Attempt to detect protocol version by sending V2 wake command.
     * If device responds, we're on V2. Otherwise fall back to V1.
     */
    async detectProtocol(): Promise<"v1" | "v2"> {
        // Try to get firmware version via feature report (this works on both?)
        try {
            const version = await this.getFirmwareVersion();
            if (version) {
                console.log("Firmware:", version);
            }
        } catch (e) {
            console.log("Could not get firmware version via feature report");
        }

        // Try V2 wake
        console.log("Trying V2 wake...");
        await this.wakeScreen();

        // Give device time to respond
        await new Promise((resolve) => setTimeout(resolve, 500));

        return "v2"; // assume V2 for now; can be extended with actual detection
    }

    async setBootImage(image: string | Buffer): Promise<void> {
        const imgBuffer = await this.getImageBuffer(image);
        const img = (await Jimp.fromBuffer(imgBuffer))
            .resize({
                w: 800,
                h: 480,
            })
            .rotate(180);

        const imgData = Buffer.alloc(800 * 480 * 3);
        img.scan((x, y) => {
            const color = intToRGBA(img.getPixelColor(x, y));
            const pixelIndex = (y * img.bitmap.width + x) * 3;

            imgData[pixelIndex] = color.b;
            imgData[pixelIndex + 1] = color.g;
            imgData[pixelIndex + 2] = color.r;
        });

        // Try V2 LOG command
        await this.sendV2(StreamDock.CMD_LOG_V2());
        await this.sendBytes(imgData, StreamDock.REPORT_ID);
        await this.refresh();
    }

    async setBootImageV1(image: string | Buffer): Promise<void> {
        const imgBuffer = await this.getImageBuffer(image);
        const img = (await Jimp.fromBuffer(imgBuffer))
            .resize({
                w: 800,
                h: 480,
            })
            .rotate(180);

        const imgData = Buffer.alloc(800 * 480 * 3);
        img.scan((x, y) => {
            const color = intToRGBA(img.getPixelColor(x, y));
            const pixelIndex = (y * img.bitmap.width + x) * 3;

            imgData[pixelIndex] = color.b;
            imgData[pixelIndex + 1] = color.g;
            imgData[pixelIndex + 2] = color.r;
        });

        await this.sendV1(StreamDock.CRT_LOG_V1());
        await this.sendBytes(imgData);
        await this.refreshV1();
    }
}
