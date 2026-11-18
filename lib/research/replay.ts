/**
 * Research gateway replay mode — deterministic, offline research fetches.
 *
 * Replay serves previously captured (or hand-written synthetic) responses
 * through the SAME production path as a live fetch: URL and domain-policy
 * checks on every hop, manual redirect handling, content-type allowlisting,
 * bounded body reads, per-agent budgets and content hashing. The only thing it
 * swaps out is the transport (and DNS), so `validateResearchContent` sees a
 * `FetchSuccess` that is indistinguishable in shape from a live one.
 *
 * Guarantees while replay is active:
 *
 *   1. **No real network access.** The caller's `fetchImpl` and the system DNS
 *      resolver are never invoked. A URL with no capture is a typed
 *      `replay_miss` failure — it never falls through to the network.
 *   2. **No paid endpoints.** A capture marked `paid: true`, a captured `402
 *      Payment Required`, or a request carrying an x402 payment header is
 *      refused with `replay_paid_endpoint`. Replay never authorises payment.
 *   3. **Determinism.** The response cache is bypassed (so a live result can
 *      never leak into a replay run and vice versa), and `capturedAt` comes from
 *      the fixture when it is set, so repeated runs produce identical results.
 *
 * Enable it per call with `gatewayFetch({ replay })`, or process-wide with
 * `RESEARCH_REPLAY_FIXTURE=/path/to/fixture.json`. A configured fixture that
 * cannot be loaded fails closed: every fetch is refused with
 * `replay_invalid_fixture` rather than silently going live.
 */

import { readFileSync } from "node:fs";

export const REPLAY_FIXTURE_VERSION = 1;

/**
 * Default resolved address for replayed hosts. 93.184.216.34 is a documented
 * public address (example.com), so the production SSRF address check passes
 * without consulting DNS. A capture may override it with `addresses` — e.g. to
 * prove a replayed host that resolves privately is still refused.
 */
export const REPLAY_DEFAULT_ADDRESSES: readonly string[] = ["93.184.216.34"];

/** Request headers that indicate an x402 / paid request. Refused in replay. */
const PAYMENT_HEADERS = ["x-payment", "x-402-payment", "payment-signature", "x-payment-authorization"];

export interface ReplayCapture {
  /** The exact URL requested (compared after URL normalisation). */
  url: string;
  /** HTTP status to serve. Defaults to 200. 3xx requires `location`. */
  status?: number;
  /** Content-Type header. Defaults to `text/html; charset=utf-8` for 2xx. */
  contentType?: string;
  /** Response body. Omitted for redirects. */
  body?: string;
  /** Redirect target for 3xx captures; resolved relative to `url`. */
  location?: string;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Epoch ms the capture was taken. Used as `capturedAt` for determinism. */
  capturedAt?: number;
  /** Addresses this host "resolves" to during replay. Defaults to REPLAY_DEFAULT_ADDRESSES. */
  addresses?: string[];
  /** Marks a paid (e.g. x402) endpoint. Always refused during replay. */
  paid?: boolean;
}

export interface ReplayFixture {
  version: number;
  captures: ReplayCapture[];
}

export type ReplayFailureKind = "replay_miss" | "replay_paid_endpoint" | "replay_invalid_fixture";

export class ReplayRefusal extends Error {
  constructor(
    readonly kind: ReplayFailureKind,
    detail: string,
  ) {
    super(detail);
    this.name = "ReplayRefusal";
  }
}

export interface ReplaySource {
  readonly captures: ReadonlyMap<string, ReplayCapture>;
  /** Set when the fixture could not be loaded; every fetch is then refused. */
  readonly loadError?: string;
}

export function normalizeReplayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function assertCapture(value: unknown, index: number): ReplayCapture {
  if (!value || typeof value !== "object") throw new Error(`capture ${index} is not an object`);
  const c = value as ReplayCapture;
  if (typeof c.url !== "string" || !c.url.trim()) throw new Error(`capture ${index} has no url`);
  try {
    new URL(c.url);
  } catch {
    throw new Error(`capture ${index} has an unparseable url`);
  }
  const status = c.status ?? 200;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`capture ${index} has an invalid status`);
  if (status >= 300 && status < 400 && typeof c.location !== "string") {
    throw new Error(`capture ${index} is a redirect without a location`);
  }
  if (c.body !== undefined && typeof c.body !== "string") throw new Error(`capture ${index} body must be a string`);
  if (c.capturedAt !== undefined && !Number.isFinite(c.capturedAt)) throw new Error(`capture ${index} capturedAt must be a number`);
  if (c.addresses !== undefined && (!Array.isArray(c.addresses) || c.addresses.some((a) => typeof a !== "string"))) {
    throw new Error(`capture ${index} addresses must be a string array`);
  }
  return c;
}

/** Build a replay source from an in-memory fixture. Throws on a malformed fixture. */
export function createReplaySource(fixture: ReplayFixture | ReplayCapture[]): ReplaySource {
  const doc: ReplayFixture = Array.isArray(fixture) ? { version: REPLAY_FIXTURE_VERSION, captures: fixture } : fixture;
  if (!doc || doc.version !== REPLAY_FIXTURE_VERSION || !Array.isArray(doc.captures)) {
    throw new Error(`replay fixture must be { version: ${REPLAY_FIXTURE_VERSION}, captures: [...] }`);
  }
  const captures = new Map<string, ReplayCapture>();
  doc.captures.forEach((raw, index) => {
    const capture = assertCapture(raw, index);
    const key = normalizeReplayUrl(capture.url);
    if (captures.has(key)) throw new Error(`capture ${index} duplicates url ${capture.url}`);
    captures.set(key, capture);
  });
  return { captures };
}

/** Load a fixture file. Never throws: a bad file yields a source that refuses everything. */
export function loadReplaySource(path: string): ReplaySource {
  try {
    return createReplaySource(JSON.parse(readFileSync(path, "utf8")) as ReplayFixture);
  } catch (err) {
    return { captures: new Map(), loadError: err instanceof Error ? err.message : String(err) };
  }
}

let envCache: { path: string; source: ReplaySource } | null = null;

/** The process-wide replay source from `RESEARCH_REPLAY_FIXTURE`, or null when unset. */
export function replaySourceFromEnv(): ReplaySource | null {
  const path = (process.env.RESEARCH_REPLAY_FIXTURE ?? "").trim();
  if (!path) return null;
  if (envCache?.path !== path) envCache = { path, source: loadReplaySource(path) };
  return envCache.source;
}

/** Test seam: forget the cached env fixture. */
export function resetReplayEnvCache(): void {
  envCache = null;
}

export function lookupCapture(source: ReplaySource, url: string): ReplayCapture | undefined {
  return source.captures.get(normalizeReplayUrl(url));
}

/** Refuse before any hop if the request itself is a paid one. */
export function checkReplayRequest(source: ReplaySource, headers: Record<string, string> | undefined): ReplayRefusal | null {
  if (source.loadError) {
    return new ReplayRefusal("replay_invalid_fixture", `replay fixture could not be loaded: ${source.loadError}`);
  }
  const names = Object.keys(headers ?? {}).map((h) => h.toLowerCase());
  const payment = names.find((h) => PAYMENT_HEADERS.includes(h));
  if (payment) {
    return new ReplayRefusal("replay_paid_endpoint", `request carries payment header '${payment}'; paid endpoints are disabled during replay`);
  }
  return null;
}

/** Resolver used during replay: answers from the fixture, never from DNS. Never throws. */
export function replayResolver(source: ReplaySource): (host: string) => Promise<string[]> {
  return async (host: string) => {
    const wanted = host.toLowerCase();
    for (const capture of source.captures.values()) {
      if (new URL(capture.url).hostname.toLowerCase() === wanted) {
        return [...(capture.addresses ?? REPLAY_DEFAULT_ADDRESSES)];
      }
    }
    // Unknown host: answer with the public default so the request reaches the
    // replay transport, which reports a typed `replay_miss` (never the network).
    return [...REPLAY_DEFAULT_ADDRESSES];
  };
}

/**
 * Transport used during replay. Serves captures as real `Response` objects so
 * the gateway's redirect, content-type and bounded-read logic runs unchanged.
 * Throws `ReplayRefusal` for a miss or a paid capture; the gateway converts it
 * into a typed failure.
 */
export function replayFetch(source: ReplaySource): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const capture = lookupCapture(source, url);
    if (!capture) throw new ReplayRefusal("replay_miss", `no replay capture for '${url}'`);
    const status = capture.status ?? 200;
    if (capture.paid || status === 402) {
      throw new ReplayRefusal("replay_paid_endpoint", `'${url}' is a paid endpoint; paid endpoints are disabled during replay`);
    }
    const headers = new Headers(capture.headers ?? {});
    if (status >= 300 && status < 400) {
      headers.set("location", capture.location!);
      return new Response(null, { status, headers });
    }
    if (!headers.has("content-type")) headers.set("content-type", capture.contentType ?? "text/html; charset=utf-8");
    const nullBody = status === 204 || status === 304;
    return new Response(nullBody ? null : (capture.body ?? ""), { status, headers });
  }) as typeof globalThis.fetch;
}
