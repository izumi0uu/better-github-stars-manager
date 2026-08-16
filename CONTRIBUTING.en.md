# Contributing

[中文](CONTRIBUTING.md)

Thanks for improving Better GitHub Stars Manager. Keep changes focused and verifiable, and reuse established repository patterns.

## Before you start

- Read [AGENTS.md](AGENTS.md) for the repository's data, sync, privacy, and verification rules.
- Before changing or debugging Cubby Agent, read the [Cubby Agent technical reference](docs/en/cubby-agent.md).
- Never put real accounts, tokens, API keys, local absolute paths, private repository content, or verbatim external work items in code, tests, logs, screenshots, or documentation. Use synthetic data.

## Install and build

The project uses the pnpm version pinned in `package.json`:

```bash
pnpm install
pnpm build
```

The normal Chrome build is written to `dist/`. Build Firefox with:

```bash
pnpm build:firefox
```

## Debug Cubby Agent

When investigating Cubby Agent diagnostics, Provider events, or recovery behavior, do not modify the release build to expose temporary debug state. Use the repository's development entry points.

Create a reproducible Agent diagnostics build:

```bash
pnpm build:agent-dev-diagnostics
```

The output is `artifacts/agent-diagnostics-dev-dist/`. In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and load that directory.

For live Provider monitoring, run:

```bash
pnpm dev:agent-diagnostics
```

This command builds `dist/` and then starts the local diagnostics service. Load or reload `dist/` as instructed by the command, and keep the process running while monitoring.

These entry points are development-only. `artifacts/agent-diagnostics-dev-dist/`, the local diagnostics service, and development traces are not store packages or release evidence. Release verification must use the production build and release gates.

## Verify changes

Every code change must run:

```bash
pnpm typecheck
```

Then run the smallest test layer that covers the changed behavior. Cubby Agent changes usually start with the relevant commands below:

```bash
pnpm test:logic
pnpm test:runtime:agent-diagnostics
pnpm test:runtime:agent-scenarios
```

See `package.json` for the other Agent runtime commands. Do not skip the real extension runtime boundary or treat a development diagnostics build as a release build.

## Submit a pull request

Describe the observable behavior change, its risk boundary, and the exact commands you ran. Do not commit generated build directories, personal data, or unsanitized diagnostic artifacts.
