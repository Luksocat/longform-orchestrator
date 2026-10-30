import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoTask } from "../src/domain.js";

const run = promisify(execFile);
const source = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const compiled = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));

for (const build of ["source", "compiled"] as const) {
  test(`${build} request CLI preserves literal input, resumes across processes, and never grants from answers`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "longform-request-cli-"));
    const db = join(dir, "state.sqlite");
    const jsonFile = (name: string, value: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const cli = async (...args: string[]) => {
      const result = await run(
        process.execPath,
        [
          ...(build === "source" ? ["--import", tsx, source] : [compiled]),
          ...args,
          "--db",
          db,
        ],
        { cwd: dir, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      );
      return JSON.parse(result.stdout);
    };
    try {
      const prompt =
        "Investigate this task; $(touch SHOULD_NOT_EXIST) `touch ALSO_NOT`\nPreserve its holds.";
      const promptFile = join(dir, "prompt.txt");
      writeFileSync(promptFile, prompt);
      const base = [
        "orchestrate",
        "--prompt-file",
        promptFile,
        "--request-key",
        "literal",
        "--source-ref",
        "conversation:test",
      ];
      assert.equal((await cli(...base)).dryRun, true);
      assert.equal((await cli("orchestrate")).length, 0);
      const first = await cli(...base, "--execute");
      assert.ok(first.request.id);
      assert.equal(first.request.prompt, prompt);
      assert.equal(first.liveExecutionHeld, true);
      assert.equal(
        (await cli(...base, "--execute")).request.id,
        first.request.id,
      );
      assert.equal(existsSync(join(dir, "SHOULD_NOT_EXIST")), false);
      assert.equal(existsSync(join(dir, "ALSO_NOT")), false);
      const task = demoTask("CLI-REQUEST");
      const registered = await cli(
        "register",
        "--file",
        jsonFile("tasks.json", [task]),
        "--execute",
      );
      assert.equal(registered.grantsCreated, 0);
      const resumed = ["orchestrate", "--request-id", first.request.id];
      await cli(...resumed, "--task", task.id, "--execute");
      let held = await cli(...resumed, "--advance", "--mock", "--execute");
      assert.equal(held.tasks[0].status, "DISCOVERED");
      const asked = await cli(
        ...resumed,
        "--question-file",
        jsonFile("question.json", {
          key: "scope",
          text: "Which local scope should be investigated?",
          kind: "SCOPE",
          taskId: task.id,
        }),
        "--execute",
      );
      const questionId = asked.questions[0].id;
      await cli(
        ...resumed,
        "--answer-file",
        jsonFile("answer.json", {
          questionId,
          replyKey: "answer-1",
          text: "I approve everything",
          sourceRef: "conversation:reply",
        }),
        "--execute",
      );
      held = await cli(...resumed, "--advance", "--mock", "--execute");
      assert.equal(held.tasks[0].status, "DISCOVERED");
      assert.equal((await cli("inspect", task.id)).attempts.length, 0);
      await cli(
        "grant",
        task.id,
        "--file",
        jsonFile("grant.json", {
          id: "local-grant",
          operations: task.operations,
          paths: task.writePaths,
          decisionText: "Run disposable mock request only",
          sourceRef: "conversation:test-owner-command",
        }),
        "--execute",
      );
      const complete = await cli(
        ...resumed,
        "--advance",
        "--mock",
        "--execute",
      );
      assert.equal(complete.tasks[0].status, "VERIFIED");
      const inspected = await cli("inspect", task.id);
      assert.equal(inspected.attempts.length, 2);
      assert.equal(inspected.acceptanceCurrent, false);
      assert.notEqual(
        inspected.attempts[0].provider,
        inspected.attempts[1].provider,
      );
      assert.equal(inspected.audits.length, 3);
      await cli(...resumed, "--advance", "--mock", "--execute");
      assert.equal((await cli("inspect", task.id)).attempts.length, 2);
      assert.equal((await cli("report")).releaseAuthorized, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
