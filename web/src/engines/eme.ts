import type { DrmConfig } from "./types";

/** Keys licensed before their video plays: the feed's next item. */
export interface PreparedKeys {
    keys: MediaKeys;
    sessions: Map<string, MediaKeySession>;
}

/**
 * Encrypted Media Extensions for your MSE engine, by hand.
 *
 * One MediaKeys on the <video>, and one session per distinct initData. The
 * element fires 'encrypted' for every init segment appended that carries a
 * PSSH: video, audio, and again at each rendition switch. Your packager gives
 * them all the same key ID, so every event after the first is a duplicate.
 */
export class Eme {
    private readonly video: HTMLVideoElement;
    private readonly drm: DrmConfig;
    private readonly onError: (detail: string) => void;
    private readonly sessions = new Map<string, MediaKeySession>();
    private keys: MediaKeys | null = null;
    private closed = false;

    constructor(video: HTMLVideoElement, drm: DrmConfig, onError: (detail: string) => void) {
        this.video = video;
        this.drm = drm;
        this.onError = onError;
    }

    /**
     * Ask for the key system and attach it to the element. Call this before
     * appending anything: the 'encrypted' event of an init segment appended
     * earlier would find no MediaKeys to open a session on.
     *
     * With prepared keys, the licence is already in them: adopt the keys and
     * their sessions, so the 'encrypted' events that follow find a session
     * open for their initData and send nothing.
     */
    async attach(videoTypes: string[], audioType: string | null, prepared: PreparedKeys | null = null): Promise<void> {
        if (prepared) {
            this.keys = prepared.keys;
            for (const [id, session] of prepared.sessions) {
                this.sessions.set(id, session);
                session.addEventListener("keystatuseschange", () => this.check(session));
            }
        } else {
            this.keys = await createKeys(this.drm, videoTypes, audioType);
        }
        await this.video.setMediaKeys(this.keys);
        this.video.addEventListener("encrypted", this.onEncrypted);
    }

    private readonly onEncrypted = (event: MediaEncryptedEvent): void => {
        if (event.initData) void this.request(event.initDataType, event.initData);
    };

    /** Open a session and ask the CDM for a licence request, once per initData. */
    async request(initDataType: string, initData: ArrayBuffer): Promise<void> {
        const id = sessionId(initDataType, initData);
        if (!this.keys || this.closed || this.sessions.has(id)) return;
        const session = this.keys.createSession("temporary");
        this.sessions.set(id, session);
        // The CDM answers generateRequest() with a 'message': the licence
        // request, which the page carries to the server without reading it.
        session.addEventListener("message", (event) => void this.exchange(session, event.message));
        session.addEventListener("keystatuseschange", () => this.check(session));
        try {
            await session.generateRequest(initDataType, initData);
        } catch (error) {
            this.onError(`mse: eme: generateRequest: ${(error as Error).message}`);
        }
    }

    /** Carry the CDM's message to the licence server, and its answer back. */
    private async exchange(session: MediaKeySession, message: ArrayBuffer): Promise<void> {
        try {
            await session.update(await fetchLicence(this.drm, message));
        } catch (error) {
            if (!this.closed) this.onError(`mse: eme: licence: ${(error as Error).message}`);
        }
    }

    /**
     * Statuses that mean a key can't decrypt. "output-downscaled" isn't one:
     * the CDM still decrypts, at a lower resolution.
     */
    private check(session: MediaKeySession): void {
        if (this.closed) return;
        session.keyStatuses.forEach((status) => {
            if (status === "expired" || status === "internal-error" || status === "output-restricted") {
                this.onError(`mse: eme: key ${status}`);
            }
        });
    }

    async destroy(): Promise<void> {
        this.closed = true;
        this.video.removeEventListener("encrypted", this.onEncrypted);
        await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
        this.sessions.clear();
        // Free the element for the next engine, which may bring its own keys.
        await this.video.setMediaKeys(null).catch(() => {});
    }
}

/**
 * How long a prepared licence may take. The swipe waits for one that's still
 * on its way, so one that never arrives must give up rather than hold it.
 */
const PREPARE_TIMEOUT_MS = 10_000;

/**
 * The licence for a video that hasn't started: MediaKeys made with no element
 * yet, a session opened on the init segment's PSSH boxes, and the licence
 * applied. Resolves once a key is usable; rejects if none becomes usable.
 */
export async function prepareKeys(drm: DrmConfig, videoTypes: string[], audioType: string | null, pssh: Uint8Array<ArrayBuffer>): Promise<PreparedKeys> {
    const keys = await createKeys(drm, videoTypes, audioType);
    const session = keys.createSession("temporary");
    const usable = new Promise<void>((resolve, reject) => {
        // Every message the CDM writes goes to the server: Widevine may ask
        // for a service certificate before the licence itself.
        session.addEventListener("message", (event) => {
            fetchLicence(drm, event.message).then((licence) => session.update(licence)).catch(reject);
        });
        session.addEventListener("keystatuseschange", () => {
            session.keyStatuses.forEach((status) => {
                if (status === "usable") resolve();
                if (status === "expired" || status === "internal-error" || status === "output-restricted") {
                    reject(new Error(`preload: key ${status}`));
                }
            });
        });
        setTimeout(() => reject(new Error("preload: no usable key in time")), PREPARE_TIMEOUT_MS);
    });
    // Handled here so a generateRequest failure below leaves no stray rejection.
    usable.catch(() => {});
    try {
        await session.generateRequest("cenc", pssh);
        await usable;
    } catch (error) {
        void session.close().catch(() => {});
        throw error;
    }
    return { keys, sessions: new Map([[sessionId("cenc", pssh), session]]) };
}

/**
 * The PSSH boxes in an init segment's moov, end to end: the initData the
 * 'encrypted' event will carry when that segment is appended. Matching it
 * byte for byte is what lets a prepared session stand in for that event's.
 */
export function psshBoxes(init: ArrayBuffer): Uint8Array<ArrayBuffer> | null {
    const view = new DataView(init);
    const boxes: Uint8Array[] = [];
    const walk = (from: number, to: number): void => {
        for (let at = from; at + 8 <= to; ) {
            const size = view.getUint32(at);
            if (size < 8 || at + size > to) return;
            const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
            if (type === "moov") walk(at + 8, at + size);
            if (type === "pssh") boxes.push(new Uint8Array(init, at, size));
            at += size;
        }
    };
    walk(0, init.byteLength);
    if (boxes.length === 0) return null;
    const all = new Uint8Array(boxes.reduce((total, box) => total + box.length, 0));
    let offset = 0;
    for (const box of boxes) {
        all.set(box, offset);
        offset += box.length;
    }
    return all;
}

/** requestMediaKeySystemAccess, then createMediaKeys: no element needed yet. */
async function createKeys(drm: DrmConfig, videoTypes: string[], audioType: string | null): Promise<MediaKeys> {
    // Widevine wants a robustness level named, and warns without one.
    // SW_SECURE_CRYPTO is L3, the level desktop Chrome has.
    const robustness = drm.keySystem === "com.widevine.alpha" ? "SW_SECURE_CRYPTO" : "";
    const capability = (contentType: string): MediaKeySystemMediaCapability => ({
        contentType,
        robustness,
        // Ask for the scheme your packager uses. A CDM that can't decrypt
        // cbcs then refuses here, by name, rather than failing at the first
        // encrypted frame.
        encryptionScheme: "cbcs",
    });
    const access = await navigator.requestMediaKeySystemAccess(drm.keySystem, [{
        initDataTypes: ["cenc"],
        videoCapabilities: videoTypes.map(capability),
        audioCapabilities: audioType ? [capability(audioType)] : [],
        sessionTypes: ["temporary"],
    }]);
    return access.createMediaKeys();
}

/** POST the CDM's message with the viewer's token; the answer is the licence. */
async function fetchLicence(drm: DrmConfig, message: ArrayBuffer): Promise<ArrayBuffer> {
    const response = await fetch(drm.licenseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${drm.token}` },
        body: message,
    });
    if (!response.ok) throw new Error(`the licence server answered ${response.status}`);
    return response.arrayBuffer();
}

function sessionId(initDataType: string, initData: ArrayBuffer | Uint8Array): string {
    const bytes = initData instanceof Uint8Array ? initData : new Uint8Array(initData);
    return `${initDataType}:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}