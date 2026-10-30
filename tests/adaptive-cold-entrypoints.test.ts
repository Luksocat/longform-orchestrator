/** R5 N2: every fresh owner command must prepare lineage before its write lock. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonical } from "../src/domain.js";
import { checkpoint, project, put, review, workWith, type Project } from "./fixtures/adaptive/remediation-project.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function reviewed() {
  const f = project();
  await checkpoint(f);
  const worker = await workWith(f, "A", (a) => put(a, "output/A/result.txt", "reviewed work\n"));
  assert.equal(worker.receipt.status, "SUCCEEDED");
  f.c.bindAcceptance("A", "receipt", "output-" + worker.attempt.id, f.c.localActor());
  const reviewer = await review(f, "PASS");
  f.c.grant("A", {
    id: randomUUID(), operations: ["ACCEPT"], paths: ["output/A"],
    decisionText: "Accept this simulation's reviewed artifact", sourceRef: "test:owner",
  }, f.c.localActor());
  return { f, worker: worker.attempt, reviewer };
}

function decide(f: Project) {
  f.c.decide("A", {
    id: randomUUID(), text: "Accept the reviewed synthetic work", sourceRef: "test:owner",
    alternatives: [], limits: ["simulation"], operations: ["ACCEPT"], artifactRevision: f.c.task("A").artifactRevision,
  }, f.c.localActor());
}

async function command(f: Project, name: "audit" | "verify" | "accept", args: string[] = []) {
  const policy = join(f.root, "routing-policy.json");
  writeFileSync(policy, canonical(f.c.config.routingPolicy));
  const result = await exec(process.execPath, ["--import", "tsx", cli, name, "A", "--db", join(f.root, "state.sqlite"),
    "--routing-policy", policy, "--host", "claude", "--execute", ...args], {
      timeout: 30_000, maxBuffer: 1024 * 1024,
      // Exercise the fixture's recorded host, independent of the test runner's host.
      env: { ...process.env, CLAUDECODE: "1", CODEX_THREAD_ID: "" },
    });
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

test("N2: separate CLI processes audit, verify and accept reviewed adaptive work", async () => {
  const { f, reviewer } = await reviewed();
  try {
    // Each command starts a new runtime and has no cache from work or review.
    const audits = await command(f, "audit", ["--run-id", reviewer.id]);
    assert.equal(audits.length, 3);
    assert.ok(audits.every((a: any) => a.result === "PASS" && a.independent), canonical(audits));
    await command(f, "verify");
    assert.equal(f.c.task("A").status, "VERIFIED");
    decide(f);
    await command(f, "accept");
    assert.equal(f.c.task("A").status, "ACCEPTED");
    f.restart();
    assert.equal(f.c.inspect("A").acceptanceCurrent, true);
  } finally { f.close(); }
});

test("N2: a fresh audit still rejects changed artifact bytes", async () => {
  const { f, worker, reviewer } = await reviewed();
  try {
    put(worker, "output/A/result.txt", "tampered after review\n");
    f.restart();
    const audits = f.c.audit("A", f.c.localActor(), reviewer.id);
    assert.ok(audits.some((a) => a.result === "FAIL" && a.checks.includes("WORKER_ARTIFACT_CHANGED_OR_UNSEALED")), canonical(audits));
    assert.ok(audits.every((a) => !a.independent), canonical(audits));
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
  } finally { f.close(); }
});

test("N2: fresh verification refuses tampering after the audits", async () => {
  const { f, worker, reviewer } = await reviewed();
  try {
    f.c.audit("A", f.c.localActor(), reviewer.id);
    put(worker, "output/A/result.txt", "tampered after audits\n");
    f.restart();
    assert.throws(() => f.c.verify("A", f.c.localActor()), /INDEPENDENT_REVIEW_REQUIRED|WORKER_ARTIFACT_CHANGED/);
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
  } finally { f.close(); }
});

test("N2: fresh acceptance refuses tampering after verification", async () => {
  const { f, worker, reviewer } = await reviewed();
  try {
    f.c.audit("A", f.c.localActor(), reviewer.id);
    f.c.verify("A", f.c.localActor());
    decide(f);
    put(worker, "output/A/result.txt", "tampered after verification\n");
    f.restart();
    assert.throws(() => f.c.accept("A", f.c.localActor()), /INDEPENDENT_REVIEW_REQUIRED|WORKER_ARTIFACT_CHANGED/);
    assert.equal(f.c.task("A").status, "VERIFIED");
  } finally { f.close(); }
});
