import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { claudeLimit, codexLimit, ProviderLimitSchema, type ProviderLimit } from "./limits.js";

/**
 * Earlier receipts that show a provider limit, for the owner to consider
 * , such as the 22–23 October Claude runs, which
 * predate recognition. Read-only. Only harness records count: a receipt's own
 * `providerLimit`, or for a run that did not succeed its output, which then
 * holds the harness's stdout and stderr. A successful receipt's output is the
 * model's normalized response and is never read for a limit.
 */
export function scanProviderLimits(db: {
  all<T = any>(sql: string, ...params: any[]): T[];
}) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const found = [];
  for (const row of db.all<{ receipt: string; attempt: string }>(
    "SELECT r.body AS receipt, a.body AS attempt FROM receipts r JOIN attempts a ON a.id = r.attempt_id ORDER BY a.rowid",
  )) {
    const receipt = JSON.parse(row.receipt),
      attempt = JSON.parse(row.attempt);
    const recorded = ProviderLimitSchema.safeParse(receipt.providerLimit);
    let limit: ProviderLimit | undefined = recorded.success
      ? recorded.data
      : undefined;
    if (!limit && receipt.status !== "SUCCEEDED") {
      const at = Date.parse(receipt.endedAt);
      const output = String(receipt.output ?? "");
      limit =
        receipt.provider === "claude"
          ? output
              .split("\n")
              .map((line) => claudeLimit(line, at))
              .find(Boolean)
          : receipt.provider === "codex"
            ? codexLimit(output, undefined, at, zone)
            : undefined;
    }
    if (!limit) continue;
    let taskStatus: string | null = null;
    try {
      const task = db.all<{ body: string }>(
        "SELECT body FROM tasks WHERE id=?",
        attempt.taskId,
      )[0];
      taskStatus = task ? String(JSON.parse(task.body).status) : null;
    } catch {
      /* a task that cannot be read shows no status */
    }
    found.push({
      runId: attempt.id as string,
      taskId: attempt.taskId as string,
      role: attempt.role as string,
      provider: receipt.provider as string,
      state: attempt.state as string,
      receiptStatus: receipt.status as string,
      endedAt: receipt.endedAt as string,
      kind: limit.kind,
      resetsAt: limit.resetsAt,
      evidence: limit.evidence,
      taskStatus,
      markedInterrupted: attempt.interruption?.cause === "PROVIDER_LIMIT",
    });
  }
  return found;
}

/**
 * Scan an existing database opened read-only: no migration, no settings, no
 * workspace; a missing file is an error, never created.
 */
export function scanProviderLimitsAt(path: string) {
  if (!existsSync(path)) throw new Error("DATABASE_NOT_FOUND: " + path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return scanProviderLimits({
      all: (sql, ...params) => db.prepare(sql).all(...params) as any[],
    });
  } finally {
    db.close();
  }
}
