import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoTask } from "../src/domain.js";
import { openRuntime } from "../src/runtime.js";

test("a database reached through a linked directory runs in its real workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "longform-runtime-paths-"));
  try {
    const real = join(root, "real");
    mkdirSync(real);
    symlinkSync(real, join(root, "linked"));
    const { db, c, actor, workspaceRoot } = openRuntime(
      join(root, "linked", "state.sqlite"),
    );
    try {
      assert.equal(workspaceRoot, join(realpathSync(real), "workspaces"));
      const t = demoTask("A", { providers: ["codex", "claude"] });
      c.importTasks([t], actor);
      c.grant(
        "A",
        {
          id: "grant-A",
          operations: t.operations,
          paths: t.writePaths,
          decisionText: "Synthetic local test only",
          sourceRef: "test:owner-authorization",
        },
        actor,
      );
      const a = c.reserve(
        "A",
        {
          provider: "codex",
          model: "synthetic-codex",
          effort: "test",
          requestKey: randomUUID(),
          role: "worker",
        },
        actor,
      );
      assert.ok(a.workspace.startsWith(workspaceRoot + "/"));
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
