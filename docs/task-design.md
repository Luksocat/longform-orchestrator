# Designing long tasks

The most useful unit of work is a bounded, reviewable deliverable. A project can be large; each task should still have a clear stopping point.

## Define the contract before assigning the work

Write down these elements:

| Element | Good definition |
| --- | --- |
| Outcome | “Produce a comparison table and a supported recommendation.” |
| Inputs | An identified source set, with revisions or digests where the workflow requires them. |
| Deliverable | Named files, sections, or changes someone can inspect. |
| Scope | Which topics, paths, or documents may change, and which decisions remain open. |
| Acceptance | Observable properties the output must satisfy. |
| Dependencies | The exact predecessor tasks whose accepted results are required. |
| Review | What a separate reviewer should challenge and what evidence it must see. |
| Budget | A sensible attempt deadline, attempt allowance, and usage caps. |
| Handoff | What the next task needs and what must remain held. |

Avoid a task such as “Improve everything until it is perfect.” It gives neither the worker nor the reviewer a stable target. A better instruction is “Revise the introduction and conclusion against these five findings, preserve the accepted thesis, and report any remaining disagreement.”

The source schema in [domain.ts](../src/domain.ts) is authoritative. Task records distinguish authorization, source effectuation, implementation, review, and release. Keep those dimensions separate: a sound design can still be unimplemented; a passing review can still await acceptance.

## Use phases to preserve context

For a large research or writing project, use a structure like this:

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| Source inventory | Source register, scope, conflicts, and missing information | The working source set and gaps are explicit. |
| Structure | Outline, argument map, and coverage allocation | Each required topic has a planned home. |
| Drafting | Bounded sections or modules | Each output satisfies its own contract and cites its inputs. |
| Cross-document review | Contradiction, omission, terminology, and continuity findings | Material inconsistencies have a defined resolution. |
| Integration | Coherent complete deliverable | The whole output satisfies the project-level goals. |
| Handoff | Final files, evidence summary, open decisions, next action | Another session can continue without guessing. |

For engineering, the same pattern becomes investigation → design → implementation → regression review → integration. For a long narrative, it becomes source/continuity inventory → structure → scene or section drafting → continuity and emotional review → integration.

Create dependencies where outputs must be consumed in order. Parallelize tasks only when they can work from stable inputs and separate write scopes. A project-level review is still necessary after parallel work; local correctness does not prove overall coherence.

Use a stable `projectKey` to associate related requests explicitly. The controller does not infer project membership from similar directory names or prose. The optional project overseer sees a bounded projection of the recorded project, not unlimited memory. Split a phase when its relevant evidence and outputs no longer fit that view.

## Write acceptance criteria that reveal failure

Useful criteria identify an observable defect:

- Every required question has an answer, a qualified uncertainty, or a documented gap.
- Every factual claim in the comparison table points to the source that supports it.
- Terms used in multiple sections have consistent meanings.
- A code change includes a test that fails for the reported defect and passes after the change.
- An output contains exactly the required files and does not change unrelated documents.

“High quality,” “thorough,” and “no mistakes” are goals. They are too vague to serve as the only acceptance criteria.

Use deterministic checks for properties a program can decide. The built-in `checks` types are:

| Check | What it establishes |
| --- | --- |
| `FILES_PRESENT` | Named output files exist, are regular files, and are nonempty. |
| `WORDS_ABSENT` | Specified words or phrases do not occur in selected files. |
| `CITED_DRIVE_IDS_READ` | Recognized Drive citation IDs appear in the host's recorded read history, except explicit exceptions. |
| `DRIVE_CREATES_AT_MOST` | File creation stays within the configured count for the task specification. |

`requiredTests` refers to commands allowlisted by the operator. Their receipts are recorded by the controller. A worker's claim that it ran tests is not a replacement for those receipts.

The citation check establishes recorded access, not that a source supports a claim. It uses the identifier-recognition pattern implemented in [checks.ts](../src/checks.ts); it is not a general citation parser. Semantic support and conflicting evidence still need review.

## Give each role a distinct job

**The worker** produces the deliverable, states assumptions, and identifies missing decisions. It should not manufacture evidence or declare its own output accepted.

**Deterministic checks** inspect the sealed output before model review. Fixing a missing file or failing test first makes the review more useful.

**The reviewer** challenges the exact current artifact and its contract. Ask for concrete counterexamples, unsupported claims, contradictions, and material omissions. Require it to distinguish findings from optional improvements.

**An advisor**, when requested, offers input before execution. Advice does not grant authority or count as an acceptance review.

**The project overseer**, when configured, evaluates the project across tasks and maintains checkpoints. Its technical plan is separate from the owner's decisions and from controller evidence.

**The owner/operator** supplies grants and decisions that the workflow requires. A conversational answer, a worker recommendation, and a recorded decision are different things.

## Keep reviews from becoming an endless loop

Bound the review to the current contract. Classify a finding by its effect on that contract. Keep optional improvements distinct from defects that prevent acceptance.

When a review fails, have the worker address the findings against the same authoritative inputs. Recheck the changed artifact; do not reuse a review of an older revision. If the task itself changes, revise its specification and rebind it to the request explicitly. Existing evidence may no longer be sufficient.

Repeated failure can lead to stronger model routing, but a more capable model cannot repair an undefined objective or missing owner decision. Inspect whether the failure is caused by bad task boundaries, conflicting sources, unavailable access, or an actual reasoning problem before increasing the budget.

## Recover without losing the thread

Keep the database, its associated workspaces, and required private runtime records together. Save the request ID and project key in the handoff. Inspect recorded status when returning in a fresh chat.

If a run ends with an unknown outcome, investigate and reconcile it. Retrying immediately can duplicate an external effect. Use the controller's cancellation and reconciliation paths rather than editing SQLite rows or deleting a lock to force progress.

A useful handoff includes the deliverable locations, current task/request identifiers, accepted decisions, review status, verification performed, limitations, unresolved holds, and the next authorized step. A new session should be able to explain the project's state from those records before it starts new work.

