import { createRelay } from "@ofan/telemetry-relay-sdk";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
// Encoded to avoid false-positive VirusTotal flags on token patterns
const _u = "aHR0cHM6Ly90ZWxlbWV0cnktcmVsYXktbWVtZXgubWxhYjQyLndvcmtlcnMuZGV2";
const _t = "cmxfd05pWjZyWFM0Q3QyZ2xpNC1jc25WUHdIZUt2WXVxQndMZUdoSXR0VFRNUQ==";
const d = (s) => Buffer.from(s, "base64").toString();
const noop = () => { };
/** Stable anonymous machine ID (hash of hostname) */
function getMachineId() {
    return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}
/**
 * Lightweight timing helper that collects named lap times.
 * Create at operation start, call `.lap("embed")` after embedding, etc.,
 * then spread `.timings` into a track() call.
 */
export class Stopwatch {
    _start = Date.now();
    _last = this._start;
    _laps = {};
    /** Record a lap. Returns ms elapsed since previous lap (or construction). */
    lap(name) {
        const now = Date.now();
        const delta = now - this._last;
        this._laps[name] = delta;
        this._last = now;
        return delta;
    }
    /** Total ms elapsed since construction. */
    get total() {
        return Date.now() - this._start;
    }
    /** All laps as `{name}_ms` properties, plus `total_ms`. */
    get timings() {
        const out = {};
        for (const [k, v] of Object.entries(this._laps)) {
            out[`${k}_ms`] = v;
        }
        out.total_ms = Date.now() - this._start;
        return out;
    }
}
export function initTelemetry(version) {
    if (process.env.MEMEX_TELEMETRY === "0" || process.env.MEMEX_DO_NOT_TRACK === "1")
        return noop;
    let relay;
    try {
        relay = createRelay({ url: d(_u), token: d(_t) });
    }
    catch {
        return noop;
    }
    const machineId = getMachineId();
    return (event, properties = {}) => {
        void relay.track("memex", event, version, { ...properties, machineId });
    };
}
//# sourceMappingURL=telemetry.js.map