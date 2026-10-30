import { readFileSync } from "node:fs";
import { validReset, type ProviderLimit } from "./limits.js";

/**
 * A provider's pause after a usage or rate limit (a limit pauses launches on that provider; it is not failed work). The pause
 * is derived from events in the shared journal, so every controller process
 * and every restarted driver sees the same state:
 *
 * - PROVIDER_LIMIT_OBSERVED: a run or probe hit a limit. Its `until` is the
 *   valid stated reset plus a minute, or, without one, a recheck interval
 *   that doubles with each consecutive limit without a valid reset.
 * - PROVIDER_PAUSE_CLEARED: a recheck (a probe, or the one run allowed to
 *   test the provider) ended without a limit, or the operator cleared it
 *   with evidence. It ends the pause episode.
 *
 * While `now < until` the provider is PAUSED: nothing new may use it. After
 * that it is in RECHECK: exactly one operation (a probe or one task run) may
 * test it at a time. After six limits without a valid reset in one episode
 * it is HELD: no automatic recheck; only the operator's clear, or an
 * explicit operator probe, ends it.
 */
export type PauseProvider = "codex" | "claude" | "mock";
export type PauseState = {
  provider: PauseProvider;
  state: "CLEAR" | "PAUSED" | "RECHECK" | "HELD";
  /** The sequence number of the episode's first limit observation. */
  episode?: number;
  since?: string;
  until?: string;
  kind?: ProviderLimit["kind"];
  resetsAt?: string | null;
  resetBasis?: ProviderLimit["resetBasis"];
  /** Limits in this episode without a valid reset (six make it HELD). */
  untimed?: number;
  /** The run or probe whose limit is the latest in the episode. */
  observedBy?: {
    runId?: string;
    taskId?: string;
    role?: string;
    probeId?: string;
  };
  step?: string | null;
};
export type PauseEvent = { seq: number; kind: string; body: any };

export const RESET_GRACE_MS = 60_000;
export const MAX_UNTIMED_LIMITS = 6;
const INTERVALS = {
  USAGE_LIMIT: { base: 15 * 60_000, cap: 4 * 3_600_000 },
  RATE_LIMIT: { base: 2 * 60_000, cap: 30 * 60_000 },
} as const;

/** The events of the provider's current episode: limits since its last clear. */
function episodeOf(events: readonly PauseEvent[], provider: PauseProvider) {
  const mine = events.filter((e) => e.body?.provider === provider);
  const cleared = mine.findLastIndex(
    (e) => e.kind === "PROVIDER_PAUSE_CLEARED",
  );
  return mine
    .slice(cleared + 1)
    .filter((e) => e.kind === "PROVIDER_LIMIT_OBSERVED");
}

/**
 * When a new limit's pause ends: its valid reset plus a minute, or the
 * recheck interval for the consecutive limits without a valid reset.
 */
export function pauseUntil(
  limit: ProviderLimit,
  observedAt: number,
  events: readonly PauseEvent[],
  provider: PauseProvider,
): { until: number; validResetAt: number | undefined; untimed: number } {
  const reset = validReset(limit.resetsAt, observedAt);
  const prior = episodeOf(events, provider);
  let consecutive = 0;
  for (const e of [...prior].reverse()) {
    if (e.body.validResetAt) break;
    consecutive++;
  }
  const untimed =
    prior.filter((e) => !e.body.validResetAt).length + (reset ? 0 : 1);
  if (reset !== undefined)
    return { until: reset + RESET_GRACE_MS, validResetAt: reset, untimed };
  const { base, cap } = INTERVALS[limit.kind];
  return {
    until: observedAt + Math.min(cap, base * 2 ** consecutive),
    validResetAt: undefined,
    untimed,
  };
}

/** The provider's pause as the journal records it, at `now`. */
export function derivePause(
  events: readonly PauseEvent[],
  provider: PauseProvider,
  now: number,
): PauseState {
  const episode = episodeOf(events, provider);
  if (!episode.length) return { provider, state: "CLEAR" };
  const latest = episode.at(-1)!.body;
  const until = Math.max(...episode.map((e) => Date.parse(e.body.until)));
  const untimed = episode.filter((e) => !e.body.validResetAt).length;
  return {
    provider,
    state:
      untimed >= MAX_UNTIMED_LIMITS
        ? "HELD"
        : now < until
          ? "PAUSED"
          : "RECHECK",
    episode: episode[0]!.seq,
    since: episode[0]!.body.observedAt,
    until: new Date(until).toISOString(),
    kind: latest.kind,
    resetsAt: latest.resetsAt ?? null,
    resetBasis: latest.resetBasis,
    untimed,
    observedBy: {
      ...(latest.runId ? { runId: latest.runId } : {}),
      ...(latest.taskId ? { taskId: latest.taskId } : {}),
      ...(latest.role ? { role: latest.role } : {}),
      ...(latest.probeId ? { probeId: latest.probeId } : {}),
    },
    step: latest.step ?? null,
  };
}

/** Why a launch on this provider must not happen now, or undefined. */
export function pauseRefusal(
  pause: PauseState,
  holdsToken: boolean,
): string | undefined {
  if (pause.state === "PAUSED")
    return `PROVIDER_PAUSED:${pause.provider}:until=${pause.until}`;
  if (pause.state === "HELD") return `PROVIDER_PAUSED:${pause.provider}:held`;
  if (pause.state === "RECHECK" && !holdsToken)
    return `PROVIDER_RECHECK_IN_PROGRESS:${pause.provider}`;
  return undefined;
}

/** Kernel start time distinguishes a live process from a reused PID. */
export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : (fields[19] ?? null);
  } catch {
    return null;
  }
}
