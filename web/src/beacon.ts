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
export function sendBeacon(snapshot: QoESnapshot): void {
    const body = new Blob([JSON.stringify(snapshot)], { type: "text/plain" });
    const queued = navigator.sendBeacon(`${API_URL}/beacons`, body);
    if (!queued) console.warn("beacon not queued — payload too large, or page already gone");
}

export function reportOnExit(get: () => QoESnapshot | null): void {
    let sent = false;

    // `why` exists only so the console can tell you which of the two triggers
    // fired — or that neither did. Page-lifecycle events differ by browser and
    // OS, and "nothing arrived" looks identical whether the listener never ran
    // or the request failed.
    const fire = (why: string) => {
        if (sent) return console.log(`[beacon] ${why} — already sent`);
        const s = get();
        if (!s) return console.log(`[beacon] ${why} — no session yet`);
        sent = true;
        console.log(`[beacon] ${why} — queued=${sendBeacon(s)}`);
    };

    // Logged at three points, because "nothing arrived" has three different
    // causes that look identical from the outside: the module never ran, the
    // event never fired, or the event fired in a state we ignore. Each line
    // below rules one of them out.
    console.log("[beacon] exit reporting armed");

    // pagehide, not unload: unload is unreliable on mobile and disqualifies the
    // page from the back/forward cache.
    window.addEventListener("pagehide", () => {
        console.log("[beacon] pagehide");
        fire("pagehide");
    });

    // Logged for EVERY visibilitychange, not only the hidden ones — otherwise
    // an event that fires with state "visible" is indistinguishable from no
    // event at all.
    document.addEventListener("visibilitychange", () => {
        console.log(`[beacon] visibilitychange -> ${document.visibilityState}`);
        if (document.visibilityState === "hidden") fire("visibilitychange");
    });
}
