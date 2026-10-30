import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { DrivePolicySchema, type DrivePolicy } from "./domain.js";
import { DRIVE_CLIENT_IN_SANDBOX, type DriveWriteHooks } from "./drive.js";
import {
  claudeLimit,
  codexLimit,
  CodexSessionSignalSchema,
  ProviderLimitSchema,
  type CodexSessionSignal,
  type ProviderLimit,
} from "./limits.js";

/** Provider configuration belongs to the trusted operator/controller, never a work packet. */
export type ProviderId = "codex" | "claude" | "mock";
export type ExecutionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "UNKNOWN";
export interface ProviderRequest {
  runId: string;
  taskId: string;
  provider: ProviderId;
  model: string;
  effort: string;
  role:
    | "worker"
    | "reviewer"
    | "advisor"
    | "moderator"
    | "assessor"
    | "overseer";
  cwd: string;
  brief: string;
  deadlineMs: number;
  maxOutputBytes?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  /** Derived by the trusted controller from current task authorization, never worker text. */
  filesystemPolicy?: { writablePaths: string[] };
  /** Derived by the controller from the task's authorized Drive scope (live workers only). */
  drivePolicy?: DrivePolicy;
  /** Controller-owned JSON Schema for the final response (live reviewers, advisors,
   * moderators and proposal-reply workers). */
  outputSchema?: Record<string, unknown>;
  /**
   * The run's owner-text files (the owner's request text, byte for byte),
   * prepared by the controller outside the workspace; the runner mounts the
   * folder read-only at OWNER_TEXT_IN_SANDBOX. `required` when the brief
   * points at a file instead of carrying the text.
   */
  ownerText?: {
    dir: string;
    files: Array<{ file: string; sha256: string }>;
    required: boolean;
  };
  signal?: AbortSignal;
  /**
   * The controller's last check, called by the runner just before it spawns
   * the provider process (after every queue, lock and preparation wait): a
   * reason not to launch, or undefined. A refusal means nothing started.
   */
  launchGate?: () => string | undefined;
  /**
   * The controller's write-intent hooks for the run's Drive gateway (S4):
   * every Drive write is recorded before it is sent and its outcome after.
   */
  driveWrites?: DriveWriteHooks;
}
export interface ProviderReceipt {
  runId: string;
  taskId: string;
  provider: ProviderId;
  model: string;
  effort: string;
  sessionId: string;
  exitCode: number | null;
  status: ExecutionStatus;
  startedAt: string;
  endedAt: string;
  output: string;
  /** CLI prose is not an executable test receipt. Tests must be collected independently. */
  tests: unknown[];
  costUsd: number | null;
  /** Budget tokens: cached-context reads count at their price share (cacheReadWeight). */
  tokens: number | null;
  /** The harness's raw counts behind `tokens`, when it reported them. */
  usageDetail?: UsageDetail;
  identityVerified: boolean;
  simulation: boolean;
  /**
   * Set only by an adapter, when its trusted runner or preflight established
   * that no provider process started. Requires FAILED with zero usage.
   */
  notLaunched?: true;
  /**
   * The provider's usage or rate limit that ended the run, as its harness
   * reported it (src/limits.ts). Never on a successful run; a limit proves
   * nothing about what the run did before it.
   */
  providerLimit?: ProviderLimit;
  provenance?: {
    cliVersion: string;
    executableDigest: string;
    isolationEvidenceRef: string;
    capabilityEvidenceRef: string;
    identityEvidenceRef: string;
    rawStdoutDigest: string;
    rawStdoutBytes: number;
  };
}
/**
 * What an adapter can say about a run's processes while its execute() is
 * still pending, for a stop the controller asks of the run
 * (Controller.stopRun): `processStopped` is true only when the adapter knows
 * no process of the run is alive (none was launched, or every one has
 * stopped). An adapter that cannot say leaves it false.
 */
export type RunActivity = { processStopped: boolean; detail: string };
/** A run of which something may still be going in this process (ProviderAdapter.busy). */
export type BusyRun = { runId: string; detail: string };
export interface ProviderAdapter {
  execute(request: ProviderRequest): Promise<ProviderReceipt>;
  /** The run's processes, as far as this adapter knows (see RunActivity). */
  activity?(runId: string): RunActivity;
  /**
   * The runs a process of which is alive, or whose preflight probes may
   * still be running, whether or not their execute() has returned: the host
   * must not let its lock and database go while one is listed.
   */
  busy?(): BusyRun[];
}
export interface UsageDetail {
  /** Fresh input, not read from or written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheReadWeight: number;
}

/**
 * What a read of cached context costs as a share of fresh input, by model.
 * Claude Code re-sends a run's whole context on every turn, mostly as cache
 * reads, so counting them at full price booked long runs at many times their
 * cost and capped good work (count tokens at their
 * real cost). Anthropic's prices as of 2026-10: Fable 5.1 $0.25 against $10,
 * Opus 5.5 $0.20 against $4, Sonnet 5.5 $0.10 against $2. Everything else
 * counts at 0.1: Haiku 5.5 and OpenAI's usual cached-input rate (not checked
 * for gpt-6.1-sol).
 */
const CACHE_READ_WEIGHT: Readonly<Record<string, number>> = {
  "claude-fable-5-1": 0.025,
  "claude-opus-5-5": 0.05,
  "claude-sonnet-5-5": 0.05,
};
export function cacheReadWeight(model: string): number {
  return CACHE_READ_WEIGHT[model] ?? 0.1;
}

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
function safeRelativeScope(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
/** Largest brief a provider request accepts. */
export const MAX_BRIEF_CHARS = 128_000;
/**
 * Where a run's owner-text files (the owner's request text, byte for byte,
 * when it does not fit in the brief) are mounted read-only in the sandbox.
 */
export const OWNER_TEXT_IN_SANDBOX = "/run/longform-owner-text";
/**
 * Child output a live run keeps by default. Past it, the runner drops only
 * what the parsers skip (Codex tool events) and never stops a run over output
 * size. A Codex event stream that reads many
 * documents through its shell runs long.
 */
const DEFAULT_CAPTURE_BYTES = 4 * 1_048_576;
/**
 * A Codex `--json` line that normalizeCliResponse and inspectCliOutput skip
 * without effect: an item event, well formed, that isn't an agent message
 * (tool calls and their output). Dropping one can't change what they decide.
 * Every other line, including anything malformed, is not skippable.
 */
export function skippableCodexEvent(line: string): boolean {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const { type, item } = event as { type?: unknown; item?: unknown };
  if (typeof type !== "string" || !type.startsWith("item.")) return false;
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const itemType = (item as { type?: unknown }).type;
  return typeof itemType === "string" && itemType !== "agent_message";
}
/**
 * The line that stands in for a run of dropped Codex events: an event the
 * parsers skip too, so every other line keeps its place (a blank line in the
 * middle of the stream, which the parsers reject, never moves to an edge).
 */
export const DROPPED_CODEX_EVENTS =
  JSON.stringify({
    type: "item.completed",
    item: { type: "longform_dropped_output" },
  }) + "\n";
/**
 * Whether a Claude run's model declined the request: Claude Code reports a
 * refusal stop, or it handed the run to another model after a safety stop and
 * the requested model produced nothing. Harness metadata, not model text.
 */
function claudeDeclined(stdout: string, model: string): boolean {
  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    if (envelope.type !== "result") return false;
    if (envelope.stop_reason === "refusal") return true;
    const usage = envelope.modelUsage as
      | Record<string, { outputTokens?: unknown }>
      | undefined;
    return (
      typeof envelope.safety_stops === "number" &&
      envelope.safety_stops > 0 &&
      !!usage &&
      typeof usage === "object" &&
      Object.keys(usage).length > 1 &&
      usage[model]?.outputTokens === 0
    );
  } catch {
    return false;
  }
}
/** The most owner-text files one run can be given (see ownerText below). */
export const OWNER_TEXT_FILES_MAX = 4_096;
const requestSchema = z.object({
  runId: identifier,
  taskId: identifier,
  provider: z.enum(["codex", "claude", "mock"]),
  model: identifier,
  effort: identifier,
  role: z.enum([
    "worker",
    "reviewer",
    "advisor",
    "moderator",
    "assessor",
    "overseer",
  ]),
  cwd: z.string().min(1),
  brief: z.string().min(1).max(MAX_BRIEF_CHARS),
  deadlineMs: z.number().int().min(1).max(3_600_000),
  maxOutputBytes: z.number().int().min(64).max(4_194_304).optional(),
  maxCostUsd: z.number().finite().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  filesystemPolicy: z
    .object({
      writablePaths: z
        .array(z.string().max(4_096).refine(safeRelativeScope))
        .max(512),
    })
    .strict()
    .optional(),
  drivePolicy: DrivePolicySchema.optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  ownerText: z
    .object({
      dir: z.string().min(1).refine(isAbsolute),
      files: z
        .array(
          z
            .object({
              file: z.string().regex(/^request-[A-Za-z0-9-]{1,80}\.txt$/),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .min(1)
        // One file per request the run's view carries, inline or not. Every
        // such request takes at least its ID in the brief, so a brief within
        // MAX_BRIEF_CHARS never carries this many.
        .max(OWNER_TEXT_FILES_MAX),
      required: z.boolean(),
    })
    .strict()
    .optional(),
});
export const providerReceiptSchema = z
  .object({
    runId: identifier,
    taskId: identifier,
    provider: z.enum(["codex", "claude", "mock"]),
    model: identifier,
    effort: identifier,
    sessionId: z.string().min(1).max(200),
    exitCode: z.number().int().nullable(),
    status: z.enum([
      "SUCCEEDED",
      "FAILED",
      "TIMED_OUT",
      "CANCELLED",
      "UNKNOWN",
    ]),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    output: z.string(),
    tests: z.array(z.unknown()),
    costUsd: z.number().finite().nonnegative().nullable(),
    tokens: z.number().int().nonnegative().nullable(),
    usageDetail: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheWriteTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative(),
        cacheReadWeight: z.number().finite().min(0).max(1),
      })
      .strict()
      .optional(),
    identityVerified: z.boolean(),
    simulation: z.boolean(),
    provenance: z
      .object({
        cliVersion: z.string().min(1),
        executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
        isolationEvidenceRef: z.string().min(1),
        capabilityEvidenceRef: z.string().min(1),
        identityEvidenceRef: z.string().min(1),
        rawStdoutDigest: z.string().regex(/^[a-f0-9]{64}$/),
        rawStdoutBytes: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    notLaunched: z.literal(true).optional(),
    providerLimit: ProviderLimitSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.providerLimit && receipt.status === "SUCCEEDED")
      context.addIssue({
        code: "custom",
        message: "A provider limit cannot accompany a successful run",
      });
    // A run that never launched was refused, cancelled or timed out before
    // anything ran (review r2 finding R5), with a truthful zero usage.
    if (
      receipt.notLaunched &&
      (!["FAILED", "CANCELLED", "TIMED_OUT"].includes(receipt.status) ||
        receipt.costUsd !== 0 ||
        receipt.tokens !== 0)
    )
      context.addIssue({
        code: "custom",
        message: "NOT_LAUNCHED_REQUIRES_FAILED_WITH_ZERO_USAGE",
      });
    if (
      receipt.status === "SUCCEEDED" &&
      (receipt.exitCode !== 0 || !receipt.identityVerified)
    ) {
      context.addIssue({
        code: "custom",
        message: "Success requires exit 0 and verified provider identity",
      });
    }
    if (Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "Receipt chronology is invalid",
      });
    }
  });

/** Best-effort output defence, not an authorization or classification mechanism. */
export function redact(value: string, secrets: readonly string[] = []): string {
  let output = value;
  for (const secret of [...secrets]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output
    .replace(
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
      "[REDACTED]",
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED JWT]",
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[=:]\s*["']?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

export function validateProviderReceipt(
  value: unknown,
  request?: ProviderRequest,
): ProviderReceipt {
  const receipt = providerReceiptSchema.parse(value);
  if (
    request &&
    ["runId", "taskId", "provider", "model", "effort"].some(
      (key) =>
        receipt[key as keyof ProviderReceipt] !==
        request[key as keyof ProviderRequest],
    )
  ) {
    throw new ProviderError("RECEIPT_IDENTITY_MISMATCH");
  }
  if (
    request &&
    Buffer.byteLength(receipt.output) > (request.maxOutputBytes ?? 1_048_576)
  ) {
    throw new ProviderError("RECEIPT_OUTPUT_LIMIT");
  }
  return receipt;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function baseReceipt(
  request: ProviderRequest,
  simulation: boolean,
): ProviderReceipt {
  return {
    runId: request.runId,
    taskId: request.taskId,
    provider: request.provider,
    model: request.model,
    effort: request.effort,
    sessionId: randomUUID(),
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: null,
    status: "UNKNOWN",
    output: "",
    tests: [],
    costUsd: null,
    tokens: null,
    identityVerified: false,
    simulation,
  };
}
function truncateBytes(text: string, max: number): string {
  // Decode only complete characters, preserving the byte limit even for Unicode output.
  let result = Buffer.from(text).subarray(0, max).toString("utf8");
  while (Buffer.byteLength(result) > max) result = result.slice(0, -1);
  return result;
}
function finish(
  receipt: ProviderReceipt,
  request: ProviderRequest,
  changes: Partial<ProviderReceipt>,
  secrets: readonly string[] = [],
): ProviderReceipt {
  return validateProviderReceipt(
    {
      ...receipt,
      ...changes,
      endedAt: new Date().toISOString(),
      output: truncateBytes(
        redact(changes.output ?? receipt.output, secrets),
        request.maxOutputBytes ?? 1_048_576,
      ),
    },
    request,
  );
}

const finishReceipt = finish;

export interface MockProviderOptions {
  delayMs?: number;
  /** The mock can simulate either provider but every receipt remains simulation=true. */
  providerIdentity?: ProviderId;
  model?: string;
  effort?: string;
  outcome?: "success" | "failure" | "auth-failure" | "crash" | "malformed";
  output?: string;
  /**
   * A provider limit the run reports (outcome "failure" or "crash"), with its
   * usage before the limit (default zero).
   */
  limit?: ProviderLimit;
  limitUsage?: { costUsd: number; tokens: number };
}
export class MockProvider implements ProviderAdapter {
  active = 0;
  maxActive = 0;
  readonly requests: Omit<ProviderRequest, "signal">[] = [];
  constructor(private readonly options: MockProviderOptions = {}) {}
  activity(): RunActivity {
    return { processStopped: true, detail: "a mock run has no process" };
  }
  busy(): BusyRun[] {
    return [];
  }
  async execute(request: ProviderRequest): Promise<ProviderReceipt> {
    request = { ...requestSchema.parse(request), signal: request.signal };
    const receipt = baseReceipt(request, true);
    const { signal: _signal, ...record } = request;
    this.requests.push(record);
    if (request.signal?.aborted)
      return finish(receipt, request, {
        status: "CANCELLED",
        output: "CANCELLED_BEFORE_START",
      });
    if (
      (this.options.providerIdentity &&
        this.options.providerIdentity !== request.provider) ||
      (this.options.model && this.options.model !== request.model) ||
      (this.options.effort && this.options.effort !== request.effort)
    ) {
      return finish(receipt, request, {
        status: "FAILED",
        output: "PROVIDER_IDENTITY_MISMATCH",
      });
    }
    this.active++;
    this.maxActive = Math.max(this.active, this.maxActive);
    try {
      const result = await new Promise<"done" | "timeout" | "cancelled">(
        (res) => {
          let settled = false;
          const settle = (value: "done" | "timeout" | "cancelled") => {
            if (settled) return;
            settled = true;
            clearTimeout(delay);
            clearTimeout(deadline);
            request.signal?.removeEventListener("abort", cancel);
            res(value);
          };
          const cancel = () => settle("cancelled");
          const delay = setTimeout(
            () => settle("done"),
            this.options.delayMs ?? 5,
          );
          const deadline = setTimeout(
            () => settle("timeout"),
            request.deadlineMs,
          );
          request.signal?.addEventListener("abort", cancel, { once: true });
          if (request.signal?.aborted) cancel();
        },
      );
      if (result === "timeout")
        return finish(receipt, request, {
          status: "TIMED_OUT",
          output: "DEADLINE_EXCEEDED",
        });
      if (result === "cancelled")
        return finish(receipt, request, {
          status: "CANCELLED",
          output: "CANCELLED",
        });
      const outcome = this.options.outcome ?? "success";
      if (outcome === "malformed")
        throw new ProviderError("MALFORMED_PROVIDER_RECEIPT");
      const limited = this.options.limit
        ? {
            providerLimit: this.options.limit,
            costUsd: this.options.limitUsage?.costUsd ?? 0,
            tokens: this.options.limitUsage?.tokens ?? 0,
          }
        : {};
      if (outcome === "crash")
        return finish(receipt, request, {
          status: "UNKNOWN",
          output: "SIMULATED_CRASH_OUTCOME_REQUIRES_RECONCILIATION",
          ...limited,
        });
      if (outcome === "auth-failure")
        return finish(receipt, request, {
          status: "FAILED",
          exitCode: 1,
          output: "PROVIDER_AUTHENTICATION_FAILED",
        });
      if (outcome === "failure")
        return finish(receipt, request, {
          status: "FAILED",
          exitCode: 1,
          output: this.options.limit
            ? "SIMULATED_PROVIDER_LIMIT: " + this.options.limit.message
            : "SIMULATED_PROVIDER_FAILURE",
          ...limited,
        });
      return finish(receipt, request, {
        status: "SUCCEEDED",
        exitCode: 0,
        identityVerified: true,
        output:
          this.options.output ??
          "SIMULATION: bounded mock work finished; no native tests or external side effects claimed.",
        costUsd: 0,
        tokens: 0,
      });
    } finally {
      this.active--;
    }
  }
}

export interface ProcessResult {
  exitCode: number | null;
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  /** Bytes the isolated runner dropped from long output. */
  droppedBytes?: number;
  /** The runner couldn't keep every line the parsers need; the run can't succeed. */
  outputIncomplete?: boolean;
  /** With `statusFd`: what the process wrote on file descriptor 3. */
  statusOutput?: string;
  /** Why this runner stopped the process itself (deadline, output limit, cancel). */
  stoppedFor?: ExecutionStatus;
}
/**
 * Trusted argv only; never accepts shell text. Best-effort cleanup kills the
 * original process group. Descendants that create another session/process group
 * can escape this helper; hostile workers require separate OS containment.
 */
export async function runBoundedProcess(options: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  deadlineMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /**
   * Read file descriptor 3 apart from the output, up to 64 KiB, outside the
   * output allowance (bubblewrap's --json-status-fd).
   */
  statusFd?: boolean;
  /** Called with the process ID just before this runner stops the process. */
  onStop?: (pid: number) => void;
}): Promise<ProcessResult> {
  if (
    !isAbsolute(options.executable) ||
    !isAbsolute(options.cwd) ||
    !Number.isInteger(options.deadlineMs) ||
    options.deadlineMs < 1 ||
    options.deadlineMs > 3_600_000 ||
    options.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    (options.maxOutputBytes !== undefined &&
      (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1))
  ) {
    throw new ProviderError("INVALID_PROCESS_CONFIGURATION");
  }
  if (options.signal?.aborted)
    return { exitCode: null, status: "CANCELLED", stdout: "", stderr: "" };
  return new Promise((resolveResult) => {
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      bytes = 0;
    let forcedStatus: ExecutionStatus | null = null;
    let settled = false;
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: options.statusFd
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let status = Buffer.alloc(0);
    (child.stdio[3] as NodeJS.ReadableStream | null | undefined)?.on(
      "data",
      (data: Buffer) => {
        if (status.length < 65_536)
          status = Buffer.concat([status, data.subarray(0, 65_536 - status.length)]);
      },
    );
    const killGroup = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* process group already gone */
      }
    };
    const stop = (status: ExecutionStatus) => {
      if (settled || forcedStatus) return;
      forcedStatus = status;
      if (child.pid) options.onStop?.(child.pid);
      killGroup();
    };
    const onAbort = () => stop("CANCELLED");
    const timer = setTimeout(() => stop("TIMED_OUT"), options.deadlineMs);
    const collect = (buffer: Buffer, stream: "stdout" | "stderr") => {
      const max = options.maxOutputBytes ?? 1_048_576;
      const remaining = Math.max(0, max - bytes);
      const part = buffer.subarray(0, remaining);
      bytes += buffer.length;
      if (stream === "stdout") stdout = Buffer.concat([stdout, part]);
      else stderr = Buffer.concat([stderr, part]);
      if (bytes > max) stop("FAILED");
    };
    child.stdout.on("data", (data: Buffer) => collect(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => collect(data, "stderr"));
    const complete = (exitCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      // Also clean up same-group descendants after the leader exits. This does
      // not contain descendants that have created their own session/group.
      killGroup();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolveResult({
        exitCode,
        status:
          forcedStatus ??
          (error
            ? "FAILED"
            : exitCode === 0
              ? "SUCCEEDED"
              : exitCode === null
                ? "UNKNOWN"
                : "FAILED"),
        stdout: stdout.toString("utf8"),
        stderr: error
          ? error.message
          : `${stderr.toString("utf8")}${bytes > (options.maxOutputBytes ?? 1_048_576) ? "\nOUTPUT_LIMIT_EXCEEDED" : ""}`,
        ...(options.statusFd ? { statusOutput: status.toString("utf8") } : {}),
        ...(forcedStatus ? { stoppedFor: forcedStatus } : {}),
      });
    };
    child.once("error", (error) => complete(null, error));
    child.once("close", (code) => complete(code));
    child.stdin.on("error", () => {
      /* EPIPE from a process that exited; close is authoritative. */
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdin.end(options.stdin ?? "");
  });
}

export interface CliProbe {
  provider: "codex" | "claude";
  executable: string;
  version: string | null;
  compatible: boolean;
  missingFlags: string[];
  error: string | null;
}
const requiredFlags = {
  codex: [
    "--model",
    "--json",
    "--ephemeral",
    "--sandbox",
    "--ignore-user-config",
    "--ignore-rules",
  ],
  claude: [
    "--model",
    "--effort",
    "--print",
    "--output-format",
    "--no-session-persistence",
    "--tools",
    "--strict-mcp-config",
    "--bare",
    "--restricted",
    "--allowedTools",
  ],
} as const;
export async function probeCli(
  provider: "codex" | "claude",
  executable: string,
): Promise<CliProbe> {
  const result: CliProbe = {
    provider,
    executable,
    version: null,
    compatible: false,
    missingFlags: [],
    error: null,
  };
  try {
    const resolved = await realpath(executable);
    await access(resolved, constants.X_OK);
    const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
    const [version, help] = await Promise.all([
      runBoundedProcess({
        executable: resolved,
        args: ["--version"],
        cwd: "/tmp",
        env,
        deadlineMs: 5_000,
      }),
      runBoundedProcess({
        executable: resolved,
        args: provider === "codex" ? ["exec", "--help"] : ["--help"],
        cwd: "/tmp",
        env,
        deadlineMs: 5_000,
      }),
    ]);
    if (version.status !== "SUCCEEDED" || help.status !== "SUCCEEDED")
      throw new ProviderError("CLI_PROBE_FAILED");
    const prefix =
      provider === "codex"
        ? /^codex-cli ([\d.]+)\s*$/
        : /^([\d.]+) \(Claude Code\)\s*$/;
    const match = version.stdout.trim().match(prefix);
    if (!match?.[1]) throw new ProviderError("INCORRECT_PROVIDER_IDENTITY");
    result.version = match[1];
    result.executable = resolved;
    result.missingFlags = requiredFlags[provider].filter(
      (flag) => !help.stdout.includes(flag),
    );
    result.compatible = result.missingFlags.length === 0;
    if (!result.compatible) result.error = "CLI_FLAGS_INCOMPATIBLE";
  } catch (error) {
    result.error =
      error instanceof ProviderError ? error.code : "CLI_UNAVAILABLE";
  }
  return result;
}

/** Uses each installed CLI's read-only auth status command; never returns account or token contents. */
export async function probeAuthentication(
  provider: "codex" | "claude",
  executable: string,
): Promise<{
  provider: "codex" | "claude";
  status: "AUTHENTICATED" | "UNAVAILABLE" | "ERROR";
  method: "CLI_STATUS";
  error: string | null;
}> {
  const probe = await probeCli(provider, executable);
  if (!probe.compatible)
    return {
      provider,
      status: "ERROR",
      method: "CLI_STATUS",
      error: probe.error,
    };
  const result = await runBoundedProcess({
    executable: probe.executable,
    args:
      provider === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
    cwd: "/tmp",
    env: process.env,
    deadlineMs: 5_000,
    maxOutputBytes: 16_384,
  });
  if (result.status !== "SUCCEEDED")
    return {
      provider,
      status: "UNAVAILABLE",
      method: "CLI_STATUS",
      error: "AUTHENTICATION_UNAVAILABLE_OR_STATUS_FAILED",
    };
  if (provider === "claude") {
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      return {
        provider,
        status: value.loggedIn === true ? "AUTHENTICATED" : "UNAVAILABLE",
        method: "CLI_STATUS",
        error: null,
      };
    } catch {
      return {
        provider,
        status: "ERROR",
        method: "CLI_STATUS",
        error: "MALFORMED_AUTHENTICATION_STATUS",
      };
    }
  }
  const authenticated =
    /logged in/i.test(`${result.stdout}\n${result.stderr}`) &&
    !/not logged in/i.test(`${result.stdout}\n${result.stderr}`);
  return {
    provider,
    status: authenticated ? "AUTHENTICATED" : "UNAVAILABLE",
    method: "CLI_STATUS",
    error: null,
  };
}

export async function probeIsolation(
  executable = "/usr/bin/bwrap",
): Promise<{ available: boolean; error: string | null }> {
  try {
    const result = await runBoundedProcess({
      executable,
      args: [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--",
        "/bin/true",
      ],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
      deadlineMs: 5_000,
    });
    return {
      available: result.status === "SUCCEEDED",
      error: result.status === "SUCCEEDED" ? null : "OS_ISOLATION_UNAVAILABLE",
    };
  } catch {
    return { available: false, error: "OS_ISOLATION_UNAVAILABLE" };
  }
}

/** An operator-authenticated discovery result. A worker recommendation cannot populate this. */
export interface CapabilityAttestation {
  provider: "codex" | "claude";
  cliVersion: string;
  model: string;
  efforts: readonly string[];
  verifiedAt: string;
  authenticated: true;
  evidenceRef: string;
}
export interface IsolatedRunnerVerification {
  osIsolated: boolean;
  filesystemAllowlisted: boolean;
  networkAllowlisted: boolean;
  credentialsScoped: boolean;
  nestedDelegationDisabled: boolean;
  supportsWritableWorkspace: boolean;
  executableDigest: string;
  verifiedAt: string;
  evidenceRef: string;
}
const runnerVerificationSchema = z.object({
  osIsolated: z.literal(true),
  filesystemAllowlisted: z.literal(true),
  networkAllowlisted: z.literal(true),
  credentialsScoped: z.literal(true),
  nestedDelegationDisabled: z.literal(true),
  supportsWritableWorkspace: z.boolean(),
  executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.iso.datetime(),
  evidenceRef: z.string().min(1),
});
export interface HarnessIdentityProof {
  runId: string;
  taskId: string;
  provider: "codex" | "claude";
  model: string;
  effort: string;
  sessionId: string;
  executableDigest: string;
  source: "AUTHENTICATED_HARNESS";
  evidenceRef: string;
}
/**
 * The phase Codex's session log gives each assistant message: a progress note
 * ("commentary") or the answer ("final_answer"). `codex exec --json` streams
 * the same messages without it.
 */
export type CodexMessagePhase = "commentary" | "final_answer";
/** What an isolated run returns to the adapter. */
export type IsolatedRunResult = ProcessResult & {
  identity?: HarnessIdentityProof;
  notLaunched?: boolean;
  /**
   * Codex only: one phase per agent message in stdout, in order, supplied by
   * the runner only when the raw stream matched the run's session log one
   * for one (same session log as the identity proof).
   */
  messagePhases?: readonly CodexMessagePhase[];
  /**
   * Codex only: what the run's own session log (the identity proof's log)
   * says about how it ended, read by the runner when the log is
   * unambiguous: its error code, rate-limit windows and token usage.
   */
  codexSession?: CodexSessionSignal;
};
export interface IsolatedRunInput {
  runId: string;
  taskId: string;
  provider: "codex" | "claude";
  executable: string;
  executableDigest: string;
  args: readonly string[];
  cwd: string;
  stdin: string;
  env: Readonly<Record<string, string>>;
  policy: {
    workspace: string;
    writableWorkspace: boolean;
    writablePaths: readonly string[];
    nestedDelegation: false;
    networkProvider: "codex" | "claude";
    /** Drive scope served by the runner's host-side gateway; workers only. */
    drive?: DrivePolicy;
  };
  deadlineMs: number;
  maxOutputBytes: number;
  /** Written by the runner to $HOME/output-schema.json for Codex --output-schema. */
  outputSchema?: Record<string, unknown>;
  /** The run's owner-text folder, mounted read-only at OWNER_TEXT_IN_SANDBOX after its files are re-checked. */
  ownerText?: { dir: string; files: Array<{ file: string; sha256: string }> };
  signal?: AbortSignal;
  /** The controller's last check before spawning (ProviderRequest.launchGate). */
  launchGate?: () => string | undefined;
  /** The controller's write-intent hooks for the gateway (ProviderRequest.driveWrites). */
  driveWrites?: DriveWriteHooks;
}
/**
 * Installed by trusted controller configuration only. It must enforce OS mounts,
 * network/credential policy and obtain proof from authenticated harness metadata,
 * never from the model response. It is part of the trusted computing base.
 */
export interface IsolatedProviderRunner {
  verify(input: {
    provider: "codex" | "claude";
    executable: string;
    executableDigest: string;
    workspace: string;
    writableWorkspace: boolean;
    writablePaths: readonly string[];
  }): Promise<IsolatedRunnerVerification>;
  /** `notLaunched` is the runner's authenticated statement that nothing started. */
  execute(input: IsolatedRunInput): Promise<IsolatedRunResult>;
  /** Return true only after every process in the isolated execution has stopped. */
  cancel(runId: string): Promise<boolean>;
  /**
   * `processStopped` true only when no process of the isolated execution is
   * alive: none was launched, or every one has stopped.
   */
  activity?(runId: string): RunActivity;
  /** The runs with a sandbox process alive, whether or not execute() has returned. */
  busy?(): BusyRun[];
}
export interface CliProviderOptions {
  enabled?: boolean;
  executable: string;
  allowedCwdRoot: string;
  apiKey?: string;
  credentialMode?: "explicit-api-key" | "runner-brokered";
  /** Attested routes, or a reader of them so a proof renewed mid-advance is seen . */
  capabilities?:
    | readonly CapabilityAttestation[]
    | (() => readonly CapabilityAttestation[]);
  bwrapExecutable?: string;
  /** Default is read-only; controller must separately authorize any writable workspace. */
  writableWorkspace?: boolean;
  /** Relative mount scopes; may narrow but never expand request.filesystemPolicy.
   * "controller" uses exactly the controller-derived request scope. */
  writePaths?: readonly string[] | "controller";
  /** Subscription credentials: Claude cannot use --bare (API-key only), and Codex
   * keeps its per-run session log so the runner can prove model and effort. */
  subscriptionAuth?: boolean;
  /** Token/cost caps are enforced by the controller from reported usage after the
   * run, not by the CLI. Overrun is detected, not prevented. */
  budgetEnforcement?: "controller-post-hoc";
  /** Subscription runs have no per-call price; record Codex cost as 0. */
  costAccounting?: "subscription";
  /** Classify the already minimized brief at the trusted controller boundary. */
  sanitizedPublicBrief?: boolean;
  runner?: IsolatedProviderRunner;
}

/**
 * Live dispatch requires a controller-installed OS-isolated runner and egress
 * broker. No fallback to unsandboxed subprocesses or host networking exists.
 */
export class CliProvider implements ProviderAdapter {
  /**
   * Where each pending run is: its preflight (probes, which run short
   * processes of their own) or the isolated runner.
   */
  private readonly phases = new Map<string, "preflight" | "isolated">();
  constructor(
    readonly provider: "codex" | "claude",
    private readonly options: CliProviderOptions,
  ) {}
  execute(request: ProviderRequest): Promise<ProviderReceipt> {
    this.phases.set(request.runId, "preflight");
    return this.run(request, false).finally(() =>
      this.phases.delete(request.runId),
    );
  }
  /**
   * What this adapter knows of a pending run's processes: nothing while its
   * preflight probes may still be running, else the runner's word.
   */
  activity(runId: string): RunActivity {
    const phase = this.phases.get(runId);
    if (phase === undefined)
      return { processStopped: true, detail: "no run of this ID is pending" };
    if (phase === "preflight")
      return {
        processStopped: false,
        detail: "its preflight probes may still be running",
      };
    return (
      this.options.runner?.activity?.(runId) ?? {
        processStopped: false,
        detail: "the runner cannot say whether its process has stopped",
      }
    );
  }
  /** Runs whose preflight probes may still be running, and the runner's busy runs. */
  busy(): BusyRun[] {
    return [
      ...[...this.phases]
        .filter(([, phase]) => phase === "preflight")
        .map(([runId]) => ({
          runId,
          detail: "its preflight probes may still be running",
        })),
      ...(this.options.runner?.busy?.() ?? []),
    ];
  }
  /**
   * Trusted operator probe: run one minimal request through the full isolated
   * path without a prior attestation. Only a SUCCEEDED, identity-verified
   * receipt for the exact model/effort establishes capability.
   */
  probeCapability(request: ProviderRequest): Promise<ProviderReceipt> {
    return this.run(request, true);
  }
  private async run(
    request: ProviderRequest,
    capabilityProbe: boolean,
  ): Promise<ProviderReceipt> {
    request = {
      ...requestSchema.parse(request),
      signal: request.signal,
      launchGate: request.launchGate,
      driveWrites: request.driveWrites,
    };
    const receipt = baseReceipt(request, false);
    const secrets = [this.options.apiKey ?? ""];
    // Usage is always reported: zero before anything launches (truthful), the
    // harness-parsed figures afterwards, and null only when it is unknown.
    let launched = false;
    let observed: {
      costUsd: number | null;
      tokens: number | null;
      usageDetail?: UsageDetail;
    } = {
      costUsd: null,
      tokens: null,
    };
    // A provider limit the harness reported, kept on any receipt but a
    // success, whatever else rejects the run (S3 review S3-4).
    let detectedLimit: ProviderLimit | undefined;
    const finish = (
      r: ProviderReceipt,
      req: ProviderRequest,
      changes: Partial<ProviderReceipt>,
      s: readonly string[] = [],
    ) =>
      finishReceipt(
        r,
        req,
        {
          ...(launched ? observed : { costUsd: 0, tokens: 0 }),
          ...(launched && detectedLimit && changes.status !== "SUCCEEDED"
            ? { providerLimit: detectedLimit }
            : {}),
          // A failure, cancellation or timeout before anything launched is a
          // known non-launch (review r2 finding R5).
          ...(!launched &&
          ["FAILED", "CANCELLED", "TIMED_OUT"].includes(changes.status ?? "")
            ? { notLaunched: true as const }
            : {}),
          ...changes,
        },
        s,
      );
    const failure = (code: string) =>
      finish(receipt, request, { status: "FAILED", output: code }, secrets);
    if (request.signal?.aborted)
      return finish(receipt, request, {
        status: "CANCELLED",
        output: "CANCELLED_BEFORE_START",
      });
    if (!this.options.enabled) return failure("LIVE_PROVIDER_DISABLED");
    if (request.provider !== this.provider)
      return failure("PROVIDER_IDENTITY_MISMATCH");
    if (
      !this.options.sanitizedPublicBrief ||
      redact(request.brief, secrets) !== request.brief
    )
      return failure("BRIEF_DATA_CLASSIFICATION_REQUIRED");
    if (
      !this.options.apiKey &&
      this.options.credentialMode !== "runner-brokered"
    )
      return failure("PROVIDER_AUTHENTICATION_UNAVAILABLE");
    if (
      this.options.credentialMode === "runner-brokered" &&
      !this.options.runner
    )
      return failure("CREDENTIAL_BROKER_UNAVAILABLE");
    if (
      this.options.budgetEnforcement !== "controller-post-hoc" &&
      (request.maxTokens !== undefined ||
        (this.provider === "codex" && request.maxCostUsd !== undefined))
    )
      return failure("HARD_BUDGET_UNSUPPORTED");
    const probe = await probeCli(this.provider, this.options.executable);
    if (!probe.compatible || !probe.version)
      return failure(probe.error ?? "CLI_INCOMPATIBLE");
    const capabilities =
      typeof this.options.capabilities === "function"
        ? this.options.capabilities()
        : this.options.capabilities;
    const attestation = capabilityProbe
      ? { evidenceRef: "CAPABILITY_PROBE_IN_PROGRESS" }
      : capabilities?.find(
          (capability) =>
            capability.authenticated === true &&
            capability.provider === this.provider &&
            capability.model === request.model &&
            capability.cliVersion === probe.version &&
            capability.efforts.includes(request.effort) &&
            capability.evidenceRef.length > 0 &&
            Number.isFinite(Date.parse(capability.verifiedAt)) &&
            Date.parse(capability.verifiedAt) <= Date.now() &&
            Date.now() - Date.parse(capability.verifiedAt) < 3_600_000,
        );
    if (!attestation) return failure("CURRENT_MODEL_CAPABILITY_UNVERIFIED");
    try {
      await this.assertWorkspace(request.cwd);
    } catch {
      return failure("WORKSPACE_OUTSIDE_ALLOWLIST");
    }
    if (!this.options.runner) {
      const isolation = await probeIsolation(this.options.bwrapExecutable);
      return failure(
        isolation.available
          ? "LIVE_EGRESS_BROKER_UNAVAILABLE"
          : "OS_ISOLATION_UNAVAILABLE",
      );
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(probe.executable))
      hash.update(chunk);
    const binaryDigest = hash.digest("hex");
    const runner = this.options.runner;
    const workspace = await realpath(request.cwd);
    const controllerWritePaths = request.filesystemPolicy?.writablePaths ?? [];
    const writableWorkspace =
      this.options.writableWorkspace === true &&
      request.role === "worker" &&
      controllerWritePaths.length > 0;
    const writablePaths = writableWorkspace
      ? this.options.writePaths === "controller"
        ? [...controllerWritePaths]
        : [...(this.options.writePaths ?? [])]
      : [];
    // Drive writes and source packs go only to writable workers, whose
    // workspace receives the gateway's record. Reviewers and advisors may
    // only read.
    if (
      request.drivePolicy &&
      !(
        (writableWorkspace && request.role === "worker") ||
        (this.provider === "claude" &&
          driveReadRole(request.role) &&
          driveReadOnly(request.drivePolicy))
      )
    )
      return failure(
        !driveReadRole(request.role)
          ? "DRIVE_REQUIRES_WRITABLE_WORKER"
          : this.provider !== "claude"
            ? "DRIVE_READ_NEEDS_CLAUDE"
            : "DRIVE_WRITE_REQUIRES_WRITABLE_WORKER",
      );
    if (
      writableWorkspace &&
      (!writablePaths.length ||
        writablePaths.some((path) => !safeRelativeScope(path)))
    )
      return failure("WRITE_SCOPE_REQUIRED");
    if (
      writablePaths.some(
        (path) =>
          !controllerWritePaths.some(
            (allowed) => path === allowed || path.startsWith(`${allowed}/`),
          ),
      )
    )
      return failure("WRITE_SCOPE_EXCEEDS_CONTROLLER_POLICY");
    try {
      for (const path of writablePaths) {
        let current = workspace;
        for (const part of path.split("/")) {
          current = join(current, part);
          try {
            if ((await lstat(current)).isSymbolicLink())
              return failure("UNSAFE_WRITE_SCOPE");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw error;
          }
        }
      }
    } catch {
      return failure("UNSAFE_WRITE_SCOPE");
    }
    let verification: IsolatedRunnerVerification;
    let verificationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      verification = await Promise.race([
        runner.verify({
          provider: this.provider,
          executable: probe.executable,
          executableDigest: binaryDigest,
          workspace,
          writableWorkspace,
          writablePaths,
        }),
        new Promise<never>((_, reject) => {
          verificationTimer = setTimeout(
            () => reject(new ProviderError("PREFLIGHT_TIMED_OUT")),
            Math.max(
              1,
              request.deadlineMs - (Date.now() - Date.parse(receipt.startedAt)),
            ),
          );
        }),
      ]);
    } catch (error) {
      return error instanceof ProviderError &&
        error.code === "PREFLIGHT_TIMED_OUT"
        ? finish(receipt, request, {
            status: "TIMED_OUT",
            output: "DEADLINE_EXCEEDED_DURING_PREFLIGHT",
          })
        : failure(
            // Keep an actionable owner diagnostic; other details stay internal.
            error instanceof Error &&
              error.message.startsWith("CODEX_CREDENTIAL_RECOVERY_PENDING: ")
              ? error.message
              : "ISOLATED_RUNNER_VERIFICATION_FAILED",
          );
    } finally {
      clearTimeout(verificationTimer);
    }
    if (!runnerVerificationSchema.safeParse(verification).success)
      return failure("ISOLATED_RUNNER_POLICY_UNVERIFIED");
    if (
      verification.osIsolated !== true ||
      verification.filesystemAllowlisted !== true ||
      verification.networkAllowlisted !== true ||
      verification.credentialsScoped !== true ||
      verification.nestedDelegationDisabled !== true ||
      (writableWorkspace && verification.supportsWritableWorkspace !== true) ||
      verification.executableDigest !== binaryDigest ||
      !verification.evidenceRef ||
      !Number.isFinite(Date.parse(verification.verifiedAt)) ||
      Date.parse(verification.verifiedAt) > Date.now() ||
      Date.now() - Date.parse(verification.verifiedAt) > 300_000
    )
      return failure("ISOLATED_RUNNER_POLICY_UNVERIFIED");
    if (request.signal?.aborted)
      return finish(receipt, request, {
        status: "CANCELLED",
        output: "CANCELLED_BEFORE_START",
      });
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: "/home/worker",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    if (this.options.apiKey)
      env[this.provider === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"] =
        this.options.apiKey;
    if (this.provider === "codex") env.CODEX_HOME = "/home/worker/.codex";
    // When a model's safety system declines a request, Claude Code otherwise
    // has a different model do the whole run, which the identity check then
    // rejects. Stop at the decline instead: a clean, cheap failure. This is an
    // undocumented switch (CLI 2.1.306 compatibility check); without it
    // the identity check still refuses the other model's work.
    if (this.provider === "claude")
      env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = "1";
    const remainingDeadline =
      request.deadlineMs - (Date.now() - Date.parse(receipt.startedAt));
    if (remainingDeadline <= 0)
      return finish(receipt, request, {
        status: "TIMED_OUT",
        output: "DEADLINE_EXCEEDED_DURING_PREFLIGHT",
      });
    // A brief that points at the owner's text must go to a run that can read it.
    if (
      request.ownerText?.required &&
      !canReadOwnerText(this.provider, request, writableWorkspace, {
        subscriptionAuth: this.options.subscriptionAuth === true,
      })
    )
      return failure("OWNER_TEXT_UNREADABLE_BY_ROLE");
    let execution: IsolatedRunResult;
    launched = true;
    this.phases.set(request.runId, "isolated");
    try {
      execution = await this.runIsolated(runner, {
        runId: request.runId,
        taskId: request.taskId,
        provider: this.provider,
        executable: probe.executable,
        executableDigest: binaryDigest,
        args: buildCliArguments(this.provider, request, writableWorkspace, {
          subscriptionAuth: this.options.subscriptionAuth === true,
          outputSchemaPath:
            request.outputSchema && this.provider === "codex"
              ? "/home/worker/output-schema.json"
              : undefined,
        }),
        cwd: workspace,
        stdin: redact(request.brief, secrets),
        env,
        policy: {
          workspace,
          writableWorkspace,
          writablePaths,
          nestedDelegation: false,
          networkProvider: this.provider,
          ...(request.drivePolicy ? { drive: request.drivePolicy } : {}),
        },
        deadlineMs: remainingDeadline,
        maxOutputBytes: request.maxOutputBytes ?? DEFAULT_CAPTURE_BYTES,
        outputSchema: request.outputSchema,
        ...(request.ownerText
          ? {
              ownerText: {
                dir: request.ownerText.dir,
                files: request.ownerText.files,
              },
            }
          : {}),
        signal: request.signal,
        ...(request.launchGate ? { launchGate: request.launchGate } : {}),
        ...(request.driveWrites ? { driveWrites: request.driveWrites } : {}),
      });
    } catch {
      return finish(
        receipt,
        request,
        {
          status: "UNKNOWN",
          output: "ISOLATED_RUNNER_FAILED_OUTCOME_REQUIRES_RECONCILIATION",
        },
        secrets,
      );
    }
    const processSchema = z.object({
      exitCode: z.number().int().nullable(),
      status: z.enum([
        "SUCCEEDED",
        "FAILED",
        "TIMED_OUT",
        "CANCELLED",
        "UNKNOWN",
      ]),
      stdout: z.string(),
      stderr: z.string(),
      notLaunched: z.boolean().optional(),
    });
    if (!processSchema.safeParse(execution).success)
      return failure("MALFORMED_PROVIDER_RECEIPT");
    // The trusted runner reports a run it never launched (cancelled while
    // queued, or refused before launch), so its usage is a truthful zero. Only
    // its metadata counts: stdout/stderr are child output, never authority.
    if (execution.notLaunched === true) launched = false;
    // Codex's own session log, as the runner read it, checked here too.
    const session =
      this.provider === "codex"
        ? CodexSessionSignalSchema.safeParse(execution.codexSession)
        : undefined;
    const codexSession = session?.success ? session.data : undefined;
    {
      const parsed = inspectCliOutput(
        this.provider,
        execution.stdout,
        request.model,
      );
      // A failed Codex run's stream reports no usage; its own session log
      // records it (harness metadata), so that is the run's observed usage.
      // Nothing invents a zero.
      const logged =
        parsed.tokens === null && codexSession?.totalTokenUsage
          ? countUsage("codex", codexSession.totalTokenUsage, request.model)
          : undefined;
      const tokens = parsed.tokens ?? logged?.tokens ?? null;
      const usageDetail = parsed.usageDetail ?? logged?.usageDetail;
      observed = {
        tokens,
        costUsd:
          parsed.costUsd ??
          (this.provider === "codex" &&
          this.options.costAccounting === "subscription" &&
          tokens !== null
            ? 0
            : null),
        ...(usageDetail ? { usageDetail } : {}),
      };
    }
    // Recognised before any other check can reject the run, from the
    // harness's structured output and Codex's own session log.
    if (
      launched &&
      (execution.status !== "SUCCEEDED" || execution.exitCode !== 0)
    )
      detectedLimit =
        this.provider === "claude"
          ? claudeLimit(execution.stdout, Date.now())
          : codexLimit(execution.stdout, codexSession, Date.now(), hostZone());
    if (
      execution.outputIncomplete === true ||
      Buffer.byteLength(execution.stdout) +
        Buffer.byteLength(execution.stderr) >
        (request.maxOutputBytes ?? DEFAULT_CAPTURE_BYTES)
    )
      return failure("OUTPUT_LIMIT_EXCEEDED");
    // A model that declined did no work; say so plainly. Its usage is known.
    if (
      this.provider === "claude" &&
      claudeDeclined(execution.stdout, request.model)
    )
      return finish(
        receipt,
        request,
        {
          status: "FAILED",
          exitCode: execution.exitCode,
          output: `MODEL_DECLINED: ${request.model} declined this request (its safety system stopped it), so nothing it produced counts.\n${execution.stdout}\n${execution.stderr}`,
        },
        secrets,
      );
    if (execution.status !== "SUCCEEDED" || execution.exitCode !== 0)
      return finish(
        receipt,
        request,
        {
          status:
            execution.status === "SUCCEEDED" ? "FAILED" : execution.status,
          exitCode: execution.exitCode,
          output: `${execution.stdout}\n${execution.stderr}`,
        },
        secrets,
      );
    const metadata = inspectCliOutput(
      this.provider,
      execution.stdout,
      request.model,
    );
    if (!metadata.sessionId || !metadata.complete)
      return failure("MALFORMED_PROVIDER_OUTPUT");
    const proof = execution.identity;
    if (metadata.actualModel !== null && metadata.actualModel !== request.model)
      return failure("PROVIDER_MODEL_IDENTITY_MISMATCH");
    if (
      !proof ||
      proof.source !== "AUTHENTICATED_HARNESS" ||
      proof.runId !== request.runId ||
      proof.taskId !== request.taskId ||
      proof.provider !== this.provider ||
      proof.model !== request.model ||
      proof.effort !== request.effort ||
      proof.sessionId !== metadata.sessionId ||
      proof.executableDigest !== binaryDigest ||
      !proof.evidenceRef
    ) {
      return finish(
        receipt,
        request,
        {
          status: "UNKNOWN",
          exitCode: 0,
          sessionId: metadata.sessionId,
          output:
            "ACTUAL_PROVIDER_MODEL_EFFORT_UNVERIFIED; reconcile completed process before retry.",
        },
        secrets,
      );
    }
    // Only Codex omits price on subscription runs; Claude reports total_cost_usd,
    // so a missing Claude cost stays unknown.
    if (
      metadata.costUsd === null &&
      this.provider === "codex" &&
      this.options.costAccounting === "subscription"
    )
      metadata.costUsd = 0;
    if (
      request.maxCostUsd !== undefined &&
      this.options.budgetEnforcement !== "controller-post-hoc" &&
      (metadata.costUsd === null || metadata.costUsd > request.maxCostUsd)
    )
      return failure("COST_BUDGET_EVIDENCE_INVALID");
    const provenance = {
      cliVersion: probe.version,
      executableDigest: binaryDigest,
      isolationEvidenceRef: verification.evidenceRef,
      capabilityEvidenceRef: attestation.evidenceRef,
      identityEvidenceRef: proof.evidenceRef,
      rawStdoutDigest: createHash("sha256")
        .update(execution.stdout)
        .digest("hex"),
      rawStdoutBytes: Buffer.byteLength(execution.stdout),
    };
    let response: string;
    try {
      response = normalizeCliResponse(this.provider, execution.stdout, {
        structured: request.outputSchema !== undefined,
        // Reached only after the identity proof above checked out, so these
        // labels come from the same verified session log.
        messagePhases:
          this.provider === "codex" ? execution.messagePhases : undefined,
      });
    } catch (error) {
      return finish(
        receipt,
        request,
        {
          status: "UNKNOWN",
          exitCode: 0,
          sessionId: metadata.sessionId,
          // Usage is known even when the final response is not; record it.
          costUsd: metadata.costUsd,
          tokens: metadata.tokens,
          ...(metadata.usageDetail
            ? { usageDetail: metadata.usageDetail }
            : {}),
          output: `${error instanceof ProviderError ? error.code : "MALFORMED_PROVIDER_FINAL_RESPONSE"}; completed process requires reconciliation.`,
          provenance,
        },
        secrets,
      );
    }
    return finish(
      receipt,
      request,
      {
        status: "SUCCEEDED",
        exitCode: 0,
        identityVerified: true,
        sessionId: metadata.sessionId,
        costUsd: metadata.costUsd,
        tokens: metadata.tokens,
        ...(metadata.usageDetail ? { usageDetail: metadata.usageDetail } : {}),
        output: response,
        provenance,
      },
      secrets,
    );
  }
  private async runIsolated(
    runner: IsolatedProviderRunner,
    input: IsolatedRunInput,
  ): Promise<IsolatedRunResult> {
    const aborter = new AbortController();
    return new Promise((resolveRun, rejectRun) => {
      let settled = false,
        stopping = false;
      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancel);
      };
      const stop = async (reason: "TIMED_OUT" | "CANCELLED") => {
        if (settled || stopping) return;
        stopping = true;
        aborter.abort();
        // Cancellation itself is bounded. An unconfirmed outcome remains UNKNOWN.
        let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
        let confirmed = false;
        try {
          confirmed = await Promise.race([
            runner.cancel(input.runId),
            new Promise<false>((res) => {
              cancellationTimer = setTimeout(() => res(false), 250);
            }),
          ]);
        } catch {
          /* no authenticated confirmation */
        }
        clearTimeout(cancellationTimer);
        // Keep the runner's authenticated no-launch metadata (cancelled while
        // queued) so the receipt can report a truthful zero usage.
        let notLaunched = execution === undefined;
        if (confirmed === true && execution) {
          let waitTimer: ReturnType<typeof setTimeout> | undefined;
          const returned = await Promise.race([
            execution.catch(() => undefined),
            new Promise<undefined>((res) => {
              waitTimer = setTimeout(() => res(undefined), 250);
            }),
          ]);
          clearTimeout(waitTimer);
          notLaunched = returned?.notLaunched === true;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolveRun({
          status: confirmed === true ? reason : "UNKNOWN",
          exitCode: null,
          stdout: "",
          stderr:
            confirmed === true
              ? notLaunched
                ? "CANCELLED_BEFORE_LAUNCH"
                : reason
              : "CANCELLATION_UNCONFIRMED_RECONCILIATION_REQUIRED",
          ...(confirmed === true && notLaunched ? { notLaunched: true } : {}),
        });
      };
      const cancel = () => {
        void stop("CANCELLED");
      };
      const timer = setTimeout(() => {
        void stop("TIMED_OUT");
      }, input.deadlineMs);
      input.signal?.addEventListener("abort", cancel, { once: true });
      if (input.signal?.aborted) cancel();
      let execution: Promise<IsolatedRunResult> | undefined;
      Promise.resolve()
        .then(() =>
          stopping
            ? undefined
            : (execution = runner.execute({
                ...input,
                signal: aborter.signal,
              })),
        )
        .then(
          (result) => {
            if (settled || stopping || !result) return;
            settled = true;
            cleanup();
            resolveRun(result);
          },
          (error) => {
            if (settled || stopping) return;
            settled = true;
            cleanup();
            rejectRun(error);
          },
        );
    });
  }
  private async assertWorkspace(cwd: string): Promise<void> {
    if (!isAbsolute(cwd) || !isAbsolute(this.options.allowedCwdRoot))
      throw new ProviderError("INVALID_WORKSPACE");
    const [root, directory] = await Promise.all([
      realpath(this.options.allowedCwdRoot),
      realpath(cwd),
    ]);
    const relation = relative(root, directory);
    if (
      relation === "" ||
      relation.startsWith(`..${sep}`) ||
      relation === ".." ||
      isAbsolute(relation) ||
      !(await stat(directory)).isDirectory() ||
      (await lstat(cwd)).isSymbolicLink()
    )
      throw new ProviderError("INVALID_WORKSPACE");
  }
}
export class CodexCliProvider extends CliProvider {
  constructor(options: CliProviderOptions) {
    super("codex", options);
  }
}
export class ClaudeCliProvider extends CliProvider {
  constructor(options: CliProviderOptions) {
    super("claude", options);
  }
}

/** Roles that may read Drive without writing. */
export const driveReadRole = (role: ProviderRequest["role"]) =>
  role === "reviewer" || role === "advisor";
/** A Drive scope that changes nothing and fetches no pack. */
export const driveReadOnly = (policy: DrivePolicy) =>
  !policy.update.length && !policy.createIn.length && !policy.pack?.length;

/** The tools a Claude run gets (see buildCliArguments). */
function claudeTools(
  request: ProviderRequest,
  writable: boolean,
  drive: boolean,
  driveRead: boolean,
  mode: { subscriptionAuth?: boolean },
): string {
  return writable
    ? "Read,Edit,Write" + (drive ? ",Bash" : "")
    : mode.subscriptionAuth && request.role !== "worker"
      ? "Read,Glob,Grep" + (driveRead ? ",Bash" : "")
      : "";
}
/**
 * Whether a run can read its owner-text files with the tools it is given:
 * Codex through its shell (both of its sandboxes read the mounted files),
 * Claude only with Read. Checked from the same rules that build the argv.
 */
export function canReadOwnerText(
  provider: "codex" | "claude",
  request: ProviderRequest,
  writableWorkspace: boolean,
  mode: { subscriptionAuth?: boolean } = {},
): boolean {
  if (provider === "codex") return true;
  const writable =
    writableWorkspace &&
    request.role === "worker" &&
    (request.filesystemPolicy?.writablePaths.length ?? 0) > 0;
  const drive = writable && !!request.drivePolicy;
  const driveRead =
    !writable &&
    driveReadRole(request.role) &&
    !!request.drivePolicy &&
    driveReadOnly(request.drivePolicy);
  return claudeTools(request, writable, drive, driveRead, mode)
    .split(",")
    .includes("Read");
}
/**
 * Why a provider would refuse this request's shape, if it would: the
 * controller checks before marking a run started, so a request no adapter can
 * take never becomes an unknown outcome.
 */
export function providerRequestProblem(
  request: Omit<ProviderRequest, "signal">,
): string | undefined {
  const parsed = requestSchema.safeParse(request);
  return parsed.success
    ? undefined
    : "PROVIDER_REQUEST_INVALID: " +
        parsed.error.issues
          .slice(0, 5)
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; ");
}
/**
 * The host's time zone: Codex states a reset as a wall time in it (the
 * runner binds the host's /etc/localtime into the sandbox).
 */
function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
/** Produce inspectable argv without running it. The executable path is controller-owned. */
export function buildCliArguments(
  provider: "codex" | "claude",
  request: ProviderRequest,
  writableWorkspace = false,
  mode: { subscriptionAuth?: boolean; outputSchemaPath?: string } = {},
): string[] {
  requestSchema.parse(request);
  if (request.provider !== provider)
    throw new ProviderError("PROVIDER_IDENTITY_MISMATCH");
  const writable =
    writableWorkspace &&
    request.role === "worker" &&
    (request.filesystemPolicy?.writablePaths.length ?? 0) > 0;
  const drive = writable && !!request.drivePolicy;
  // A Claude reviewer or advisor reads Drive through the same gateway client.
  const driveRead =
    provider === "claude" &&
    !writable &&
    driveReadRole(request.role) &&
    !!request.drivePolicy &&
    driveReadOnly(request.drivePolicy);
  if (provider === "codex")
    return [
      "exec",
      "--json",
      // A subscription run keeps its per-run session log as identity evidence.
      ...(mode.subscriptionAuth ? [] : ["--ephemeral"]),
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      writable ? "workspace-write" : "read-only",
      "--model",
      request.model,
      "--config",
      `model_reasoning_effort=${JSON.stringify(request.effort)}`,
      "--config",
      "project_doc_max_bytes=0",
      "--config",
      "features.multi_agent=false",
      // The Drive gateway is a Unix socket; Codex's shell sandbox reaches it
      // only with network access. The outer sandbox still allows no other egress.
      ...(drive
        ? ["--config", "sandbox_workspace_write.network_access=true"]
        : []),
      ...(mode.outputSchemaPath && request.outputSchema
        ? ["--output-schema", mode.outputSchemaPath]
        : []),
      "-",
    ];
  // Subscription reviewers, advisors and moderators read the workspace; still no
  // write/shell tools.
  const tools = claudeTools(request, writable, drive, driveRead, mode);
  // A Drive run's shell runs the gateway client and nothing else.
  const allowed = drive
    ? `Read,Edit,Write,Bash(${DRIVE_CLIENT_IN_SANDBOX}:*)`
    : driveRead && tools
      ? `Read,Glob,Grep,Bash(${DRIVE_CLIENT_IN_SANDBOX}:*)`
      : tools;
  return [
    "--print",
    "--output-format",
    "json",
    // --bare accepts only ANTHROPIC_API_KEY; --restricted still ignores settings files.
    ...(mode.subscriptionAuth ? [] : ["--bare"]),
    "--restricted",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    tools,
    ...(tools ? ["--allowedTools", allowed] : []),
    "--permission-mode",
    "dontAsk",
    // The owner-text mount is outside the working directory; Read reaches it
    // only as an added directory (it is mounted read-only).
    ...(request.ownerText?.required && tools.split(",").includes("Read")
      ? ["--add-dir", OWNER_TEXT_IN_SANDBOX]
      : []),
    "--model",
    request.model,
    "--effort",
    request.effort,
    ...(request.maxCostUsd === undefined
      ? []
      : ["--max-budget-usd", String(request.maxCostUsd)]),
    ...(request.outputSchema
      ? ["--json-schema", JSON.stringify(request.outputSchema)]
      : []),
  ];
}

/** Extract model content only after the separate harness identity checks succeed. */
export function normalizeCliResponse(
  provider: "codex" | "claude",
  stdout: string,
  options: {
    structured?: boolean;
    /** Codex only: the runner's phase for each agent message, in order. */
    messagePhases?: readonly CodexMessagePhase[];
  } = {},
): string {
  try {
    if (provider === "claude") {
      const envelope: unknown = JSON.parse(stdout);
      const parsed = z
        .object({
          type: z.literal("result"),
          is_error: z.literal(false),
          session_id: z.string().min(1),
          result: z.string(),
          structured_output: z.unknown().optional(),
        })
        .passthrough()
        .safeParse(envelope);
      if (!parsed.success)
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      // --json-schema results arrive as harness-validated structured_output.
      const structured = parsed.data.structured_output;
      if (
        structured !== undefined &&
        structured !== null &&
        typeof structured === "object" &&
        !Array.isArray(structured)
      )
        return JSON.stringify(structured);
      if (!parsed.data.result.trim())
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      return parsed.data.result;
    }
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
        return value as Record<string, unknown>;
      });
    if (
      events.filter((event) => event.type === "thread.started").length !== 1 ||
      events.filter((event) => event.type === "turn.completed").length !== 1 ||
      events.some(
        (event) => event.type === "turn.failed" || event.type === "error",
      )
    )
      throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
    const messages: string[] = [];
    // The runner's labels apply only to a run without an output schema (a
    // structured run keeps taking its last message and checking its JSON,
    // review r2) and only when there is exactly one per agent message;
    // otherwise the stream is read as before.
    const agentMessages = events.filter(
      (event) =>
        event.type === "item.completed" &&
        !!event.item &&
        typeof event.item === "object" &&
        (event.item as Record<string, unknown>).type === "agent_message",
    ).length;
    const supplied =
      !options.structured && options.messagePhases?.length === agentMessages
        ? options.messagePhases
        : undefined;
    let agentIndex = 0;
    let started = false,
      completed = false;
    for (const event of events) {
      if (event.type === "thread.started") {
        if (completed)
          throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
        started = true;
      }
      if (event.type === "turn.completed") {
        if (!started)
          throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
        completed = true;
      }
      if (event.type !== "item.completed") continue;
      const item = event.item;
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      const message = item as Record<string, unknown>;
      if (typeof message.type !== "string")
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      if (message.type !== "agent_message") continue;
      if (
        !started ||
        completed ||
        typeof message.text !== "string" ||
        !message.text.trim()
      )
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      const streamed = message.phase ?? message.channel;
      const labelled = supplied?.[agentIndex];
      agentIndex++;
      const isNote = (value: unknown) =>
        value === "commentary" || value === "analysis";
      // A stream label and the session log's label must agree. A label is
      // supplied only where the stream has none at all: an explicit null
      // stays malformed, as before (review r3).
      if (
        typeof streamed === "string" &&
        labelled !== undefined &&
        isNote(streamed) !== isNote(labelled)
      )
        throw new ProviderError("CONFLICTING_PROVIDER_FINAL_MESSAGES");
      const phase = streamed === undefined ? labelled : streamed;
      if (isNote(phase)) continue;
      if (phase !== undefined && phase !== "final_answer" && phase !== "final")
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      messages.push(message.text);
    }
    // With --output-schema, Codex's final response is its last agent message
    // (the --output-last-message contract); earlier unlabelled messages are
    // progress commentary between tool calls. It must be a JSON object.
    if (options.structured && messages.length > 1) {
      const last = messages.at(-1)!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(last);
      } catch {
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
      return last;
    }
    const distinct = [...new Set(messages)];
    if (distinct.length > 1)
      throw new ProviderError("CONFLICTING_PROVIDER_FINAL_MESSAGES");
    if (distinct.length !== 1)
      throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
    return distinct[0]!;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_PROVIDER_FINAL_RESPONSE");
  }
}

/** Model-authored text is never parsed as a controller-verified test result. */
/**
 * Budget tokens and the raw counts behind them for a harness usage record
 * (Claude's envelope usage, Codex's stream or session-log usage), or
 * undefined when the record is not a complete usage record.
 */
export function countUsage(
  provider: "codex" | "claude",
  value: unknown,
  expectedModel: string,
  models: readonly string[] = [],
): { tokens: number; usageDetail: UsageDetail } | undefined {
  const whole = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  if (!whole(usage.input_tokens) || !whole(usage.output_tokens))
    return undefined;
  // Cache writes and reads are real context use and count against the
  // budget; reads count at their price share. Claude reports both apart
  // from input_tokens; Codex's input_tokens already includes its
  // cached_input_tokens.
  let input = usage.input_tokens,
    cacheWrite = 0,
    cacheRead = 0;
  if (provider === "claude") {
    for (const key of [
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ])
      if (usage[key] !== undefined && !whole(usage[key])) return undefined;
    cacheWrite = (usage.cache_creation_input_tokens as number) ?? 0;
    cacheRead = (usage.cache_read_input_tokens as number) ?? 0;
  } else if (
    whole(usage.cached_input_tokens) &&
    usage.cached_input_tokens <= input
  ) {
    // An implausible cached count is ignored: all input counts in full.
    cacheRead = usage.cached_input_tokens;
    input -= cacheRead;
  }
  // The usage is one total, so a run that another model also worked on (a
  // decline handed over) counts at the highest share among them.
  const weight = Math.max(
    ...[expectedModel, ...models].map((model) => cacheReadWeight(model)),
  );
  const tokens =
    input + usage.output_tokens + cacheWrite + Math.ceil(cacheRead * weight);
  if (!Number.isSafeInteger(tokens)) return undefined;
  return {
    tokens,
    usageDetail: {
      inputTokens: input,
      outputTokens: usage.output_tokens,
      cacheWriteTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      cacheReadWeight: weight,
    },
  };
}

export function inspectCliOutput(
  provider: "codex" | "claude",
  output: string,
  expectedModel: string,
): {
  sessionId: string | null;
  actualModel: string | null;
  identityVerified: boolean;
  complete: boolean;
  costUsd: number | null;
  tokens: number | null;
  usageDetail?: UsageDetail;
} {
  const result: {
    sessionId: string | null;
    actualModel: string | null;
    identityVerified: boolean;
    complete: boolean;
    costUsd: number | null;
    tokens: number | null;
    usageDetail?: UsageDetail;
  } = {
    sessionId: null,
    actualModel: null,
    identityVerified: false,
    complete: false,
    costUsd: null,
    tokens: null,
  };
  const count = (value: unknown, models: readonly string[] = []) => {
    const counted = countUsage(provider, value, expectedModel, models);
    if (!counted) return;
    result.tokens = counted.tokens;
    result.usageDetail = counted.usageDetail;
  };
  try {
    if (provider === "claude") {
      const envelope = JSON.parse(output) as Record<string, unknown>;
      if (envelope.type !== "result") return result;
      // Usage is harness accounting and is kept even for an error result, so a
      // failed run with known usage is a clean failure rather than an unknown.
      if (
        typeof envelope.total_cost_usd === "number" &&
        Number.isFinite(envelope.total_cost_usd) &&
        envelope.total_cost_usd >= 0
      )
        result.costUsd = envelope.total_cost_usd;
      const ran =
        envelope.modelUsage &&
        typeof envelope.modelUsage === "object" &&
        !Array.isArray(envelope.modelUsage)
          ? Object.keys(envelope.modelUsage)
          : [];
      count(envelope.usage, ran);
      if (
        typeof envelope.session_id !== "string" ||
        envelope.is_error !== false
      )
        return result;
      result.sessionId = envelope.session_id;
      result.complete = true;
      // modelUsage is harness metadata, unlike a model's own claim in `result`.
      const usage = envelope.modelUsage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const keys = Object.keys(usage);
        if (keys.length === 1 && keys[0]) {
          result.actualModel = keys[0];
          result.identityVerified = keys[0] === expectedModel;
        }
      }
    } else {
      const events = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const started = events.find(
        (event) =>
          event.type === "thread.started" &&
          typeof event.thread_id === "string",
      );
      if (started) result.sessionId = started.thread_id as string;
      result.complete =
        !!started &&
        events.some((event) => event.type === "turn.completed") &&
        !events.some(
          (event) => event.type === "turn.failed" || event.type === "error",
        );
      count(events.find((event) => event.type === "turn.completed")?.usage);
      // Codex exec 0.163.0's public JSON contract does not guarantee an actual-model field.
      // The requested argument and an agent's prose cannot attest actual identity.
    }
  } catch {
    /* malformed/partial metadata leaves identity unverified */
  }
  return result;
}
