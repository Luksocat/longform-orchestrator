import { appendFileSync } from "node:fs";
import type { ProgressRun } from "./controller.js";

/**
 * The built-in driver's progress log : one plain
 * line per event, appended to a file the owner can watch (`tail -f`) to see
 * that work is going on. Nothing reads it back and nothing decides from it.
 * A line that cannot be written is dropped; the first failure is kept for the
 * driver's result, and the driver goes on.
 */
export class ProgressLog {
  /** The first write failure, if any. */
  failure?: string;
  /** How often the driver looks at runs while it waits (ms). */
  readonly pollMs: number;
  /** After this long without a line, a "still" line says what is going on (ms). */
  readonly quietMs: number;
  private lastWrite: number;
  private readonly reported = new Map<string, "started" | "ended">();
  constructor(
    private readonly append: (text: string) => void,
    private readonly now: () => number = Date.now,
    options: { pollMs?: number; quietMs?: number } = {},
  ) {
    this.pollMs = options.pollMs ?? 30_000;
    this.quietMs = options.quietMs ?? 5 * 60_000;
    this.lastWrite = this.now();
  }
  /** Appends to `path`, creating it readable by its owner only. */
  static toFile(path: string, now?: () => number) {
    return new ProgressLog(
      (text) => appendFileSync(path, text, { mode: 0o600 }),
      now,
    );
  }
  line(scope: string, text: string) {
    try {
      this.append(
        `${stamp(this.now())} ${scope} ${text.replace(/\s+/g, " ").trim()}\n`,
      );
      this.lastWrite = this.now();
    } catch (error) {
      this.failure ??= String((error as Error)?.message ?? error).slice(0, 300);
    }
  }
  quiet() {
    return this.now() - this.lastWrite >= this.quietMs;
  }
  /** Runs shown as started whose end is not shown yet: still to be looked at. */
  pending() {
    return [...this.reported]
      .filter(([, seen]) => seen === "started")
      .map(([runId]) => runId);
  }
  /**
   * A line for each run of a request's tasks that started or ended since the
   * last call, from the controller's `progressRuns`. A run that started and
   * ended between two calls gets both lines; one released before it
   * launched, only that.
   */
  runs(
    requests: ReadonlyArray<{ scope: string; taskIds: readonly string[] }>,
    runs: readonly ProgressRun[],
  ) {
    for (const { scope, taskIds } of requests)
      for (const r of runs) {
        if (!taskIds.includes(r.taskId)) continue;
        const seen = this.reported.get(r.runId);
        if (seen === "ended") continue;
        if (!seen && r.state !== "NOT_STARTED") {
          const late =
            r.startedAt && this.now() - Date.parse(r.startedAt) > 60_000
              ? `, reserved ${stamp(Date.parse(r.startedAt))}`
              : "";
          this.line(scope, `run started: ${describe(r)} (${r.model}${late})`);
          this.reported.set(r.runId, "started");
        }
        if (!open(r)) {
          this.line(scope, ended(r, this.now()));
          this.reported.set(r.runId, "ended");
        }
      }
  }
  /**
   * What each request is doing, for a quiet stretch: its runs going (and how
   * long), or what it waits for.
   */
  still(
    requests: ReadonlyArray<{
      scope: string;
      taskIds: readonly string[];
      state: string;
    }>,
    runs: readonly ProgressRun[],
  ) {
    for (const { scope, taskIds, state } of requests) {
      const going = runs.filter((r) => taskIds.includes(r.taskId) && open(r));
      if (!going.length) this.line(scope, `still ${state}`);
      for (const r of going)
        this.line(
          scope,
          r.state === "RESERVED" || !r.startedAt
            ? `still waiting to launch: ${describe(r)}`
            : `still working: ${describe(r)} for ${duration(this.now() - Date.parse(r.startedAt))}${queued(r, runs) ? " (probably waiting its turn: Codex runs one at a time, and an earlier Codex run is still going)" : ""}`,
        );
    }
  }
}

const open = (r: ProgressRun) => r.state === "RESERVED" || r.state === "STARTED";
const describe = (r: ProgressRun) => `${r.taskId} ${r.role} on ${r.provider}`;
/** A Codex run with an earlier one still going waits for the login's lock. */
const queued = (r: ProgressRun, runs: readonly ProgressRun[]) =>
  r.provider === "codex" &&
  runs.some(
    (x) =>
      x.runId !== r.runId &&
      x.provider === "codex" &&
      x.state === "STARTED" &&
      !!x.startedAt &&
      x.startedAt < r.startedAt!,
  );
function ended(r: ProgressRun, now: number) {
  const took =
    r.startedAt &&
    duration((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt));
  switch (r.state) {
    case "NOT_STARTED":
      return `run released before launch: ${describe(r)}`;
    case "UNKNOWN":
      return `run outcome unknown: ${describe(r)}; it needs reconciliation`;
    default:
      return `run finished: ${describe(r)}: ${r.state}${took ? " after " + took : ""}`;
  }
}
export const stamp = (ms: number) =>
  Number.isFinite(ms)
    ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
    : "an unknown time";
export function duration(ms: number) {
  if (!Number.isFinite(ms)) return "an unknown time";
  const s = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${s}s`;
}
