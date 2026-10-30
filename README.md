# Longform Orchestrator

**Durable orchestration for complex work that outlives a single chat.**

Longform Orchestrator wraps Codex and Claude workers in a deterministic controller. It keeps task specifications, dependencies, evidence, reviews, decisions, and recovery state in a local SQLite database. Models produce and challenge the work; the controller determines which steps are allowed and whether their recorded requirements have been met.

Use it for a substantial research report, a connected set of design documents, a long-form writing project, or a sequence of code changes that needs consistent review and a reliable handoff between sessions.

Maintained by **Luksocat**. This is a standalone open-source distribution under the [MIT License](LICENSE). See [licensing](docs/licensing.md) and the preserved [upstream notice](NOTICE.md).

## What it does

| Capability | Why it matters during long work |
| --- | --- |
| Persistent requests and task state | Resume from recorded state instead of reconstructing progress from chat memory. |
| Dependencies and explicit holds | A downstream task cannot rely on a predecessor whose completion evidence is missing or stale. |
| Scoped grants and decisions | Permission to read, write, run checks, and accept work is recorded separately from model output. |
| Complexity and stakes routing | Route roles to explicitly configured models and efforts; raise the review requirements for protected material and consequential changes. |
| Separate authorship and review | Bind a review to the exact specification and artifact it inspected, with provider/session provenance and declared limitations. |
| Checks before review | Catch missing files, forbidden terms, recognized unread Drive citations, excessive file creation, and configured test failures before spending a review run. |
| Review and rework | Return failed work to its worker, evaluate the new revision, and track improvement proposals and owner questions. |
| Project oversight | Group related requests under a project key, preserve checkpoints, and review coherence across task outputs. |
| Optional Google Drive gateway | Read sources, prepare source packs, and perform explicitly scoped content updates or file creation with host-side records. |
| Pinned repository inputs | Seed code work from an exact local Git commit, verify the sealed output, and export a patch for a separate integration step. |
| Built-in driver | Advance requests until they finish or reach a real hold; wait for known provider resets, preserve owner pauses, and report progress beside the database. |
| Adaptive routing | Optionally select independent worker/reviewer pairs from qualified evaluation evidence, pin the selection, and explain holds. |
| Recovery and budgets | Record attempts, deadlines, usage, cancellations, and uncertain outcomes; prevent blind replay when a run's effects are unknown. |
| Synthetic pilot | Learn the workflow with mock providers and sample tasks before configuring credentials. |

The implementation and its limits are described in [architecture](docs/architecture.md). The schemas in [domain.ts](src/domain.ts), [routing.ts](src/routing.ts), and [live.ts](src/live.ts) define the accepted records and configuration.

## Current source distribution

This revision refreshes the controller, tests and portable host integration to the current implementation. It includes the built-in driver, provider-limit pauses, write claims, recovery guidance, scoped owner/operator questions, pre-design decision screening, and the opt-in adaptive workflow. See [current workflow and operation](docs/current-workflow.md) and [verification status](docs/RELEASE_REVIEW.md).

This is a public, MIT-licensed source distribution. Live providers, credentials and Drive connections must be configured separately. Private runtime data and configuration are excluded.

## Start with the synthetic pilot

Use a Linux environment with a supported Node.js release and working Bubblewrap isolation. The package accepts Node **22.13 or later in the 22.x line**, or **24 and later**; Node 23 is excluded. Dependency installation needs npm registry access or a populated package cache.

From this repository:

```sh
npm ci
npm run check
npm run pilot
node bin/longform-orchestrator --help
```

`npm run check` builds the project and runs its tests. The pilot then exercises mock workers, review, acceptance gates, and recovery using disposable local state. It makes **no real model calls**. Passing these checks does not establish that your provider account, model routes, credentials, or live sandbox are ready.

The pilot creates `.longform/pilot-*` state and a local `evidence/pilot-output.json` report. Those generated records are private working material and are excluded from version control. See [the full quickstart](docs/quickstart.md) for prerequisites, request creation, and the boundary between simulation and live execution.

## How to get good results

**Give the orchestrator one bounded outcome at a time.** A useful task has named inputs, a concrete deliverable, narrow write scope, and acceptance criteria someone can actually check.

For a large report, a workable sequence is:

1. Establish the source set and unresolved questions.
2. Build the argument, outline, and coverage map.
3. Draft independent sections against that approved structure.
4. Review claims, evidence, and contradictions across sections.
5. Produce the integrated report and a handoff that records remaining decisions.

Use dependencies where one task consumes another's result. Use a stable project key for related requests. Keep phases small enough that their evidence and outputs fit the project view. Review the whole deliverable at integration points; individually good sections can still disagree.

A useful starting brief looks like this:

> Prepare a comparative research report from the supplied source set. First produce a source inventory and a proposed outline. Distinguish supported findings, conflicting evidence, and assumptions. Preserve the agreed evaluation criteria. Write only the named deliverables. Run the specified checks, obtain separate review, and record unresolved decisions before moving to the drafting phase.

The [task-design guide](docs/task-design.md) explains how to turn such a brief into registered tasks and how to avoid endless review loops.

## Using it from a host assistant

The optional bundled `$longform-orchestrator` integration provides a conversational entry point for compatible Codex and Claude hosts. It invokes the same controller and uses the same durable records as the CLI. It does not turn conversational replies into permission grants.

Inspect the installation plan before applying it:

```sh
node scripts/install-integrations.mjs
```

Installation is a separate, explicit step. The CLI and pilot work without installing the integration. See [configuration](docs/configuration.md#optional-host-integration) for the install/update boundary and how to keep installations separate.

## Where it fits

**Strong uses:** source-heavy research, connected writing, design review, multi-step engineering, controlled document maintenance, and tasks that need a durable decision trail.

**Poor uses:** a quick one-shot answer, unattended operation with no defined scope, a public multi-tenant service, or a workflow whose correctness depends on models silently inventing missing authority.

This is a local, single-host system. Live execution uses Linux/Bubblewrap and explicit provider configuration. It is not a distributed queue, a hosted service, or a promise of unlimited autonomous execution. A separate reviewer improves the process; it does not guarantee truth.

The controller does not commit, push, open pull requests, merge, deploy, or administer hosted databases. Authorized Drive writes are supported through the gateway. `export-patch` produces a code change for a separately authorized integration process.

## Documentation

| Guide | Read it for |
| --- | --- |
| [Quickstart](docs/quickstart.md) | Build, run the synthetic pilot, and create or inspect a durable request. |
| [Task design](docs/task-design.md) | Phase boundaries, acceptance criteria, evidence, reviews, and long-task handoffs. |
| [Configuration](docs/configuration.md) | Live providers, routing, project profiles, Drive scope, code repositories, and host integration. |
| [Current workflow](docs/current-workflow.md) | Driver, recovery, question handling, screening, and adaptive routing. |
| [Architecture](docs/architecture.md) | Controller boundaries, state, review provenance, recovery, and limits of enforcement. |
| [Privacy and operations](docs/privacy.md) | Credentials, logs, source packs, sharing, and installation isolation. |
| [Contributing](docs/contributing.md) | Focused changes, meaningful verification, and a clean contribution. |
| [Licensing](docs/licensing.md) | Current licensing status and preserved third-party attribution. |

