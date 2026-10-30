import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexIdentity,
  codexStreamPhases,
  type SessionLogMessage,
} from "../src/live.js";
import { normalizeCliResponse, redact } from "../src/providers.js";

// Shape of a Codex 0.163 session log: assistant
// messages are response items whose payload carries the phase.
function sessionHome(lines: unknown[], extraFile = false) {
  const home = mkdtempSync(join(tmpdir(), "codex-labels-"));
  const dir = join(home, ".codex", "sessions", "2030", "01", "01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rollout-thread-1.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  if (extraFile) writeFileSync(join(dir, "rollout-other.jsonl"), "");
  return home;
}
const started = JSON.stringify({
  type: "thread.started",
  thread_id: "thread-1",
});
const message = (
  phase: string | undefined,
  text: string,
  role = "assistant",
) => ({
  type: "response_item",
  payload: {
    type: "message",
    role,
    ...(phase === undefined ? {} : { phase }),
    content: [{ type: "output_text", text, annotations: [] }],
  },
});
const base = [
  { type: "session_meta", payload: { id: "thread-1" } },
  { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "max" } },
];
const stream = (...texts: string[]) =>
  [
    started,
    ...texts.map((text) =>
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text },
      }),
    ),
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "x" },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
const log = (...pairs: Array<[string | null, string]>): SessionLogMessage[] =>
  pairs.map(([phase, text]) => ({ phase, text }));

test("the runner reads each Codex assistant message and its phase from the session log", () => {
  const home = sessionHome([
    ...base,
    message(undefined, "the task text", "user"),
    { type: "response_item", payload: { type: "reasoning", summary: [] } },
    message("commentary", "Checking.\n"),
    { type: "event_msg", payload: { type: "agent_message", message: "dup" } },
    message("final_answer", "Done."),
  ]);
  try {
    const observed = codexIdentity(started, home);
    assert.equal(observed.ok, true);
    if (!observed.ok) return;
    assert.equal(observed.model, "gpt-6.1-sol");
    assert.deepEqual(
      observed.messages,
      log(["commentary", "Checking.\n"], ["final_answer", "Done."]),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const two = sessionHome([...base, message("final_answer", "Done.")], true);
  try {
    assert.deepEqual(codexIdentity(started, two), {
      ok: false,
      reason: "CODEX_SESSION_LOG_IDENTITY_AMBIGUOUS",
    });
  } finally {
    rmSync(two, { recursive: true, force: true });
  }
});

test("phases are supplied only when the raw stream matches the session log one for one", () => {
  const good = log(
    ["commentary", "Reading.\n"],
    ["commentary", "Checked.\n"],
    ["final_answer", "Report."],
  );
  assert.deepEqual(
    codexStreamPhases(stream("Reading.\n", "Checked.\n", "Report."), good),
    ["commentary", "commentary", "final_answer"],
  );
  const raw = stream("Reading.\n", "Checked.\n", "Report.");
  for (const session of [
    log(
      ["commentary", "Reading."],
      ["commentary", "Checked.\n"],
      ["final_answer", "Report."],
    ),
    log(
      ["commentary", "Reading.\n"],
      ["commentary", "Checked.\n"],
      ["final_answer", "Other."],
    ),
    log(["commentary", "Checked.\n"], ["final_answer", "Report."]),
    log(
      ["commentary", "Reading.\n"],
      ["commentary", "Extra.\n"],
      ["commentary", "Checked.\n"],
      ["final_answer", "Report."],
    ),
    log(
      ["commentary", "Reading.\n"],
      ["commentary", "Checked.\n"],
      ["commentary", "Report."],
    ),
    log(
      ["commentary", "Reading.\n"],
      ["final_answer", "Checked.\n"],
      ["final_answer", "Report."],
    ),
    log(
      ["final_answer", "Reading.\n"],
      ["commentary", "Checked.\n"],
      ["commentary", "Report."],
    ),
    log(
      [null, "Reading.\n"],
      ["commentary", "Checked.\n"],
      ["final_answer", "Report."],
    ),
    log(),
  ])
    assert.equal(codexStreamPhases(raw, session), undefined);
  assert.equal(codexStreamPhases(raw + "\nnot json", good), undefined);
});

test("review r1 finding 1: a secret-like pattern in a note can't make matching messages differ", () => {
  const note = "password=example\nChecking the files.\n";
  const raw = stream(note, "Done.");
  const phases = codexStreamPhases(
    raw,
    log(["commentary", note], ["final_answer", "Done."]),
  );
  assert.deepEqual(phases, ["commentary", "final_answer"]);
  // The adapter only ever sees redacted stdout; the labels still line up.
  const redacted = redact(raw, ["example"]);
  assert.notEqual(redacted, raw);
  assert.equal(
    normalizeCliResponse("codex", redacted, { messagePhases: phases }),
    "Done.",
  );
});
