<div align="center">

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

`dsh-price-less` is a non-official DeepSeek Harness plugin focused on context economy. It helps reduce token waste by:

- Establishing explicit task boundaries
- Initializing a project frame through user confirmation
- Automatically discriminating task continuation, new tasks, and message classes
- Providing a manual context section entry point
- Keeping all plugin facts replayable and fail-safe

## Current Status

| Area | Status |
|---|---|
| R1 platform layer | Completed |
| R2 discriminator core (P8–P13) | Completed |
| P14a/P14b manual optimize + star UI | Not yet wired |
| R3 shear / R4 compaction | Planned |
| npm/tarball distribution | Not published yet |

> **Important**: automatic discrimination is **off by default**. Enable it explicitly with `discriminator.auto = true`. The `/optimize-prompt` command is registered, but the full manual-optimize flow will only be available after P14b.

## Features

- **Task boundaries**: `/task`, `/task close`, and `/task` status.
- **Project frame**: `/init` proposal → user confirmation → persisted `project_frame` v1.
- **Automatic discrimination**: T0 → L0 → table matching → LLM → fail-lazy chain.
- **Manual section**: `/optimize-prompt` entry point, shared with the future star button.
- **Replayable facts**: all `context-economy/*` events are log-only and `ignorable`.
- **Graceful degradation**: falls back to KV fact mirroring when the harness ignorable channel is unavailable.

## Architecture

![Architecture](docs/architecture.png)

The diagram shows the current implemented architecture with color-coded layers and clearly marks planned modules as dashed.

```text
src/
├─ platform/    # Harness adapter layer, only external touchpoint
├─ core/        # Pure logic, zero harness imports
├─ domains/     # Command face, automatic discriminator, orchestration
├─ config.ts    # Config schema and defaults
├─ settings.ts  # Settings UI wiring
└─ index.ts     # Plugin entry
client/         # Settings card and star-button UI shell
docs/           # Design canon and implementation work orders
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
```

## Configuration

Configuration is currently grouped under `discriminator`.

| Key | Type | Schema default | Description |
|---|---|---|---|
| `discriminator.auto` | boolean | `false` | Master switch for automatic discrimination |
| `discriminator.provider` | string | unset | Auxiliary LLM provider; when set together with `model`, overrides the built-in preset |
| `discriminator.model` | string | unset | Auxiliary LLM model; when set together with `provider`, overrides the built-in preset |

> The schema declares no default for `provider`/`model`. Left empty, auxiliary calls (automatic discrimination, `/init`) fall back to the built-in preset `deepseek-official` / `deepseek-v4-flash-vision-exp`; setting **both** values overrides it. Enabling `discriminator.auto` or using `/init` may invoke an auxiliary LLM. This can incur API costs and may send relevant prompt content to the configured model provider.

## Commands

| Command | Purpose |
|---|---|
| `/task <description>` | Explicitly open a new task |
| `/task close` | Explicitly close the current task |
| `/task` | Show current task status |
| `/init <goal>` | Start a project frame initialization proposal |
| `/init confirm` | Confirm and persist `project_frame` v1 |
| `/init cancel` | Cancel the current proposal |
| `/init` | Show current project frame |
| `/optimize-prompt` | Manual context section entry; full flow pending P14b |

## Session Events

All currently emitted custom events are log-only and carry `ignorable: true`.

| Event | Meaning |
|---|---|
| `context-economy/task-boundary` | Task boundary fact |
| `context-economy/judge-recorded` | Automatic discrimination record |
| `context-economy/judge-error` | Discrimination failure record |
| `context-economy/judge-verdict` | New task verdict |

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
- [09 · State](docs/09-state.md)
- [10 · Wiring](docs/10-wiring.md)
- [11 · Structure](docs/11-structure.md)
- [12 · Platform capabilities](docs/12-platform-capabilities.md)
- [13 · Harness plugin spec](docs/13-harness-plugin-spec.md)
- [Implementation master plan](docs/implement/00-master.md)

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| R1 | Platform: events, storage, skills, LLM, history, tools | Completed |
| R2 | Discriminator: task boundaries, project frame, auto/manual sections | P8–P13 done; P14 pending |
| R3 | Shear domain | Planned |
| R4 | Compaction domain | Planned |

See [docs/implement/00-master.md](docs/implement/00-master.md) for detailed work orders.

## Known Limitations

- **Not published**: the package is still marked `private` and there is no official npm/tarball release.
- **Automatic mode is opt-in**: `discriminator.auto` defaults to `false` to avoid unexpected auxiliary LLM costs.
- **Manual optimize is incomplete**: `/optimize-prompt` is only an entry point; the full star-button flow depends on P14b.
- **R3/R4 not implemented**: shear and compaction domains are designed but not yet available.
- **Local checkout required**: building currently requires a local DeepSeek Harness source checkout and `dev_inject_plugin`.
- **Ignorable-channel dependency**: if the host harness does not include the local ignorable channel, plugin facts are mirrored to KV instead of being written as session events. Replay and observability may be reduced until the upstream channel is merged.
- **LLM calls**: enabling automatic discrimination or using `/init` may send content to the configured auxiliary LLM provider and incur costs.
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
