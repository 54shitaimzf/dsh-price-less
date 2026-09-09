<div align="center">

<img src="docs/icons/whale-ring.png" alt="dsh-price-less — the DeepSeek whale behind a context token ring" width="120" />

# dsh-price-less

**Context management plugin for DeepSeek Harness**

> **Priceless thoughts. Price-less costs.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-development-yellow.svg)]()
[![DSH](https://img.shields.io/badge/DSH-plugin--bundle-blue.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)]()

[English](./README.md) · [中文](./README.zh-CN.md)

</div>

---

## Table of Contents

- [About The Project](#about-the-project)
- [Current Status](#current-status)
- [Features](#features)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Source Installation](#source-installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Commands](#commands)
- [Session Events](#session-events)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## About The Project

Long AI-coding sessions get expensive — and drift. `dsh-price-less` is an unofficial **context steward** for DeepSeek Harness: it tracks what you are working on, keeps the context sent to the model lean, and never touches anything it isn't sure about — so every token you send earns its place.

- **Explicit tasks**: `/task` marks what you are working on; opening and closing tasks is always your call
- **Project brief (project frame)**: `/init` asks a few questions and persists a project brief, so the model always knows what this project is
- **Intent detection**: decides whether each message continues the current task or starts a new one — keyword rules first, a light auxiliary model only when unsure
- **Star button / prompt optimizer**: one click folds the current intent into a deterministic execution package, previewed and confirmed by you
- **Tool shear**: slims tool output at write time, drops reads superseded by a later write, and flushes finished question/verification runs
- **Compaction**: folds closed tasks into a versioned archive with a hot tail, a 35%-of-window pressure path, and an overflow fuse
- **Log-only & replayable**: every plugin action leaves a replayable fact log; on any failure it changes nothing — your content is never lost

## Current Status

| Area | Status |
|---|---|
| R1 platform foundation (events, storage, skills, LLM, history, tools) | Completed |
| R2 detection & optimizer core (P8–P14d: task boundaries, project frame, intent detection, prompt optimizer, star button) | Completed |
| R3 shear (write-time shaping, T0/T0-R, run flush) | Completed |
| R4 compaction (boundary assembler, hot tail, pressure path, fuse, restore) | Completed |
| New-build activation | Requires a DSH restart to load the rebuilt `lib/` |
| npm/tarball distribution | Not published yet |

> **Important**: automatic intent detection is **off by default** — enable it explicitly with `discriminator.auto = true`. Tool shear (`shear.enabled`) and both compaction paths default to on. All facts are log-only; any failure changes nothing.

## Features

- **Task boundaries**: `/task`, `/task close`, `/task` — split continuous work into clearly bounded tasks
- **Project brief**: `/init` proposal → your confirmation → persisted as project brief v1 (`project_frame`)
- **Intent detection**: your explicit instruction first, then zero-cost keyword rules, then past verdicts, and only then a light model — anything unresolved stays untouched (fail-lazy)
- **Prompt optimizer + star button**: `/optimize-prompt` and the star button share one section; output = verbatim key facts plus a rewritten execution package, previewed before it is applied
- **Tool shear**: T-entry write-time shaping (process logs only — ≥120 lines and ≥16 KiB; failures, listings and data queries stay verbatim), T0 superseded reads, T0-R declaration-table repair, and run flush for finished question/verification runs
- **Compaction**: task-boundary folding into a versioned archive + hot tail; 35%-of-window pressure path; overflow fuse; restore ordering on session start
- **Workspace isolation**: archive/prefix keys are scoped by the session workspace (`header.cwd`)
- **Replayable facts**: all `context-economy/*` events are log-only and `ignorable`
- **Graceful degradation**: if the harness lacks the ignorable channel, facts fall back to KV mirroring — still recorded, just stored elsewhere

## Architecture

![Architecture](docs/architecture.png)

The diagram shows the implemented architecture with color-coded layers. How to read it in one line: you and the harness sit on top; `domains/` decides what to do, `core/` does the computing, `platform/` does the connecting — the bottom band is what gets recorded.

```text
src/
├─ platform/    # adapter layer — the plugin's only way to touch the harness
├─ core/        # pure logic — computation only, zero harness imports
├─ domains/     # orchestration — commands, intent detection, wiring
├─ config.ts    # config schema and defaults
├─ settings.ts  # settings UI wiring
└─ index.ts     # plugin entry
client/         # settings card and star-button UI
docs/           # design canon and work orders
```

## Getting Started

### Prerequisites

- Node.js with ESM support (Node 20+ recommended)
- A local DeepSeek Harness source checkout for building
- `dsh` CLI or `dev_inject_plugin` for loading the plugin

### Source Installation

This is currently a **source-build / developer installation**. There is no published npm package or tarball distribution yet.

```bash
# 1. Install dependencies
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --no-package-lock

# 2. Build from source (requires a local DSH checkout)
DSH_CHECKOUT=/path/to/deepseek-harness npm run build

# 3. Inject into a DSH instance
dev_inject_plugin /path/to/dsh-price-less
```

Planned distribution forms (not available yet):

- npm: `dsh plugin add dsh-price-less`
- tarball: `dsh plugin add ./dsh-price-less-0.0.1.tgz`

## Usage

```text
/init I am building a context management plugin
/init confirm

/task Design the command face
/task
/task close

/optimize-prompt
```

## Configuration

Configuration is grouped under `shear`, `compression` and `discriminator`.

| Key | Type | Schema default | Description |
|---|---|---|---|
| `shear.enabled` | boolean | `true` | Tool-shear master switch |
| `compression.boundary` | boolean | `true` | Task-boundary compaction |
| `compression.pressure` | boolean | `true` | Pressure-path compaction |
| `compression.pressureRatio` | number | `0.35` | Pressure valve = ratio × main-model context window |
| `compression.domainTokens` | number | `125000` | Assumed window when the main model declares none |
| `compression.retainTokens` | number | `10000` | Hot-tail budget |
| `compression.thresholdTokens` | number | `100000` | Absolute safety net |
| `compression.archiveCapTokens` | number | `10000` | Archive hard cap (digest only) |
| `discriminator.auto` | boolean | `false` | Automatic intent-detection master switch |
| `discriminator.provider` / `model` | string | unset | Auxiliary LLM route; set both to override, empty = follow the session model |
| `discriminator.reasoningEffort` | string | unset | Auxiliary reasoning effort; unset = follow the model default |

> The schema declares no default for `provider`/`model`. Left empty, auxiliary calls (intent detection, `/init`, star section, boundary compression) first **follow the current session model** (provider/model of the latest request), falling back to the built-in default `deepseek-official` / `deepseek-v4.1-flash-expires-on-0910` when the session has no request yet; setting **both** values overrides it. Enabling `discriminator.auto` or using `/init`, the star button, or boundary compression may invoke the auxiliary LLM. This can incur API costs and may send relevant prompt content to the configured provider.

## Commands

| Command | Purpose |
|---|---|
| `/task <description>` | Explicitly open a new task |
| `/task close` | Close the current task |
| `/task` | Show current task status |
| `/init <goal>` | Start a project brief proposal |
| `/init confirm` | Confirm and persist the project brief v1 (`project_frame`) |
| `/init cancel` | Cancel the current proposal |
| `/init` | Show the current project brief |
| `/optimize-prompt` | Command-form prompt optimizer entry (the star button is the primary UI) |

## Session Events

All custom events are log-only and carry `ignorable: true`.

| Event | Meaning |
|---|---|
| `context-economy/task-boundary` | Task boundary fact (which task opened / closed) |
| `context-economy/judge-recorded` / `judge-error` / `judge-verdict` | Intent-detection records and verdict |
| `context-economy/optimize-run` | Star-section full account |
| `context-economy/shear-applied` / `shear-decision` / `shear-error` / `shear-run-plan` | Shear actions, decisions, errors, star run plans |
| `context-economy/assemble-run` | Boundary assembly account |
| `context-economy/compress-run` | Compression-call account |
| `context-economy/pressure-fired` / `hard-truncate` | Pressure trigger / overflow fuse |
| `context-economy/restore-step` / `restore-degraded` / `restore-done` | Restore ordering on session start |

## Documentation

The design canon is maintained under [`docs/`](docs/):

- [00 · System overview](docs/00-overview.md)
- [01 · Architecture](docs/01-architecture.md)
- [02 · Discriminator](docs/02-discriminator.md)
- [03 · Shear](docs/03-shear.md)
- [04 · Compactor](docs/04-compactor.md)
- [05 · Constitution](docs/05-constitution.md)
- [06 · Cache](docs/06-cache.md)
- [07 · Metrics](docs/07-metrics.md)
- [08 · Experiment protocol (sealed)](docs/08-experiment.md)
- [09 · State](docs/09-state.md)
- [10 · Wiring](docs/10-wiring.md)
- [11 · Structure](docs/11-structure.md)
- [12 · Platform capabilities](docs/12-platform-capabilities.md)
- [13 · Harness plugin spec](docs/13-harness-plugin-spec.md)
- [legacy · Retired designs](docs/legacy.md)
- [TODO · Pending directions](docs/implement/TODO.md)
- [ledger-history · Snapshot archive](docs/ledger-history.md)

> `docs/implement/archive/` (R1–R4 work orders and retired-feature docs) is **local-only**: it is excluded by `.gitignore`, and the full text remains in git history.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| R1 | Platform foundation: events, storage, skills, LLM, history, tools | Completed |
| R2 | Detection & optimizer: task boundaries, project brief, intent detection, prompt optimizer, star button | Completed |
| R3 | Shear: slim tool results, superseded reads, run flush | Completed |
| R4 | Compaction: boundary assembler, pressure path, fuse, restore | Completed |
| B series | Branch/merge context (checkout/merge) — space for efficiency | Pending validation — [TODO §3](docs/implement/TODO.md) |
| R series | Reasoning-replay stripping | Pending validation — [TODO §3](docs/implement/TODO.md) |

## Known Limitations

- **Not published**: the package is still marked `private` and there is no official npm/tarball release.
- **A rebuilt `lib/` needs a DSH restart**: mechanisms load on the next restart.
- **Intent detection is opt-in**: `discriminator.auto` defaults to `false` to avoid unexpected auxiliary LLM costs.
- **Auxiliary LLM calls may cost money**: enabling intent detection, using `/init`, the star button, or boundary compression can send content to the configured provider.
- **Ignorable-channel dependency**: if the host harness does not include the local ignorable channel, plugin facts are mirrored to KV instead of being written as session events. Replay and observability may be reduced until the upstream channel is merged.
- **Archive docs are local-only**: `docs/implement/archive/` is gitignored; the full text stays in git history.
- **Local checkout required**: building currently requires a local DeepSeek Harness source checkout and `dev_inject_plugin`.
- **Non-affiliation**: this project is not affiliated with DeepSeek.

## Contributing

Contributions are welcome. Before submitting a change, ensure:

```bash
npm run gate
```

passes completely.

When changing documentation, please update both `README.md` and `README.zh-CN.md` together.

## License

Distributed under the [MIT License](LICENSE).

## Acknowledgments

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Cordis](https://github.com/cordijs/cordis)
- Inspired by the context-economy design in `docs/`

> This project is not affiliated with DeepSeek.
