# Quickstart

Start with the synthetic workflow. Configure live access only after you understand what a task, scope, review, and hold mean in the controller.

## 1. Prepare an isolated checkout

Extract or clone this distribution into its own directory. Use a separate database and runtime configuration for each installation. Do not reuse state from another orchestrator or copy its authentication files into this tree.

The concrete runner and several tests need Linux, Bubblewrap, and working unprivileged user namespaces, including the ability to mount fresh `/proc` and `/dev` inside the sandbox. On a Debian- or Ubuntu-based development machine, Bubblewrap is normally available through the system package manager. Whether user namespaces are permitted depends on the host's security policy; follow that policy rather than disabling protections indiscriminately.

The accepted Node.js range is recorded in [package.json](../package.json): Node 22.13+ within the 22.x line, or Node 24+. This implementation uses Node's SQLite support and POSIX identity checks. It does not provide an equivalent native Windows or macOS live sandbox.

## 2. Install dependencies and check the build

From the repository root:

```sh
npm ci
npm run check
node bin/longform-orchestrator --help
```

`npm ci` needs access to the pinned packages, either from the npm registry or an existing package cache. Once dependencies are installed, the synthetic pilot does not require a provider account or a model API call. Some tests exercise local networking and OS isolation; an environment that prevents those operations cannot provide a complete verification result.

A development host without those sandbox capabilities reports explicit skipped tests. A release check must run `LONGFORM_REQUIRE_SANDBOX_TESTS=1 npm run check` on a capable Linux host, with zero failures and zero skips. The supplied CI workflow enforces that requirement.

Run the checks from an ordinary shell or from a single assistant host. When one host runs inside another, both sets of host environment variables are present and the CLI deliberately refuses to guess (`HOST_AMBIGUOUS_PASS_--host`), so the CLI-driven tests fail. Start a plain shell, or remove the outer host's variables, before running them.

The binary uses the compiled `dist/src/cli.js`. Run `npm run build` after changing TypeScript source, or use `npm run cli -- ...` while developing.

## 3. Run the pilot

```sh
npm run pilot
```

The pilot demonstrates:

- Importing held example planning records without authorizing them.
- Running two mock workers in separate workspaces.
- Checking produced artifacts and recording a separate synthetic review.
- Rejecting an outdated review and preserving owner decision gates.
- Reopening the database after an uncertain run and refusing a blind retry.

The pilot writes `.longform/pilot-*/state.sqlite`, local workspaces, and `evidence/pilot-output.json`. The report includes its database path, receipts, checks, and explicit simulation status. These are generated working records, not material to commit or publish.

The mock review is fabricated by the test harness on purpose. It shows that the controller enforces the workflow; it is not a judgment by a real reviewer model.

## 4. Explore a planning database

The following imports the bundled synthetic, held planning fixture into a separate database:

```sh
node bin/longform-orchestrator init --db .longform/learning.sqlite --execute
node bin/longform-orchestrator status --db .longform/learning.sqlite
node bin/longform-orchestrator plan --db .longform/learning.sqlite
node bin/longform-orchestrator report --db .longform/learning.sqlite
```

An imported record is not a grant. The example planning tasks remain held until the controller's requirements are satisfied. Importing a fixture or observing a passing mock run does not advance real work.

`--execute` is required by state-changing workflow commands. Omitting it provides a command plan where supported, but the CLI may still open or initialize its SQLite database. Use a disposable database when experimenting; “dry run” is not a promise of zero filesystem activity.

## 5. Create a durable request

This records a request without running a provider:

```sh
node bin/longform-orchestrator orchestrate \
  "Prepare a source inventory and outline for a comparative research report." \
  --db .longform/learning.sqlite \
  --request-key research-outline-001 \
  --project-key research-example \
  --source-ref local:example-request \
  --execute
```

The CLI detects the invoking host. An installed integration supplies its own host identity; do not override it to impersonate another host. Save the returned request ID. Inspect it later with:

```sh
node bin/longform-orchestrator orchestrate \
  --db .longform/learning.sqlite \
  --request-id YOUR_REQUEST_ID
```

A request is a durable brief and journal. It does not automatically become an executable task. Tasks need schema-valid specifications, authenticated source bindings where required, scoped grants, satisfied dependencies, and suitable provider routes. The controller reports the missing requirements instead of inferring permission from the prose.

Use `--prompt-file ./request.txt` for a larger literal UTF-8 brief. The file is read as text, not evaluated by a shell. Do not supply a new prompt when resuming an existing request; inspect the recorded request and use the supported revision/rebinding process.

## 6. Register and attach defined tasks

After preparing task records against [TaskSchema](../src/domain.ts):

```sh
node bin/longform-orchestrator register \
  --db .longform/learning.sqlite --file ./tasks.json --execute

node bin/longform-orchestrator orchestrate \
  --db .longform/learning.sqlite \
  --request-id YOUR_REQUEST_ID --task YOUR_TASK_ID --execute

node bin/longform-orchestrator inspect YOUR_TASK_ID \
  --db .longform/learning.sqlite
```

Registration creates no grants and awards no acceptance. Read the reported blockers. Follow [task design](task-design.md) to define good work, and [configuration](configuration.md) to configure live execution. Do not remove a blocker merely because it prevents progress; resolve the condition it describes.

## 7. Move to live execution deliberately

The live path adds real provider calls, credentials, possible charges, and any Drive writes explicitly granted to the task. It requires a trusted live configuration, exact model routes, working isolation, capability attestation, and executable task authorization.

After that setup, advancing an existing authorized request has this shape:

```sh
node bin/longform-orchestrator orchestrate \
  --db /absolute/path/to/instance/state.sqlite \
  --live-config /absolute/path/to/instance/live-config.json \
  --request-id YOUR_REQUEST_ID \
  --advance --live --execute
```

This is an execution command. Use it only for the request and configuration you intend to run. It may attest routes and invoke paid provider work. Start with a small, disposable live task before entrusting a large project to the setup.

