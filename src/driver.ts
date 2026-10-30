import type { RunStop } from "./controller.js";
import { conflictingHosts, type Orchestrator } from "./orchestrator.js";
import { duration, stamp, type ProgressLog } from "./progress-log.js";

/**
 * One built-in driver for the requests this host owns , in place of ad hoc polling scripts. It only advances requests
 * through the orchestrator's normal `drive()`, so every gate applies as in a
 * manual advance: question scopes, request and provider pauses, recovery
 * rules, write claims, the one admission path. It never answers a question,
 * clears a hold or a pause, reconciles or grants anything.
 *
 * One advance at a time per project, up to the execution slots at once, the
 * least recently served first. After each advance it classifies the request
 * from its view. A request whose advance changed nothing it tracks (its
 * progress fingerprint) is not advanced again until something changes, or
 * until a known time (a provider's reset) or a backoff for a passing
 * condition (capacity, another run in the project, a recheck elsewhere).
 * What only a person can clear (an unknown run, an uncertain Drive write) is
 * untimed. With nothing runnable it sleeps until the earliest such time
 * within its budget; with only untimed blockers left it returns, saying what
 * each request waits for.
 */
export type DriveOutcome =
  | "FINISHED"
  | "PAUSED"
  | "WAITING_FOR_ANSWERS"
  | "WAITING_FOR_OWNER"
  | "HELD"
  | "WAITING_UNTIL"
  | "TIME_BUDGET_ENDED";
export type DriveResult = {
  requestId: string;
  outcome: DriveOutcome;
  detail: string;
  until?: string;
  advances: number;
  nextActions: string[];
};
type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((done) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", () => (clearTimeout(timer), done()), {
        once: true,
      });
    }),
};
/**
 * The longest single sleep. State is read again between sleeps, so a pause,
 * an answer or a release recorded elsewhere is seen within this time.
 */
const LONGEST_SLEEP_MS = 60_000;
/** Conditions another advance may clear by itself, given time. */
const PASSING =
  /ASSESSOR_ADMISSIBLE|MAX_CONCURRENCY|PROJECT_RUN_ACTIVE_OR_UNKNOWN|OTHER_HOST_LIVE_PROCESS_ACTIVE|PROVIDER_RECHECK_IN_PROGRESS|CLAIM_CONFLICT|LEASE_NOT_OWNED|SQLITE_BUSY|database is locked/;
/**
 * The same conditions when only a person can clear them: a run whose
 * outcome is unknown, a Drive write left uncertain or open by an operation
 * that has ended, or a filing that stopped holding its claims. These wait
 * for reconciliation, so they are not retried.
 */
const NEEDS_RECONCILIATION =
  /write intent UNCERTAIN|lease ran out|attempt (?!RESERVED\b|STARTED\b)[A-Z_]+|PROJECT_RUN_ACTIVE_OR_UNKNOWN: run \S+ is UNKNOWN/;
/**
 * Whether a line names a condition that passes with time alone. Capacity
 * passes only while some slot belongs to a run that is going; slots held by
 * unknown runs wait for reconciliation.
 */
const passing = (line: string) => {
  if (!PASSING.test(line) || NEEDS_RECONCILIATION.test(line)) return false;
  const capacity = /MAX_CONCURRENCY: slots held by (.*)/.exec(line);
  return !capacity || /\((RESERVED|STARTED)\)/.test(capacity[1]!);
};
/** Holds a provider's reset can clear: the pause itself and its recheck. */
const resettable = (hold: string) =>
  /PROVIDER_PAUSED|PROVIDER_RECHECK/.test(hold);
/** The assessor providers a required-assessment hold names as untried. */
const pendingAssessors = (t: any): string[] => {
  const assessment = (t.holds as string[]).find((h) =>
    h.startsWith("ASSESSMENT_REQUIRED: "),
  );
  return assessment
    ? [...assessment.matchAll(/([a-z]+)=PENDING\b/g)].map((m) => m[1]!)
    : [];
};
/**
 * The providers whose reset could let this task's next run start. While a
 * required assessment is pending, that run is an assessor: a pending
 * provider counts when the controller's admission check for its assessor,
 * made now, refuses it for that provider's own pause and nothing earlier
 * (capacity, the project's run, its route), whatever was recorded before;
 * the worker's provider does not count. Otherwise the task counts only when
 * every hold it has is a pause or passes with time, and then for the
 * providers its holds and refusals name.
 */
function timedProviders(
  t: any,
  lines: string[],
  assessorNow: (taskId: string, provider: string) => string | undefined,
): string[] {
  const assessment = (t.holds as string[]).find((h) =>
    h.startsWith("ASSESSMENT_REQUIRED: "),
  );
  if (assessment) {
    const others = (t.holds as string[]).filter(
      (h) => h !== assessment && !resettable(h) && !passing(h),
    );
    if (others.length) return [];
    return pendingAssessors(t).filter((provider) =>
      new RegExp("^PROVIDER_PAUSED:" + provider + ":until=").test(
        assessorNow(t.taskId, provider) ?? "",
      ),
    );
  }
  if ((t.holds as string[]).some((h) => !resettable(h) && !passing(h)))
    return [];
  return [
    ...new Set(
      lines.flatMap((line) =>
        [...line.matchAll(/PROVIDER_PAUSED:([a-z]+)/g)].map((m) => m[1]!),
      ),
    ),
  ];
}
/**
 * These providers' pauses in a list of pauses, as [provider, reset], in a
 * stable order: a timed wait records it from the same view its reset came
 * from and compares it with the controller's pauses later, so clearing or
 * changing any one of them wakes the request, not only the earliest.
 */
function pausesIn(
  pauses: ReadonlyArray<{ provider: string; state: string; until?: string }>,
  providers: Set<string>,
): Array<[string, number]> {
  return pauses
    .filter((p) => providers.has(p.provider) && p.state === "PAUSED" && p.until)
    .map((p) => [p.provider, Date.parse(p.until!)] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]));
}
/** The runs and filings a blocker names (their IDs). */
const holderIds = (text: string) => [
  ...new Set(
    [...text.matchAll(/\b(?:run|filing) ([0-9a-f]{8}-[0-9a-f-]{27})\b/g)].map(
      (m) => m[1]!,
    ),
  ),
];
/** What those holders hold now: a release or reconciliation changes it. */
function holderState(o: Orchestrator, ids: string[]): string {
  return JSON.stringify(
    ids.map((id) => [
      id,
      o.controller.db.get<{ state: string }>(
        "SELECT state FROM attempts WHERE id=?",
        id,
      )?.state ?? null,
      o.controller.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM resource_claims WHERE holder_id=? AND state IN ('RUN','HELD','OPEN','UNCERTAIN')",
        id,
      )?.n ?? 0,
    ]),
  );
}
/**
 * An expired lease is not proof that a process stopped or that its external
 * effects are settled. The driver may report it, but only recover/reconcile
 * under the operator's separate evidence and authority (never blind replay).
 * Read the attempt rows directly: a full project view can be slow on a live DB.
 */
type WatchedLease = {
  id: string;
  taskId: string;
  role: string;
  state: "RESERVED" | "STARTED";
  leaseUntil: number;
};
function expiredRun(
  o: Orchestrator,
  taskIds: readonly string[],
  blockerText: string,
): WatchedLease | undefined {
  const tasks = new Set(taskIds);
  const holders = new Set(holderIds(blockerText));
  return o.controller.db
    .all<{ body: string }>(
      "SELECT body FROM attempts WHERE state IN ('RESERVED','STARTED')",
    )
    .map((row) => JSON.parse(row.body) as WatchedLease)
    .filter(
      (run) =>
        (tasks.has(run.taskId) || holders.has(run.id)) &&
        Number.isFinite(run.leaseUntil) &&
        run.leaseUntil <= Date.now(),
    )
    .sort((a, b) => a.leaseUntil - b.leaseUntil)[0];
}
/** The run's state now (it may have been recorded unknown, or reconciled, since). */
const runState = (o: Orchestrator, id: string) =>
  o.controller.db.get<{ state: string }>(
    "SELECT state FROM attempts WHERE id=?",
    id,
  )?.state ?? "GONE";
/**
 * The hold an expired lease puts on a request, and the operator's next step,
 * by the run's state: a run still RESERVED/STARTED belongs to a process that
 * may be dead (`resume --execute` recovers every expired attempt in the
 * shared database, so its scope is said); one recorded UNKNOWN, by its own
 * end or by the stop the driver asked, waits for reconciliation from the
 * operator's own checks. Neither is proof of process death or of the absence
 * of outside effects.
 */
function expiredHold(
  run: WatchedLease,
  state: string,
): { detail: string; action: string } {
  const named =
    "RUN_LEASE_EXPIRED: " +
    run.id +
    " (" +
    state +
    ", " +
    run.role +
    ", task " +
    run.taskId +
    "). ";
  // Ended since (reconciled by the operator, or settled by its own process):
  // nothing of it is pending any more.
  if (!["RESERVED", "STARTED", "UNKNOWN"].includes(state)) {
    const action =
      "The run has since been recorded " +
      state +
      "; nothing of it is pending. Advance the request again.";
    return {
      action,
      detail: named + "Its heartbeat lease expired while the driver served the request. " + action,
    };
  }
  const action =
    state === "UNKNOWN"
      ? "The run is recorded UNKNOWN; its claims are kept. `reconcile-helper --run-id " +
        run.id +
        "` drafts the checks; establish yourself that its process stopped, what Drive holds and its usage, import the evidence (`evidence … --envelope`) and `reconcile` before any retry."
      : "Inspect the run and any external effects; `longform-orchestrator resume --execute` " +
        "recovers ALL expired attempts in the shared database. " +
        (run.state === "STARTED"
          ? "Then use `reconcile-helper --run-id " +
            run.id +
            "`, check process/effects/usage, import the evidence and `reconcile` before retrying."
          : "A definitely unstarted reservation needs no outcome reconciliation.");
  return {
    action,
    detail:
      named +
      "Its heartbeat lease expired; process death and external effects " +
      "are NOT established. Recovery required; do not restart or replay it. " +
      action,
  };
}

const FIRST_BACKOFF_MS = 30_000;
const ACTIVE_WATCHDOG_SLEEP_MS = 10_000;
const LONGEST_BACKOFF_MS = 10 * 60_000;
/** How long a run asked to stop has to confirm before its facts are looked at. */
const STOP_GRACE_MS = 30_000;
/** A stop still unconfirmed is said again this often, not at every wake. */
const NOTICE_EVERY_MS = 60_000;

/**
 * Waits until nothing of this process's live runs can still be going,
 * whether or not their advance has ended: no sandbox process alive and no
 * preflight probe running (each adapter's word), and no Drive write begun
 * here still open (its end needs the database). A cancellation the adapter
 * gave up confirming (`CANCELLATION_UNCONFIRMED…`) ends an advance while the
 * runner may still be stopping or draining, so the driver and the CLI wait
 * here before the live host lock goes and the database closes. It never
 * gives up and never takes time passed as evidence; it says what it waits
 * for, at most once a minute, and a failed read of the records is waited
 * out too .
 */
export async function hostQuiescence(
  o: Orchestrator,
  options: { clock?: Clock; notify?: (message: string) => void } = {},
): Promise<void> {
  const clock = options.clock ?? realClock;
  let noticed: number | undefined,
    last = "";
  for (;;) {
    let text: string;
    try {
      const { busy, openDriveWrites } = o.hostActivity();
      if (!busy.length && !openDriveWrites.length) return;
      text = [
        ...busy.map((b) => "run " + b.runId + ": " + b.detail),
        ...openDriveWrites.map(
          (w) =>
            "run " +
            w.runId +
            ": Drive write " +
            w.intentId +
            " (" +
            w.resource +
            ") still open",
        ),
      ].join("; ");
    } catch (error) {
      text =
        "the records could not be read: " +
        String((error as Error)?.message ?? error).slice(0, 300);
    }
    const now = clock.now();
    if (text !== last || noticed === undefined || now - noticed >= NOTICE_EVERY_MS) {
      noticed = now;
      last = text;
      try {
        options.notify?.(
          "waiting before the host lock and database go: " + text,
        );
      } catch {
        /* an unwritable notice changes nothing */
      }
    }
    await clock.sleep(ACTIVE_WATCHDOG_SLEEP_MS);
  }
}

/**
 * What the driver watches for change: per task its status, specifications,
 * holds, pending rework, proposal stage, assessment and advice, latest work,
 * review and checks, unsettled and interrupted runs; per request its status,
 * pause, open questions and Astra's checkpoint. Recorded refusals and held
 * steps are left out, so a pass that only records another refusal changes
 * nothing.
 */
export function progressFingerprint(
  o: Orchestrator,
  requestId: string,
): string {
  const view = o.inspect(requestId) as any;
  const tasks = view.tasks.map((t: any) => {
    const detail = o.controller.inspect(t.taskId) as any;
    const worker = detail.attempts
      .filter((a: any) => a.role === "worker" && a.state === "SUCCEEDED")
      .at(-1);
    const review = detail.reviews.at(-1);
    return {
      id: t.taskId,
      status: t.status,
      bound: t.boundSpecDigest,
      current: t.currentSpecDigest,
      holds: [...t.holds].sort(),
      rework: t.rework ?? null,
      proposals: t.proposals?.stage ?? null,
      difficulty: t.difficulty ?? null,
      advice: t.advice ?? null,
      worker: worker?.id ?? null,
      review: review ? [review.runId ?? null, review.verdict ?? null] : null,
      checks: detail.checkRework?.checksId ?? null,
      unresolved: t.unresolvedRuns,
      interrupted: t.interrupted?.runId ?? null,
    };
  });
  return JSON.stringify({
    status: view.status,
    pause: view.pause ?? null,
    questions: [
      ...view.questions
        .filter((q: any) => q.status === "OPEN")
        .map((q: any) => q.id),
      ...(view.otherRequestQuestions ?? []).map((q: any) => q.id),
    ].sort(),
    checkpoint: view.project
      ? [view.project.astraPlan?.revision ?? null, view.project.current ?? null]
      : null,
    tasks,
  });
}

const stepKeys = (view: any) =>
  new Set<string>(
    view.tasks.flatMap((t: any) => t.steps.map((s: any) => String(s.key))),
  );

export async function driveRequests(
  o: Orchestrator,
  options: {
    live?: boolean;
    mock?: boolean;
    /** Requests to serve; by default every request this host owns. */
    requestIds?: string[];
    /** Time budget in minutes (default 50, at most 600). */
    maxMinutes?: number;
    clock?: Clock;
    /** An upper bound on advances (tests). */
    maxAdvances?: number;
    /** Where progress lines go for the owner to watch; never read back. */
    progress?: ProgressLog;
    /** Test injection for the active-advance lease watcher only. */
    watchdogClock?: Clock;
    /**
     * The watchdog's notices as they happen (an expired lease, a stop asked
     * of its run and what that established), for the CLI's stderr; never
     * read back. None treats expiry as proof of process death.
     */
    notify?: (message: string) => void;
    /** How long a run asked to stop has to confirm (tests shorten it). */
    stopGraceMs?: number;
  },
): Promise<{ results: DriveResult[]; advances: number }> {
  if (!!options.live === !!options.mock)
    throw new Error("DRIVE_MODE_REQUIRED_ONE_OF_LIVE_MOCK");
  const clock = options.clock ?? realClock;
  // A virtual scheduler clock must not advance merely because an unrelated
  // advance is still pending. Watch active leases on their own clock instead.
  const watchdogClock = options.watchdogClock ?? realClock;
  const graceMs = options.stopGraceMs ?? STOP_GRACE_MS;
  const actor = o.controller.localActor();
  // The owner's progress log: lines from what the driver already knows and
  // one read-only query of runs; nothing here schedules or decides.
  const log = options.progress;
  const since = log ? o.controller.journalPosition() : 0;
  const short = (id: string) => id.slice(0, 8);
  const firstLine = (text: string) =>
    (text.split("\n").find((line) => line.trim()) ?? "").slice(0, 300);
  // Logging never stops the driver: a failure is kept for its result.
  const logged = (write: (log: ProgressLog) => void) => {
    if (!log) return;
    try {
      write(log);
    } catch (error) {
      log.failure ??= String((error as Error)?.message ?? error).slice(0, 300);
    }
  };
  // A notice sink that fails is not evidence of anything; the driver goes on.
  // Every notice goes to the progress log too, under its request when it has
  // one, so the owner sees it where the rest of the drive is.
  const notify = (message: string, scope = `driver[${process.pid}]`) => {
    try {
      options.notify?.(message);
    } catch {
      /* an unwritable notice changes nothing */
    }
    logged((log) => log.line(scope, "watchdog: " + message));
  };
  if (
    options.maxMinutes !== undefined &&
    (!Number.isFinite(options.maxMinutes) ||
      options.maxMinutes < 1 ||
      options.maxMinutes > 600)
  )
    throw new Error("MAX_MINUTES_INVALID: a number from 1 to 600");
  const minutes = options.maxMinutes ?? 50;
  const deadline = clock.now() + minutes * 60_000;
  const all = o.requests();
  let chosen: typeof all;
  if (options.requestIds?.length) {
    chosen = [];
    for (const id of options.requestIds) {
      const r = all.find((x) => x.id === id);
      if (!r) throw new Error("REQUEST_NOT_FOUND:" + id);
      // Never another agent host's request, even when named.
      if (conflictingHosts(r.host as never, o.host))
        throw new Error("REQUEST_OWNED_BY_OTHER_HOST:" + r.host);
      chosen.push(r);
    }
  } else
    // By default only the requests this host owns; untagged and operator
    // requests only when named.
    chosen = all.filter((r) => r.host === o.host);
  type State = {
    id: string;
    project: string;
    /** The request's tasks as its latest view showed them (progress log). */
    taskIds: string[];
    /** When its advance under way started (progress log). */
    advanceStarted?: number;
    served: number;
    advances: number;
    nextTry: number;
    backoff: number;
    fingerprint: string;
    /** Tasks this request owns; plus named blocking runs in detail/holders. */
    watchTaskIds: string[];
    recoveryAction?: string;
    /** The expired run the hold names, as found; its state is read again later. */
    expiredRun?: WatchedLease;
    /** The stop asked of that run while its advance is in flight, until it answers. */
    stop?: Promise<void>;
    /** What the last stop asked established. */
    stopped?: RunStop;
    /** When the last stop notice was given (watchdog clock). */
    noticed?: number;
    stalled?: string;
    /** The runs and filings a stalled request's blockers name, and their state then. */
    holders?: { ids: string[]; state: string };
    done?: { outcome: DriveOutcome; detail: string };
    detail: string;
    until?: number;
    /** The pauses a timed wait is for: each provider and its reset then. */
    timedOn?: Array<[provider: string, until: number]>;
  };
  const states: State[] = chosen.map((r) => ({
    id: r.id,
    project: r.projectKey,
    taskIds: [],
    served: 0,
    advances: 0,
    nextTry: 0,
    backoff: FIRST_BACKOFF_MS,
    fingerprint: progressFingerprint(o, r.id),
    watchTaskIds: (o.inspect(r.id) as any).tasks.map((t: any) => t.taskId),
    detail: "",
  }));
  let advances = 0,
    tick = 0;
  // A request's state as its view shows it, before or after an advance.
  const settle = (s: State, view: any) => {
    s.taskIds = view.tasks.map((t: any) => t.taskId);
    if (o.requestPause(s.id))
      return (s.done = { outcome: "PAUSED", detail: "paused by the owner" });
    switch (view.status) {
      case "ACCEPTED_BY_CONTROLLER":
        return (s.done = { outcome: "FINISHED", detail: "accepted" });
      case "VERIFIED_AWAITING_ACCEPTANCE":
        return (s.done = {
          outcome: "WAITING_FOR_OWNER",
          detail: "verified; the owner's acceptance is next",
        });
      case "WAITING_INPUT":
        return (s.done = {
          outcome: "WAITING_FOR_ANSWERS",
          detail: "questions are open for every task that could advance",
        });
      case "NEEDS_SCOPING":
        return (s.done = {
          outcome: "HELD",
          detail: "the request has no tasks",
        });
      default:
        return undefined;
    }
  };
  /**
   * A stale STARTED/RESERVED lease must not be treated as a live heartbeat.
   * Do not auto-recover it: recover() is global to the shared database, and
   * only the operator can establish process/effect/usage facts. The request
   * is held as soon as the expiry is seen, and the owner told then, whether
   * or not an advance is still in flight on it. Its underlying run retains
   * all controller claims; no new worker is authorized by this observation.
   */
  const holdExpiredRun = (s: State): boolean => {
    if (s.expiredRun) return true;
    const run = expiredRun(
      o,
      s.watchTaskIds,
      [s.detail, ...(s.holders?.ids.map((id) => "run " + id) ?? [])].join("\n"),
    );
    if (!run) return false;
    const hold = expiredHold(run, run.state);
    s.expiredRun = run;
    s.recoveryAction = hold.action;
    s.done = { outcome: "HELD", detail: hold.detail };
    notify(hold.detail, short(s.id));
    return true;
  };
  /**
   * An expired run that an advance still in flight waits on is asked to
   * stop, scoped to that run (Controller.stopRun), as a lost lease stops any
   * run. The advance stays in flight, and with it the caller's host lock and
   * open database, until the controller ends it: when the adapter confirms
   * the stop, or when nothing of the run can still be going (no process of
   * it alive, by the adapter's own word, and no Drive write of it open), in
   * which case the run's outcome is recorded unknown for reconciliation.
   * While a process or a Drive write of it may be alive, or the adapter
   * cannot say, the driver keeps waiting and says so, and asks again at a
   * later wake. A run that is not this process's is left to its own process.
   * Nothing is released, replayed or reconciled here.
   */
  const stopExpiredRun = (s: State) => {
    if (s.stop || s.stopped?.outcome === "NOT_IN_PROCESS") return;
    const run = s.expiredRun!;
    s.stop = o.controller
      .stopRun(run.id, actor, {
        reason: "RUN_LEASE_EXPIRED: stop asked by the driver",
        graceMs,
      })
      .then(
        (stop) => stop,
        (error): RunStop => ({
          outcome: "UNCONFIRMED",
          detail:
            "the stop could not be asked: " +
            String((error as Error)?.message ?? error).slice(0, 300),
        }),
      )
      .then((stop) => {
        s.stop = undefined;
        const now = watchdogClock.now();
        const repeated =
          s.stopped?.outcome === stop.outcome &&
          s.stopped.detail === stop.detail &&
          s.noticed !== undefined &&
          now - s.noticed < NOTICE_EVERY_MS;
        s.stopped = stop;
        if (repeated) return;
        s.noticed = now;
        notify(
          "run " +
            run.id +
            " (task " +
            run.taskId +
            "): stop " +
            stop.outcome +
            ": " +
            stop.detail +
            (stop.outcome === "UNCONFIRMED"
              ? "; the advance, the host lock and the database are kept; asking again"
              : stop.outcome === "ABANDONED"
                ? "; its advance was ended here, for reconciliation"
                : stop.outcome === "NOT_IN_PROCESS"
                  ? "; its advance waits on something else and ends on its own"
                  : ""),
          short(s.id),
        );
      });
  };
  // What would refuse this provider's assessor for the task right now
  // (undefined: it would be admitted), from the controller's own admission
  // checks, made read-only; never from old refusals, which are recorded only
  // once per reason and go stale.
  const assessorNow = (taskId: string, provider: string, requestId: string) => {
    const others = (["codex", "claude", "mock"] as const).filter(
      (p) => p !== provider,
    );
    try {
      return o.controller.admissionRefusal(taskId, {
        role: "assessor",
        excludeProviders: [...others],
        projectRequestId: requestId,
      });
    } catch (error) {
      return String((error as Error)?.message ?? error);
    }
  };
  // After an advance: did the request move, and if not, what does it wait for?
  const classify = (
    s: State,
    error: string | undefined,
    before: Set<string>,
  ) => {
    const view = o.inspect(s.id) as any;
    s.watchTaskIds = view.tasks.map((t: any) => t.taskId);
    if (holdExpiredRun(s)) return;
    if (settle(s, view)) return;
    const fp = progressFingerprint(o, s.id);
    if (fp !== s.fingerprint) {
      s.fingerprint = fp;
      s.nextTry = clock.now();
      s.backoff = FIRST_BACKOFF_MS;
      s.until = undefined;
      return;
    }
    // Steps this advance recorded, and each task's latest held step: a
    // refusal for the same reason as before is recorded only once, so it is
    // not new.
    const perTask = view.tasks.map((t: any) => {
      const fresh = t.steps.filter(
        (step: any) => !before.has(String(step.key)),
      );
      // The task's latest step when it is held: a refusal for the same reason
      // as before is recorded only once, so it is not new. (Not each
      // stage's latest: a stage that later succeeds records no step, so its
      // old refusal would look current.)
      const last = t.steps.at(-1);
      const assessing = pendingAssessors(t);
      // Only a task the advance could serve is probed: one no open question
      // covers and with no other hold time cannot clear (the orchestrator's
      // own gates, which the controller's checks do not repeat).
      const assessmentHold = (t.holds as string[]).find((h) =>
        h.startsWith("ASSESSMENT_REQUIRED: "),
      );
      const covers = (q: any) =>
        q.projectWide || (q.taskIds ?? []).includes(t.taskId);
      const servable =
        !(view.questions ?? []).some(
          (q: any) => q.status === "OPEN" && covers(q),
        ) &&
        !(view.otherRequestQuestions ?? []).some(covers) &&
        !(t.holds as string[]).some(
          (h) => h !== assessmentHold && !resettable(h) && !passing(h),
        );
      const pending = servable ? assessing : [];
      const steps = (
        last?.outcome === "HELD" && !fresh.includes(last)
          ? [...fresh, last]
          : fresh
      )
        // While an assessment is pending, its assessors' admission is asked
        // now instead (below); their recorded refusals may be stale.
        .filter(
          (step: any) =>
            !assessing.length || step.stage !== "ASSESSMENT_NOT_OBTAINED",
        );
      const now = new Map(
        pending.map(
          (provider) =>
            [provider, assessorNow(t.taskId, provider, s.id)] as const,
        ),
      );
      const lines = [
        ...steps.map((step: any) => `${step.stage}: ${step.detail}`),
        ...[...now].map(([provider, refusal]) =>
          refusal === undefined
            ? `ASSESSOR_ADMISSIBLE[${provider}]: its assessor can be reserved now`
            : `ASSESSOR_NOW[${provider}]: ${refusal}`,
        ),
        ...(t.holds as string[]).map((h) => `${t.taskId}: ${h}`),
      ];
      return {
        lines,
        timed: timedProviders(t, lines, (_task, provider) => now.get(provider)),
      };
    });
    const text = [error ?? "", ...perTask.flatMap((t: any) => t.lines)].join(
      "\n",
    );
    // A reset counts only for a task whose next run it could let start; the
    // pauses waited on are taken from this same view, so a clear recorded
    // after it is seen as a change in the next round.
    const waited = pausesIn(
      view.providerPauses ?? [],
      new Set(perTask.flatMap((t: any) => t.timed as string[])),
    );
    const until = waited.length
      ? Math.min(...waited.map(([, at]) => at))
      : undefined;
    if (until !== undefined && until > clock.now()) {
      s.until = until;
      s.timedOn = waited;
      s.nextTry = until + 1_000;
      s.detail = "waiting for a provider's reset";
    } else if (
      view.status !== "HELD_RECONCILIATION" &&
      (text.split("\n").some(passing) ||
        view.status === "RUNNING_OR_RECOVERY_REQUIRED")
    ) {
      s.nextTry = clock.now() + s.backoff;
      s.backoff = Math.min(LONGEST_BACKOFF_MS, s.backoff * 2);
      s.detail =
        "waiting for a passing condition: " +
        (text.split("\n").find(passing)?.slice(0, 300) ?? "a run in progress");
    } else {
      // Untimed: not retried until something it tracks changes, or a run or
      // filing its blocker names lets go.
      s.stalled = fp;
      const ids = holderIds(text);
      s.holders = ids.length ? { ids, state: holderState(o, ids) } : undefined;
      s.detail =
        text.slice(0, 2_000) || "no progress, and nothing known to wait for";
    }
  };
  const budgetOpen = () =>
    clock.now() < deadline &&
    (options.maxAdvances === undefined || advances < options.maxAdvances);
  // Advances run side by side, one per project and up to the slots; each is
  // judged as it ends, and freed capacity is used at once.
  const inflight = new Map<string, Promise<void>>();
  const ended: Array<{ s: State; error?: string; before: Set<string> }> = [];
  const runsSeen = (log: ProgressLog) => {
    const runs = o.controller.progressRuns(since, log.pending());
    log.runs(
      states.map((s) => ({ scope: short(s.id), taskIds: s.taskIds })),
      runs,
    );
    return runs;
  };
  const waitingFor = (s: State) =>
    s.done
      ? `${s.done.outcome}: ${s.done.detail}`
      : inflight.has(s.id)
        ? "advancing"
        : s.until !== undefined
          ? `waiting for a provider's reset until ${stamp(s.until)}`
          : s.stalled !== undefined
            ? `held: ${firstLine(s.detail)}`
            : `waiting: ${firstLine(s.detail) || "nothing yet"}; next try ${stamp(s.nextTry)}`;
  const start = (s: State) => {
    const before = stepKeys(o.inspect(s.id));
    s.served = ++tick;
    s.advances++;
    advances++;
    s.advanceStarted = clock.now();
    logged((log) => log.line(short(s.id), `advance ${s.advances} started`));
    inflight.set(
      s.id,
      o
        .drive(s.id, options.live ? { live: true } : { mock: true })
        .then(
          () => undefined,
          (error) => String((error as Error)?.message ?? error),
        )
        .then((error) => {
          ended.push({ s, ...(error !== undefined ? { error } : {}), before });
          inflight.delete(s.id);
        }),
    );
  };
  logged((log) =>
    log.line(
      `driver[${process.pid}]`,
      `started (${options.live ? "live" : "mock"}, budget ${minutes} min): ` +
        (states.map((s) => `${short(s.id)} (${s.project})`).join(", ") ||
          "no requests to serve"),
    ),
  );
  for (const s of states)
    if (!holdExpiredRun(s)) settle(s, o.inspect(s.id));
  // Between advances' ends: runs starting and finishing, and after a quiet
  // stretch what each request is doing.
  const ticker =
    log &&
    setInterval(
      () =>
        logged((log) => {
          const runs = runsSeen(log);
          if (log.quiet())
            log.still(
              states
                .filter((s) => !s.done)
                .map((s) => ({
                  scope: short(s.id),
                  taskIds: s.taskIds,
                  state: waitingFor(s),
                })),
              runs,
            );
        }),
      log.pollMs,
    );
  ticker?.unref();
  // The caller releases host locks and closes the database on return.
  // An expired in-flight advance therefore must settle before we return;
  // the diagnostic is delivered immediately even when this takes longer.
  try {
    while (true) {
      for (const e of ended.splice(0)) {
        const fingerprint = e.s.fingerprint;
        if (!e.s.done) classify(e.s, e.error, e.before);
        else if (e.s.expiredRun)
          notify(
            "advance ended; run " +
              e.s.expiredRun.id +
              " is " +
              runState(o, e.s.expiredRun.id) +
              (e.error ? "; the advance ended with: " + e.error.slice(0, 300) : ""),
            short(e.s.id),
          );
        logged((log) => {
          runsSeen(log);
          log.line(
            short(e.s.id),
            `advance ${e.s.advances} ended after ${duration(clock.now() - (e.s.advanceStarted ?? clock.now()))}: ` +
              (!e.s.done && e.s.fingerprint !== fingerprint
                ? "progress recorded"
                : waitingFor(e.s)),
          );
        });
      }
      const now = clock.now();
      // Every request not advancing is read again: paused, finished or answered
      // elsewhere, or a blocker released.
      for (const s of states) {
        if (inflight.has(s.id)) {
          // Report promptly, and ask the run to stop, again at later wakes
          // while unconfirmed; the promise is never detached: the live CLI
          // must retain its host lock and open database until drive() ends,
          // and only the controller ends it. Expiry is not proof that the
          // process or its effects have stopped.
          if (holdExpiredRun(s)) stopExpiredRun(s);
          continue;
        }
        if (s.done) continue;
        const view = o.inspect(s.id) as any;
        s.watchTaskIds = view.tasks.map((t: any) => t.taskId);
        if (holdExpiredRun(s) || settle(s, view)) continue;
        // A request waiting for a reset is woken when that pause ends or
        // changes before it (an operator's evidenced clear, a new limit).
        if (
          s.until !== undefined &&
          s.timedOn?.length &&
          JSON.stringify(
            pausesIn(
              o.controller.providerPauses(),
              new Set(s.timedOn.map(([p]) => p)),
            ),
          ) !== JSON.stringify(s.timedOn)
        ) {
          s.until = undefined;
          s.timedOn = undefined;
          s.nextTry = now;
        }
        if (s.stalled !== undefined) {
          const fp = progressFingerprint(o, s.id);
          if (
            fp !== s.stalled ||
            (s.holders && holderState(o, s.holders.ids) !== s.holders.state)
          ) {
            s.stalled = undefined;
            s.holders = undefined;
            s.fingerprint = fp;
            s.nextTry = now;
          }
        }
      }
      const idle = states.filter((s) => !s.done && !inflight.has(s.id));
      if (budgetOpen())
        for (const s of idle
          .filter((x) => x.stalled === undefined && x.nextTry <= now)
          .sort((a, b) => a.served - b.served)) {
          if (inflight.size >= o.controller.workerLimit || !budgetOpen()) break;
          if (
            [...inflight.keys()].some(
              (id) => states.find((x) => x.id === id)!.project === s.project,
            )
          )
            continue;
          start(s);
        }
      const due = budgetOpen()
        ? idle
            .filter(
              (s) =>
                !inflight.has(s.id) &&
                s.stalled === undefined &&
                s.nextTry > now,
            )
            .map((s) => s.nextTry)
        : [];
      if (!inflight.size && !due.length) break;
      // Always wake while drive() is pending. Keep that watchdog timer
      // separate from the scheduler clock: simulated retries and provider
      // resets must not advance merely because another project is working.
      // This preserves existing backoff semantics while detecting dead runs.
      const stop = new AbortController();
      const wake = Math.max(
        0,
        Math.min(
          due.length ? Math.min(...due) : Infinity,
          deadline,
          now + LONGEST_SLEEP_MS,
        ) - now,
      );
      try {
        await Promise.race([
          ...inflight.values(),
          ...(due.length || !inflight.size
            ? [clock.sleep(wake, stop.signal)]
            : []),
          ...(inflight.size
            ? [watchdogClock.sleep(ACTIVE_WATCHDOG_SLEEP_MS, stop.signal)]
            : []),
        ]);
      } finally {
        stop.abort();
      }
    }
  } catch (error) {
    await Promise.allSettled([...inflight.values()]);
    throw error;
  } finally {
    if (ticker) clearInterval(ticker);
  }
  // Nothing of this process's runs may still be going when the driver
  // returns: the caller releases the host lock and closes the database then.
  await hostQuiescence(o, { clock: watchdogClock, notify });
  // Settled again before reporting: a pause or a finish recorded meanwhile.
  for (const s of states) {
    if (!s.done) settle(s, o.inspect(s.id));
    // The expired run's state now: recorded unknown since (by its own end or
    // the stop asked), its hold names reconciliation, not recovery.
    if (s.expiredRun && s.done) {
      const state = runState(o, s.expiredRun.id);
      if (state !== s.expiredRun.state) {
        const hold = expiredHold(s.expiredRun, state);
        s.recoveryAction = hold.action;
        s.done = { outcome: "HELD", detail: hold.detail };
      }
    }
  }
  const results: DriveResult[] = states.map((s) => {
    const view = o.inspect(s.id) as any;
    const outcome: DriveOutcome = s.done
      ? s.done.outcome
      : s.stalled !== undefined
        ? "HELD"
        : s.until !== undefined
          ? "WAITING_UNTIL"
          : "TIME_BUDGET_ENDED";
    return {
      requestId: s.id,
      outcome,
      detail: s.done?.detail ?? s.detail,
      ...(s.until !== undefined && !s.done
        ? { until: new Date(s.until).toISOString() }
        : {}),
      advances: s.advances,
      nextActions: s.recoveryAction
        ? [s.recoveryAction, ...view.nextSteps]
        : view.nextSteps,
    };
  });
  logged((log) => {
    runsSeen(log);
    log.line(
      `driver[${process.pid}]`,
      `stopped after ${advances} advance(s): ` +
        (results
          .map(
            (r) =>
              `${short(r.requestId)} ${r.outcome}${r.until ? " until " + r.until : ""}`,
          )
          .join("; ") || "no requests served"),
    );
  });
  return { results, advances };
}
