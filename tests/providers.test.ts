import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  chmod,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MockProvider,
  CodexCliProvider,
  ClaudeCliProvider,
  redact,
  runBoundedProcess,
  buildCliArguments,
  inspectCliOutput,
  probeCli,
  probeIsolation,
  validateProviderReceipt,
  normalizeCliResponse,
  type ProviderRequest,
  type IsolatedProviderRunner,
  type IsolatedRunInput,
  type ProcessResult,
  type CodexMessagePhase,
  canReadOwnerText,
  OWNER_TEXT_IN_SANDBOX,
} from "../src/providers.js";
import { ReviewSchema, reviewPayload } from "../src/domain.js";

function request(changes: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: "run-1",
    taskId: "MOCK-1",
    provider: "mock",
    model: "mock-v1",
    effort: "low",
    role: "worker",
    cwd: "/tmp",
    brief: "Synthetic public mock task.",
    deadlineMs: 500,
    ...changes,
  };
}

test("mock identities can emulate both providers and independent sessions without claiming live execution", async () => {
  const provider = new MockProvider({ delayMs: 30 });
  const [codex, claude] = await Promise.all([
    provider.execute(
      request({ provider: "codex", runId: "run-codex", model: "exact-codex" }),
    ),
    provider.execute(
      request({
        provider: "claude",
        runId: "run-claude",
        model: "exact-claude",
        role: "reviewer",
      }),
    ),
  ]);
  assert.equal(provider.maxActive, 2);
  assert.equal(codex.status, "SUCCEEDED");
  assert.equal(claude.status, "SUCCEEDED");
  assert.equal(codex.simulation, true);
  assert.equal(claude.simulation, true);
  assert.equal(codex.provider, "codex");
  assert.equal(claude.provider, "claude");
  assert.notEqual(codex.sessionId, claude.sessionId);
  assert.deepEqual(codex.tests, []);
});

test("mock rejects mismatched provider, model and effort identities", async () => {
  for (const options of [
    { providerIdentity: "codex" as const },
    { model: "other" },
    { effort: "high" },
  ]) {
    const receipt = await new MockProvider(options).execute(request());
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.identityVerified, false);
  }
});

test("mock distinguishes authentication failure, crash, malformed output, timeout and cancellation", async () => {
  assert.equal(
    (await new MockProvider({ outcome: "auth-failure" }).execute(request()))
      .output,
    "PROVIDER_AUTHENTICATION_FAILED",
  );
  assert.equal(
    (await new MockProvider({ outcome: "crash" }).execute(request())).status,
    "UNKNOWN",
  );
  await assert.rejects(
    new MockProvider({ outcome: "malformed" }).execute(request()),
    /MALFORMED_PROVIDER_RECEIPT/,
  );
  assert.equal(
    (
      await new MockProvider({ delayMs: 100 }).execute(
        request({ deadlineMs: 5 }),
      )
    ).status,
    "TIMED_OUT",
  );
  const abort = new AbortController();
  const pending = new MockProvider({ delayMs: 100 }).execute(
    request({ signal: abort.signal }),
  );
  abort.abort();
  assert.equal((await pending).status, "CANCELLED");
  assert.equal(
    (await new MockProvider().execute(request({ signal: abort.signal })))
      .output,
    "CANCELLED_BEFORE_START",
  );
});

test("malformed requests, forged success and unrelated execution receipts are rejected", async () => {
  await assert.rejects(
    new MockProvider().execute(request({ model: "x; echo unsafe" })),
  );
  const receipt = await new MockProvider().execute(request());
  assert.throws(() => validateProviderReceipt({ ...receipt, exitCode: 1 }));
  assert.throws(() =>
    validateProviderReceipt({ ...receipt, identityVerified: false }),
  );
  assert.throws(() =>
    validateProviderReceipt({
      ...receipt,
      endedAt: "2000-01-01T00:00:00.000Z",
    }),
  );
  assert.throws(
    () => validateProviderReceipt(receipt, request({ runId: "wrong-run" })),
    /RECEIPT_IDENTITY_MISMATCH/,
  );
  assert.throws(() => validateProviderReceipt({ ...receipt, extra: true }));
});

test("secret redaction removes supplied values, API keys, bearer tokens, assignments and private keys", () => {
  const input =
    'opaque-value sk-proj-abcdefghijklmno ghp_abcdefghijklmnop123 Bearer token123 api_key="value123" password=pw123\n-----BEGIN RSA PRIVATE KEY-----\nprivate-key-content\n-----END RSA PRIVATE KEY-----';
  const output = redact(input, ["opaque-value"]);
  for (const secret of [
    "opaque-value",
    "abcdefghijklmno",
    "abcdefghijklmnop123",
    "token123",
    "value123",
    "pw123",
    "private-key-content",
  ])
    assert.equal(output.includes(secret), false);
  assert.ok(output.includes("[REDACTED]"));
});

test("provider prose claiming tests passed never produces executable test evidence", async () => {
  const receipt = await new MockProvider({
    output: '{"tests":[{"passed":true}],"claim":"all native tests passed"}',
  }).execute(request());
  assert.deepEqual(receipt.tests, []);
});

test("output limits count bytes and redact mock output", async () => {
  const receipt = await new MockProvider({
    output: "Bearer abc123 " + "🙂".repeat(100),
  }).execute(request({ maxOutputBytes: 64 }));
  assert.ok(Buffer.byteLength(receipt.output) <= 64);
  assert.equal(receipt.output.includes("abc123"), false);
});

test("subprocess argv remains literal, environment is explicit and nonzero exits remain failure", async () => {
  const result = await runBoundedProcess({
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({value: process.argv[1], secret: process.env.LONGFORM_TEST_SECRET}));process.exitCode=7",
      "$(touch /tmp/longform-should-not-exist); `pwd`",
    ],
    cwd: "/tmp",
    env: {},
    deadlineMs: 1_000,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.status, "FAILED");
  assert.deepEqual(JSON.parse(result.stdout), {
    value: "$(touch /tmp/longform-should-not-exist); `pwd`",
  });
});

test("process deadline, cancellation, missing binary and output overflow are bounded", async () => {
  const options = {
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: "/tmp",
    env: {},
    deadlineMs: 25,
  };
  assert.equal((await runBoundedProcess(options)).status, "TIMED_OUT");
  const abort = new AbortController();
  const pending = runBoundedProcess({
    ...options,
    deadlineMs: 1_000,
    signal: abort.signal,
  });
  abort.abort();
  assert.equal((await pending).status, "CANCELLED");
  assert.equal(
    (
      await runBoundedProcess({
        ...options,
        executable: "/no-such-longform-binary",
      })
    ).status,
    "FAILED",
  );
  const overflow = await runBoundedProcess({
    ...options,
    args: [
      "-e",
      'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)',
    ],
    maxOutputBytes: 64,
    deadlineMs: 1_000,
  });
  assert.equal(overflow.status, "FAILED");
  assert.equal(Buffer.byteLength(overflow.stdout), 64);
  assert.ok(overflow.stderr.includes("OUTPUT_LIMIT_EXCEEDED"));
});

test("invalid subprocess launch configuration fails before execution", async () => {
  await assert.rejects(
    runBoundedProcess({
      executable: "sh",
      args: [],
      cwd: "/tmp",
      env: {},
      deadlineMs: 100,
    }),
    /INVALID_PROCESS_CONFIGURATION/,
  );
  await assert.rejects(
    runBoundedProcess({
      executable: "/bin/true",
      args: [],
      cwd: "/tmp",
      env: {},
      deadlineMs: 0,
    }),
    /INVALID_PROCESS_CONFIGURATION/,
  );
});

test("successful subprocess leaders cannot orphan same-group children with ignored stdio", async () => {
  const result = await runBoundedProcess({
    executable: process.execPath,
    args: [
      "-e",
      'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(c.pid));c.unref();',
    ],
    cwd: "/tmp",
    env: {},
    deadlineMs: 1_000,
  });
  assert.equal(result.status, "SUCCEEDED");
  const childPid = Number(result.stdout);
  assert.ok(childPid > 1);
  let stopped = false;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const status = await readFile(`/proc/${childPid}/stat`, "utf8");
        if (/\) [ZX] /.test(status)) {
          stopped = true;
          break;
        }
      } catch {
        stopped = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 10));
    }
    assert.equal(stopped, true);
  } finally {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      /* already stopped */
    }
  }
});

test("live providers remain disabled without separate trusted controller enablement", async () => {
  for (const [provider, Adapter] of [
    ["codex", CodexCliProvider],
    ["claude", ClaudeCliProvider],
  ] as const) {
    const receipt = await new Adapter({
      executable: "/nonexistent",
      allowedCwdRoot: "/tmp",
    }).execute(request({ provider }));
    assert.equal(receipt.output, "LIVE_PROVIDER_DISABLED");
    assert.equal(receipt.simulation, false);
  }
});

test("live mode rejects missing authentication, secret transmission and unsupported hard budgets", async () => {
  const base = {
    enabled: true,
    executable: "/nonexistent",
    allowedCwdRoot: "/tmp",
    sanitizedPublicBrief: true,
  };
  assert.equal(
    (await new CodexCliProvider(base).execute(request({ provider: "codex" })))
      .output,
    "PROVIDER_AUTHENTICATION_UNAVAILABLE",
  );
  const authenticated = new CodexCliProvider({
    ...base,
    apiKey: "private-provider-key",
  });
  assert.equal(
    (
      await authenticated.execute(
        request({ provider: "codex", brief: "send private-provider-key" }),
      )
    ).output,
    "BRIEF_DATA_CLASSIFICATION_REQUIRED",
  );
  assert.equal(
    (await authenticated.execute(request({ provider: "codex", maxCostUsd: 1 })))
      .output,
    "HARD_BUDGET_UNSUPPORTED",
  );
  assert.equal(
    (await authenticated.execute(request({ provider: "codex", maxTokens: 10 })))
      .output,
    "HARD_BUDGET_UNSUPPORTED",
  );
});

test("CLI argument builders pin model and effort with fresh contexts and no fallback or nested workers", () => {
  const codex = buildCliArguments(
    "codex",
    request({ provider: "codex", model: "exact-model", effort: "high" }),
  );
  assert.ok(codex.includes("--ephemeral"));
  assert.ok(codex.includes("--ignore-user-config"));
  assert.ok(codex.includes("exact-model"));
  assert.ok(codex.includes('model_reasoning_effort="high"'));
  assert.ok(codex.includes("features.multi_agent=false"));
  assert.equal(
    codex.includes("--dangerously-bypass-approvals-and-sandbox"),
    false,
  );
  const claude = buildCliArguments(
    "claude",
    request({ provider: "claude", maxCostUsd: 0.5 }),
  );
  assert.ok(claude.includes("--no-session-persistence"));
  assert.ok(claude.includes("--bare"));
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  assert.ok(claude.includes("--max-budget-usd"));
  assert.equal(claude.includes("--fallback-model"), false);
});

test("only harness model metadata can establish identity; prose or requested Codex model cannot", () => {
  const metadata = inspectCliOutput(
    "claude",
    JSON.stringify({
      type: "result",
      session_id: "session-1",
      is_error: false,
      result: "all tests passed, model=chosen",
      modelUsage: { chosen: { inputTokens: 1 } },
      total_cost_usd: 0.01,
    }),
    "chosen",
  );
  assert.equal(metadata.identityVerified, true);
  assert.equal(metadata.costUsd, 0.01);
  assert.equal(
    inspectCliOutput(
      "claude",
      JSON.stringify({
        type: "result",
        session_id: "session-1",
        is_error: false,
        modelUsage: { wrong: {} },
      }),
      "chosen",
    ).identityVerified,
    false,
  );
  assert.equal(
    inspectCliOutput(
      "claude",
      JSON.stringify({
        type: "result",
        session_id: "session-1",
        is_error: false,
        result: "chosen",
      }),
      "chosen",
    ).identityVerified,
    false,
  );
  assert.equal(
    inspectCliOutput(
      "codex",
      '{"type":"thread.started","thread_id":"1"}\n{"type":"turn.completed","model":"chosen"}',
      "chosen",
    ).identityVerified,
    false,
  );
  assert.equal(
    inspectCliOutput("claude", "partial json", "chosen").identityVerified,
    false,
  );
});

test("CLI probes reject incorrect identity even when a binary accepts the same flags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "longform-provider-probe-"));
  try {
    const executable = join(directory, "fake-provider");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version') ? 'different-provider 1.0.0' : '--model --json --ephemeral --sandbox --ignore-user-config --ignore-rules');\n`,
    );
    await chmod(executable, 0o700);
    const result = await probeCli("codex", executable);
    assert.equal(result.compatible, false);
    assert.equal(result.error, "INCORRECT_PROVIDER_IDENTITY");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current capability and OS isolation must be established before any live model dispatch", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "longform-provider-capability-"),
  );
  try {
    const executable = join(directory, "fake-codex");
    const workspace = join(directory, "work");
    await mkdir(workspace);
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version') ? 'codex-cli 0.163.0' : '--model --json --ephemeral --sandbox --ignore-user-config --ignore-rules');\n`,
    );
    await chmod(executable, 0o700);
    const options = {
      enabled: true,
      executable,
      allowedCwdRoot: directory,
      apiKey: "fake-key",
      sanitizedPublicBrief: true,
    };
    const req = request({ provider: "codex", cwd: workspace });
    assert.equal(
      (await new CodexCliProvider(options).execute(req)).output,
      "CURRENT_MODEL_CAPABILITY_UNVERIFIED",
    );
    const capabilities = [
      {
        provider: "codex" as const,
        cliVersion: "0.163.0",
        model: req.model,
        efforts: [req.effort],
        verifiedAt: new Date().toISOString(),
        authenticated: true as const,
        evidenceRef: "operator-probe:synthetic-test",
      },
    ];
    assert.equal(
      (
        await new CodexCliProvider({
          ...options,
          capabilities,
          bwrapExecutable: "/no-bwrap",
        }).execute(req)
      ).output,
      "OS_ISOLATION_UNAVAILABLE",
    );
    assert.equal(
      (
        await new CodexCliProvider({ ...options, capabilities }).execute({
          ...req,
          cwd: "/tmp",
        })
      ).output,
      "WORKSPACE_OUTSIDE_ALLOWLIST",
    );
    assert.equal(
      (
        await new CodexCliProvider({
          ...options,
          capabilities: [
            { ...capabilities[0]!, verifiedAt: "2000-01-01T00:00:00.000Z" },
          ],
        }).execute(req)
      ).output,
      "CURRENT_MODEL_CAPABILITY_UNVERIFIED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing OS isolation reports its exact hold", async () => {
  assert.deepEqual(await probeIsolation("/no-bwrap"), {
    available: false,
    error: "OS_ISOLATION_UNAVAILABLE",
  });
});

async function withSyntheticCli(
  provider: "codex" | "claude",
  work: (context: {
    executable: string;
    directory: string;
    workspace: string;
    options: {
      enabled: true;
      executable: string;
      allowedCwdRoot: string;
      apiKey: string;
      sanitizedPublicBrief: true;
      capabilities: {
        provider: "codex" | "claude";
        cliVersion: string;
        model: string;
        efforts: string[];
        verifiedAt: string;
        authenticated: true;
        evidenceRef: string;
      }[];
    };
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "longform-synthetic-runner-"));
  try {
    const executable = join(directory, "synthetic-cli");
    const workspace = join(directory, "work");
    await mkdir(workspace);
    const version =
      provider === "codex" ? "codex-cli 0.163.0" : "2.1.296 (Claude Code)";
    const flags =
      "--model --json --ephemeral --sandbox --ignore-user-config --ignore-rules --effort --print --output-format --no-session-persistence --tools --strict-mcp-config --bare --restricted --allowedTools";
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(process.argv.includes('--version') ? ${JSON.stringify(version)} : ${JSON.stringify(flags)});\n`,
    );
    await chmod(executable, 0o700);
    await work({
      executable,
      directory,
      workspace,
      options: {
        enabled: true,
        executable,
        allowedCwdRoot: directory,
        apiKey: "synthetic-key",
        sanitizedPublicBrief: true,
        capabilities: [
          {
            provider,
            cliVersion: provider === "codex" ? "0.163.0" : "2.1.296",
            model: "exact-synthetic-model",
            efforts: ["high"],
            verifiedAt: new Date().toISOString(),
            authenticated: true,
            evidenceRef: "synthetic-test-only",
          },
        ],
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function syntheticRunner(
  implementation?: (
    input: IsolatedRunInput,
  ) => Promise<ProcessResult & { identity?: unknown }>,
  cancelConfirmed = true,
): IsolatedProviderRunner & { captured: IsolatedRunInput[] } {
  const captured: IsolatedRunInput[] = [];
  return {
    captured,
    verify: async (input) => ({
      osIsolated: true,
      filesystemAllowlisted: true,
      networkAllowlisted: true,
      credentialsScoped: true,
      nestedDelegationDisabled: true,
      supportsWritableWorkspace: true,
      executableDigest: input.executableDigest,
      verifiedAt: new Date().toISOString(),
      evidenceRef: "synthetic-test-policy-only",
    }),
    execute: async (input) => {
      captured.push(input);
      if (implementation)
        return (await implementation(input)) as Awaited<
          ReturnType<IsolatedProviderRunner["execute"]>
        >;
      return {
        status: "SUCCEEDED",
        exitCode: 0,
        stdout:
          input.provider === "claude"
            ? JSON.stringify({
                type: "result",
                session_id: "synthetic-session",
                is_error: false,
                result: "Synthetic harness; not a live model invocation.",
                modelUsage: { "exact-synthetic-model": {} },
                total_cost_usd: 0,
              })
            : '{"type":"thread.started","thread_id":"synthetic-session"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Synthetic harness; not a live model invocation."}}\n{"type":"turn.completed"}',
        stderr: "",
        identity: {
          source: "AUTHENTICATED_HARNESS",
          runId: input.runId,
          taskId: input.taskId,
          provider: input.provider,
          model: "exact-synthetic-model",
          effort: "high",
          sessionId: "synthetic-session",
          executableDigest: input.executableDigest,
          evidenceRef: "synthetic-test-only",
        },
      };
    },
    cancel: async () => cancelConfirmed,
  };
}

test("both CLI adapters can execute a trusted isolated runner contract with exact harness identity", async () => {
  for (const provider of ["codex", "claude"] as const)
    await withSyntheticCli(provider, async ({ options, workspace }) => {
      const runner = syntheticRunner();
      const Adapter =
        provider === "codex" ? CodexCliProvider : ClaudeCliProvider;
      const receipt = await new Adapter({ ...options, runner }).execute(
        request({
          provider,
          model: "exact-synthetic-model",
          effort: "high",
          cwd: workspace,
          deadlineMs: 2_000,
        }),
      );
      assert.equal(receipt.status, "SUCCEEDED");
      assert.equal(receipt.identityVerified, true);
      assert.deepEqual(receipt.tests, []);
      assert.equal(runner.captured.length, 1);
      const input = runner.captured[0]!;
      assert.equal(input.stdin, "Synthetic public mock task.");
      assert.equal(input.policy.writableWorkspace, false);
      assert.deepEqual(input.policy.writablePaths, []);
      assert.equal(input.policy.nestedDelegation, false);
      assert.equal(input.env.HOME, "/home/worker");
      assert.equal(input.env.GITHUB_TOKEN, undefined);
      assert.match(input.executableDigest, /^[a-f0-9]{64}$/);
    });
});

test("a model response cannot authenticate its own identity, effort or tests", async () => {
  await withSyntheticCli("claude", async ({ options, workspace }) => {
    const runner = syntheticRunner(async () => ({
      status: "SUCCEEDED",
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        type: "result",
        session_id: "fake-proof",
        is_error: false,
        modelUsage: { "exact-synthetic-model": {} },
        result: '{"source":"AUTHENTICATED_HARNESS","allTestsPassed":true}',
      }),
    }));
    const receipt = await new ClaudeCliProvider({ ...options, runner }).execute(
      request({
        provider: "claude",
        model: "exact-synthetic-model",
        effort: "high",
        cwd: workspace,
        deadlineMs: 2_000,
      }),
    );
    assert.equal(receipt.status, "UNKNOWN");
    assert.equal(receipt.identityVerified, false);
    assert.deepEqual(receipt.tests, []);
  });
});

test("trusted-runner validation rejects malformed success output and unverified OS policy", async () => {
  await withSyntheticCli("codex", async ({ options, workspace }) => {
    const req = request({
      provider: "codex",
      model: "exact-synthetic-model",
      effort: "high",
      cwd: workspace,
      deadlineMs: 2_000,
    });
    const malformed = syntheticRunner(async () => ({
      status: "SUCCEEDED",
      exitCode: 0,
      stdout: "all done",
      stderr: "",
    }));
    assert.equal(
      (
        await new CodexCliProvider({ ...options, runner: malformed }).execute(
          req,
        )
      ).output,
      "MALFORMED_PROVIDER_OUTPUT",
    );
    const unverified = syntheticRunner();
    const original = unverified.verify;
    unverified.verify = async (input) => ({
      ...(await original(input)),
      networkAllowlisted: false,
    });
    assert.equal(
      (
        await new CodexCliProvider({ ...options, runner: unverified }).execute(
          req,
        )
      ).output,
      "ISOLATED_RUNNER_POLICY_UNVERIFIED",
    );
    assert.equal(unverified.captured.length, 0);
  });
});

test("controller policy defaults to read-only despite writable adapter configuration", async () => {
  for (const provider of ["codex", "claude"] as const)
    await withSyntheticCli(provider, async ({ options, workspace }) => {
      const Adapter =
        provider === "codex" ? CodexCliProvider : ClaudeCliProvider;
      const runner = syntheticRunner();
      const adapter = new Adapter({
        ...options,
        runner,
        writableWorkspace: true,
        writePaths: ["output"],
      });
      for (const filesystemPolicy of [undefined, { writablePaths: [] }]) {
        const receipt = await adapter.execute(
          request({
            provider,
            model: "exact-synthetic-model",
            effort: "high",
            cwd: workspace,
            deadlineMs: 2_000,
            filesystemPolicy,
          }),
        );
        assert.equal(receipt.status, "SUCCEEDED");
        const input = runner.captured.at(-1)!;
        assert.equal(input.policy.writableWorkspace, false);
        assert.deepEqual(input.policy.writablePaths, []);
        if (provider === "codex") assert.ok(input.args.includes("read-only"));
        else assert.equal(input.args[input.args.indexOf("--tools") + 1], "");
      }
    });
});

test("writable workers require matching controller scope and reviewer sessions stay read-only", async () => {
  for (const provider of ["codex", "claude"] as const)
    await withSyntheticCli(provider, async ({ options, workspace }) => {
      const Adapter =
        provider === "codex" ? CodexCliProvider : ClaudeCliProvider;
      const runner = syntheticRunner();
      const req = request({
        provider,
        model: "exact-synthetic-model",
        effort: "high",
        cwd: workspace,
        deadlineMs: 2_000,
        filesystemPolicy: { writablePaths: ["output"] },
      });
      assert.equal(
        (
          await new Adapter({
            ...options,
            runner,
            writableWorkspace: true,
          }).execute(req)
        ).output,
        "WRITE_SCOPE_REQUIRED",
      );
      assert.equal(
        (
          await new Adapter({
            ...options,
            runner,
            writableWorkspace: true,
            writePaths: ["../outside"],
          }).execute(req)
        ).output,
        "WRITE_SCOPE_REQUIRED",
      );
      assert.equal(
        (
          await new Adapter({
            ...options,
            runner,
            writableWorkspace: true,
            writePaths: ["output"],
          }).execute(req)
        ).status,
        "SUCCEEDED",
      );
      assert.deepEqual(runner.captured[0]!.policy.writablePaths, ["output"]);
      if (provider === "codex")
        assert.ok(runner.captured[0]!.args.includes("workspace-write"));
      else
        assert.equal(
          runner.captured[0]!.args[
            runner.captured[0]!.args.indexOf("--tools") + 1
          ],
          "Read,Edit,Write",
        );
      await new Adapter({
        ...options,
        runner,
        writableWorkspace: true,
        writePaths: ["output"],
      }).execute({ ...req, runId: "review-run", role: "reviewer" });
      assert.equal(runner.captured[1]!.policy.writableWorkspace, false);
      assert.deepEqual(runner.captured[1]!.policy.writablePaths, []);
      if (provider === "codex")
        assert.ok(runner.captured[1]!.args.includes("read-only"));
      else
        assert.equal(
          runner.captured[1]!.args[
            runner.captured[1]!.args.indexOf("--tools") + 1
          ],
          "",
        );
    });
});

// Design choice: Claude reviewers and advisors may read Drive,
// never write. Codex ones may not (Codex's
// workspace-write sandbox cannot start on a read-only workspace, and its
// read-only sandbox cannot reach the gateway).
test("Claude reviewers and advisors get read-only Drive; Codex ones and other roles get none; writes stay with workers", async () => {
  for (const provider of ["codex", "claude"] as const)
    await withSyntheticCli(provider, async ({ options, workspace }) => {
      const Adapter =
        provider === "codex" ? CodexCliProvider : ClaudeCliProvider;
      const runner = syntheticRunner();
      const adapter = new Adapter({
        ...options,
        runner,
        writableWorkspace: true,
        writePaths: ["output"],
        subscriptionAuth: true,
      });
      const base = request({
        provider,
        model: "exact-synthetic-model",
        effort: "high",
        cwd: workspace,
        deadlineMs: 2_000,
      });
      const readOnly = { read: "ANY" as const, update: [], createIn: [] };
      for (const role of ["reviewer", "advisor"] as const) {
        const receipt = await adapter.execute({
          ...base,
          runId: role + "-run",
          role,
          drivePolicy: readOnly,
        });
        if (provider === "codex") {
          assert.equal(receipt.output, "DRIVE_READ_NEEDS_CLAUDE");
          continue;
        }
        assert.equal(receipt.status, "SUCCEEDED", receipt.output);
        const input = runner.captured.at(-1)!;
        assert.equal(input.policy.writableWorkspace, false);
        assert.deepEqual(input.policy.drive, readOnly);
        assert.equal(input.args[input.args.indexOf("--tools") + 1], "Read,Glob,Grep,Bash");
        assert.equal(
          input.args[input.args.indexOf("--allowedTools") + 1],
          "Read,Glob,Grep,Bash(/run/longform-shim/longform-drive:*)",
        );
      }
      const before = runner.captured.length;
      // A reviewer may not update, create or fetch a pack.
      for (const drivePolicy of [
        { ...readOnly, update: ["docAAAAAAAAAAAAA"] },
        { ...readOnly, createIn: ["folderAAAAAAAAAA"] },
        { ...readOnly, pack: ["docAAAAAAAAAAAAA"] },
      ])
        assert.equal(
          (await adapter.execute({ ...base, runId: "r-write", role: "reviewer", drivePolicy })).output,
          provider === "codex" ? "DRIVE_READ_NEEDS_CLAUDE" : "DRIVE_WRITE_REQUIRES_WRITABLE_WORKER",
        );
      // Other read-only roles get no Drive at all.
      for (const role of ["moderator", "assessor", "overseer"] as const)
        assert.equal(
          (await adapter.execute({ ...base, runId: "r-" + role, role, drivePolicy: readOnly })).output,
          "DRIVE_REQUIRES_WRITABLE_WORKER",
        );
      assert.equal(runner.captured.length, before);
      // Without a Drive scope a reviewer stays as it was; a Codex reviewer
      // keeps its read-only sandbox, with no socket access.
      await adapter.execute({ ...base, runId: "plain-review", role: "reviewer" });
      const plain = runner.captured.at(-1)!;
      if (provider === "codex") {
        assert.ok(plain.args.includes("read-only"));
        assert.ok(!plain.args.includes("sandbox_workspace_write.network_access=true"));
      } else assert.equal(plain.args[plain.args.indexOf("--tools") + 1], "Read,Glob,Grep");
    });
});

test("adapter write paths can narrow but cannot widen the controller policy", async () => {
  await withSyntheticCli("codex", async ({ options, workspace }) => {
    const req = request({
      provider: "codex",
      model: "exact-synthetic-model",
      effort: "high",
      cwd: workspace,
      deadlineMs: 2_000,
      filesystemPolicy: { writablePaths: ["output/task"] },
    });
    const runner = syntheticRunner();
    for (const scope of ["output", "output/task-other", "unrelated"]) {
      const receipt = await new CodexCliProvider({
        ...options,
        runner,
        writableWorkspace: true,
        writePaths: [scope],
      }).execute(req);
      assert.equal(receipt.output, "WRITE_SCOPE_EXCEEDS_CONTROLLER_POLICY");
    }
    assert.equal(runner.captured.length, 0);
    const receipt = await new CodexCliProvider({
      ...options,
      runner,
      writableWorkspace: true,
      writePaths: ["output/task/partial"],
    }).execute(req);
    assert.equal(receipt.status, "SUCCEEDED");
    assert.deepEqual(runner.captured[0]!.policy.writablePaths, [
      "output/task/partial",
    ]);
  });
});

test("filesystem policy survives request validation and rejects unsafe scopes or symlink mounts", async () => {
  const mock = new MockProvider();
  await mock.execute(
    request({ filesystemPolicy: { writablePaths: ["output/task"] } }),
  );
  assert.deepEqual(mock.requests[0]!.filesystemPolicy, {
    writablePaths: ["output/task"],
  });
  for (const scope of [
    ".",
    "..",
    "../outside",
    "/outside",
    "output/../outside",
    "output//nested",
    "output\\nested",
    "output\0nested",
  ]) {
    await assert.rejects(
      mock.execute(request({ filesystemPolicy: { writablePaths: [scope] } })),
    );
  }
  await withSyntheticCli("codex", async ({ options, workspace, directory }) => {
    await symlink(directory, join(workspace, "escape"));
    const runner = syntheticRunner();
    const receipt = await new CodexCliProvider({
      ...options,
      runner,
      writableWorkspace: true,
      writePaths: ["escape/nested"],
    }).execute(
      request({
        provider: "codex",
        model: "exact-synthetic-model",
        effort: "high",
        cwd: workspace,
        deadlineMs: 2_000,
        filesystemPolicy: { writablePaths: ["escape"] },
      }),
    );
    assert.equal(receipt.output, "UNSAFE_WRITE_SCOPE");
    assert.equal(runner.captured.length, 0);
  });
});

test("isolated runner hangs have bounded cancellation and unconfirmed stop remains unknown", async () => {
  await withSyntheticCli("codex", async ({ options, workspace }) => {
    const req = request({
      provider: "codex",
      model: "exact-synthetic-model",
      effort: "high",
      cwd: workspace,
      deadlineMs: 200,
    });
    const confirmed = syntheticRunner(async () => new Promise(() => {}));
    assert.equal(
      (
        await new CodexCliProvider({ ...options, runner: confirmed }).execute(
          req,
        )
      ).status,
      "TIMED_OUT",
    );
    const unconfirmed = syntheticRunner(
      async () => new Promise(() => {}),
      false,
    );
    const receipt = await new CodexCliProvider({
      ...options,
      runner: unconfirmed,
    }).execute(req);
    assert.equal(receipt.status, "UNKNOWN");
    assert.ok(receipt.output.includes("RECONCILIATION_REQUIRED"));
  });
});

test("both CLI runner contracts normalize structured review payloads and preserve raw stdout identity", async () => {
  for (const provider of ["codex", "claude"] as const)
    await withSyntheticCli(provider, async ({ options, workspace }) => {
      const review = ReviewSchema.parse({
        id: "synthetic-review",
        taskId: "MOCK-1",
        runId: "run-1",
        artifactRevision: "synthetic-revision",
        specDigest: "synthetic-spec",
        reviewerSession: "synthetic-session",
        provider,
        authorshipDisclosure:
          "Synthetic separate reviewer fixture; no live review.",
        availableEvidence: [],
        findings: [],
        testsExecuted: [],
        testsNotExecuted: ["Native tests were not executed by this fixture."],
        conflictingEvidence: [],
        remediation: [],
        residualHolds: ["Live provider execution remains unverified."],
        verdict: "PASS_WITH_LIMITATIONS",
        scope: "Synthetic provider report normalization.",
        nextAuthorizedStep: "Continue deterministic integration tests.",
        auditAssessments: [],
      });
      const payload = reviewPayload(review);
      const finalResponse = JSON.stringify(payload);
      const runner = syntheticRunner();
      const original = runner.execute;
      let rawStdout = "";
      runner.execute = async (input) => {
        const result = await original(input);
        rawStdout =
          provider === "codex"
            ? [
                { type: "thread.started", thread_id: "synthetic-session" },
                {
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    phase: "commentary",
                    text: "Synthetic inspection in progress.",
                  },
                },
                {
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    phase: "final_answer",
                    text: finalResponse,
                  },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 10, output_tokens: 20 },
                },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n")
            : JSON.stringify({
                type: "result",
                session_id: "synthetic-session",
                is_error: false,
                result: finalResponse,
                modelUsage: { "exact-synthetic-model": {} },
                total_cost_usd: 0,
              });
        return { ...result, stdout: rawStdout };
      };
      const Adapter =
        provider === "codex" ? CodexCliProvider : ClaudeCliProvider;
      const receipt = await new Adapter({ ...options, runner }).execute(
        request({
          provider,
          role: "reviewer",
          cwd: workspace,
          model: "exact-synthetic-model",
          effort: "high",
          deadlineMs: 2_000,
        }),
      );
      assert.equal(receipt.status, "SUCCEEDED");
      assert.equal(receipt.identityVerified, true);
      assert.equal(receipt.output, finalResponse);
      assert.deepEqual(JSON.parse(receipt.output), payload);
      assert.equal(
        receipt.provenance?.rawStdoutDigest,
        createHash("sha256").update(rawStdout).digest("hex"),
      );
      assert.equal(
        receipt.provenance?.rawStdoutBytes,
        Buffer.byteLength(rawStdout),
      );
      assert.deepEqual(receipt.tests, []);
    });
});

test("a Codex run's progress notes count as notes only when the runner supplies matching labels", () => {
  type Agent = { text: string; phase?: string };
  const codex = (...messages: Agent[]) =>
    [
      { type: "thread.started", thread_id: "synthetic-session" },
      ...messages.map((item) => ({
        type: "item.completed",
        item: { type: "agent_message", ...item },
      })),
      { type: "turn.completed" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
  const note = "commentary" as const,
    answer = "final_answer" as const;
  const stream = codex(
    { text: "Reading the files.\n" },
    { text: "Checked.\n" },
    { text: "Final report." },
  );
  const phases: CodexMessagePhase[] = [note, note, answer];
  assert.equal(
    normalizeCliResponse("codex", stream, { messagePhases: phases }),
    "Final report.",
  );
  // Without the runner's labels it stays a conflict, as before.
  assert.throws(
    () => normalizeCliResponse("codex", stream),
    /CONFLICTING_PROVIDER_FINAL_MESSAGES/,
  );
  // Labels that don't cover every agent message one for one are ignored.
  for (const messagePhases of [
    [note, answer],
    [note, note, note, answer],
    [],
  ] as CodexMessagePhase[][])
    assert.throws(
      () => normalizeCliResponse("codex", stream, { messagePhases }),
      /CONFLICTING_PROVIDER_FINAL_MESSAGES/,
    );
  // Two answers among the labels stay a conflict.
  assert.throws(
    () =>
      normalizeCliResponse("codex", stream, {
        messagePhases: [note, answer, answer],
      }),
    /CONFLICTING_PROVIDER_FINAL_MESSAGES/,
  );
  // Review r1 finding 2: a note the stream already labels keeps its place,
  // so labels for the whole sequence still line up.
  const mixed = codex(
    { text: "Labelled note.", phase: "commentary" },
    { text: "Unlabelled note." },
    { text: "Answer." },
  );
  assert.equal(
    normalizeCliResponse("codex", mixed, {
      messagePhases: [note, note, answer],
    }),
    "Answer.",
  );
  assert.throws(
    () =>
      normalizeCliResponse("codex", mixed, { messagePhases: [note, answer] }),
    /CONFLICTING_PROVIDER_FINAL_MESSAGES/,
  );
  // A stream label that contradicts the session log's is a conflict, in
  // either direction (without the check the first would read as no answer
  // at all, the second as two answers).
  assert.throws(
    () =>
      normalizeCliResponse(
        "codex",
        codex({ text: "Note." }, { text: "Answer?", phase: "commentary" }),
        { messagePhases: [note, answer] },
      ),
    /CONFLICTING_PROVIDER_FINAL_MESSAGES/,
  );
  assert.throws(
    () =>
      normalizeCliResponse(
        "codex",
        codex({ text: "Note?", phase: "final_answer" }, { text: "Answer." }),
        { messagePhases: [note, answer] },
      ),
    /CONFLICTING_PROVIDER_FINAL_MESSAGES/,
  );
  // An explicit null label stays malformed with or without supplied labels,
  // structured or not, as on main (review r3).
  const nullChannel = [
    JSON.stringify({ type: "thread.started", thread_id: "s" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: '{"ok":true}', channel: null },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  for (const structured of [false, true])
    for (const messagePhases of [undefined, [answer]])
      assert.throws(
        () =>
          normalizeCliResponse("codex", nullChannel, {
            structured,
            messagePhases,
          }),
        /MALFORMED_PROVIDER_FINAL_RESPONSE/,
      );
  // A single answer never needed labels.
  assert.equal(
    normalizeCliResponse("codex", codex({ text: "Only answer." })),
    "Only answer.",
  );
  // A structured run still takes its last message, which must be a JSON
  // object, whether or not the runner supplied labels (review r2).
  for (const messagePhases of [undefined, [note, answer]])
    assert.equal(
      normalizeCliResponse(
        "codex",
        codex({ text: "Reading." }, { text: '{"verdict":"PASS"}' }),
        { structured: true, messagePhases },
      ),
      '{"verdict":"PASS"}',
    );
  for (const last of ["not json", "null", "[]"])
    for (const messagePhases of [undefined, [note, answer]])
      assert.throws(
        () =>
          normalizeCliResponse(
            "codex",
            codex({ text: "Reading." }, { text: last }),
            { structured: true, messagePhases },
          ),
        /MALFORMED_PROVIDER_FINAL_RESPONSE/,
      );
});

test("the Codex adapter accepts a labelled final answer and still rejects an unlabelled conflict", async () => {
  const stdout = [
    { type: "thread.started", thread_id: "synthetic-session" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "Reading.\n" },
    },
    { type: "item.completed", item: { type: "agent_message", text: "Done." } },
    { type: "turn.completed" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  for (const labelled of [true, false])
    await withSyntheticCli("codex", async ({ options, workspace }) => {
      const runner = syntheticRunner(async (input) => ({
        status: "SUCCEEDED",
        exitCode: 0,
        stdout,
        stderr: "",
        identity: {
          source: "AUTHENTICATED_HARNESS",
          runId: input.runId,
          taskId: input.taskId,
          provider: input.provider,
          model: "exact-synthetic-model",
          effort: "high",
          sessionId: "synthetic-session",
          executableDigest: input.executableDigest,
          evidenceRef: "synthetic-test-only",
        },
        ...(labelled ? { messagePhases: ["commentary", "final_answer"] } : {}),
      }));
      const receipt = await new CodexCliProvider({
        ...options,
        runner,
      }).execute(
        request({
          provider: "codex",
          model: "exact-synthetic-model",
          effort: "high",
          cwd: workspace,
          deadlineMs: 2_000,
        }),
      );
      if (labelled) {
        assert.equal(receipt.status, "SUCCEEDED");
        assert.equal(receipt.identityVerified, true);
        assert.equal(receipt.output, "Done.");
      } else {
        assert.equal(receipt.status, "UNKNOWN");
        assert.match(receipt.output, /CONFLICTING_PROVIDER_FINAL_MESSAGES/);
      }
    });
});

test("response normalization rejects missing, malformed and conflicting final messages", () => {
  const codex = (...messages: unknown[]) =>
    [
      { type: "thread.started", thread_id: "synthetic-session" },
      ...messages.map((text) => ({
        type: "item.completed",
        item: { type: "agent_message", text },
      })),
      { type: "turn.completed" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
  assert.throws(
    () => normalizeCliResponse("codex", codex()),
    /MALFORMED_PROVIDER_FINAL_RESPONSE/,
  );
  assert.throws(
    () => normalizeCliResponse("codex", codex({ verdict: "PASS" })),
    /MALFORMED_PROVIDER_FINAL_RESPONSE/,
  );
  assert.throws(
    () =>
      normalizeCliResponse("codex", codex("first report", "different report")),
    /CONFLICTING_PROVIDER_FINAL_MESSAGES/,
  );
  // A schema-constrained run's final answer is the last message; earlier ones are commentary.
  assert.equal(
    normalizeCliResponse(
      "codex",
      codex("Reading the files.", '{"verdict":"PASS"}'),
      {
        structured: true,
      },
    ),
    '{"verdict":"PASS"}',
  );
  assert.throws(
    () =>
      normalizeCliResponse("codex", codex('{"verdict":"PASS"}', "not json"), {
        structured: true,
      }),
    /MALFORMED_PROVIDER_FINAL_RESPONSE/,
  );
  assert.equal(
    normalizeCliResponse(
      "codex",
      codex("identical report", "identical report"),
    ),
    "identical report",
  );
  assert.throws(
    () =>
      normalizeCliResponse(
        "codex",
        codex("one") +
          "\n" +
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "late" },
          }),
      ),
    /MALFORMED_PROVIDER_FINAL_RESPONSE/,
  );
  assert.throws(
    () =>
      normalizeCliResponse(
        "claude",
        JSON.stringify({
          type: "result",
          session_id: "one",
          is_error: false,
          result: {},
        }),
      ),
    /MALFORMED_PROVIDER_FINAL_RESPONSE/,
  );
  const claude = JSON.stringify({
    type: "result",
    session_id: "one",
    is_error: false,
    result: "report",
  });
  assert.throws(
    () => normalizeCliResponse("claude", claude + "\n" + claude),
    /MALFORMED_PROVIDER_FINAL_RESPONSE/,
  );
});

// Design choice: when a Claude model's safety system declines,
// Claude Code is told not to hand the run to another model, and a decline is
// a known failure with its usage, not an unknown outcome to reconcile.
test("a Claude model that declines is a clean, known failure with its usage, whether Claude Code stops or hands the run to another model", async () => {
  await withSyntheticCli("claude", async ({ options, workspace }) => {
    const usage = {
      input_tokens: 4,
      output_tokens: 0,
      cache_creation_input_tokens: 985,
      cache_read_input_tokens: 11_188,
    };
    const cases: [string, ProcessResult][] = [
      // With CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, Claude Code stops there.
      [
        "stopped at the decline",
        {
          status: "FAILED",
          exitCode: 1,
          stderr: "",
          stdout: JSON.stringify({
            type: "result",
            is_error: true,
            stop_reason: "refusal",
            session_id: "declined-1",
            total_cost_usd: 0.022,
            usage,
            modelUsage: { "exact-synthetic-model": { outputTokens: 0 } },
          }),
        },
      ],
      // Without it, another model did the run after the safety stops.
      [
        "handed to another model",
        {
          status: "SUCCEEDED",
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            type: "result",
            is_error: false,
            stop_reason: "end_turn",
            safety_stops: 2,
            session_id: "declined-2",
            result: "OK",
            total_cost_usd: 0.072,
            usage,
            modelUsage: {
              "exact-synthetic-model": { outputTokens: 0 },
              "claude-opus-4-8": { outputTokens: 158 },
            },
          }),
        },
      ],
    ];
    for (const [name, result] of cases) {
      const runner = syntheticRunner(async () => result);
      const receipt = await new ClaudeCliProvider({
        ...options,
        runner,
      }).execute(
        request({
          provider: "claude",
          model: "exact-synthetic-model",
          effort: "high",
          cwd: workspace,
          deadlineMs: 2_000,
        }),
      );
      assert.equal(receipt.status, "FAILED", name);
      assert.equal(receipt.identityVerified, false, name);
      assert.match(
        receipt.output,
        /^MODEL_DECLINED: exact-synthetic-model declined this request/,
        name,
      );
      assert.equal(receipt.costUsd, JSON.parse(result.stdout).total_cost_usd);
      assert.equal(receipt.tokens, 4 + 0 + 985 + Math.ceil(11_188 * 0.1));
      assert.equal(
        runner.captured[0]!.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK,
        "1",
      );
    }
  });
});

test("R2: output the runner couldn't keep whole never counts as a success", async () => {
  for (const provider of ["codex", "claude"] as const)
    await withSyntheticCli(provider, async ({ options, workspace }) => {
      const clean = syntheticRunner();
      const runner = syntheticRunner(async (input) => ({
        ...(await clean.execute(input)),
        outputIncomplete: true,
      }));
      const Adapter =
        provider === "codex" ? CodexCliProvider : ClaudeCliProvider;
      const receipt = await new Adapter({ ...options, runner }).execute(
        request({
          provider,
          model: "exact-synthetic-model",
          effort: "high",
          cwd: workspace,
          deadlineMs: 2_000,
        }),
      );
      assert.equal(receipt.status, "FAILED", provider);
      assert.match(receipt.output, /OUTPUT_LIMIT_EXCEEDED/, provider);
    });
});

test("a brief that points at the owner's text reaches only runs that can read it: every role on both providers gets the folder, and Claude gets Read with the folder added", async () => {
  const ownerText = {
    dir: "/srv/run-attachments/run-x/owner-text",
    files: [{ file: "request-r1.txt", sha256: "a".repeat(64) }],
    required: true,
  };
  for (const provider of ["codex", "claude"] as const)
    await withSyntheticCli(provider, async ({ options, workspace }) => {
      const Adapter =
        provider === "codex" ? CodexCliProvider : ClaudeCliProvider;
      const runner = syntheticRunner();
      const subscription = new Adapter({
        ...options,
        runner,
        writableWorkspace: true,
        writePaths: ["output"],
        subscriptionAuth: true,
      });
      const base = request({
        provider,
        model: "exact-synthetic-model",
        effort: "high",
        cwd: workspace,
        deadlineMs: 2_000,
        ownerText,
      });
      for (const role of [
        "worker",
        "reviewer",
        "advisor",
        "moderator",
        "assessor",
        "overseer",
      ] as const) {
        const receipt = await subscription.execute({
          ...base,
          runId: role + "-owner-text",
          role,
          ...(role === "worker"
            ? { filesystemPolicy: { writablePaths: ["output"] } }
            : {}),
        });
        assert.equal(receipt.status, "SUCCEEDED", role + ": " + receipt.output);
        const input = runner.captured.at(-1)!;
        assert.deepEqual(input.ownerText, { dir: ownerText.dir, files: ownerText.files }, role);
        if (provider === "claude") {
          assert.ok(input.args[input.args.indexOf("--tools") + 1]!.split(",").includes("Read"), role);
          assert.equal(input.args[input.args.indexOf("--add-dir") + 1], OWNER_TEXT_IN_SANDBOX, role);
        } else assert.ok(!input.args.includes("--add-dir"));
        assert.equal(
          canReadOwnerText(provider, { ...base, role, ...(role === "worker" ? { filesystemPolicy: { writablePaths: ["output"] } } : {}) }, true, { subscriptionAuth: true }),
          true,
        );
      }
      // Not required: the folder is still mounted, but Claude's argv is unchanged.
      await subscription.execute({ ...base, runId: "inline", role: "reviewer", ownerText: { ...ownerText, required: false } });
      assert.ok(!runner.captured.at(-1)!.args.includes("--add-dir"));
      const before = runner.captured.length;
      // A Claude worker with no write paths, or an API-key Claude reviewer,
      // has no Read tool: a required owner-text file stops it before launch.
      const workerNoPaths = await subscription.execute({ ...base, runId: "no-paths", role: "worker" });
      const apiKey = new Adapter({ ...options, runner, subscriptionAuth: false });
      const apiReviewer = await apiKey.execute({ ...base, runId: "api-reviewer", role: "reviewer" });
      for (const receipt of [workerNoPaths, apiReviewer])
        if (provider === "claude") {
          assert.equal(receipt.output, "OWNER_TEXT_UNREADABLE_BY_ROLE");
          assert.equal(receipt.notLaunched, true);
          assert.equal(receipt.tokens, 0);
        } else assert.equal(receipt.status, "SUCCEEDED", receipt.output);
      assert.equal(runner.captured.length, before + (provider === "codex" ? 2 : 0));
    });
});

test("a provider's usage limit is read from its harness output: Claude's result envelope, and a failed Codex run's own session log, with that log's usage", async () => {
  await withSyntheticCli("claude", async ({ options, workspace }) => {
    const runner = syntheticRunner(async () => ({
      status: "FAILED",
      exitCode: 1,
      stderr: "",
      stdout: JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 429,
        api_error: "usage_limit_reached",
        session_id: "limited",
        result: "You've hit your session limit · resets 10pm (America/Denver)",
        usage: { input_tokens: 12, output_tokens: 0 },
        total_cost_usd: 0,
      }),
    }));
    const receipt = await new ClaudeCliProvider({ ...options, runner }).execute(
      request({ provider: "claude", model: "exact-synthetic-model", effort: "high", cwd: workspace, deadlineMs: 2_000 }),
    );
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.providerLimit?.kind, "USAGE_LIMIT");
    assert.equal(receipt.providerLimit?.resetBasis, "STATED_WITH_ZONE");
    assert.equal(receipt.tokens, 12);
    assert.equal(receipt.costUsd, 0);
  });
  await withSyntheticCli("codex", async ({ options, workspace }) => {
    const runner = syntheticRunner(async () => ({
      status: "FAILED",
      exitCode: 1,
      stderr: "",
      stdout:
        '{"type":"thread.started","thread_id":"t1"}\n{"type":"error","message":"You’ve hit your usage limit."}\n{"type":"turn.failed","error":{"message":"You’ve hit your usage limit."}}',
      codexSession: {
        errorInfo: "usage_limit_exceeded",
        message: "You've hit your usage limit. try again at Oct 19th, 2026 12:50 AM.",
        rateLimits: [{ usedPercent: 100, resetsAt: 1_792_392_603 }],
        totalTokenUsage: { input_tokens: 18_407, cached_input_tokens: 11_904, output_tokens: 14 },
      },
    }));
    const receipt = await new CodexCliProvider({ ...options, runner, costAccounting: "subscription" }).execute(
      request({ provider: "codex", model: "exact-synthetic-model", effort: "high", cwd: workspace, deadlineMs: 2_000 }),
    );
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.providerLimit?.kind, "USAGE_LIMIT");
    assert.equal(receipt.providerLimit?.resetBasis, "STRUCTURED");
    assert.equal(receipt.providerLimit?.resetsAt, "2026-10-19T06:50:03.000Z");
    // The log's usage, mapped as the stream's: cached input at its price share.
    assert.ok(receipt.tokens !== null && receipt.tokens > 6_000, String(receipt.tokens));
    assert.equal(receipt.costUsd, 0);
  });
  // An ordinary failure carries no limit.
  await withSyntheticCli("claude", async ({ options, workspace }) => {
    const runner = syntheticRunner(async () => ({
      status: "FAILED",
      exitCode: 1,
      stderr: "boom",
      stdout: JSON.stringify({ type: "result", is_error: true, session_id: "x", result: "Something else went wrong" }),
    }));
    const receipt = await new ClaudeCliProvider({ ...options, runner }).execute(
      request({ provider: "claude", model: "exact-synthetic-model", effort: "high", cwd: workspace, deadlineMs: 2_000 }),
    );
    assert.equal(receipt.providerLimit, undefined);
  });
});

test("a limit the harness reported survives a rejection of the run's output (review S3-4)", async () => {
  await withSyntheticCli("codex", async ({ options, workspace }) => {
    const runner = syntheticRunner(async () => ({
      status: "FAILED",
      exitCode: 1,
      stderr: "",
      stdout: '{"type":"thread.started","thread_id":"t1"}\n',
      outputIncomplete: true,
      codexSession: {
        errorInfo: "usage_limit_exceeded",
        message: "You've hit your usage limit.",
        rateLimits: [],
        totalTokenUsage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 },
      },
    }));
    const receipt = await new CodexCliProvider({ ...options, runner, costAccounting: "subscription" }).execute(
      request({ provider: "codex", model: "exact-synthetic-model", effort: "high", cwd: workspace, deadlineMs: 2_000 }),
    );
    assert.equal(receipt.output, "OUTPUT_LIMIT_EXCEEDED");
    assert.equal(receipt.providerLimit?.kind, "USAGE_LIMIT");
    assert.equal(receipt.tokens, 105);
  });
});
