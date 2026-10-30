import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProgressRun } from "../src/controller.js";
import { duration, ProgressLog } from "../src/progress-log.js";

// The driver's progress log : lines for the owner
// to watch; nothing reads them back.

const T0 = Date.parse("2026-10-27T10:00:00Z");
function memory(options: { quietMs?: number } = {}) {
  let now = T0;
  const lines: string[] = [];
  const log = new ProgressLog((text) => lines.push(text), () => now, options);
  return { log, lines, at: (ms: number) => (now = T0 + ms) };
}
const run = (over: Partial<ProgressRun>): ProgressRun => ({
  runId: "r1",
  taskId: "A",
  role: "worker",
  provider: "codex",
  model: "gpt-6.1-sol",
  state: "STARTED",
  startedAt: new Date(T0).toISOString(),
  ...over,
});

test("each run is shown once when it starts and once when it ends, with its outcome and time taken", () => {
  const m = memory();
  const mine = [{ scope: "req1", taskIds: ["A", "B"] }];
  m.log.runs(mine, [run({})]);
  m.log.runs(mine, [run({})]);
  assert.deepEqual(m.log.pending(), ["r1"], "looked at again until its end is shown");
  m.at(90_000);
  m.log.runs(mine, [
    run({ state: "SUCCEEDED", endedAt: new Date(T0 + 83_000).toISOString() }),
    // Started and ended between two looks: both lines.
    run({ runId: "r2", taskId: "B", role: "reviewer", provider: "claude", model: "claude-opus-5-5", state: "FAILED", startedAt: new Date(T0 + 10_000).toISOString(), endedAt: new Date(T0 + 20_000).toISOString() }),
    run({ runId: "r3", role: "assessor", state: "NOT_STARTED" }),
    run({ runId: "r4", role: "advisor", state: "UNKNOWN" }),
    // Another request's task: not this request's line.
    run({ runId: "r5", taskId: "Z" }),
  ]);
  m.log.runs(mine, [run({ state: "SUCCEEDED" })]);
  assert.deepEqual(m.log.pending(), []);
  assert.deepEqual(m.lines, [
    "2026-10-27T10:00:00Z req1 run started: A worker on codex (gpt-6.1-sol)\n",
    "2026-10-27T10:01:30Z req1 run finished: A worker on codex: SUCCEEDED after 1m23s\n",
    "2026-10-27T10:01:30Z req1 run started: B reviewer on claude (claude-opus-5-5, reserved 2026-10-27T10:00:10Z)\n",
    "2026-10-27T10:01:30Z req1 run finished: B reviewer on claude: FAILED after 10s\n",
    // Released before it launched, never seen going: only that line.
    "2026-10-27T10:01:30Z req1 run released before launch: A assessor on codex\n",
    "2026-10-27T10:01:30Z req1 run started: A advisor on codex (gpt-6.1-sol, reserved 2026-10-27T10:00:00Z)\n",
    "2026-10-27T10:01:30Z req1 run outcome unknown: A advisor on codex; it needs reconciliation\n",
  ]);
});

test("a quiet stretch gets a line per request: its runs going and for how long, a Codex run behind another one flagged, or what it waits for", () => {
  const m = memory({ quietMs: 300_000 });
  assert.equal(m.log.quiet(), false);
  m.at(299_000);
  assert.equal(m.log.quiet(), false);
  m.at(12 * 60_000);
  assert.equal(m.log.quiet(), true);
  const runs = [
    run({ runId: "early", taskId: "OTHER", startedAt: new Date(T0 - 60_000).toISOString() }),
    run({ runId: "late", taskId: "A" }),
    run({ runId: "review", taskId: "B", role: "reviewer", provider: "claude" }),
    // Reserved, not launched: no start time, and no Codex run is behind it.
    run({ runId: "reserved", taskId: "B", role: "assessor", state: "RESERVED", startedAt: undefined }),
    run({ runId: "done", taskId: "B", state: "SUCCEEDED" }),
  ];
  m.log.still(
    [
      { scope: "req1", taskIds: ["A", "B"], state: "advancing" },
      { scope: "req2", taskIds: ["C"], state: "waiting for a provider's reset until 2026-10-27T11:00:00Z" },
    ],
    runs,
  );
  assert.deepEqual(m.lines, [
    "2026-10-27T10:12:00Z req1 still working: A worker on codex for 12m00s (probably waiting its turn: Codex runs one at a time, and an earlier Codex run is still going)\n",
    "2026-10-27T10:12:00Z req1 still working: B reviewer on claude for 12m00s\n",
    "2026-10-27T10:12:00Z req1 still waiting to launch: B assessor on codex\n",
    "2026-10-27T10:12:00Z req2 still waiting for a provider's reset until 2026-10-27T11:00:00Z\n",
  ]);
  assert.equal(m.log.quiet(), false);
});

test("a line that cannot be written is dropped without stopping anything, and the first failure is kept", () => {
  let calls = 0;
  const log = new ProgressLog(() => {
    calls++;
    throw new Error("EACCES: permission denied, open 'driver.log'");
  });
  log.line("driver[1]", "started");
  log.line("driver[1]", "stopped");
  assert.equal(calls, 2);
  assert.match(log.failure!, /EACCES/);
});

test("durations read plainly", () => {
  assert.equal(duration(0), "0s");
  assert.equal(duration(59_400), "59s");
  assert.equal(duration(61_000), "1m01s");
  assert.equal(duration(3_600_000 + 5 * 60_000 + 30_000), "1h05m");
});

const tsx = fileURLToPath(import.meta.resolve("tsx"));
const source = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
test("the drive command writes its log beside the database by default, or where --log-file says, and an unwritable log does not stop it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longform-drive-log-"));
  const db = join(dir, "state.sqlite");
  const drive = async (...extra: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ["--import", tsx, source, "orchestrate", "--drive", "--mock", "--execute", "--max-minutes", "1", "--db", db, "--host", "claude", ...extra],
          { cwd: dir, timeout: 30000 },
        )
      ).stdout,
    );
  try {
    const first = await drive();
    assert.equal(first.logFile, join(dir, "driver.log"));
    assert.equal(first.logError, undefined);
    assert.deepEqual(first.results, []);
    assert.equal(statSync(first.logFile).mode & 0o777, 0o600);
    const text = readFileSync(first.logFile, "utf8");
    assert.match(text, /^\S+Z driver\[\d+\] started \(mock, budget 1 min\): no requests to serve\n\S+Z driver\[\d+\] stopped after 0 advance\(s\): no requests served\n$/);
    // Appended, not replaced.
    await drive();
    assert.equal(readFileSync(first.logFile, "utf8").split("\n").filter(Boolean).length, 4);
    const other = join(dir, "other.log");
    assert.equal((await drive("--log-file", other)).logFile, other);
    assert.match(readFileSync(other, "utf8"), /started \(mock/);
    const broken = await drive("--log-file", join(dir, "missing", "driver.log"));
    assert.match(broken.logError, /ENOENT/);
    assert.deepEqual(broken.results, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
