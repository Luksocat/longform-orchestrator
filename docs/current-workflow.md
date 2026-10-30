# Current workflow and operation

The controller includes the current two-tier workflow and the opt-in `CAPABILITY_BIDIRECTIONAL_V1` workflow. The built-in default remains synthetic. This source copy includes no active installation, private database, credentials, project source packs, or measured live routing evidence.

## Drive a request

After registering bounded tasks, attaching them to a request, and recording the required grants, the built-in driver advances requests owned by the selected host:

```sh
node bin/longform-orchestrator orchestrate --drive --mock --execute
node bin/longform-orchestrator orchestrate --request-id REQUEST --compact
```

Use `--request-id REQUEST` to restrict the driver to one request and `--max-minutes N` to select a budget from 1 to 600 minutes. The default is 50 minutes. `--live` requires independently configured live providers, current capability attestations, and all task gates. The driver writes `driver.log` beside the selected database; `--log-file PATH` chooses another location.

Pause or resume one request using an owner instruction file containing `text` and `sourceRef`:

```sh
node bin/longform-orchestrator orchestrate --request-id REQUEST --pause --file instruction.json --execute
node bin/longform-orchestrator orchestrate --request-id REQUEST --resume --file instruction.json --execute
```

An in-flight run finishes after a request pause; another run for that request does not start. Resume clears the request pause only. It does not clear evidence, authorization, review, provider or unknown-outcome holds.

## Limits, claims and recovery

Harness-reported provider limits create durable pauses. The driver waits for a known reset and performs a bounded recheck. An exhausted retry allowance requires an owner instruction through `retry-extend`. Inspection is available through `provider-pause`, read-only `provider-limits --scan`, and the request's compact view.

The `claims` command shows outstanding resource claims and uncertain Drive write intents. An unknown external effect cannot be safely retried merely because a process ended. Reconciliation requires recorded evidence about process termination, usage and external effects. `reconcile-helper --run-id RUN` drafts an evidence envelope and lists the facts the operator still needs to establish; the draft proves none of those facts.

The driver watches run leases and requests a stop for an expired in-flight run while retaining host ownership until the controller settles it. A busy database gets bounded waits while the lease remains protected. A run whose stop or effects remain unknown stays held for evidence-backed reconciliation.

## Questions and decisions

Questions name their affected task IDs or explicitly apply project-wide. Owner questions cover goals, scope, domain rules, spending and decisions. Operator questions concern facts the controller's records can settle and require cited evidence in the reply. An operator answer cannot replace an owner decision or grant.

A reply whose task specification has changed can be recorded with `historicalOnly: true`; it closes the old question without applying that answer to the revised specification. Revised work still requires current grants and explicit rebinding. Only the owner's explicit instruction can defer a task-scoped information question; decision, scope, access and project-wide questions cannot be deferred that way.

A task can opt into `preDesignDiscovery`. The project overseer screens the task's sources, dependencies and recorded decisions for unresolved owner choices before admitting its first worker. Questions already settled by the owner remain settled. Missing sources and current decisions remain gates.

## Adaptive routing

The [adaptive policy example](examples/adaptive-routing-policy.example.json) documents the accepted route shape and current model identifiers. Its intake is `DISABLED`. It contains no credentials or qualifying evidence and cannot qualify live execution by itself. Configured route names are examples, not a recommendation or an assertion that a provider account has access.

Adaptive selection considers qualified worker/reviewer pairs for the task's class, tier and context. It enforces cross-provider independence and effort floors. A frozen evaluation plan and qualifying evidence determine eligibility and quality ordering; price does not rank candidates. The chosen pair is pinned to the task specification. A changed or unavailable pinned route causes a hold rather than a silent replacement.

Contribution lineage includes prior work, advice, review-loop material, exposed questions, seeded files, and recorded Drive reads and writes. An advisor contributes to authorship. Selection, reservation, launch and retained review validate the applicable lineage.

`AUTO`, `GUIDED` and `PINNED` preferences change selection or how an owner choice is presented. They never waive independence, evidence, attestation or effort requirements. `adaptive scorecard --task TASK` explains current roles, reasons, holds and lineage; `adaptive rollback-check` reports pins and in-flight work relevant to a binary rollback.

Evaluation commands include `adaptive freeze-plan`, `harness-init`, `record-fixture`, `build-bundle`, `import-evidence` and the read-only `adaptive evidence`. Imports without a bound evaluation journal are synthetic and qualify simulation work only. Live evidence must match recorded provider runtime provenance and the frozen plan.

Current limits remain explicit: adaptive oversight supports coordination-only checkpoints. Substantive oversight is held. The evaluation harness does not yet run project-governed or Drive-backed cases, so synthetic checkpoint evidence does not qualify a live overseer. Enabling intake requires suitable measured evidence and separate operator configuration; copying this repository does not activate it.

## Separate installation

Use a fresh database and dedicated provider credential home. Keep private configuration outside version control. The host integration retains the `longform-orchestrator` command, plugin, skill and installation receipt namespace. Preview `node scripts/install-integrations.mjs` before intentionally installing it. Building, testing and running the mock pilot do not install a global integration.

The [CLI help](../src/cli.ts), [configuration guide](configuration.md) and [privacy guide](privacy.md) describe the remaining boundaries. The controller preserves separate authorization, implementation, review, acceptance and release requirements.
