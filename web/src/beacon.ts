import type { QoESnapshot } from "./qoe";
import { API_URL } from "./config";

/**
 * Ship the session record.
 *
 * sendBeacon, not fetch: it hands the request to the browser's network stack
 * and lets it outlive the document. A fetch issued during unload is routinely
 * cancelled — losing exactly the abandoned sessions you most want.
 *
 * "text/plain", not "application/json": CORS splits requests into simple
 * (sent immediately) and non-simple (preceded by an OPTIONS preflight round
 * trip). application/json makes this non-simple, and a dying page has no time
 * for a round trip. The server parses JSON regardless of the declared type.
 * The constraint is page lifecycle; the content type is the consequence.
 */
export function sendBeacon(snapshot: QoESnapshot): boolean {
    const body = new Blob([JSON.stringify(snapshot)], { type: "text/plain" });
    return navigator.sendBeacon(`${API_URL}/beacons`, body);
}

/**
 * Ids of sessions already sent. A session can now be reported from several
 * places (the runner, loading a new asset, the page closing), so this makes a
 * second report of the same session a no-op on the client. ON CONFLICT DO
 * NOTHING does the same on the server.
 *
 * This replaces the old `sent` flag, which allowed one beacon per PAGE. The
 * rule that matters is one beacon per SESSION.
 */
const reported = new Set<string>();

export function reportSession(snapshot: QoESnapshot): boolean {
    if (reported.has(snapshot.sessionId)) return true;
    const queued = sendBeacon(snapshot);
    // Only remember it if the browser accepted it, so a refused beacon can be
    // tried again.
    if (queued) reported.add(snapshot.sessionId);
    return queued;
}

export function reportOnExit(get: () => QoESnapshot | null): void {
    const fire = (why: string) => {
        const s = get();
        if (!s) return console.debug(`[beacon] ${why}: no session`);
        console.debug(`[beacon] ${why}: queued=${reportSession(s)}`);
    };

    window.addEventListener("pagehide", () => fire("pagehide"));
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") fire("visibilitychange");
    });
}
