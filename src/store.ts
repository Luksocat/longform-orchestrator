import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, digest, Task, TaskSchema } from "./domain.js";

/**
 * Whether SQLite refused an operation because another connection holds the
 * database (SQLITE_BUSY or SQLITE_LOCKED, extended codes included): another
 * session writing, which passes with time. Nothing was written.
 */
export function databaseBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number")
    return (code & 0xff) === 5 || (code & 0xff) === 6;
  return /\bdatabase (?:table )?is locked\b|\bSQLITE_BUSY\b/.test(
    String((error as Error | null)?.message ?? error),
  );
}

// Deliberately small persistence boundary. A future PostgreSQL adapter implements
// the same methods; controller transactions never depend on SDK sessions.
export interface Persistence {
  transaction<T>(fn: () => T): T;
  /** Read-only lock state, for moving historical file work outside writes. */
  inWriteTransaction?(): boolean;
  /**
   * Run fn against the store and always undo what it wrote, inside an
   * enclosing transaction too (a savepoint), returning fn's result.
   */
  rollbackOnly<T>(fn: () => T): T;
  run(
    sql: string,
    ...params: any[]
  ): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = any>(sql: string, ...params: any[]): T | undefined;
  all<T = any>(sql: string, ...params: any[]): T[];
  event(kind: string, taskId: string | null, data: unknown): void;
  /**
   * Run fn with every wait for another connection's lock bounded by `ms`
   * (optional; without it fn runs with the store's usual waits).
   */
  waitingAtMost?<T>(ms: number, fn: () => T): T;
  /**
   * Bound every wait for another connection's lock, for all callers, by
   * `ms` until the returned release is called (optional). With several
   * limits the smallest applies.
   */
  limitLockWaits?(ms: number): () => void;
}
export const migrations = [
  {
    version: 1,
    sql: `
    CREATE TABLE tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE evidence(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),body TEXT NOT NULL);
    CREATE TABLE grants(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),spec_digest TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE decisions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),spec_digest TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE decision_revocations(id TEXT PRIMARY KEY,decision_id TEXT UNIQUE NOT NULL REFERENCES decisions(id),body TEXT NOT NULL);
    CREATE TABLE attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),role TEXT NOT NULL,state TEXT NOT NULL,lease_owner TEXT NOT NULL,lease_until INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE UNIQUE INDEX single_active_task ON attempts(task_id) WHERE state IN ('RESERVED','STARTED','UNKNOWN');
    CREATE TABLE receipts(id TEXT PRIMARY KEY,attempt_id TEXT UNIQUE NOT NULL REFERENCES attempts(id),body TEXT NOT NULL);
    CREATE TABLE command_receipts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),body TEXT NOT NULL);
    CREATE TABLE reviews(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),body TEXT NOT NULL);
    CREATE TABLE audits(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,kind TEXT NOT NULL,task_id TEXT,body TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `,
  },
  {
    version: 2,
    sql: [
      "evidence",
      "grants",
      "decisions",
      "decision_revocations",
      "receipts",
      "command_receipts",
      "reviews",
      "audits",
      "events",
    ]
      .map(
        (t) => `
    CREATE TRIGGER immutable_${t}_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    CREATE TRIGGER immutable_${t}_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`,
      )
      .join("\n"),
  },
  {
    version: 3,
    sql: `CREATE TABLE acceptance_bindings(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),evidence_id TEXT NOT NULL REFERENCES evidence(id),body TEXT NOT NULL);
    CREATE TRIGGER immutable_bindings_update BEFORE UPDATE ON acceptance_bindings BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    CREATE TRIGGER immutable_bindings_delete BEFORE DELETE ON acceptance_bindings BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`,
  },
  {
    version: 4,
    sql: `CREATE TABLE execution_observations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),body TEXT NOT NULL);
    CREATE TRIGGER immutable_observations_update BEFORE UPDATE ON execution_observations BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
    CREATE TRIGGER immutable_observations_delete BEFORE DELETE ON execution_observations BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`,
  },
  {
    version: 5,
    sql: `CREATE TABLE grant_revocations(id TEXT PRIMARY KEY,grant_id TEXT UNIQUE NOT NULL REFERENCES grants(id),body TEXT NOT NULL);
      CREATE TRIGGER immutable_grant_revocations_update BEFORE UPDATE ON grant_revocations BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
      CREATE TRIGGER immutable_grant_revocations_delete BEFORE DELETE ON grant_revocations BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`,
  },
  {
    // What each run or filing may write (claims) and each Drive write in
    // flight (intents), one registry for both .
    // Additive: older code ignores the table.
    version: 6,
    sql: `CREATE TABLE resource_claims(id TEXT PRIMARY KEY,kind TEXT NOT NULL,resource TEXT NOT NULL,holder_kind TEXT NOT NULL,holder_id TEXT NOT NULL,task_id TEXT NOT NULL,spec_digest TEXT NOT NULL,state TEXT NOT NULL,lease_until INTEGER,created_at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX resource_claims_unresolved ON resource_claims(resource) WHERE state IN ('RUN','HELD','OPEN','UNCERTAIN');
      CREATE INDEX resource_claims_holder ON resource_claims(holder_kind,holder_id);`,
  },
  {
    // Adaptive pins are queried on ordinary routing paths as well. Keep a
    // negative lookup indexed without changing any historical event bytes.
    version: 7,
    sql: "CREATE INDEX events_kind_task_seq ON events(kind,task_id,seq);",
  },
];

export class SqliteStore implements Persistence {
  private db: DatabaseSync;
  private inTransaction = false;
  inWriteTransaction(): boolean { return this.inTransaction; }
  private savepoints = 0;
  /** How long a statement or BEGIN waits for another connection's lock. */
  private lockWaitMs = 5000;
  /** Limits from limitLockWaits, and the one waitingAtMost sets for its call. */
  private lockLimits: number[] = [];
  private scopedLockWait: number | undefined;
  constructor(readonly path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.withLockRetry(() =>
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      ),
    );
    this.withLockRetry(() =>
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);",
      ),
    );
    for (const m of migrations)
      this.transaction(() => {
        if (
          !this.get(
            "SELECT version FROM schema_migrations WHERE version=?",
            m.version,
          )
        ) {
          this.db.exec(m.sql);
          this.run(
            "INSERT INTO schema_migrations VALUES(?,?)",
            m.version,
            new Date().toISOString(),
          );
        }
      });
  }
  /** WAL initialization may return BUSY without honoring busy_timeout. Retry only
   * idempotent setup or BEGIN, never a transaction callback with side effects. */
  private withLockRetry<T>(operation: () => T): T {
    const started = performance.now();
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let attempt = 0;
    while (true) {
      try {
        return operation();
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (
          (code !== 5 && code !== 6) ||
          performance.now() - started >= this.lockWaitMs
        )
          throw error;
        Atomics.wait(sleeper, 0, 0, Math.min(25, 5 + attempt++));
      }
    }
  }
  /** Apply the smallest lock wait in force: 5 s, or a limit below it. */
  private applyLockWait() {
    const ms = Math.max(
      0,
      Math.floor(
        Math.min(5000, ...this.lockLimits, this.scopedLockWait ?? Infinity),
      ),
    );
    if (ms === this.lockWaitMs) return;
    this.db.exec(`PRAGMA busy_timeout=${ms}`);
    this.lockWaitMs = ms;
  }
  /**
   * Run fn with SQLite's busy timeout and the BEGIN retry bounded by `ms`
   * instead of 5 s, for callers that must not hold up the process while
   * another connection writes (a run's heartbeat, the configured workflow).
   * Everything here is synchronous, so nothing else runs meanwhile.
   */
  waitingAtMost<T>(ms: number, fn: () => T): T {
    const before = this.scopedLockWait;
    this.scopedLockWait = Math.min(ms, before ?? Infinity);
    this.applyLockWait();
    try {
      return fn();
    } finally {
      this.scopedLockWait = before;
      this.applyLockWait();
    }
  }
  /**
   * Bound every lock wait in this store by `ms` until the release is called
   * (each release counts once): while runs are going in this process, no
   * other work here may hold the process up for long .
   */
  limitLockWaits(ms: number): () => void {
    this.lockLimits.push(ms);
    this.applyLockWait();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.lockLimits.splice(this.lockLimits.indexOf(ms), 1);
      this.applyLockWait();
    };
  }
  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }
  get<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.withLockRetry(() => this.db.exec("BEGIN IMMEDIATE"));
    this.inTransaction = true;
    try {
      const result = fn();
      if (result instanceof Promise)
        throw new Error("ASYNC_TRANSACTION_FORBIDDEN");
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  rollbackOnly<T>(fn: () => T): T {
    const settle = (result: T) => {
      if (result instanceof Promise)
        throw new Error("ASYNC_TRANSACTION_FORBIDDEN");
      return result;
    };
    if (this.inTransaction) {
      // Nested transactions are flattened into the outer one, so undo only
      // this part, and leave the outer transaction to commit or roll back.
      const name = "rollback_only_" + ++this.savepoints;
      this.db.exec("SAVEPOINT " + name);
      try {
        return settle(fn());
      } finally {
        this.db.exec("ROLLBACK TO " + name);
        this.db.exec("RELEASE " + name);
      }
    }
    this.withLockRetry(() => this.db.exec("BEGIN IMMEDIATE"));
    this.inTransaction = true;
    try {
      return settle(fn());
    } finally {
      this.db.exec("ROLLBACK");
      this.inTransaction = false;
    }
  }
  event(kind: string, taskId: string | null, data: unknown) {
    this.transaction(() => {
      const prev =
        this.get<{ hash: string }>(
          "SELECT hash FROM events ORDER BY seq DESC LIMIT 1",
        )?.hash ?? "GENESIS";
      const at = new Date().toISOString(),
        body = canonical(data),
        hash = digest({ prev, at, kind, taskId, body });
      this.run(
        "INSERT INTO events(at,kind,task_id,body,previous_hash,hash) VALUES(?,?,?,?,?,?)",
        at,
        kind,
        taskId,
        body,
        prev,
        hash,
      );
    });
  }
  verifyEvents(): boolean {
    let previous = "GENESIS";
    for (const e of this.all("SELECT * FROM events ORDER BY seq")) {
      if (
        e.previous_hash !== previous ||
        e.hash !==
          digest({
            prev: previous,
            at: e.at,
            kind: e.kind,
            taskId: e.task_id,
            body: e.body,
          })
      )
        return false;
      previous = e.hash;
    }
    return true;
  }
  tasks(): Task[] {
    return this.all<{ body: string }>("SELECT body FROM tasks ORDER BY id").map(
      (r) => TaskSchema.parse(JSON.parse(r.body)),
    );
  }
  close() {
    this.db.close();
  }
}
/**
 * A database opened read-only, for commands that must change nothing (issue
 * #12 review E5 V1): no setup and no migration, and any write fails.
 */
export class ReadOnlyStore implements Persistence {
  private readonly db: DatabaseSync;
  private depth = 0;
  constructor(readonly path: string) {
    if (!existsSync(path)) throw new Error("DATABASE_NOT_FOUND: " + path);
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec("PRAGMA busy_timeout=5000;");
  }
  /** One read snapshot for the whole call. */
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN");
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error("ASYNC_TRANSACTION_FORBIDDEN");
      return result;
    } finally {
      this.depth--;
      this.db.exec("COMMIT");
    }
  }
  rollbackOnly<T>(fn: () => T): T {
    return this.transaction(fn);
  }
  run(): never {
    throw new Error("READ_ONLY_DATABASE");
  }
  get<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  event(): never {
    throw new Error("READ_ONLY_DATABASE");
  }
  close() {
    this.db.close();
  }
}
