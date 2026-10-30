import type { Persistence, SqliteStore } from "../src/store.js";

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * The real store, refusing outer transactions the way SQLite does while
 * another connection holds the database: before anything is written, and,
 * when `blockPerWaitMs` is set, only after blocking the process for that
 * share of the lock wait in force (5 s by default, less inside
 * `waitingAtMost` or under `limitLockWaits`), as SQLite's busy timeout does.
 */
export class BusyStore implements Persistence {
  private depth = 0;
  private scoped: number | undefined;
  private limits: number[] = [];
  /** Outer transactions still to refuse. */
  refuse = 0;
  /** Refuse every outer transaction until released. */
  held = false;
  /** Milliseconds a refusal blocks per millisecond of lock wait (0: at once). */
  blockPerWaitMs = 0;
  refused = 0;
  /** Outer transactions that went through after the first refusal. */
  throughAfterRefusal = 0;
  constructor(readonly inner: SqliteStore) {}
  transaction<T>(fn: () => T): T {
    if (this.depth === 0 && (this.held || this.refuse > 0)) {
      if (this.refuse > 0) this.refuse--;
      this.refused++;
      if (this.blockPerWaitMs)
        Atomics.wait(sleeper, 0, 0, this.waitMs * this.blockPerWaitMs);
      throw Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
        errstr: "database is locked",
      });
    }
    if (this.depth === 0 && this.refused) this.throughAfterRefusal++;
    this.depth++;
    try {
      return this.inner.transaction(fn);
    } finally {
      this.depth--;
    }
  }
  /** The lock wait in force, as the real store computes it. */
  get waitMs() {
    return Math.min(5000, ...this.limits, this.scoped ?? Infinity);
  }
  waitingAtMost<T>(ms: number, fn: () => T): T {
    const before = this.scoped;
    this.scoped = Math.min(ms, before ?? Infinity);
    try {
      return this.inner.waitingAtMost(ms, fn);
    } finally {
      this.scoped = before;
    }
  }
  limitLockWaits(ms: number): () => void {
    this.limits.push(ms);
    const release = this.inner.limitLockWaits(ms);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.limits.splice(this.limits.indexOf(ms), 1);
      release();
    };
  }
  rollbackOnly<T>(fn: () => T): T {
    return this.inner.rollbackOnly(fn);
  }
  run(sql: string, ...params: any[]) {
    return this.inner.run(sql, ...params);
  }
  get<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.inner.get<T>(sql, ...params);
  }
  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.inner.all<T>(sql, ...params);
  }
  event(kind: string, taskId: string | null, data: unknown) {
    this.inner.event(kind, taskId, data);
  }
}
