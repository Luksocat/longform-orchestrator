import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  GitHubReadOnlyAdapter,
  redactSecrets,
  sha256,
  type EvidenceResult,
  type GitHubResource,
} from "./evidence.js";
import { runBoundedProcess } from "./providers.js";

const MANAGED_AUTH_MARKER = "longform-gh-cli-managed-authentication";
const ORIGIN = "https://api.github.com";
const RESOURCE_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository") }).strict(),
  z
    .object({
      kind: z.literal("branch"),
      branch: z
        .string()
        .min(1)
        .max(200)
        .refine(
          (value) => !value.includes("..") && !/[?#\\{}\x00-\x20]/.test(value),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflowRuns"),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["pullRequest", "changedFiles", "reviews"]),
      number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
const ENVIRONMENT_SELECTORS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
] as const;

export interface GitHubGhOptions {
  /** Absolute, trusted operator-selected binary; no model executable or command text. */
  ghExecutable?: string;
  /** Source values are filtered to fixed auth/config/proxy/CA selectors. No values are logged. */
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  timeoutMs?: number;
}
export interface GitHubGhReceipt {
  endpoint: string;
  method: "GET";
  hostname: "github.com";
  status: number;
  rawStdoutDigest: string;
  originalBodyDigest: string;
  responseBodyDigest: string;
  redactionApplied: boolean;
  retrievedAt: string;
}

export function githubCliEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    GH_HOST: "github.com",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "",
    PAGER: "",
    NO_COLOR: "1",
    CLICOLOR: "0",
  };
  for (const name of ENVIRONMENT_SELECTORS) {
    const value = source[name];
    if (value !== undefined && !value.includes("\0")) env[name] = value;
  }
  // DEBUG/GH_DEBUG, arbitrary executables, SSH variables and unrelated service
  // credentials are deliberately not inherited. gh's normal config identity is.
  return env;
}

function configuration(options: GitHubGhOptions) {
  const executable = options.ghExecutable ?? "/usr/bin/gh";
  const maxBytes = options.maxBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!isAbsolute(executable) || executable.includes("\0"))
    throw new Error("GH_EXECUTABLE_MUST_BE_ABSOLUTE");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_485_760)
    throw new Error("GH_INVALID_BYTE_LIMIT");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("GH_INVALID_DEADLINE");
  return {
    executable,
    maxBytes,
    timeoutMs,
    env: githubCliEnvironment(options.env),
  };
}

function validatedEndpoint(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): string {
  if (input instanceof Request) throw new Error("GH_REQUEST_OBJECT_PROHIBITED");
  if (init?.method !== "GET" || (init.body !== undefined && init.body !== null))
    throw new Error("GH_MUTATION_PROHIBITED");
  if (init.redirect !== "manual")
    throw new Error("GH_REDIRECT_POLICY_REQUIRED");
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error("GH_EXTERNAL_ORIGIN_PROHIBITED");
  }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash)
    throw new Error("GH_EXTERNAL_ORIGIN_PROHIBITED");
  const parts = url.pathname.match(
    /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(branches\/(?:[A-Za-z0-9._~-]|%[a-fA-F0-9]{2})+|commits\/[a-f0-9]{40}|pulls\/[1-9][0-9]*(?:\/(?:files|reviews))?|actions\/runs))?$/,
  );
  if (
    !parts ||
    [".", ".."].includes(parts[1]!) ||
    [".", ".."].includes(parts[2]!)
  )
    throw new Error("GH_ENDPOINT_NOT_ALLOWLISTED");
  if (parts[3]?.startsWith("branches/")) {
    const branch = decodeURIComponent(parts[3].slice("branches/".length));
    if (!RESOURCE_SCHEMA.safeParse({ kind: "branch", branch }).success)
      throw new Error("GH_INVALID_BRANCH_ENDPOINT");
  }
  const query = [...url.searchParams.entries()];
  if (
    url.searchParams.get("per_page") !== "100" ||
    query.filter(([name]) => name === "per_page").length !== 1 ||
    query.some(
      ([name, value]) =>
        name !== "per_page" &&
        (name !== "head_sha" ||
          parts[3] !== "actions/runs" ||
          !/^[a-f0-9]{40}$/.test(value)),
    ) ||
    query.filter(([name]) => name === "head_sha").length > 1 ||
    (parts[3] === "actions/runs" && !url.searchParams.has("head_sha"))
  )
    throw new Error("GH_QUERY_NOT_ALLOWLISTED");
  let headers: Headers;
  try {
    headers = new Headers(init.headers);
  } catch {
    throw new Error("GH_REQUEST_HEADER_PROHIBITED");
  }
  for (const [name, value] of headers) {
    if (name === "authorization" && value === `Bearer ${MANAGED_AUTH_MARKER}`)
      continue;
    if (name === "accept" && value === "application/vnd.github+json") continue;
    if (name === "user-agent" && value === "longform-orchestrator/0.1-read-only")
      continue;
    throw new Error("GH_REQUEST_HEADER_PROHIBITED");
  }
  return url.pathname.slice(1) + url.search;
}

function parseIncludedResponse(stdout: string): {
  status: number;
  body: string;
  contentType: string;
} {
  const separator = stdout.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined || separator.index > 65_536)
    throw new Error("GH_MALFORMED_HTTP_RESPONSE");
  const lines = stdout.slice(0, separator.index).split(/\r?\n/);
  const statusLine = lines
    .shift()
    ?.match(/^HTTP\/[0-9.]+ ([1-5][0-9]{2})(?: [^\r\n]*)?$/);
  if (!statusLine) throw new Error("GH_MALFORMED_HTTP_RESPONSE");
  const status = Number(statusLine[1]);
  let contentType = "";
  for (const line of lines) {
    const header = line.match(
      /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):[ \t]*([^\r\n]*)$/,
    );
    if (!header) throw new Error("GH_MALFORMED_HTTP_HEADER");
    const name = header[1]!.toLowerCase();
    if (name === "location" || (status >= 300 && status < 400))
      throw new Error("GH_REDIRECT_REJECTED");
    if (name === "authorization" || name === "proxy-authorization")
      throw new Error("GH_CREDENTIAL_HEADER_REJECTED");
    if (name === "content-type") contentType = header[2]!;
  }
  if (status >= 300 && status < 400) throw new Error("GH_REDIRECT_REJECTED");
  const body = stdout.slice(separator.index + separator[0].length);
  if (/^HTTP\/[0-9.]+ [0-9]{3}/.test(body))
    throw new Error("GH_MULTIPLE_HTTP_RESPONSES_REJECTED");
  if (!/^application\/(?:[A-Za-z0-9._-]+\+)?json(?:;|$)/i.test(contentType))
    throw new Error("GH_NON_JSON_RESPONSE_REJECTED");
  return { status, body, contentType };
}

/**
 * Bridge for the existing typed adapter. No generic arbitrary API capability is
 * exposed by GitHubGhReadOnlyAdapter. The fetch boundary rechecks the fixed GET
 * origin, typed-resource endpoint patterns, query and harmless request headers.
 *
 * gh 2.4.0 may internally follow redirects and exposes no no-follow flag. We
 * reject returned redirects/Location, but cannot prove absence of hidden follows.
 * This limitation is explicit in resulting evidence metadata, not suppressed.
 */
export function createGitHubGhFetch(options: GitHubGhOptions = {}): {
  fetch: typeof fetch;
  receipts: GitHubGhReceipt[];
} {
  const config = configuration(options);
  const receipts: GitHubGhReceipt[] = [];
  const secrets = [config.env.GH_TOKEN, config.env.GITHUB_TOKEN].filter(
    (value): value is string => !!value,
  );
  const bridge: typeof fetch = async (input, init) => {
    const endpoint = validatedEndpoint(input, init);
    const execution = await runBoundedProcess({
      executable: config.executable,
      args: [
        "api",
        "--method",
        "GET",
        "--hostname",
        "github.com",
        "--include",
        "--header",
        "Accept: application/vnd.github+json",
        "--",
        endpoint,
      ],
      cwd: "/tmp",
      env: config.env,
      deadlineMs: config.timeoutMs,
      maxOutputBytes: config.maxBytes + 65_536,
      signal: init?.signal ?? undefined,
    });
    if (execution.status !== "SUCCEEDED" && execution.status !== "FAILED")
      throw new Error(`GH_CLI_${execution.status}`);
    if (execution.stderr.includes("OUTPUT_LIMIT_EXCEEDED"))
      throw new Error("GH_RESPONSE_EXCEEDS_LIMIT");
    if (!execution.stdout)
      throw new Error("GH_AUTHENTICATION_OR_CLI_UNAVAILABLE");
    const parsed = parseIncludedResponse(execution.stdout);
    if (Buffer.byteLength(parsed.body) > config.maxBytes)
      throw new Error("GH_RESPONSE_EXCEEDS_LIMIT");
    if (execution.exitCode !== 0 && parsed.status < 400)
      throw new Error("GH_CLI_FAILED");
    const body = redactSecrets(parsed.body, secrets);
    receipts.push({
      endpoint,
      method: "GET",
      hostname: "github.com",
      status: parsed.status,
      rawStdoutDigest: sha256(execution.stdout),
      originalBodyDigest: sha256(parsed.body),
      responseBodyDigest: sha256(body),
      redactionApplied: body !== parsed.body,
      retrievedAt: new Date().toISOString(),
    });
    // Do not propagate response Set-Cookie, OAuth metadata, request headers or
    // gh stderr. The existing adapter needs only status and JSON body bytes.
    return new Response(parsed.status === 204 ? null : body, {
      status: parsed.status,
      headers: {
        "Content-Type": parsed.contentType,
        "Content-Length": String(Buffer.byteLength(body)),
      },
    });
  };
  return { fetch: bridge, receipts };
}

export class GitHubGhReadOnlyAdapter {
  constructor(private readonly options: GitHubGhOptions = {}) {
    configuration(options);
  }
  async read(
    repository: string,
    resource: GitHubResource,
    options: {
      taskId: string;
      expectedRevision?: string;
      expectedDigest?: string;
    },
  ): Promise<EvidenceResult> {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..")
    ) {
      return {
        ok: false,
        code: "EVIDENCE_UNAVAILABLE",
        reason: "INVALID_GITHUB_REPOSITORY",
      };
    }
    const parsed = RESOURCE_SCHEMA.safeParse(resource);
    if (!parsed.success)
      return {
        ok: false,
        code: "EVIDENCE_UNAVAILABLE",
        reason: "INVALID_GITHUB_RESOURCE",
      };
    const bridge = createGitHubGhFetch(this.options);
    // This marker only enables the existing adapter's authenticated transport
    // route. It is discarded at the bridge and is never sent as a credential.
    const adapter = new GitHubReadOnlyAdapter({
      token: MANAGED_AUTH_MARKER,
      fetch: bridge.fetch,
      timeoutMs: this.options.timeoutMs,
      maxBytes: this.options.maxBytes,
    });
    const result = await adapter.read(repository, parsed.data, options);
    if (result.ok)
      Object.assign(result.envelope.metadata, {
        transport: "GITHUB_CLI_AUTHENTICATED_GET",
        credentialHandling:
          "NORMAL_GH_CONFIG_OR_ALLOWLISTED_ENV_NO_TOKEN_EXTRACTION",
        representation: "gh-api-json-after-secret-redaction",
        redirectControl:
          "RETURNED_RESPONSE_ONLY_GH_MAY_FOLLOW_INTERNAL_REDIRECTS",
        transportReceipts: bridge.receipts,
      });
    return result;
  }
}
