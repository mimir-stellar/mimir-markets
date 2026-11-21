/**
 * Extra market sources beyond crypto and equities.
 *
 * Every market Mimir opens has to be settleable by an oracle that fetches ONE url
 * and reads a number out of it. That rules out most "interesting" topics and is the
 * reason the arena drifted into being all price predictions: they were the only
 * sources wired up.
 *
 * These two are free, keyless, and return JSON whose answer is a number or a date —
 * so the settlement is arithmetic rather than interpretation:
 *
 *   Open-Meteo        tomorrow's maximum temperature for a named city
 *   Launch Library 2  whether a named rocket launch happens before a date
 *
 * The resolution URL IS the API call, so the oracle reads the same document the
 * market was written from. A page that might be rewritten later is not evidence.
 *
 * Source failures are tracked per source with a stable reason and a next-eligible
 * time, so a rejected or unavailable fetch is retried in a bounded queue instead of
 * hammering the upstream API on every run.
 */

export interface WeatherEvent {
  city: string;
  country: string;
  resolutionUrl: string;
  /** Forecast high for the target day, Celsius. */
  forecastHighC: number;
  targetDate: string;
}

export interface LaunchEvent {
  id: string;
  name: string;
  provider: string;
  windowStart: string;
  windowStartMs: number;
  resolutionUrl: string;
}

/** Stable, machine-readable reasons a source fetch was rejected. */
export type SourceRejectReason =
  | "http_error"
  | "network_error"
  | "malformed_payload"
  | "no_usable_records";

export interface SourceRetryState {
  source: string;
  reason: SourceRejectReason;
  attempts: number;
  /** Epoch ms before which this source must not be re-fetched. */
  nextEligibleAt: number;
}

export interface SourceRetryOptions {
  /** Base backoff in ms; doubles per consecutive failure. */
  baseBackoffMs?: number;
  /** Upper bound on backoff in ms. */
  maxBackoffMs?: number;
  /** Maximum consecutive attempts before a source is parked until the next success window. */
  maxAttempts?: number;
  now?: () => number;
}

const DEFAULT_RETRY: Required<Omit<SourceRetryOptions, "now">> = {
  baseBackoffMs: 60_000,
  maxBackoffMs: 60 * 60_000,
  maxAttempts: 5,
};

/**
 * In-memory bounded retry queue keyed by source name. Holds one entry per source,
 * so memory is bounded by the number of configured sources.
 */
export class SourceRetryQueue {
  private readonly states = new Map<string, SourceRetryState>();
  private readonly opts: Required<Omit<SourceRetryOptions, "now">>;
  private readonly now: () => number;

  constructor(options: SourceRetryOptions = {}) {
    this.opts = { ...DEFAULT_RETRY, ...options };
    this.now = options.now ?? (() => Date.now());
  }

  /** True when the source may be fetched now. */
  isEligible(source: string): boolean {
    const state = this.states.get(source);
    if (!state) return true;
    if (state.attempts >= this.opts.maxAttempts) {
      return this.now() >= state.nextEligibleAt;
    }
    return this.now() >= state.nextEligibleAt;
  }

  /** Record a rejected fetch with a stable reason and schedule the next eligibility. */
  recordFailure(source: string, reason: SourceRejectReason): SourceRetryState {
    const previous = this.states.get(source);
    const attempts = (previous?.attempts ?? 0) + 1;
    const backoff = Math.min(
      this.opts.baseBackoffMs * 2 ** (attempts - 1),
      this.opts.maxBackoffMs,
    );
    const state: SourceRetryState = {
      source,
      reason,
      attempts,
      nextEligibleAt: this.now() + backoff,
    };
    this.states.set(source, state);
    return state;
  }

  /** Clear retry state after a successful fetch. */
  recordSuccess(source: string): void {
    this.states.delete(source);
  }

  /** Snapshot of current retry state for observability and tests. */
  snapshot(): SourceRetryState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }
}

const CITIES = [
  { city: "New York", country: "US", lat: 40.71, lon: -74.01 },
  { city: "London", country: "UK", lat: 51.51, lon: -0.13 },
  { city: "Tokyo", country: "JP", lat: 35.68, lon: 139.69 },
  { city: "Istanbul", country: "TR", lat: 41.01, lon: 28.98 },
  { city: "Sydney", country: "AU", lat: -33.87, lon: 151.21 },
  { city: "Berlin", country: "DE", lat: 52.52, lon: 13.41 },
] as const;

const FETCH_TIMEOUT_MS = 12_000;

type JsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: SourceRejectReason };

async function getJson<T>(url: string): Promise<JsonResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mimir-MarketCreator/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // A source that is down costs us that category this run, nothing more.
    return { ok: false, reason: "network_error" };
  }
  if (!response.ok) return { ok: false, reason: "http_error" };
  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, reason: "malformed_payload" };
  }
}

/**
 * Tomorrow's forecast high per city.
 *
 * `forecast_days=2` and reading index 1 gives tomorrow in the city's own timezone,
 * which is the day a reader means by "tomorrow" — UTC would put Sydney a day out.
 */
export async function fetchWeatherEvents(
  queue?: SourceRetryQueue,
): Promise<{ text: string; events: WeatherEvent[] }> {
  const source = "open-meteo";
  if (queue && !queue.isEligible(source)) {
    return { text: "Weather: source in retry backoff this run.", events: [] };
  }

  const events: WeatherEvent[] = [];
  let lastReason: SourceRejectReason | null = null;

  for (const spot of CITIES) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}`
      + `&daily=temperature_2m_max&timezone=auto&forecast_days=2`;
    const result = await getJson<{ daily?: { time?: string[]; temperature_2m_max?: number[] } }>(url);
    if (!result.ok) {
      lastReason = result.reason;
      continue;
    }
    const high = result.data?.daily?.temperature_2m_max?.[1];
    const date = result.data?.daily?.time?.[1];
    if (typeof high !== "number" || !date) {
      lastReason = "malformed_payload";
      continue;
    }
    events.push({
      city: spot.city, country: spot.country, resolutionUrl: url,
      forecastHighC: Math.round(high * 10) / 10, targetDate: date,
    });
  }

  if (events.length === 0) {
    if (queue) queue.recordFailure(source, lastReason ?? "no_usable_records");
    return { text: "Weather: source unavailable this run.", events };
  }
  if (queue) queue.recordSuccess(source);

  const text = events
    .map((event) => `${event.city} (${event.country}) — forecast high ${event.forecastHighC}°C on ${event.targetDate}`)
    .join("\n");
  return { text: `Weather forecasts (Open-Meteo, resolves to daily max temperature):\n${text}`, events };
}

/**
 * Upcoming orbital launches.
 *
 * Filtered to launches with a real window inside the next week: "will it launch
 * eventually" is not a market, and a slip beyond the deadline is exactly the
 * uncertainty being traded.
 *
 * Deduplicates by launch ID to ensure Mimir preserves funded-state safety and
 * clear operational boundaries. If the API returns multiple entries for the same
 * launch (e.g., status updates or historical records mixed in), only the first
 * valid one is kept.
 */
export async function fetchLaunchEvents(
  queue?: SourceRetryQueue,
): Promise<{ text: string; events: LaunchEvent[] }> {
  const source = "launch-library";
  if (queue && !queue.isEligible(source)) {
    return { text: "Spaceflight: source in retry backoff this run.", events: [] };
  }

  const url = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=8&mode=list";
  const result = await getJson<{
    results?: Array<{ id?: string; name?: string; net?: string; launch_service_provider?: { name?: string } }>;
  }>(url);

  if (!result.ok) {
    if (queue) queue.recordFailure(source, result.reason);
    return { text: "Spaceflight: source unavailable this run.", events: [] };
  }

  const now = Date.now();
  const week = now + 7 * 86_400_000;
  const events: LaunchEvent[] = [];
  const seenIds = new Set<string>();

  for (const entry of result.data?.results ?? []) {
    const windowStartMs = Date.parse(entry.net ?? "");
    if (!Number.isFinite(windowStartMs)) continue;
    if (windowStartMs <= now || windowStartMs > week) continue;

    const id = String(entry.id ?? "");
    // Deduplicate by ID to prevent duplicate market creation for the same event.
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    events.push({
      id,
      name: String(entry.name ?? "").slice(0, 120),
      provider: String(entry.launch_service_provider?.name ?? "unknown"),
      windowStart: new Date(windowStartMs).toISOString(),
      windowStartMs,
      // One launch, so the oracle reads a single record rather than a list it has
      // to search through.
      resolutionUrl: `https://ll.thespacedevs.com/2.2.0/launch/${id}/`,
    });
  }

  if (events.length === 0) {
    if (queue) queue.recordFailure(source, "no_usable_records");
    return { text: "Spaceflight: no launches scheduled in the next week.", events };
  }
  if (queue) queue.recordSuccess(source);

  const text = events
    .map((event) => `${event.name} — ${event.provider}, window opens ${event.windowStart}`)
    .join("\n");
  return {
    text: `Upcoming orbital launches (Launch Library, resolves from the launch record's status):\n${text}`,
    events,
  };
}
