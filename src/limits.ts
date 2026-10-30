import { z } from "zod";

/**
 * Recognising a provider's usage limit from harness data (a limit pauses the provider instead of reading as failed work).
 * Only structured harness output is read: Claude Code's result envelope, and
 * for Codex its own session log (kept by the runner) or, failing that, its
 * `--json` stream's harness error events. Model text is never parsed.
 *
 * Formats, from local records (BASELINE.md F3): Claude's envelope has
 * `is_error: true`, `api_error: "usage_limit_reached"`, `api_error_status:
 * 429` and `result: "You've hit your session limit · resets 12pm
 * (America/Denver)"`. Codex's session log has a `task_complete` event with
 * `error.codex_error_info: "usage_limit_exceeded"` and, when the run got far
 * enough, a `token_count` event whose `rate_limits` windows carry
 * `used_percent` and `resets_at` (Unix seconds); its message says "try again
 * at Sep 19th, 2026 2:44 AM" in the host's zone. The 0.164 `--json` stream was
 * not seen in a limit, so its fallback is unverified.
 */
export const ProviderLimitSchema = z
  .object({
    kind: z.enum(["USAGE_LIMIT", "RATE_LIMIT"]),
    /** Which harness record showed it. */
    evidence: z.string().min(1).max(300),
    resetsAt: z.iso.datetime().nullable(),
    resetBasis: z.enum([
      "STATED_WITH_ZONE",
      "STRUCTURED",
      "STATED_HOST_ZONE",
      "NONE",
    ]),
    message: z.string().max(500),
  })
  .strict();
export type ProviderLimit = z.infer<typeof ProviderLimitSchema>;

const whole = z.number().int().nonnegative();
/** What a Codex run's own session log says about how it ended (read by the runner). */
export const CodexSessionSignalSchema = z
  .object({
    errorInfo: z.string().max(100).nullable(),
    message: z.string().max(2_000).nullable(),
    /** The latest token_count's rate-limit windows. */
    rateLimits: z
      .array(
        z
          .object({
            usedPercent: z.number().finite(),
            resetsAt: whole.nullable(),
          })
          .strict(),
      )
      .max(10),
    /** The latest token_count's total_token_usage, as Codex recorded it. */
    totalTokenUsage: z
      .object({
        input_tokens: whole,
        cached_input_tokens: whole.optional(),
        output_tokens: whole,
      })
      .passthrough()
      .nullable(),
  })
  .strict();
export type CodexSessionSignal = z.infer<typeof CodexSessionSignalSchema>;

/**
 * The signal in a Codex session log's text for one thread, or undefined when
 * the log is not that thread's.
 */
export function codexSessionSignal(
  log: string,
  thread: string,
): CodexSessionSignal | undefined {
  let matched = false;
  const signal: CodexSessionSignal = {
    errorInfo: null,
    message: null,
    rateLimits: [],
    totalTokenUsage: null,
  };
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    let record: { type?: unknown; payload?: any };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload;
    if (record.type === "session_meta" && payload?.id === thread)
      matched = true;
    if (record.type !== "event_msg" || !payload || typeof payload !== "object")
      continue;
    if (payload.type === "task_complete") {
      const error = payload.error;
      signal.errorInfo =
        error && typeof error.codex_error_info === "string"
          ? error.codex_error_info.slice(0, 100)
          : null;
      signal.message =
        error && typeof error.message === "string"
          ? error.message.slice(0, 2_000)
          : null;
    }
    if (payload.type === "token_count") {
      const usage = payload.info?.total_token_usage;
      if (usage && typeof usage === "object") signal.totalTokenUsage = usage;
      const limits = payload.rate_limits;
      if (limits && typeof limits === "object") {
        signal.rateLimits = [];
        for (const key of ["primary", "secondary"]) {
          const w = limits[key];
          if (w && typeof w.used_percent === "number")
            signal.rateLimits.push({
              usedPercent: w.used_percent,
              resetsAt:
                Number.isSafeInteger(w.resets_at) && w.resets_at >= 0
                  ? w.resets_at
                  : null,
            });
        }
      }
    }
  }
  if (!matched) return undefined;
  const parsed = CodexSessionSignalSchema.safeParse(signal);
  return parsed.success ? parsed.data : undefined;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";

/** The zone's wall-clock fields for an instant. */
function wall(zone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}
/**
 * The one instant at which the zone's clock reads this wall time, or
 * undefined when there is none (a date that does not exist, or a time a
 * clock change skips) or more than one (a time a clock change repeats).
 */
function zoned(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | undefined {
  const target = Date.UTC(year, month, day, hour, minute);
  const check = new Date(target);
  // Date.UTC rolls an impossible date (Feb 31) into the next month.
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day
  )
    return undefined;
  const reads = (at: number) => {
    const w = wall(zone, at);
    return (
      w.year === year &&
      w.month === month &&
      w.day === day &&
      w.hour === hour &&
      w.minute === minute
    );
  };
  // Every offset a zone uses lies within a day of UTC: test each quarter
  // hour of it, so a skipped or repeated time is seen as such.
  const found: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const at = target - offset * 60_000;
    if (reads(at) && !found.includes(at)) found.push(at);
  }
  return found.length === 1 ? found[0] : undefined;
}
function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
const hour24 = (h: number, meridiem: string) =>
  (h % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);

/**
 * A stated reset time as the next such instant after the observation, in the
 * zone given: a time only (today or tomorrow), a month and day (this year or
 * next) or a full date. Undefined when it cannot be read.
 */
function statedReset(
  zone: string,
  observedAt: number,
  stated: {
    monthName?: string;
    day?: number;
    year?: number;
    hour: number;
    minute: number;
    meridiem: string;
  },
): number | undefined {
  if (!validZone(zone)) return undefined;
  if (stated.hour < 1 || stated.hour > 12 || stated.minute > 59)
    return undefined;
  const hour = hour24(stated.hour, stated.meridiem);
  const now = wall(zone, observedAt);
  if (stated.monthName !== undefined && stated.day !== undefined) {
    const month = MONTHS.indexOf(stated.monthName.slice(0, 3).toLowerCase());
    if (month < 0 || stated.day < 1 || stated.day > 31) return undefined;
    let year = stated.year ?? now.year;
    let at = zoned(zone, year, month, stated.day, hour, stated.minute);
    if (stated.year === undefined && at !== undefined && at <= observedAt)
      at = zoned(zone, ++year, month, stated.day, hour, stated.minute);
    return at;
  }
  let at = zoned(zone, now.year, now.month, now.day, hour, stated.minute);
  if (at !== undefined && at <= observedAt) {
    const tomorrow = new Date(Date.UTC(now.year, now.month, now.day + 1));
    at = zoned(
      zone,
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      hour,
      stated.minute,
    );
  }
  return at;
}

/** Claude Code's result envelope reporting a usage or rate limit. */
export function claudeLimit(
  stdout: string,
  observedAt: number,
): ProviderLimit | undefined {
  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.type !== "result" ||
    envelope.is_error !== true
  )
    return undefined;
  const text = typeof envelope.result === "string" ? envelope.result : "";
  let kind: ProviderLimit["kind"], evidence: string;
  if (envelope.api_error === "usage_limit_reached") {
    kind = "USAGE_LIMIT";
    evidence = 'claude result envelope: api_error "usage_limit_reached"';
  } else if (envelope.api_error_status === 429) {
    // A 429 without the usage marker is a rate limit, not exhaustion.
    kind = "RATE_LIMIT";
    evidence = "claude result envelope: api_error_status 429";
  } else return undefined;
  const m = new RegExp(
    "\\bresets\\s+(?:" +
      MONTH +
      "\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:at\\s+)?)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\s*\\(([^)\\s]+)\\)",
    "i",
  ).exec(text);
  const at = m
    ? statedReset(m[6]!, observedAt, {
        ...(m[1] ? { monthName: m[1], day: Number(m[2]) } : {}),
        hour: Number(m[3]),
        minute: m[4] ? Number(m[4]) : 0,
        meridiem: m[5]!,
      })
    : undefined;
  const resetsAt = statable(at);
  return {
    kind,
    evidence,
    resetsAt,
    resetBasis: resetsAt === null ? "NONE" : "STATED_WITH_ZONE",
    message: text.slice(0, 500),
  };
}

/** "try again at <Mon Dth, YYYY> h:mm AM|PM" in the given zone. */
function tryAgainAt(
  text: string,
  zone: string,
  observedAt: number,
): number | undefined {
  const m = new RegExp(
    "try again at\\s+(?:" +
      MONTH +
      "\\s+(\\d{1,2})(?:st|nd|rd|th)?,\\s*(\\d{4})\\s+)?(\\d{1,2}):(\\d{2})\\s*(AM|PM)",
    "i",
  ).exec(text);
  if (!m) return undefined;
  return statedReset(zone, observedAt, {
    ...(m[1] ? { monthName: m[1], day: Number(m[2]), year: Number(m[3]) } : {}),
    hour: Number(m[4]),
    minute: Number(m[5]),
    meridiem: m[6]!,
  });
}

/**
 * A Codex run that ended on a limit: from its session log first (the error
 * code Codex records, and the reset of an exhausted rate-limit window), else
 * from its `--json` stream's harness error events.
 */
export function codexLimit(
  stdout: string,
  session: CodexSessionSignal | undefined,
  observedAt: number,
  hostZone: string,
): ProviderLimit | undefined {
  const fromSession =
    session?.errorInfo === "usage_limit_exceeded"
      ? ("USAGE_LIMIT" as const)
      : session?.errorInfo === "rate_limit_exceeded"
        ? ("RATE_LIMIT" as const)
        : undefined;
  if (session && fromSession) {
    // A reset no ordinary timestamp can state is not a reset.
    const exhausted = session.rateLimits
      .filter((w) => w.usedPercent >= 100 && w.resetsAt !== null)
      .map((w) => w.resetsAt! * 1000)
      .filter((ms) => ms >= 0 && ms <= LATEST_STATABLE);
    const stated = session.message
      ? tryAgainAt(session.message, hostZone, observedAt)
      : undefined;
    const [reset, basis] = exhausted.length
      ? [Math.max(...exhausted), "STRUCTURED" as const]
      : stated !== undefined
        ? [stated, "STATED_HOST_ZONE" as const]
        : [undefined, "NONE" as const];
    const resetsAt = statable(reset);
    return {
      kind: fromSession,
      evidence:
        "codex session log: task_complete codex_error_info " +
        JSON.stringify(session.errorInfo),
      resetsAt,
      resetBasis: resetsAt === null ? "NONE" : basis,
      message: (session.message ?? "").slice(0, 500),
    };
  }
  let message: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const text =
      event?.type === "error"
        ? event.message
        : event?.type === "turn.failed"
          ? event.error?.message
          : undefined;
    if (typeof text === "string" && /hit your usage limit/i.test(text))
      message = text;
  }
  if (message === undefined) return undefined;
  const resetsAt = statable(tryAgainAt(message, hostZone, observedAt));
  return {
    kind: "USAGE_LIMIT",
    evidence: "codex --json stream: harness error event (usage limit message)",
    resetsAt,
    resetBasis: resetsAt === null ? "NONE" : "STATED_HOST_ZONE",
    message: message.slice(0, 500),
  };
}

/** The latest instant an ISO timestamp states without an extended year (9999-12-31). */
const LATEST_STATABLE = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
/** A reset as a timestamp, or null when no ordinary timestamp can state it. */
function statable(at: number | undefined): string | null {
  return at !== undefined && at >= 0 && at <= LATEST_STATABLE
    ? new Date(at).toISOString()
    : null;
}
/** The longest a stated reset may lie ahead and still be believed. */
export const MAX_RESET_AHEAD_MS = 8 * 24 * 3_600_000;
/** A reset the controller trusts: after the observation and at most 8 days later. */
export function validReset(
  resetsAt: string | null,
  observedAt: number,
): number | undefined {
  if (resetsAt === null) return undefined;
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) &&
    at > observedAt &&
    at - observedAt <= MAX_RESET_AHEAD_MS
    ? at
    : undefined;
}
