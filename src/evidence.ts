import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** Authentication describes transport/custody, never owner authorization. */
export const EvidenceEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    kind: z.enum([
      "DRIVE",
      "GITHUB",
      "LOCAL",
      "TEST_RECEIPT",
      "REVIEW",
      "SOURCE_BINDING",
    ]),
    uri: z.string().min(1),
    revision: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    retrievedAt: z.iso.datetime(),
    authorityTier: z.enum([
      "GOVERNING",
      "OWNER_DECISION",
      "RATIFIED",
      "PLANNING",
      "IMPLEMENTATION",
      "REVIEW",
      "HISTORICAL",
      "UNVERIFIED",
    ]),
    authentication: z.enum([
      "AUTHENTICATED_CONNECTOR",
      "AUTHENTICATED_API",
      // The owner's own request text, captured by UID-authenticated intake.
      "LOCAL_OWNER_REQUEST",
      "LOCAL_IMPORT",
      "UNAUTHENTICATED",
    ]),
    currentness: z.enum(["CURRENT_AT_RETRIEVAL", "STALE", "UNKNOWN"]),
    claims: z.array(z.string()),
    supersedes: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;
/** Old local imports serialized an absent optional supersession as null.
 * Interpret only that legacy absence on reads; never rewrite immutable bytes,
 * relax new input validation or upgrade authority/currentness. */
export function parseStoredEvidence(body: string): EvidenceEnvelope {
  const value = JSON.parse(body);
  if (value && typeof value === "object" && value.supersedes === null)
    delete value.supersedes;
  return EvidenceEnvelopeSchema.parse(value);
}
export type EvidenceResult =
  | { ok: true; envelope: EvidenceEnvelope; content: string }
  | { ok: false; code: "EVIDENCE_UNAVAILABLE"; reason: string };
export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Defense in depth only. Restricted source export still requires explicit policy. */
export function redactSecrets(
  value: string,
  knownSecrets: readonly string[] = [],
): string {
  let result = value;
  for (const secret of [...knownSecrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[REDACTED]");
  return result
    .replace(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk-(?:proj-)?[\w-]{12,}|gh[pousr]_[\w]{15,}|github_pat_[\w]{15,})\b/g,
      "[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"',;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:postgres(?:ql)?|https?):\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      "$1[REDACTED]@",
    );
}

export function evidenceCurrentness(
  envelope: EvidenceEnvelope,
  current: { revision?: string; digest?: string },
): EvidenceEnvelope["currentness"] {
  if (current.revision !== undefined && current.revision !== envelope.revision)
    return "STALE";
  if (current.digest !== undefined && current.digest !== envelope.digest)
    return "STALE";
  return current.revision !== undefined || current.digest !== undefined
    ? "CURRENT_AT_RETRIEVAL"
    : "UNKNOWN";
}

type ImportOptions = {
  taskId: string;
  path: string;
  allowedRoot: string;
  revision?: string;
  expectedDigest?: string;
  maxBytes?: number;
  kind?: "LOCAL" | "TEST_RECEIPT" | "REVIEW" | "SOURCE_BINDING";
  claims?: string[];
  supersedes?: string;
};
const unavailable = (reason: string): EvidenceResult => ({
  ok: false,
  code: "EVIDENCE_UNAVAILABLE",
  reason,
});
const boundBytes = (value = 1_048_576): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_485_760)
    throw new Error("maxBytes must be 1..10485760");
  return value;
};

export async function importLocalEvidence(
  options: ImportOptions,
): Promise<EvidenceResult> {
  try {
    const limit = boundBytes(options.maxBytes);
    const [root, target] = await Promise.all([
      realpath(options.allowedRoot),
      realpath(options.path),
    ]);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      return unavailable("LOCAL_PATH_OUTSIDE_ALLOWLIST");
    const info = await stat(target);
    if (!info.isFile() || info.size > limit)
      return unavailable("LOCAL_FILE_NOT_REGULAR_OR_EXCEEDS_LIMIT");
    // Open the canonical path, then check its identity; do not follow a changed symlink.
    const handle = await open(target, "r");
    let bytes: Buffer;
    try {
      const after = await handle.stat();
      if (
        after.ino !== info.ino ||
        after.dev !== info.dev ||
        after.size > limit
      )
        return unavailable("LOCAL_FILE_CHANGED_DURING_IMPORT");
      bytes = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          total,
          bytes.length - total,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > limit) return unavailable("LOCAL_FILE_EXCEEDS_LIMIT");
      const final = await handle.stat();
      if (
        final.size !== total ||
        final.size !== after.size ||
        final.mtimeMs !== after.mtimeMs ||
        final.ctimeMs !== after.ctimeMs
      )
        return unavailable("LOCAL_FILE_CHANGED_DURING_IMPORT");
      bytes = bytes.subarray(0, total);
    } finally {
      await handle.close();
    }
    const digest = sha256(bytes);
    const content = redactSecrets(bytes.toString("utf8"));
    return {
      ok: true,
      content,
      envelope: EvidenceEnvelopeSchema.parse({
        id: randomUUID(),
        taskId: options.taskId,
        kind: options.kind ?? "LOCAL",
        uri: pathToFileURL(target).href,
        revision: options.revision ?? `sha256:${digest}`,
        digest,
        retrievedAt: new Date().toISOString(),
        authorityTier: "UNVERIFIED",
        authentication: "LOCAL_IMPORT",
        currentness: options.expectedDigest
          ? options.expectedDigest === digest
            ? "CURRENT_AT_RETRIEVAL"
            : "STALE"
          : "UNKNOWN",
        claims: (options.claims ?? []).map((v) => redactSecrets(v)),
        ...(options.supersedes === undefined
          ? {}
          : { supersedes: options.supersedes }),
        metadata: {
          byteLength: bytes.length,
          representation: "original-file-bytes",
          redactedContentDigest: sha256(content),
          authorityNotEstablishedByHash: true,
        },
      }),
    };
  } catch (error) {
    return unavailable(`LOCAL_IMPORT_FAILED: ${safeError(error)}`);
  }
}

type ConnectorOptions = {
  token?: string;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
};
type HttpResult = { ok: true; content: string } | { ok: false; reason: string };
function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** There is no generic URL/method entry point. Only fixed-origin GET requests exist. */
class ReadOnlyApi {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  private readonly performFetch: typeof fetch;
  constructor(
    private readonly origin:
      | "https://www.googleapis.com"
      | "https://api.github.com",
    private readonly options: ConnectorOptions,
  ) {
    this.maxBytes = boundBytes(options.maxBytes);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000
    )
      throw new Error("timeoutMs must be 1..60000");
    this.performFetch = options.fetch ?? fetch;
  }
  async get(
    path: string,
    parameters: Record<string, string> = {},
  ): Promise<HttpResult> {
    if (!this.options.token)
      return {
        ok: false,
        reason:
          "MISSING_CREDENTIAL: explicit read-only API token unavailable; connected-app authentication is separate",
      };
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !path.startsWith("/"))
      return { ok: false, reason: "PROHIBITED_EXTERNAL_ENDPOINT" };
    for (const [key, value] of Object.entries(parameters))
      url.searchParams.set(key, value);
    try {
      const response = await this.performFetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: this.origin.includes("github")
            ? "application/vnd.github+json"
            : "application/json",
          "User-Agent": "longform-orchestrator/0.1-read-only",
        },
      });
      if (response.status >= 300 && response.status < 400)
        return { ok: false, reason: "REDIRECT_REJECTED" };
      if (!response.ok)
        return {
          ok: false,
          reason: `HTTP_${response.status}${response.status === 401 || response.status === 403 ? ": AUTHENTICATION_OR_SCOPE_DENIED" : ""}`,
        };
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > this.maxBytes)
        return { ok: false, reason: "RESPONSE_EXCEEDS_LIMIT" };
      if (!response.body) return { ok: false, reason: "EMPTY_RESPONSE" };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.length;
          if (total > this.maxBytes) {
            await reader.cancel();
            return { ok: false, reason: "RESPONSE_EXCEEDS_LIMIT" };
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return { ok: true, content: Buffer.concat(chunks).toString("utf8") };
    } catch (error) {
      const detail = safeError(error);
      return {
        ok: false,
        reason: `READ_FAILED: ${this.options.token ? detail.split(this.options.token).join("[REDACTED]") : detail}`,
      };
    }
  }
}

type ReadOptions = {
  taskId: string;
  expectedRevision?: string;
  expectedDigest?: string;
};
function envelope(
  kind: "DRIVE" | "GITHUB",
  uri: string,
  revision: string,
  original: string,
  options: ReadOptions,
  metadata: Record<string, unknown>,
): EvidenceEnvelope {
  const digest = sha256(original);
  const initial = EvidenceEnvelopeSchema.parse({
    id: randomUUID(),
    taskId: options.taskId,
    kind,
    uri,
    revision,
    digest,
    retrievedAt: new Date().toISOString(),
    authorityTier: "UNVERIFIED",
    authentication: "AUTHENTICATED_API",
    currentness: "CURRENT_AT_RETRIEVAL",
    claims: [],
    metadata,
  });
  initial.currentness =
    options.expectedRevision || options.expectedDigest
      ? evidenceCurrentness(initial, {
          revision: options.expectedRevision,
          digest: options.expectedDigest,
        })
      : "CURRENT_AT_RETRIEVAL";
  return initial;
}

const DriveMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  version: z.string().optional(),
  headRevisionId: z.string().optional(),
  modifiedTime: z.string().optional(),
  trashed: z.boolean().optional(),
  owners: z
    .array(
      z.object({
        displayName: z.string().optional(),
        emailAddress: z.string().optional(),
        me: z.boolean().optional(),
      }),
    )
    .optional(),
});
export class DriveReadOnlyAdapter {
  private readonly api: ReadOnlyApi;
  constructor(options: ConnectorOptions = {}) {
    this.api = new ReadOnlyApi("https://www.googleapis.com", options);
  }
  async read(fileId: string, options: ReadOptions): Promise<EvidenceResult> {
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(fileId))
      return unavailable("INVALID_DRIVE_FILE_ID");
    const info = await this.api.get(`/drive/v3/files/${fileId}`, {
      fields:
        "id,name,mimeType,version,headRevisionId,modifiedTime,trashed,owners",
    });
    if (!info.ok) return unavailable(`DRIVE: ${info.reason}`);
    try {
      const metadata = DriveMetadataSchema.parse(JSON.parse(info.content));
      if (metadata.id !== fileId || metadata.trashed)
        return unavailable("DRIVE_ID_MISMATCH_OR_TRASHED");
      const native =
        metadata.mimeType === "application/vnd.google-apps.document";
      if (
        metadata.mimeType.startsWith("application/vnd.google-apps.") &&
        !native
      )
        return unavailable(
          "DRIVE_UNSUPPORTED_NATIVE_TYPE: Docs only; Sheets/Slides require bounded structured adapters",
        );
      if (
        !native &&
        !["text/plain", "text/markdown", "application/json"].includes(
          metadata.mimeType,
        )
      )
        return unavailable(
          "DRIVE_UNSUPPORTED_MIME_TYPE: no automatic binary or restricted package export",
        );
      const result = await this.api.get(
        `/drive/v3/files/${fileId}${native ? "/export" : ""}`,
        native ? { mimeType: "text/plain" } : { alt: "media" },
      );
      if (!result.ok) return unavailable(`DRIVE: ${result.reason}`);
      if (!result.content.trim())
        return unavailable(
          "DRIVE_EMPTY_CONTENT: metadata/title cannot establish evidence",
        );
      // A concurrent edit during retrieval must fail closed; a before-only read can bind the wrong revision.
      const after = await this.api.get(`/drive/v3/files/${fileId}`, {
        fields:
          "id,name,mimeType,version,headRevisionId,modifiedTime,trashed,owners",
      });
      if (!after.ok)
        return unavailable(`DRIVE_CURRENTNESS_RECHECK: ${after.reason}`);
      const current = DriveMetadataSchema.parse(JSON.parse(after.content));
      if (JSON.stringify(current) !== JSON.stringify(metadata))
        return unavailable("DRIVE_CHANGED_DURING_RETRIEVAL");
      const revision =
        metadata.headRevisionId ??
        metadata.version ??
        `content-sha256:${sha256(result.content)}`;
      const content = redactSecrets(result.content);
      return {
        ok: true,
        content,
        envelope: envelope(
          "DRIVE",
          `https://drive.google.com/file/d/${fileId}/view`,
          revision,
          result.content,
          options,
          {
            fileId,
            name: redactSecrets(metadata.name),
            mimeType: metadata.mimeType,
            modifiedTime: metadata.modifiedTime,
            representation: native ? "text/plain-export" : "utf8-media",
            nativeRevisionAvailable: !!(
              metadata.headRevisionId ?? metadata.version
            ),
            ownerMetadataAvailable: !!metadata.owners?.length,
            redactedContentDigest: sha256(content),
            authorityNotEstablishedByTransport: true,
          },
        ),
      };
    } catch (error) {
      return unavailable(`DRIVE_INVALID_RESPONSE: ${safeError(error)}`);
    }
  }
  async discover(
    query: string,
    pageToken?: string,
  ): Promise<
    | { ok: true; files: unknown[]; nextPageToken?: string }
    | { ok: false; code: "EVIDENCE_UNAVAILABLE"; reason: string }
  > {
    if (query.length > 1000 || (pageToken?.length ?? 0) > 4096)
      return {
        ok: false,
        code: "EVIDENCE_UNAVAILABLE",
        reason: "DRIVE_DISCOVERY_INPUT_EXCEEDS_LIMIT",
      };
    const response = await this.api.get("/drive/v3/files", {
      q: query,
      pageSize: "100",
      fields:
        "nextPageToken,files(id,name,mimeType,version,headRevisionId,modifiedTime,parents)",
      ...(pageToken ? { pageToken } : {}),
    });
    if (!response.ok)
      return {
        ok: false,
        code: "EVIDENCE_UNAVAILABLE",
        reason: `DRIVE: ${response.reason}`,
      };
    try {
      const data = z
        .object({
          files: z.array(z.unknown()).max(100),
          nextPageToken: z.string().optional(),
        })
        .parse(JSON.parse(response.content));
      return { ok: true, ...data };
    } catch {
      return {
        ok: false,
        code: "EVIDENCE_UNAVAILABLE",
        reason: "DRIVE_INVALID_DISCOVERY_RESPONSE",
      };
    }
  }
}

export type GitHubResource =
  | { kind: "repository" }
  | { kind: "branch"; branch: string }
  | { kind: "commit"; sha: string }
  | { kind: "pullRequest" | "changedFiles" | "reviews"; number: number }
  | { kind: "workflowRuns"; sha: string };
export class GitHubReadOnlyAdapter {
  private readonly api: ReadOnlyApi;
  constructor(options: ConnectorOptions = {}) {
    this.api = new ReadOnlyApi("https://api.github.com", options);
  }
  async read(
    repository: string,
    resource: GitHubResource,
    options: ReadOptions,
  ): Promise<EvidenceResult> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      return unavailable("INVALID_GITHUB_REPOSITORY");
    const base = `/repos/${repository}`;
    let path: string;
    const parameters: Record<string, string> = { per_page: "100" };
    if (resource.kind === "repository") path = base;
    else if (resource.kind === "branch") {
      if (
        !resource.branch ||
        resource.branch.length > 200 ||
        resource.branch.includes("..") ||
        /[?#\\\x00-\x20]/.test(resource.branch)
      )
        return unavailable("INVALID_GITHUB_BRANCH");
      path = `${base}/branches/${encodeURIComponent(resource.branch)}`;
    } else if (resource.kind === "commit" || resource.kind === "workflowRuns") {
      if (!/^[a-f0-9]{40}$/.test(resource.sha))
        return unavailable("GITHUB_IMMUTABLE_COMMIT_REQUIRED");
      path =
        resource.kind === "commit"
          ? `${base}/commits/${resource.sha}`
          : `${base}/actions/runs`;
      if (resource.kind === "workflowRuns") parameters.head_sha = resource.sha;
    } else {
      if (!Number.isSafeInteger(resource.number) || resource.number < 1)
        return unavailable("INVALID_GITHUB_PR_NUMBER");
      path = `${base}/pulls/${resource.number}${resource.kind === "changedFiles" ? "/files" : resource.kind === "reviews" ? "/reviews" : ""}`;
    }
    const result = await this.api.get(path, parameters);
    if (!result.ok) return unavailable(`GITHUB: ${result.reason}`);
    try {
      const parsed: unknown = JSON.parse(result.content);
      if (!parsed || typeof parsed !== "object")
        return unavailable("GITHUB_INVALID_RESPONSE");
      const data = parsed as Record<string, unknown>;
      const head = data.head as { sha?: string } | undefined;
      const commit = data.commit as { sha?: string } | undefined;
      const pinned =
        resource.kind === "commit" || resource.kind === "workflowRuns"
          ? resource.sha
          : (head?.sha ?? commit?.sha);
      if (resource.kind === "commit" && data.sha !== resource.sha)
        return unavailable("GITHUB_COMMIT_ID_MISMATCH");
      const content = redactSecrets(result.content);
      const itemCount = Array.isArray(parsed)
        ? parsed.length
        : Array.isArray(data.workflow_runs)
          ? data.workflow_runs.length
          : undefined;
      return {
        ok: true,
        content,
        envelope: envelope(
          "GITHUB",
          `https://api.github.com${path}`,
          pinned ?? `response-sha256:${sha256(result.content)}`,
          result.content,
          options,
          {
            repository,
            resource: resource.kind,
            commit: pinned,
            paginationComplete:
              itemCount === undefined ? true : itemCount < 100,
            truncatedPossibly: itemCount === 100,
            redactedContentDigest: sha256(content),
            authorityNotEstablishedByArtifactExistence: true,
          },
        ),
      };
    } catch (error) {
      return unavailable(`GITHUB_INVALID_RESPONSE: ${safeError(error)}`);
    }
  }
}
