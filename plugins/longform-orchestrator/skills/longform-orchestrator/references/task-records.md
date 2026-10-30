# Writing task records

The schema is the installed project's `src/domain.ts` (`TaskSchema`); read it rather than guessing a field. Never invent source-owned parameters, grants or acceptance evidence.

## Checklist before `register`

- **One deliverable per task**, with explicit `dependencies`, `acceptance` (each criterion with its `evidenceKind`), `writePaths` and `operations`.
- **Specification source.** When the user's own request is the specification, use the `ownerSource` that `orchestrate` returned, suffixed `-<taskId>`; otherwise an authenticated connector source.
- **Providers.** Under `ASTRA_TWO_TIER`, list both `codex` and `claude`: Codex works and Claude reviews, so a task naming only one cannot be routed.
- **Risk.** State `risk` (`LOW`, `MEDIUM` or `HIGH`) from what breaks if the work is wrong; a real task without it is refused.
- **Review.** Code changes and work touching protected documents, source law, production or owner decisions (and an `expert` work type) need `reviewPolicy` with `required`, `crossProvider` and `independentAudits` all true, or registration is refused.
- **Work type.** Name `kind` from the project profile (example profile: `rules`, `writing`, `engineering-design`, `code`, `owner-brief`, `records`). Its worker, advisor and reviewer then get that kind's guidance and the owner's working rules (the profile's sections of AGENTS.md), so the scope carries only the task itself: don't paste standing rules into it.
- **Sources.** For a Drive task, list the records the work relies on in `drive.pack` (up to 64 distinct file IDs inside `drive.read`): the host reads them before the worker starts, they count as read in that run at that version, and the reviewer sees the same bytes. Claude reviewers and advisors can read Drive within `drive.read` too (Codex ones see the pack and the worker's Drive record), so name records by ID rather than pasting their content.
- **Checks.** Where a mistake can be found mechanically, add `checks` (paths inside `writePaths`): `FILES_PRESENT`, `WORDS_ABSENT` (process codes in owner-facing text), `CITED_DRIVE_IDS_READ` (every cited Drive file was read by a run of this specification), `DRIVE_CREATES_AT_MOST`. They run before any review; failing work goes straight back to its worker.
- **Code.** Name a configured `repo` and an exact 40-character `commit` so the worker starts from that code, and `requiredTests` from the operator's configured commands. A failing test sends the work back with the test's output before review.
- **Fixes.** A task that fixes another task's failed work names it in `fixes` and stays within its allowed paths, operations and Drive scope.
- **Advice.** Add `advice` (`{"rationale", "sourceRef"}`) only when the user marks the task for it. The advisor advises once before the worker; advice is data, never permission or review, and missing advice never holds a task.
- **Pre-design discovery.** Add `preDesignDiscovery` (`{"policy": "REQUIRED" | "AUTO" | "EXEMPT", "rationale", "sourceRef"}`) only when the user asks for it on a substantial or interconnected design task: Astra then screens the task for the owner's choices before its first worker run, and the worker waits until those are answered. `AUTO` lets the controller decide from the record (design work types, high risk, dependencies, shared resources and changed documents are screened; fixes, `records` and `owner-brief` work are exempt). Leave it out for ordinary tasks; without it nothing changes.
- **Grants.** Record grants only for the operations and paths the user's command covers, with the conversation as `sourceRef`.

## Templates by work type

Each sketch shows what differs by kind; the common fields (`id`, `programme`, `lane`, `title`, `specVersion`, `dimensions`, `sources`, `providers`, `budget`, `artifactRevision`, `createdAt`) follow the schema.

**`rules`** (EXPERT; needs independent review). Scope: the rule or system to design or change and the cited records (authoritative specifications, accepted decisions) in `drive.pack`. Deliverable: numbered rules, each with inputs, outcome and edge cases, and each new or changed rule listed for the owner to decide point by point. Set `decisionRequired` when the owner must choose before acceptance.

**`writing`**. Scope: the scene, chapter or text, the beat it must land, the voice and tone, and the canon records in `drive.pack`. Checks: `WORDS_ABSENT` for terms that must not appear. Keep supported facts separate from new proposals; resolve material questions with the owner.

**`engineering-design`**. Scope: the contract or design, its invariants and the governing records in `drive.pack`. Deliverable: each failure case's outcome and how each rule would be tested. Checks: `CITED_DRIVE_IDS_READ` when the design cites records by ID.

**`code`** (EXPERT; needs independent review). `repo` and `commit`, `writePaths` limited to what changes, `requiredTests`. Take the result with `export-patch`.

**`owner-brief`**. Scope: the decisions to put to the owner and their options records in `drive.pack`. Deliverable: one plain question per decision, 2–4 answers each with what happens, recommendation first. Checks: `WORDS_ABSENT` with the process codes and terms the owner should not have to decode, and `CITED_DRIVE_IDS_READ`.

**`records`** (no proposals). Registers, handoffs and indexes that need judgment about content. When the work is only exact bytes to Drive, register a records task with that Drive scope, record its grants, and file with `drive-file` instead of running a worker. Checks: `FILES_PRESENT`, `DRIVE_CREATES_AT_MOST`.
