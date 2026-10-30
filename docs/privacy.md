# Privacy and operations

Treat the source distribution and an active instance as different things. Source code can be shareable while the instance's tasks, source packs, logs, configuration, and credentials remain private.

## Keep runtime material private

Do not commit or distribute:

- SQLite databases, task workspaces, source packs, and private document exports.
- Provider authentication homes, OAuth client/token files, and environment files.
- Live configuration with personal paths, repository paths, account identifiers, or private source IDs.
- Run logs, test transcripts from real work, provider receipts, audit records, and installation receipts.
- Generated patches or output documents that have not themselves been reviewed for disclosure.

The ignore rules help prevent accidental commits. They are not a secret scanner and do not remove a file already tracked by Git. Inspect the staged files and archive contents before publishing.

Examples should use synthetic tasks and identifiers. Retain technical constants such as loopback addresses, public provider endpoints, and runtime version requirements when they are needed for the software. A blanket deletion of every IP-like string or reference to Node.js would break legitimate functionality without establishing privacy.

## Understand what leaves the machine

Live providers receive task briefs and whatever source material the configured workflow includes. Source packs deliberately make selected documents available to the worker. Restrict them to the material the task needs.

`sanitizedPublicBrief: true` records the operator's classification. The program does not automatically establish that a brief is anonymous or suitable for disclosure. Review inputs, work-kind instructions, owner-rule sections, and project views before sending them to an external provider.

The Drive gateway performs actual reads and, when granted, writes. Local filing through `drive-file` can write to Drive without a model call. “No model invocation” does not mean “no external effect.”

## Keep installations separate

Use a distinct source checkout, database, runtime state directory, integration receipt, and credential setup for this distribution. Do not symlink its private configuration to another application's state.

The runner may persist refreshed Codex credentials back to the configured credential home. Its lock coordination applies to this implementation's credential-lock namespace. Separate applications may not participate in that coordination. A dedicated login home avoids accidental cross-application interference.

Review the integration installer's plan before using `--execute`. It may create host skill/plugin files under the selected home. Installation is optional; building and running the synthetic pilot does not install a skill or connect a provider.

## Share an export deliberately

For a public source release, inspect both tracked contents and the archive you intend to upload. Check file paths as well as text. Avoid including symlinks, unexpected binaries, editor backups, personal configuration, or generated evidence.

A new source export with fresh Git history prevents old commits from arriving in that new repository. It does not erase an already public copy, another person's clone, or information visible on the account that publishes it. If `Luksocat` is used as the public identity, that account association is intentional.

Review new commit author/committer metadata and use the intended public identity and a suitable noreply address. Git timestamps and their timezone offsets are metadata too. The README, repository description, release notes, screenshots, workflow artifacts, and issue attachments deserve the same disclosure review as source files.

Preserve third-party notices and licensing information. Removing attribution is not a privacy technique.

## Backups and recovery

Back up an active instance with its database, associated workspaces, and private records in a consistent state. Those backups can contain source documents, task prompts, and credential-recovery material; restrict access accordingly.

Use the controller's recovery and reconciliation paths for interrupted work. Do not publish a raw database or delete uncertain-state records as a troubleshooting shortcut. When reporting a bug, construct a minimal synthetic reproduction and include only the information needed to understand it.

