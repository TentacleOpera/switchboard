# Standalone Distribution & First-Class Entry

**Complexity:** 6

## Goal

Make standalone a real front door rather than a fallback. Three things stand between the headless cockpit and a user who does not have VS Code open: it cannot be installed (the npm name belongs to an unrelated third-party package, and the package has no `files` allowlist, so even an authorised `npm pack` would omit the gitignored `dist/` its `bin` points at); it refuses to cooperate with a server that is already running (`cli.ts:206-211` exits 1 rather than attaching, and has no way to hand a second process an authenticated browser session); and the `/switchboard` agent protocol's only answer to "no server" is "go open another editor". This feature closes all three so that typing `/switchboard` — in Antigravity, in a bare terminal, anywhere — produces a working board instead of an instruction to change applications.

> **Superseded:** "B4 publishes the standalone CLI to npm under a claimable name…; the entry plan then makes the CLI attach to an already-running server instead of exiting 1, and inverts the /switchboard skill protocol… Strict order: publish first, then consume the published name."
> **Reason:** accurate for the two-subtask shape, stale after the improve-feature pass split the entry plan. Attach-and-lifecycle is no longer part of "the entry plan", and — the ordering fact this hid — it does **not** depend on B4 at all. The old wording implied a single strict chain where the real graph has two independent roots.
> **Replaced with:** the Goal above, plus the explicit dependency graph in *Dependencies & sequencing*.

## How the Subtasks Achieve This

- **Feature B · B4 — npx Distribution (publish the standalone CLI to npm)**: Makes the cockpit installable at all. Renames the package to an ownable name (`@turnzero/switchboard` recommended; the bare `switchboard` is taken by an unrelated library) while keeping the daily command `switchboard`; authors the `files` allowlist from scratch — it does not exist today, so npm's `.gitignore` fallback simultaneously drops the gitignored `dist/` the `bin` points at *and* packs `src/`, `.switchboard/plans/`, `.switchboard/features/` and 23 MB of `design_system/`; adds a `prepack` hook that cleans `dist/standalone/`, rebuilds, and asserts the bundle is complete and vscode-free; and proves the result with a clean-temp-dir install-and-boot smoke rather than by inspection. It supplies the published *name* that the entry-protocol subtask invokes.

- **Standalone CLI: attach to a running server, and give a detached server a way to die**: Makes a second invocation cooperative instead of fatal. Replaces the `exit 1` at `cli.ts:206-211` with an attach path that reports the port and opens an authenticated board; solves the credential problem that makes attach useless today (the one-time token is single-use and the auth token is in-memory only) by writing the existing token to a `0600` `.switchboard/api-server-token.txt` and gating a new `POST /session/token` on the *existing* `_checkAuth` bearer path — on the extension host the route simply forwards to the already-built `mintBrowserToken()`; and records a PID, adds `switchboard stop`, and traps SIGHUP so a server that outlives its terminal can still be shut down cleanly. That last part is what makes the entry-protocol subtask's detached launch safe rather than reckless.

- **Make standalone the first-class entry point: `/switchboard` launches or attaches instead of demanding an IDE**: Turns the two capabilities above into the agent's default behaviour. Adds `.agents/scripts/switchboard-up.js`, which resolves a launcher (repo build → published CLI → newest install-root bundle that actually contains a `cli.js`, executed in place because the bundle is chunk-split), guards on an existing `.switchboard/` so `/switchboard` never scaffolds a stray one, detaches the child with a launch log, and emits `SWITCHBOARD_PORT` / `SWITCHBOARD_MODE`. Then it inverts §1 of `.agents/workflows/switchboard.md` — the mirror *source*, not the generated `.claude/skills/switchboard/SKILL.md` — so the first action is "bring it up" and the "open the workspace in VS Code" instruction is deleted outright. Adds a version-skew guard so an older CLI warns, and refuses outright on a DB migrated past its known schema.

## Dependencies & sequencing

**Cross-feature dependencies.**
- **B1 (`b1-standalone-bootstrap-wire-design-setup-taskviewer-verbs.md`) — soft, not blocking.** B1 makes the Design/Setup/TaskViewer verbs work in the standalone server; this feature makes that server installable and reachable. Shipping B4 before B1 publishes an honest partial cockpit (Board and Project/memo work; Design and Setup 503 until B1 lands). Prefer B1 first; do not block on it.
- **`extract-standalone-npx-04-npx-distribution.md` (`CODE REVIEWED`) — already landed.** It delivered the `bin` entry, boot sequence, `/health` gate, one-time-token handoff and browser-open. The attach/lifecycle subtask extends that code path; read it before implementing rather than building a second one.
- **`Standalone init` Command (`CREATED`) — no blocker, a rebase.** It also adds a subcommand to `cli.ts:143+`. Whichever of it and the attach subtask lands second rebases.
- **A2b Layer-1 (return contract)** is not required for distribution but improves what a published build can do over HTTP. Independent.

**Shipping order within this feature.** The graph has two independent roots, not one chain:

```
B4 (npx distribution) ──┬──► Entry protocol
Attach & lifecycle ─────┘
```

1. **B4 first.** It settles the package name every other piece quotes, and it owns the `usage()` block (`cli.ts:8-30`) that the attach subtask appends a `stop` line to.
2. **Attach & lifecycle second.** Functionally independent of B4 — it works against the repo-local CLI — but it edits the same `usage()` block, so per the PRD's one-agent-stream-per-file rule it serialises behind B4 rather than running beside it. If B4 stalls on the naming decision, this subtask can ship first; only the `usage()` line format has to be revisited.
3. **Entry protocol last.** Hard dependency on both: it invokes B4's published name, and it *detaches* the launched server, which is only acceptable once `switchboard stop` and the pid file exist. Its skill text also references `switchboard stop` directly.

**Prerequisites and guards.**
- **The naming decision is a human gate on B4** — `@turnzero/switchboard` (recommended) or `switchboard-browser`. Availability was checked 2026-07-22 and must be re-checked at implementation time; two weeks of registry churn already produced one semantically adjacent squat.
- **Claiming the `@turnzero` npm org** must happen before the first scoped publish. Owning the `turnzero` VS Code publisher id does not reserve it.
- **The extension-still-starting bind race is unresolved.** No `.switchboard/` bind lock exists anywhere in `src/`. It is owned by the attach subtask; the entry-protocol subtask must inherit whatever guarantee lands there and must not invent a second mechanism.
- **PRD contract #2 applies throughout.** The extension ships to ~4,000 installs; the attach subtask refactors its live `_browserTokens` mint/consume pair, so that path must stay behaviour-preserving.
- **`npm run mirror:check` is a CI gate** on the entry-protocol subtask: `.claude/skills/switchboard/SKILL.md` is generated from `.agents/workflows/switchboard.md`, and editing the generated file fails the build.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature B · B4 — npx Distribution (publish the standalone CLI to npm)](../plans/b4-npx-distribution-publish.md) — **PLAN REVIEWED** — ID: 9329d926-0999-442c-9b00-47e32f490f11
- [ ] [Standalone CLI: attach to a running server, and give a detached server a way to die](../plans/standalone-cli-attach-and-lifecycle.md) — **PLAN REVIEWED** — ID: 1924d598-f384-496b-a31e-17e00440a42f
<!-- END SUBTASKS -->

