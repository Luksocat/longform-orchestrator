// The in-memory Drive from drive.test.ts, for the filing tests.
/**
 * In-memory Drive: files by ID with a version that bumps on every write, and
 * revision IDs for stored (non-native) files. `before` runs ahead of each API
 * call, so a test can land someone else's edit at an exact moment.
 */
export function fakeDrive() {
  const files = new Map<
    string,
    { id: string; name: string; mimeType: string; parents: string[]; version: number; body: string; trashed?: boolean; revisions?: string[] }
  >();
  files.set("folderAAAAAAAAAA", { id: "folderAAAAAAAAAA", name: "RESEARCH", mimeType: "application/vnd.google-apps.folder", parents: ["rootAAAAAAAAAAAA"], version: 1, body: "" });
  files.set("docAAAAAAAAAAAAA", { id: "docAAAAAAAAAAAAA", name: "Packet", mimeType: "application/vnd.google-apps.document", parents: ["folderAAAAAAAAAA"], version: 5, body: "# Packet v1\n" });
  files.set("otherAAAAAAAAAAA", { id: "otherAAAAAAAAAAA", name: "Other", mimeType: "text/markdown", parents: ["elsewhereAAAAAAA"], version: 2, body: "other\n", revisions: ["r1"] });
  files.set("notesAAAAAAAAAAA", { id: "notesAAAAAAAAAAA", name: "Notes.md", mimeType: "text/markdown", parents: ["folderAAAAAAAAAA"], version: 3, body: "notes v1\n", revisions: ["r1", "r2"] });
  const calls: { method: string; url: string }[] = [];
  let next = 0;
  let before: ((method: string, path: string) => void) | undefined;
  const meta = (f: any) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, version: String(f.version), trashed: !!f.trashed, ...(f.revisions ? { headRevisionId: f.revisions.at(-1) } : {}) });
  /** Someone else's edit, as Drive would record it. */
  const edit = (id: string, body: string) => {
    const f = files.get(id)!;
    f.body = body;
    f.version++;
    f.revisions?.push("r" + (f.revisions.length + 1));
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const fetcher = async (raw: string, init: RequestInit) => {
    const url = new URL(raw);
    const method = init.method ?? "GET";
    calls.push({ method, url: url.pathname + url.search });
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "ya29.test" });
    const upload = url.pathname.startsWith("/upload");
    const path = url.pathname.replace(/^\/upload/, "").replace("/drive/v3", "");
    before?.(method, path + (url.searchParams.get("alt") === "media" ? "?media" : ""));
    const revisions = /^\/files\/([^/]+)\/revisions$/.exec(path);
    if (method === "GET" && revisions)
      return json({ revisions: (files.get(revisions[1]!)!.revisions ?? []).map((id) => ({ id })) });
    const m = /^\/files\/([^/]+)(\/export)?$/.exec(path);
    if (method === "GET" && m) {
      const f = files.get(m[1]!);
      if (!f) return new Response("{}", { status: 404 });
      if (m[2] || url.searchParams.get("alt") === "media") return new Response(f.body, { status: 200, headers: { "content-type": "text/plain" } });
      return json(meta(f));
    }
    if (method === "GET" && path === "/files") {
      const folder = /'([^']+)' in parents/.exec(url.searchParams.get("q") ?? "")?.[1];
      return json({ files: [...files.values()].filter((f) => f.parents.includes(folder!)).map(meta) });
    }
    if (method === "PATCH" && upload && m) {
      edit(m[1]!, Buffer.from(init.body as Uint8Array).toString("utf8"));
      return json(meta(files.get(m[1]!)));
    }
    if (method === "POST" && upload && path === "/files") {
      const text = Buffer.from(init.body as Uint8Array).toString("utf8");
      const metadata = JSON.parse(/\r\n\r\n(\{.*\})\r\n/.exec(text)![1]!);
      const id = "newfile" + String(++next).padStart(9, "A");
      files.set(id, { id, name: metadata.name, mimeType: metadata.mimeType ?? "text/markdown", parents: metadata.parents, version: 1, body: text.split("\r\n\r\n")[2]!.split("\r\n--")[0]! });
      return json(meta(files.get(id)));
    }
    return new Response("unexpected", { status: 400 });
  };
  return {
    files,
    calls,
    fetcher,
    edit,
    /** Run `hook` ahead of every later API call. */
    before: (hook: typeof before) => {
      before = hook;
    },
  };
}
