import { createRelay, type Relay } from "@ofan/telemetry-relay-sdk";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

const RELAY_URL = "https://telemetry-relay-memex.mlab42.workers.dev";
const RELAY_TOKEN = "rl_wNiZ6rXS4Ct2gli4-csnVPwHeKvYuqBwLeGhIttTTMQ";

export type TrackFn = (event: string, properties?: Record<string, unknown>) => void;

const noop: TrackFn = () => {};

/** Stable anonymous machine ID (hash of hostname) */
function getMachineId(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

export function initTelemetry(version: string): TrackFn {
  if (process.env.MEMEX_TELEMETRY === "0" || process.env.MEMEX_DO_NOT_TRACK === "1") return noop;

  let relay: Relay;
  try {
    relay = createRelay({ url: RELAY_URL, token: RELAY_TOKEN });
  } catch {
    return noop;
  }

  const machineId = getMachineId();

  return (event, properties = {}) => {
    void relay.track("memex", event, version, { ...properties, machineId });
  };
}
