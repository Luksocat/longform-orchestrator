import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Controller } from "../src/controller.js";
import { demoTask, isReservedLane } from "../src/domain.js";
import { SqliteStore } from "../src/store.js";

const run = promisify(execFile);
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const sourceUrl = (name: string) => new URL("../src/" + name, import.meta.url).href;

function controllerFixture() {
  const root = mkdtempSync(join(tmpdir(), "longform-generic-controller-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const controller = new Controller(db, {
    workspaceRoot: join(root, "work"),
    ownerUid: process.getuid!(),
  });
  return {
    controller,
    actor: controller.localActor(),
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("programme reporting includes arbitrary project names and excludes reserved work and simulations", () => {
  const fixture = controllerFixture();
  try {
    const { controller, actor } = fixture;
    controller.importTasks(
      [
        demoTask("RESEARCH", {
          programme: "RESEARCH_PROJECT",
          simulation: false,
        }),
        demoTask("WRITING", {
          programme: "WRITING_PROGRAMME",
          simulation: false,
        }),
        demoTask("DEFERRED", {
          programme: "RESEARCH_PROJECT",
          lane: "Research / HOLD",
          simulation: false,
        }),
        demoTask("SIMULATED", { programme: "RESEARCH_PROJECT" }),
      ],
      actor,
    );
    const report = controller.report();
    assert.equal(report.programme.registered, 2);
    assert.deepEqual(
      report.programme.tasks.map((task) => task.id).sort(),
      ["RESEARCH", "WRITING"],
    );
    assert.equal(report.programme.accepted, 0);
    assert.equal(report.programme.completionEstimate.percent, 0);
    assert.equal(report.simulation.registered, 1);
    assert.equal(report.externalMutations, "SCOPED_DRIVE_ONLY");
  } finally {
    fixture.close();
  }
});

test("reserved HOLD workstreams cannot be dispatched even with valid task grants", () => {
  const fixture = controllerFixture();
  try {
    const { controller, actor } = fixture;
    const lanes = ["HOLD", "hold", "Research / HOLD", "Research_HOLD"];
    const tasks = lanes.map((lane, index) => demoTask("HELD-" + index, { lane }));
    controller.importTasks(tasks, actor);
    for (const task of tasks) {
      assert.equal(isReservedLane(task.lane), true);
      controller.grant(
        task.id,
        {
          id: "grant-" + task.id,
          operations: task.operations,
          paths: task.writePaths,
          decisionText: "Synthetic test grant; reserved work remains held",
          sourceRef: "test:reserved-workstream",
        },
        actor,
      );
      assert.ok(
        controller.reasons(task.id).includes("RESERVED_LANE_EXCLUDED_FROM_EXECUTION"),
      );
      assert.throws(
        () => controller.reserve(task.id, { requestKey: "attempt-" + task.id }, actor),
        /RESERVED_LANE_EXCLUDED_FROM_EXECUTION/,
      );
      assert.equal(controller.inspect(task.id).attempts.length, 0);
    }
    for (const lane of ["RESEARCH", "shareholder-research", "holdover", "99"])
      assert.equal(isReservedLane(lane), false, lane);
  } finally {
    fixture.close();
  }
});

/**
 * A child process with a disposable home and no inherited credentials.
 * Connector reads, fetch and subprocess probes are intercepted after module
 * loading, so a regression cannot contact a service or run a provider binary.
 */
function doctorFixture() {
  const root = mkdtempSync(join(tmpdir(), "longform-generic-doctor-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  for (const executable of ["codex", "claude"])
    writeFileSync(join(bin, executable), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const database = join(root, "state.sqlite");
  const remoteCalls = join(root, "remote-calls.txt");
  const processCalls = join(root, "process-calls.txt");
  const harness = join(root, "doctor-harness.mjs");
  writeFileSync(
    harness,
    `import { main } from ${JSON.stringify(sourceUrl("cli.ts"))};
import { DriveReadOnlyAdapter, GitHubReadOnlyAdapter } from ${JSON.stringify(sourceUrl("evidence.ts"))};
import { GitHubGhReadOnlyAdapter } from ${JSON.stringify(sourceUrl("github-cli.ts"))};
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const remote = () => {
  appendFileSync(${JSON.stringify(remoteCalls)}, "blocked remote read\\n");
  throw new Error("TEST_REMOTE_READ_BLOCKED");
};
for (const adapter of [DriveReadOnlyAdapter, GitHubReadOnlyAdapter, GitHubGhReadOnlyAdapter])
  adapter.prototype.read = remote;
globalThis.fetch = remote;
const child = createRequire(import.meta.url)("node:child_process");
child.spawn = () => {
  appendFileSync(${JSON.stringify(processCalls)}, "blocked subprocess probe\\n");
  throw new Error("TEST_SUBPROCESS_BLOCKED");
};
syncBuiltinESMExports();
try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + "\\n");
  process.exitCode = 1;
}
`,
  );
  return {
    database,
    remoteCalls,
    processCalls,
    async run(args: string[]) {
      const options = {
        cwd: root,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: bin,
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          TMPDIR: root,
          LANG: "C.UTF-8",
          NO_COLOR: "1",
        },
      };
      try {
        const result = await run(
          process.execPath,
          ["--import", tsx, harness, "doctor", "--db", database, ...args],
          options,
        );
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const result = error as { code: number | string; stdout: string; stderr: string };
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      }
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const rejectedTargets = [
  {
    name: "missing explicit targets",
    args: ["--live-read"],
    error: "DOCTOR_TARGET_REQUIRED",
  },
  {
    name: "target without live-read",
    args: ["--github-repository", "example/research"],
    error: "DOCTOR_TARGET_REQUIRES_LIVE_READ",
  },
  {
    name: "invalid Drive file ID",
    args: ["--live-read", "--drive-file-id", "invalid/id"],
    error: "INVALID_DRIVE_FILE_ID",
  },
  {
    name: "invalid GitHub repository",
    args: ["--live-read", "--github-repository", "missing-owner"],
    error: "INVALID_GITHUB_REPOSITORY",
  },
  {
    name: "branch without a repository",
    args: ["--live-read", "--drive-file-id", "synthetic_file_id", "--github-branch", "main"],
    error: "GITHUB_BRANCH_REQUIRES_REPOSITORY",
  },
  {
    name: "invalid branch before any selected connector can read",
    args: [
      "--live-read", "--drive-file-id", "synthetic_file_id",
      "--github-repository", "example/research", "--github-branch", "../main",
    ],
    error: "INVALID_GITHUB_BRANCH",
  },
];

for (const scenario of rejectedTargets) {
  test("doctor rejects " + scenario.name + " before state or probes", async () => {
    const fixture = doctorFixture();
    try {
      const result = await fixture.run(scenario.args);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, new RegExp(scenario.error));
      assert.equal(existsSync(fixture.database), false);
      assert.equal(existsSync(fixture.processCalls), false);
      assert.equal(existsSync(fixture.remoteCalls), false);
    } finally {
      fixture.close();
    }
  });
}

test("doctor without live-read performs no connector reads", async () => {
  const fixture = doctorFixture();
  try {
    const result = await fixture.run([]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.live.status, "NOT_EXECUTED");
    assert.equal(report.live.reason, "--live-read not selected");
    assert.equal(existsSync(fixture.database), true);
    assert.equal(existsSync(fixture.processCalls), true, "local probes reached the test guard");
    assert.equal(existsSync(fixture.remoteCalls), false);
    assert.deepEqual(report.credentials, { driveReadToken: false, githubReadToken: false });
  } finally {
    fixture.close();
  }
});
