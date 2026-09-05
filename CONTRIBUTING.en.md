# Contributing to Better GitHub Stars Manager

[简体中文](CONTRIBUTING.md)

Use this guide to propose, implement, verify, and submit a focused change. Maintainers own release packaging, store submissions, and version releases.

## Before you start

- Read [AGENTS.md](AGENTS.md) for the repository's data, sync, privacy, and verification rules
- Before changing or debugging Cubby Agent, read the [Cubby Agent technical reference](docs/en/cubby-agent.md)
- Reuse established repository patterns instead of creating a second convention

## Choose the right starting point

Search the existing [GitHub Issues](https://github.com/izumi0uu/better-github-stars-manager/issues) before writing code. This avoids duplicate work.

You can open a Pull Request directly for:

- A focused bug fix
- Regression coverage or test reliability work
- Documentation corrections that match current behavior
- Small maintenance changes that do not change product behavior

Open an Issue and agree on scope before working on:

- A new feature or substantial interaction redesign
- Manifest, permission, or browser compatibility changes
- IndexedDB schema, index, migration, or backfill changes
- GitHub sync, authentication, retention, or data-transfer semantics
- New dependencies, large refactors, or cross-module API changes

Include these details in a bug report:

- Browser, browser version, and extension version or commit
- Minimal reproduction steps with private data removed
- Expected behavior and actual behavior
- Sanitized errors, console output, or screenshots

Never include tokens, API keys, private repository data, or personally identifiable information in an Issue. For a security vulnerability, read the [security policy](SECURITY.md) and use the private reporting option on the repository's [Security page](https://github.com/izumi0uu/better-github-stars-manager/security). If it is unavailable, open only a redacted Issue requesting a private contact route. Do not publish vulnerability details.

## Set up your development environment

Continuous integration uses Node.js 24 and pnpm 10.33.2. Use the same versions to reduce local differences.

1. Fork the repository and clone your fork
2. Create a focused branch from `master`, such as `fix/watch-account-fence`
3. Install dependencies and build the Chrome extension

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm install` configures the repository's commit message hook. The Chrome build writes to `dist/`, which Git ignores.

Verify the build in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the project's `dist/` directory

Use these commands for Firefox-specific work:

```bash
pnpm build:firefox
pnpm lint:firefox
pnpm test:smoke:firefox
```

The Firefox build writes to `dist-firefox/`. Do not edit generated files in `dist/`, `dist-edge/`, `dist-firefox/`, `dist-demo/`, or `artifacts/`.

Use these commands for Microsoft Edge work:

```bash
pnpm build:edge
pnpm check:edge-output
EDGE_EXECUTABLE="/path/to/Microsoft Edge" pnpm test:smoke:edge
```

The Edge target is a build, package, and browser identity only: it ships the same full product as Chrome, including Gist sync, Cubby, AI Providers, and Provider-backed Organize. Its build writes to `dist-edge/`, and `pnpm package:edge` writes `artifacts/edge/`. The real-browser smoke runs the shared full-product scenarios and requires an explicit Microsoft Edge executable that reports an `Edg/<version>` identity; Chrome substitution is never Edge release proof.

Build every maintained output with one command:

```bash
pnpm build:all
```

This writes the production Chrome extension to `dist/`, Firefox to `dist-firefox/`, Edge to `dist-edge/`, and the public demo to `dist-demo/`. It does not create store-upload ZIP files; use the target-specific `package:chrome`, `package:firefox`, or `package:edge` command for those artifacts.

## Debug Cubby Agent

When investigating Cubby Agent diagnostics, Provider events, or recovery behavior, do not modify the release build to expose temporary debug state. Use the repository's development entry points.

Create a reproducible Agent diagnostics build:

```bash
pnpm build:agent-dev-diagnostics
```

The output is `artifacts/agent-diagnostics-dev-dist/`. In `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and load that directory.

For live Provider monitoring, run:

```bash
pnpm dev:agent-diagnostics
```

This command builds `dist/` and then starts the local diagnostics service. Load or reload `dist/` as instructed by the command, and keep the process running while monitoring.

These entry points are development-only. The Agent diagnostics build, local diagnostics service, and development traces are not store packages or release evidence. Release verification must use the production build and release gates.

## Preserve data and browser boundaries

Keep these contracts when changing data models, sync, or manifests:

- IndexedDB in `src/storage/db.ts` is the local source of truth for stars, tags, and tag metadata
- `chrome.storage.local` stores lightweight configuration, UI state, credential material, and backfill state
- GitHub is the source of truth for remote metadata such as `archived`, `fork`, `created_at`, `pushed_at`, and `starred_at`
- Define a safe default for each new `Config` field in `src/types/index.ts`, then normalize it in `src/auth/auth-store.ts`
- Update types, the Dexie schema, and legacy-row handling when changing a persisted entity or index
- Use a capability backfill when existing rows need remote fields; do not trigger a full sync on every extension update
- Change `manifest.config.ts` or the owning build transform; do not edit a generated `manifest.json`
- Never download or execute remote code; treat external responses only as data

Fix behavior at its owning source and migrate every caller. Do not retain aliases or parallel paths for unreleased experiments.

## Protect privacy and test data

Every tracked file and asset must be safe to publish:

- Use synthetic values such as `octocat`, `user@example.com`, and repository-relative paths
- Do not commit real usernames, names, email addresses, local paths, tokens, account data, or private repository details
- Do not commit screenshots from a personal account unless a maintainer explicitly approves the public asset and it contains no private data
- Do not copy Jira, support, chat, or other external work-item text into code, tests, comments, documentation, or assets
- Translate external requirements into generic product behavior and test conditions
- Check images, JSON, logs, and other non-code assets for metadata before submission

## Verify your change

Run the smallest test that owns the changed behavior first. Every code change must run `pnpm typecheck`.

| Change surface | Verification command |
| --- | --- |
| Pure logic, filtering, or sorting | `pnpm test:logic` |
| Query or store integration | `pnpm test:integration` |
| Sync, storage compatibility, migration, or backfill | `pnpm test:regressions` |
| Extension runtime behavior | `pnpm test:runtime` or `pnpm test:smoke` |
| Cubby Agent logic or runtime | `pnpm test:logic`, `pnpm test:runtime:agent-diagnostics`, or `pnpm test:runtime:agent-scenarios` |
| Firefox-specific behavior | `pnpm build:firefox`, `pnpm lint:firefox`, and `pnpm test:smoke:firefox` |
| Microsoft Edge target | `pnpm build:edge`, `pnpm check:edge-output`, and `EDGE_EXECUTABLE="/path/to/Microsoft Edge" pnpm test:smoke:edge` |
| Documentation | Check links, commands, and both languages; code tests are optional |

A bug fix needs a regression test that fails before the fix and passes after it. Sync semantics, storage compatibility, migrations, and backfills require regression coverage.

Verify UI changes in the real extension surface. Include screenshots or recordings created with synthetic data for visual changes. Agent runtime changes cannot treat a development diagnostics build as a release build or skip the real extension runtime boundary.

Before submitting a broad or high-risk change, also run:

```bash
pnpm build
pnpm test
```

Continuous integration (CI) runs `pnpm typecheck`, `pnpm build`, and `pnpm test` for each Pull Request. It also builds the Edge and public Demo targets, checks their output contracts, and runs the credential-free Chrome extension smoke check and the public Demo browser smoke. A separate Edge workflow resolves the runner's Microsoft Edge binary and runs `pnpm test:smoke:edge` against it.

## Use the repository's commit format

Use a Conventional Commit title with at most 72 characters and no trailing period. Supported types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`.

A `docs:` or `chore:` commit can contain only one line. Every other type needs a blank line after its title and the required Lore trailers:

```text
fix(watch): preserve source account during bulk actions

Constraint: Keep each background request within the existing batch limit
Rejected: Retry against the new account | it could mutate the wrong account
Confidence: high
Scope-risk: narrow
Directive: Bind remote mutations to the projection that selected them
Tested: pnpm typecheck; focused Watch regression tests
Not-tested: Authenticated GitHub mutation against a live account
```

Describe the real verification scope in `Tested` and `Not-tested`. The commit hook rejects missing fields and invalid formats.

## Submit a Pull Request

Target `master` and keep each Pull Request focused on one problem. Include these sections in its description:

- **Problem**: what is incorrect or missing
- **Decision**: what changed and why
- **Check**: what you verified and did not verify
- **Risk**: permission, data, compatibility, or release risks
- **Evidence**: relevant tests, screenshots, or recordings

Check your Pull Request before submission:

- [ ] The diff contains no unrelated refactor or formatting work
- [ ] New behavior and bug fixes have suitable behavior tests
- [ ] `pnpm typecheck` and the smallest relevant tests pass
- [ ] English and Chinese docs match any user-visible behavior change
- [ ] You verified visual changes in the real extension surface
- [ ] The diff contains no generated output, credentials, private data, or copied external work-item text
- [ ] The Pull Request lists the tested and untested scope accurately

Maintainers review correctness, privacy boundaries, cross-browser behavior, and maintenance cost. Store releases, version numbers, and publishing credentials are outside a normal Pull Request.

## License

By contributing, you agree to license your contribution under this repository's [MIT License](LICENSE).
