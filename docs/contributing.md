# Contributing

The controller's value lies in preserving a task's meaning and authority across many steps. A contribution should make that behavior easier to trust, inspect, or use.

## Make a focused change

Explain the concrete problem, the resulting behavior, and any schema or compatibility impact. Keep unrelated refactors out of the change. If a public field, operation, path namespace, or CLI option changes, update its callers, tests, examples, and documentation together.

Preserve the distinction between advice, model output, evidence, authorization, review, acceptance, and release. Do not make a workflow succeed by quietly weakening a gate.

## Verify what changed

Use a supported Node.js runtime and a Linux environment that permits the required isolation. Run the relevant tests during development, followed by:

```sh
npm run check
```

For a changed behavior, prefer tests that demonstrate a real failure or invariant: stale evidence is rejected, an unauthorized path fails, an interrupted write does not replay blindly, or a request survives a restart with its meaning intact. Avoid tests that merely repeat the implementation's own calculation.

Use mock providers, disposable homes, synthetic Drive services, and temporary Git repositories. Do not use a real account or live project as a test fixture. Installer tests must target a disposable home. Never run an installer against an existing host configuration merely to prove that it works.

State which checks passed, which were skipped, and why. A build in a restricted environment may be useful evidence while still leaving sandbox behavior unverified. Do not silently convert a failed prerequisite into a passing test.

## Keep contributions safe to share

Check staged paths and content for credentials, personal paths, account data, private document IDs, logs, and generated artifacts. Use fictitious examples. Inspect fixtures carefully: an “example” copied from real work is still real data.

The original implementation is available under the [MIT License](../LICENSE). Preserve that license, the upstream license and the attribution files. See [licensing](licensing.md) for their respective scope.

For a security-sensitive report, avoid including working credentials or private user data in a public issue. Describe the affected boundary and provide a minimal synthetic reproduction through an appropriate channel.

