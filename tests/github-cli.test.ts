import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubGhReadOnlyAdapter,
  createGitHubGhFetch,
  githubCliEnvironment,
} from "../src/github-cli.js";
import type { GitHubResource } from "../src/evidence.js";

const SHA = "a".repeat(40);
const URL = "https://api.github.com/repos/test-owner/test-repo?per_page=100";
const init: RequestInit = {
  method: "GET",
  redirect: "manual",
  headers: {
    Accept: "application/vnd.github+json",
    "User-Agent": "longform-orchestrator/0.1-read-only",
  },
};
async function withFakeGh(
  code: string,
  work: (executable: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "longform-gh-test-"));
  try {
    const executable = join(directory, "gh");
    await writeFile(executable, `#!${process.execPath}\n${code}\n`);
    await chmod(executable, 0o700);
    await work(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const success = (body: string) =>
  `process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json; charset=utf-8\\r\\nX-OAuth-Scopes: private-scopes\\r\\nSet-Cookie: private-cookie\\r\\n\\r\\n'+${JSON.stringify(body)});`;

test("GitHub gh adapter reads typed resources with GET fixed host and no credential arguments", async () => {
  const code = `const endpoint=process.argv.at(-1);const data={full_name:'test-owner/test-repo',sha:'${SHA}',head:{sha:'${SHA}'},commit:{sha:'${SHA}'},argv:process.argv.slice(2)};process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'+JSON.stringify(data));`;
  await withFakeGh(code, async (ghExecutable) => {
    const adapter = new GitHubGhReadOnlyAdapter({
      ghExecutable,
      env: { GH_TOKEN: "fake-token" },
    });
    for (const resource of [
      { kind: "repository" },
      { kind: "branch", branch: "feature/scoped" },
      { kind: "commit", sha: SHA },
      { kind: "pullRequest", number: 7 },
      { kind: "changedFiles", number: 7 },
      { kind: "reviews", number: 7 },
      { kind: "workflowRuns", sha: SHA },
    ] as GitHubResource[]) {
      const result = await adapter.read("test-owner/test-repo", resource, {
        taskId: "fixture-read",
      });
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      const data = JSON.parse(result.content);
      assert.deepEqual(data.argv.slice(0, 8), [
        "api",
        "--method",
        "GET",
        "--hostname",
        "github.com",
        "--include",
        "--header",
        "Accept: application/vnd.github+json",
      ]);
      assert.equal(data.argv[8], "--");
      assert.match(data.argv[9], /^repos\/test-owner\/test-repo/);
      assert.equal(
        data.argv.some(
          (arg: string) =>
            arg.includes("fake-token") ||
            arg.includes("managed-authentication"),
        ),
        false,
      );
      assert.equal(result.envelope.authentication, "AUTHENTICATED_API");
      assert.equal(
        result.envelope.metadata.transport,
        "GITHUB_CLI_AUTHENTICATED_GET",
      );
      assert.equal(
        result.envelope.metadata.redirectControl,
        "RETURNED_RESPONSE_ONLY_GH_MAY_FOLLOW_INTERNAL_REDIRECTS",
      );
      assert.equal(result.envelope.authorityTier, "UNVERIFIED");
      assert.equal(result.envelope.revision, SHA);
    }
  });
});

test("gh bridge rejects external origin, mutation, redirect policy, arbitrary endpoints, query and headers before spawn", async () => {
  const bridge = createGitHubGhFetch({
    ghExecutable: "/nonexistent-should-not-be-spawned",
    env: {},
  }).fetch;
  for (const [url, options] of [
    ["https://evil.test/repos/test-owner/test-repo?per_page=100", init],
    [URL, { ...init, method: "POST" }],
    [URL, { ...init, body: "{}" }],
    [URL, { ...init, redirect: "follow" }],
    ["https://api.github.com/user?per_page=100", init],
    [
      "https://api.github.com/repos/test-owner/test-repo/actions/runs?per_page=100",
      init,
    ],
    [URL + "&delete=true", init],
    [URL + "&per_page=1", init],
    [URL, { ...init, headers: { Authorization: "Bearer actual-secret" } }],
    [
      "https://user:password@api.github.com/repos/test-owner/test-repo?per_page=100",
      init,
    ],
    [
      "https://api.github.com/repos/test-owner/test-repo/branches/%2E%2E?per_page=100",
      init,
    ],
  ] as const)
    await assert.rejects(
      bridge(url, options),
      /GH_(?:EXTERNAL_ORIGIN_PROHIBITED|MUTATION_PROHIBITED|REDIRECT_POLICY_REQUIRED|ENDPOINT_NOT_ALLOWLISTED|QUERY_NOT_ALLOWLISTED|REQUEST_HEADER_PROHIBITED|INVALID_BRANCH_ENDPOINT)/,
    );
  await assert.rejects(
    bridge(new Request(URL), init),
    /GH_REQUEST_OBJECT_PROHIBITED/,
  );
});

test("environment preserves only operator auth/config/proxy/CA selectors and disables debug and pagers", () => {
  const env = githubCliEnvironment({
    HOME: "/configured-home",
    GH_CONFIG_DIR: "/configured-gh",
    GH_TOKEN: "fake-token",
    HTTPS_PROXY: "http://proxy.invalid",
    SSL_CERT_FILE: "/configured-ca",
    OPENAI_API_KEY: "unrelated",
    GH_DEBUG: "api",
    DEBUG: "oauth",
    GH_HOST: "evil.test",
    GH_REPO: "evil/repo",
    PATH: "/untrusted-path",
    GH_PAGER: "evil-command",
  });
  assert.equal(env.HOME, "/configured-home");
  assert.equal(env.GH_CONFIG_DIR, "/configured-gh");
  assert.equal(env.GH_TOKEN, "fake-token");
  assert.equal(env.HTTPS_PROXY, "http://proxy.invalid");
  assert.equal(env.SSL_CERT_FILE, "/configured-ca");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GH_DEBUG, undefined);
  assert.equal(env.DEBUG, undefined);
  assert.equal(env.GH_HOST, "github.com");
  assert.equal(env.GH_REPO, undefined);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.GH_PAGER, "");
});

test("gh bridge never propagates sensitive response headers and redacts known credential values", async () => {
  await withFakeGh(
    success('{"full_name":"test-owner/test-repo","reflected":"fake-token"}'),
    async (ghExecutable) => {
      const bridge = createGitHubGhFetch({
        ghExecutable,
        env: { GH_TOKEN: "fake-token" },
      });
      const response = await bridge.fetch(URL, init);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("x-oauth-scopes"), null);
      assert.equal((await response.text()).includes("fake-token"), false);
      assert.equal(bridge.receipts[0]?.redactionApplied, true);
      assert.notEqual(
        bridge.receipts[0]?.originalBodyDigest,
        bridge.receipts[0]?.responseBodyDigest,
      );
    },
  );
});

test("returned redirects, Location headers, multiple response blocks and malformed HTTP are rejected", async () => {
  for (const output of [
    "HTTP/2.0 301 Moved\r\nContent-Type: application/json\r\nLocation: https://evil.test\r\n\r\n{}",
    "HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nLocation: https://evil.test\r\n\r\n{}",
    "HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\nHTTP/2.0 200 OK\r\n\r\n{}",
    '{"no":"headers"}',
  ])
    await withFakeGh(
      `process.stdout.write(${JSON.stringify(output)});`,
      async (ghExecutable) => {
        const result = await new GitHubGhReadOnlyAdapter({
          ghExecutable,
          env: {},
        }).read(
          "test-owner/test-repo",
          { kind: "repository" },
          { taskId: "fixture" },
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, "EVIDENCE_UNAVAILABLE");
      },
    );
});

test("missing gh/auth, HTTP denial, output overflow and timeout produce precise unavailable evidence", async () => {
  const missing = await new GitHubGhReadOnlyAdapter({
    ghExecutable: "/nonexistent-gh",
    env: {},
  }).read(
    "test-owner/test-repo",
    { kind: "repository" },
    { taskId: "fixture" },
  );
  assert.equal(missing.ok, false);
  if (!missing.ok)
    assert.match(missing.reason, /GH_AUTHENTICATION_OR_CLI_UNAVAILABLE/);
  await withFakeGh(
    'process.stderr.write("secret credentials should never be returned");process.exitCode=1;',
    async (ghExecutable) => {
      const result = await new GitHubGhReadOnlyAdapter({
        ghExecutable,
        env: {},
      }).read(
        "test-owner/test-repo",
        { kind: "repository" },
        { taskId: "fixture" },
      );
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.equal(result.reason.includes("secret credentials"), false);
    },
  );
  await withFakeGh(
    'process.stdout.write("HTTP/2.0 403 Forbidden\\r\\nContent-Type: application/json\\r\\n\\r\\n{}");process.exitCode=1;',
    async (ghExecutable) => {
      const result = await new GitHubGhReadOnlyAdapter({
        ghExecutable,
        env: {},
      }).read(
        "test-owner/test-repo",
        { kind: "repository" },
        { taskId: "fixture" },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /HTTP_403/);
    },
  );
  await withFakeGh(
    success('{"value":"' + "a".repeat(1000) + '"}'),
    async (ghExecutable) => {
      const result = await new GitHubGhReadOnlyAdapter({
        ghExecutable,
        env: {},
        maxBytes: 100,
      }).read(
        "test-owner/test-repo",
        { kind: "repository" },
        { taskId: "fixture" },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /GH_RESPONSE_EXCEEDS_LIMIT/);
    },
  );
  await withFakeGh("setInterval(()=>{},1000);", async (ghExecutable) => {
    const result = await new GitHubGhReadOnlyAdapter({
      ghExecutable,
      env: {},
      timeoutMs: 30,
    }).read(
      "test-owner/test-repo",
      { kind: "repository" },
      { taskId: "fixture" },
    );
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.match(result.reason, /GH_CLI_(?:TIMED_OUT|CANCELLED)/);
  });
});

test("runtime typed-resource and configuration validation cannot expand the read-only surface", async () => {
  const adapter = new GitHubGhReadOnlyAdapter({
    ghExecutable: "/nonexistent",
    env: {},
  });
  for (const resource of [
    { kind: "delete", number: 1 },
    { kind: "commit", sha: "main" },
    { kind: "branch", branch: "../outside" },
    { kind: "repository", method: "DELETE" },
    { kind: "reviews", number: -1 },
  ]) {
    const result = await adapter.read(
      "test-owner/test-repo",
      resource as GitHubResource,
      { taskId: "fixture" },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "INVALID_GITHUB_RESOURCE");
  }
  assert.throws(
    () => new GitHubGhReadOnlyAdapter({ ghExecutable: "gh" }),
    /GH_EXECUTABLE_MUST_BE_ABSOLUTE/,
  );
  assert.throws(
    () => new GitHubGhReadOnlyAdapter({ timeoutMs: 0 }),
    /GH_INVALID_DEADLINE/,
  );
  assert.throws(
    () => new GitHubGhReadOnlyAdapter({ maxBytes: 0 }),
    /GH_INVALID_BYTE_LIMIT/,
  );
});
