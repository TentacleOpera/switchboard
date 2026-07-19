# Switchboard

**Run the whole build 0 to 1. Concept to shipped.**

Switchboard combines agent orchestration with real project management. One board runs the whole arc — research → plan → design → code → review — with the coding agents you already pay for dispatched by a card move, in your own repo. VS Code extension, or standalone in the browser.

## Full documentation

**→ https://tentacleopera.github.io/switchboard-site/**

The online docs are the single source of truth: installation, board workflows, agents, integrations, and reference.

---

## What makes it different

- **The build starts before the first line** — research, scoping, and planning come in from whatever tool you used, before any code is written.
- **A project model, not a task list** — related plans group into features, and each project carries its own PRD and rules injected only into its own prompts.
- **The move is the dispatch** — drag a card into Coding and the work goes out, routed to the right agent by complexity, on your machine, in your repo.
- **Works with anything** — a card move either drives your agent directly or puts the fully composed prompt on your clipboard (Copy Prompt). If a tool can take text, it works with Switchboard.

---

## Install

Download the latest packaged extension from the **[Releases page](https://github.com/TentacleOpera/switchboard/releases/latest)**, then install it:

- **VS Code UI:** Extensions panel → `…` menu → **Install from VSIX…** → pick the downloaded `.vsix`.
- **CLI:** `code --install-extension switchboard-<version>.vsix`

No editor? `npx switchboard` runs the same board in your browser.

Full setup steps: **[Installation guide](https://tentacleopera.github.io/switchboard-site/docs/getting-started/installation)**.

---

## Links

- [GitHub Repository](https://github.com/TentacleOpera/switchboard/)
- [Documentation](https://tentacleopera.github.io/switchboard-site/)

---

**MIT License** — fully open source. 100% local-first: no external proxy servers, no telemetry, no tracking.
