import { spawnSync } from "node:child_process";

/**
 * Test only: probe the namespace and mount features the actual runner needs.
 * A bare user namespace can work while a fresh proc mount is forbidden.
 * The command has no external network and never runs a provider.
 */
const probe = spawnSync(
  "/usr/bin/bwrap",
  [
    "--unshare-all",
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--", "/bin/true",
  ],
  {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  },
);

export const sandboxAvailable = !probe.error && probe.status === 0;
const detail = probe.error
  ? (probe.error as NodeJS.ErrnoException).code ?? probe.error.name
  : probe.stderr.trim().replace(/\s+/g, " ").slice(0, 240) ||
    `exit ${probe.status}, signal ${probe.signal ?? "none"}`;
export const sandboxSkipReason = sandboxAvailable
  ? undefined
  : "Required Bubblewrap namespaces and /proc + /dev mounts unavailable: " + detail;

// CI must execute these tests. An unsupported development environment may
// report explicit skips, but the release verification job must fail instead.
if (!sandboxAvailable && process.env.LONGFORM_REQUIRE_SANDBOX_TESTS === "1")
  throw new Error(sandboxSkipReason);

export const sandboxed = { skip: sandboxSkipReason ?? false };
