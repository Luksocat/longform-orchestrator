import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The bridge is plain JavaScript shipped in the plugin; type its one export here.
const { bridgeArguments } = (await import(
  "../plugins/longform-orchestrator/skills/longform-orchestrator/scripts/bridge.mjs" as string
)) as {
  bridgeArguments: (
    args: string[],
    config: { cli: string; databasePath: string },
    host?: string,
  ) => string[];
};
const read = (path: string) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");
// Commands the CLI's switch handles, and those it handles before opening the
// runtime (such as the read-only provider-limits scan).
const cliCommands = new Set(
  [
    ...read("src/cli.ts").matchAll(/^\s*case "([a-z-]+)":/gm),
    ...read("src/cli.ts").matchAll(/if \(command === "([a-z-]+)"\)/g),
  ].map((m) => m[1]!),
);
const config = { cli: "/p/dist/src/cli.js", databasePath: "/p/.longform/state.sqlite" };
const passes = (command: string) => {
  try {
    bridgeArguments([command], config, "claude");
    return true;
  } catch {
    return false;
  }
};

test("every controller command the skill tells the chat agent to run passes the installed bridge", () => {
  // Commands the skill names in code spans, such as `assessment <task-id> ...`.
  const named = new Set(
    [...read("plugins/longform-orchestrator/skills/longform-orchestrator/SKILL.md").matchAll(/`([a-z-]+)[^`]*`/g)]
      .map((m) => m[1]!)
      // `advice` there is the task field, not the operator's advice command.
      .filter((word) => cliCommands.has(word) && word !== "advice"),
  );
  // Commands the request view's next steps name: hyphenated names and
  // `orchestrate --...` are never ordinary words in that text.
  for (const m of read("src/orchestrator.ts").matchAll(/\b([a-z]+-[a-z-]+|orchestrate(?= --))\b/g))
    if (cliCommands.has(m[1]!)) named.add(m[1]!);
  for (const expected of ["orchestrate", "assessment", "budget-extend"])
    assert.ok(named.has(expected), "the scan no longer finds " + expected);
  assert.deepEqual([...named].filter((command) => !passes(command)), []);
});

test("every command the bridge passes is a real controller command", () => {
  const bridge = read("plugins/longform-orchestrator/skills/longform-orchestrator/scripts/bridge.mjs");
  const allowed = [...bridge.match(/const commands = new Set\(\[([\s\S]*?)\]\)/)![1]!.matchAll(/"([a-z-]+)"/g)]
    .map((m) => m[1]!);
  assert.ok(allowed.length > 10);
  assert.deepEqual(allowed.filter((command) => !cliCommands.has(command)), []);
  assert.ok(allowed.every(passes));
});
