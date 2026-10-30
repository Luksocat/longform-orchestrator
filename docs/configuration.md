# Configuration

The repository runs in synthetic mode without provider credentials. Live execution is an operator-controlled setup: provider executables, credentials, model routes, repositories, test commands, and any Drive access must be configured deliberately.

Use [the example files](examples/) as schema examples. Replace their placeholders with paths and choices for your own isolated installation. They are not a ready-to-run account configuration.

## Keep the layers distinct

| Layer | Controls |
| --- | --- |
| Live configuration | Runtime paths, provider executables and credentials, allowed hosts, optional Drive credentials, local repositories, and allowed test commands. |
| Routing policy | Exact provider/model/effort routes, roles, tiers, and optional project-oversight workflow. |
| Project profile | Protected documents/folders, important code paths, work kinds, and optional owner-rule sections. |
| Task specification | Outcome, inputs, dependencies, read/write scope, checks, risk, review policy, and budget. |
| Grant and decision records | What the operator has authorized for this exact task specification and artifact. |

Task prose and worker output cannot replace trusted configuration. Importing a task does not create a grant.

## Runtime paths and provider setup

The CLI defaults to `.longform/state.sqlite`. If `live-config.json` exists beside the selected database, the runtime can load it automatically; use `--live-config` to select it explicitly.

`LiveConfigSchema` in [live.ts](../src/live.ts) requires absolute paths for runtime state, configuration files, and executables. A shell variable or `~` inside JSON is not automatically expanded. Use actual absolute paths in your private configuration.

Configure a fresh `stateDir`, separate database directory, and dedicated credential sources. Give Codex its own `codexHome`; give Claude an explicitly selected OAuth-token file. Store those files outside the source tree and restrict their permissions. The runner checks credential-file ownership and permissions during preflight.

Codex token refresh may write updated authentication back to its configured source home. The runner serializes access within its credential-lock scheme. Another application or differently named installation may not share those locks. Do not point this distribution at another application's active login directory.

Provider and Node executables must exist and be usable in the configured sandbox. The actual provider versions, model IDs, and effort settings must work for your account. A model name in an example is not proof of access. Follow the providers' own account and CLI setup procedures; do not place tokens in task text or repository files.

`sanitizedPublicBrief: true` is an operator declaration that the selected material may be sent to the configured providers. It is not an automatic anonymizer, content classifier, or privacy certification. Inspect the task inputs and source packs before making that declaration.

## Routing and capability checks

Routes specify a provider, an explicit model ID, an effort, applicable roles, a tier, and whether they are synthetic. The schema rejects ambiguous aliases such as `latest` or `auto`. Live dispatch also needs a current capability attestation tied to the configured route.

The supplied live route templates are deliberately disabled. Replace `REPLACE_WITH_CODEX_MODEL` and `REPLACE_WITH_CLAUDE_MODEL` with exact model IDs available to your account, choose supported efforts, and enable the routes you intend to use. Configure every role/tier the selected workflow needs; merely enabling one worker route does not supply a reviewer, assessor, or overseer.

Roles include worker, reviewer, assessor, advisor, moderator, and overseer. The normal tier system ranges from routine through expert, with further escalation available after repeated failed reviews. Stakes and risk can raise a task's requirements; an optimistic hint cannot lower them.

The optional `ASTRA_TWO_TIER` workflow uses complex/expert routes and project oversight. Its current schema assigns ordinary live worker and oversight roles to Codex, reviewer roles to Claude, and supports explicitly marked opposite-author legacy pairings. This is an implemented pairing policy, not an arbitrary all-provider graph. Review [routing.ts](../src/routing.ts) when selecting a workflow.

To inspect live readiness, use `doctor` against the intended private configuration. `doctor --live-read` requires explicit `--drive-file-id` and/or `--github-repository` targets; `--github-branch` selects a branch when appropriate. Connector probes are actual read operations, so select only targets you intend to access.

`attest --execute` invokes small real provider calls for enabled routes that need proof. Advancing a live request can also refresh needed attestations. These calls can consume quota or incur charges. A successful synthetic test suite does not replace them.

## Project profiles and work kinds

A profile lets the same engine serve different domains. The example defines `rules`, `writing`, `engineering-design`, `code`, `owner-brief`, and `records`; you can define additional kinds for your own workflow. Each can supply focused worker guidance, reviewer questions, whether review should offer improvement proposals, and whether the work requires expert handling.

Protected documents/folders and code path prefixes raise the stakes of relevant work. The example starts with empty protected-document/folder lists and generic `src`, `scripts`, and `tests` code paths. Add your actual protected resources to private configuration. Keep the lists focused on material whose change has real consequences. When every document is treated as exceptional, the distinction becomes less useful.

Optional `ownerRules` selects numbered sections from a local file. That file is an input to provider briefs. Include only instructions appropriate for the task, and keep personal details or secrets out of those sections. Work-kind guidance adds context; it does not grant access or override controller rules.

## Google Drive

Drive is optional. The host-side gateway accepts configured OAuth application/token files or a selected rclone remote. Task-level Drive scope independently defines:

- `read`: readable file/folder IDs, or deliberately broad `ANY` access.
- `update`: specific files whose content may be replaced.
- `createIn`: specific destination folders for new files.
- `pack`: a bounded list of sources to fetch into the worker's workspace before execution.

Prefer explicit IDs to `ANY`. Declared scope must agree with the task's operations and grants. A source pack is checked against the read scope and recorded with source metadata and content digests. It can contain sensitive material; treat it as private task data.

Reviewers receive read-only access for their role. The gateway records relevant reads and writes on the host, supports before/after evidence, and guards updates against stale content. These records improve traceability; they do not prove a document's claims are correct.

The `drive-file` operator command files exact local bytes through the same scoped gateway without invoking a model. It is still a real external write and needs the task's applicable scope and authorization. Keep that distinction clear when using it after a local review.

## Code work and tests

Configure repositories by a short name and an absolute local path. A task's `repo` field selects that name and a full commit SHA. The controller seeds tracked files from that exact commit into an isolated workspace. It does not use the source repository as the worker's writable checkout.

Allowlist test commands in trusted configuration. A task refers to them by name through `requiredTests`; task text does not supply executable shell commands. Tests run without network on sealed work or on a disposable writable copy, depending on the command configuration. Dependency/tool directories can be mounted read-only where needed.

After verification, `export-patch TASK --out ./change.patch` exports the current sealed change against its pinned input commit. Applying that patch, committing it, pushing it, and publishing a pull request belong to a separate integration workflow.

## Optional host integration

The bundled package is under `plugins/longform-orchestrator/`, with the `$longform-orchestrator` skill beneath it. The bridge records its installation's absolute project/database paths and invokes the compiled controller. It does not allow a host request to silently override that database.

Preview installation from the repository root:

```sh
node scripts/install-integrations.mjs
```

Review the returned target paths and plan. To apply that installation intentionally:

```sh
node scripts/install-integrations.mjs --execute
```

Use `--home /absolute/path/to/disposable-home` to inspect or test a separate home. The installer uses receipts and collision checks and refuses destinations it cannot safely treat as its own. Do not bypass a refusal by deleting another installation's files.

`--claude-only` selects the dedicated Claude integration update path. `--uninstall` plans removal of a receipt-owned installation; applying it also needs `--execute`. Review the exact plan and preserve private runtime state you still need.

