# Distribution verification

## Public MIT distribution — 2026-10-30

The maintainer authorized public GitHub visibility and selected the MIT License for the original implementation. The root `LICENSE`, package metadata, README, contribution guide and licensing guide now state that grant under the public Luksocat identity. The upstream notice and license are preserved, and runtime data and credentials remain excluded.

This change updates licensing, distribution documentation and source-manifest coverage. It does not change the controller or activate live providers. Current automated checks are recorded against the publication commit in GitHub; the source-refresh results below describe the earlier implementation verification.

## Historical source refresh, before the public MIT distribution

This is a private source refresh of Longform Orchestrator. It preserves the existing public identity, third-party notices, `UNLICENSED` status, synthetic programme and installation namespace. No private project history or runtime configuration is imported.

## Content and privacy scope

The refreshed source includes the current controller, tests and host integration, including adaptive routing and evaluation, provider-limit handling, the built-in driver, resource claims, lease recovery, scoped questions and pre-design screening.

The package excludes operational evidence, historical project design records, private planning snapshots, databases, credentials, authentication homes, source packs, run logs, installation receipts, dependency directories and compiled output. Existing fictional planning and legacy-format fixtures are retained. Examples of connector access require explicit targets; no private document or repository is a built-in probe target.

Names, paths and network values needed by the software remain: Luksocat as the permitted public identity, third-party attribution, provider product/model names, public provider endpoints, loopback addresses, a public DNS isolation probe, synthetic identifiers, and the sandbox's fictional `/home/worker` and `/home/u` paths.

New Git commits use Luksocat with a GitHub noreply address and UTC timestamps. The existing sanitized repository history is retained; the private source repository's commit history is not copied.

## Verification

The following checks were executed for this source tree with Node.js 22.23 and working Bubblewrap isolation:

| Check | Result |
| --- | --- |
| Locked dependency install, `npm ci --ignore-scripts` | Passed; no vulnerabilities reported. |
| Strict build and complete suite, `LONGFORM_REQUIRE_SANDBOX_TESTS=1 npm run check` | **1,007 tests passed; 0 failed, 0 cancelled, 0 skipped.** |
| Synthetic pilot, `npm run pilot` | Passed; event chain valid, 21 fictional planning tasks retained, no live model invocation. |
| CLI help | Passed. |
| Installer dry run against a disposable home | Passed; returned a 20-file plan without installing it. |
| Relative Markdown file links | 58 checked; none broken. |
| Source privacy inspection | No matches for the checked private identifiers or original document IDs; no unexpected binary files or symlinks. |
| Source comparison | Current source test files retained, together with the existing generic-release coverage. Controller structure differs only for the distribution's existing generic reporting, reserved workstream and explicit connector-target handling. |

Earlier test attempts exposed documentation-route assumptions in newly imported mocks and an overloaded concurrency-barrier cancellation. The mocks now use a separate synthetic compatibility policy; assertions and gates were preserved. The final complete check used four logical CPUs to bound scheduling pressure, with the repository's test commands unchanged and both assistant-host markers absent. The concurrent-import regression also passed independently as a targeted check.

The first hosted CI run passed 1,006 tests and failed one route-change regression when its 90 ms lease expired under runner scheduling pressure. That test now advances the clock explicitly while exercising the real heartbeat callbacks, retaining the original lease, cancellation and recorded-reason assertions. The build and all 13 tests in that file pass; a reversal check that removes the route-change guard makes the regression fail. No application behavior or CI check was changed.

GitHub Actions runs the same strict build, tests and pilot for the pull request. Its result is recorded against that commit in GitHub; local results do not establish a hosted CI result.

No real provider execution, provider login, Drive operation, global integration installation, deployment, license change or visibility change is part of this refresh. Self-checking this distribution is not an independent review or a security certification.

## Source-refresh boundaries (historical)

Public visibility, reuse licensing, installation and live provider verification remain separate actions. Existing private visibility and licensing choices are preserved. The refresh branch can be inspected and tested before a separately authorized merge.

`RELEASE_MANIFEST.json` lists the final source payload's file sizes and SHA-256 digests, excluding itself and private generated material.
