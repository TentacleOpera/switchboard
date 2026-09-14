# A standalone-only install is never scaffolded, and the in-browser Setup button that would fix it is a no-op

> **RESCOPED 2026-09-12.** The Claude mirror generator is being deleted (*Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets*, PLAN REVIEWED). Consequences for this plan: `npm run mirror:check`, `generateClaudeMirror` and `scripts/check-claude-mirror.js` **will not exist**. The generator's CI step (`.github/workflows/integration-tests.yml:71`, `package.json:967`) is removed in the same commit that adds the **drift test** replacing it, which asserts each `.claude/skills/<name>/SKILL.md` body matches its `.agents/` counterpart modulo the frontmatter block. From then on `.claude/skills/**/SKILL.md` is ordinary committed source: **edit it directly alongside its `.agents/` source, never regenerate it.**

## Goal

Make `npx switchboard` self-sufficient for a user who never opens the VS Code extension and never types
`init`: the workspace the server is asked to serve gets the same protocol layout the extension creates on
activation, and the Setup panel's "Run Setup" control in the browser actually scaffolds instead of
silently reporting success.

### Problem analysis (re-verified against HEAD ead33f59)

> **Superseded:** The server-start path scaffolds nothing beyond one `mkdir`. `main()` creates a bare `.switchboard/` for every cwd-targeting subcommand and that is all. It never calls `ControlPlaneMigrationService.bootstrapControlPlaneLayout` or `ensureWorkspaceIdentity`.
> **Reason:** The start path now does partial scaffolding via a **different mechanism** than `init`. `bootstrap.ts:859-882` calls `seedControlPlaneFromBundle` (seeds control_plane rows in the DB from the bundle) and `projectControlPlane` (projects from DB to filesystem — creates `.agents/`, `.claude/`). `bootstrap.ts:884-899` calls `scaffoldProtocolLayers` (writes/refreshes AGENTS.md/CLAUDE.md managed blocks). `bootstrap.ts:852-857` calls `WorkspaceExcludeService.apply()` (managed gitignore).
> **Replaced with:** The start path NOW scaffolds `.agents/` and `.claude/` (via projection) and writes/refreshes AGENTS.md/CLAUDE.md managed blocks (via `scaffoldProtocolLayers`). But it still does NOT call `bootstrapControlPlaneLayout` (which creates `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/`, `worktrees/`) or `ensureWorkspaceIdentity` (which creates the `workspace_id` config row). It also does NOT create `.agent_version.json`. So a standalone-only install still ends up missing the plans directory the plan watcher needs, the workspace identity, and the version stamp.

Three mechanisms, each sufficient on its own to leave a standalone user with a board that renders and an orchestration contract that is entirely absent:

**1. The server-start path scaffolds the protocol layers but NOT the workspace contract (PARTIALLY FIXED).**

The start path at `bootstrap.ts:859-899` now does:
- `seedControlPlaneFromBundle(bundleDir, db, version)` (:876) — seeds control_plane rows in the DB
- `projectControlPlane(workspaceRoot, db, version)` (:877) — projects `.agents/` and `.claude/` to the filesystem
- `scaffoldProtocolLayers(...)` (:899) — writes/refreshes AGENTS.md/CLAUDE.md managed blocks

What `init` produces and start still does not (`ControlPlaneMigrationService._bootstrapControlPlaneLayout`):

- `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/` — NOT created on the start path
- `worktrees/` — NOT created on the start path
- `.switchboard/.agent_version.json` — NOT created on the start path
- the `workspace_id` config row (`ensureWorkspaceIdentity`) — NOT created on the start path (no `ensureWorkspaceIdentity` call in `bootstrap.ts`)

`.switchboard/plans/` is created lazily, but only by the create-a-plan path
(`bootstrap.ts:812-813`). A user who never authors a plan through the board never gets the directory the
plan watcher exists to watch, so "drop a `.md` in the plans folder and it imports itself" — the documented
way plans reach the board — has no folder to drop into.

**2. The in-browser Setup button cannot scaffold, and says nothing about it (STILL UNFIXED).**

The Setup panel *is* wired for standalone: `bootstrap.ts:4934` exposes `setupVerb` →
`SetupPanelProvider.handleServiceVerb`, and `handleServiceVerb` (`SetupPanelProvider.ts:73`) validates the
verb and then dispatches into the same `_handleMessage` switch the VS Code webview uses. The `runSetup`
arm (`SetupPanelProvider.ts:673-674`) does exactly one thing:

```ts
case 'runSetup':
    await this._seams().commands.executeCommand('switchboard.setup');
```

`switchboard.setup` is registered only by the extension's activation. The standalone registry
(`bootstrap.ts:1799-1824` onward) registers commands — `switchboard.refreshUI` (:1799),
`switchboard.triggerAgentFromKanban` (:1824), and others — and `switchboard.setup` is not
among them. Lookup is registry-first and falls through to the shim, which warns
once — `command 'switchboard.setup' is not bridged — the calling arm's side effect did not happen`
— and returns `undefined`. The verb resolves successfully. So the single in-app recovery a standalone
user would reach for reports nothing and does nothing, which is worse than an error.

**3. There is no upgrade path for protocol content in a standalone-only install (FIXED).**

> **Superseded:** `init`'s scaffolding seeds `AGENTS.md` and the `CLAUDE.md` managed block only when the file is absent. The extension does more: on every activation it runs a version- and hash-gated refresh. A standalone-only install therefore freezes its protocol files at whatever the first `init` wrote.
> **Reason:** `scaffoldProtocolLayers` (called on the start path at `bootstrap.ts:899`) does content-based refresh, not just absence-gated seed. At `protocolScaffolder.ts:246`, it compares the existing managed block content to the current `managedInner` and updates if they differ. So a protocol-block change in a later release DOES reach a standalone user on every boot. The 2026-08-24 cut from 14,826 to ~600 chars now reaches standalone users.
> **Replaced with:** This concern is addressed. `scaffoldProtocolLayers` runs on every start and refreshes the managed blocks by content comparison. No further action needed on this mechanism.

### Approach

Add the missing pieces on start, idempotently, with an opt-out. The start path already does projection
and protocol refresh; add the remaining pieces (plans/inbox/archive dirs, workspace_id,
.agent_version.json) alongside the existing mechanism. `--no-scaffold` for the "I only want to look at the
board" case, and print a one-line report of what was created.

This is trivial: `mkdir -p` five directories, one call to `ensureWorkspaceIdentity`, one `writeFile` for
the version stamp. Do not call `bootstrapControlPlaneLayout` — it would re-run the projection the start
path already does and downgrade the protocol refresh from content-based to absence-gated. Add the missing
pieces inline.

## User Review Required

None.

## Complexity Audit

### Routine

- Creating `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/`, `worktrees/` directories on the start path — `mkdirSync` with `recursive: true`, idempotent.
- Calling `ensureWorkspaceIdentity(workspaceRoot)` on the start path — the function exists and is called by `init` at `cli.ts:3892`.
- Creating `.agent_version.json` on the start path — one `writeFile` of a small JSON object with the version already resolved at `bootstrap.ts:866-872`.
- `--no-scaffold` in `parseArgs` (`cli.ts:166`) and in `usage()` — one argv check, same pattern as `--no-open`.
- Registering `switchboard.setup` in the standalone command registry — the pattern already exists 15 times in the same file (`bootstrap.ts:1799-1824`).

### Complex / Risky

- None. This is directory creation, one function call, one JSON write, one flag, one command registration.

## Edge-Case & Dependency Audit

**Race Conditions:** No race — scaffolding is idempotent (recursive mkdir, absence-gated or content-gated writes).

**Security:** The start path should check `isAllowedSwitchboardLocation` before creating dirs, same as `bootstrapControlPlaneLayout` does. Blocks `$HOME` and filesystem root.

**Side Effects:** Creating `.switchboard/plans/` on every start means the plan watcher has a folder to watch from the first boot. This is the intended behaviour. `ensureWorkspaceIdentity` writes a `workspace_id` config row — if the DB was created by `createIfMissing` without it, this is the first time it gets one.

**Dependencies & Conflicts:** Do not call `bootstrapControlPlaneLayout` — it would re-run the projection the start path already does and downgrade the protocol refresh from content-based to absence-gated. Add the missing pieces inline.

## Dependencies

- **DB creation parity** — `standalone-start-path-db-creation-parity.md` established `createIfMissing` on the start path. This plan adds the workspace contract pieces around it. No hard ordering — both can ship independently.
- **npm publishing** — `b4-npx-distribution-publish.md` must ship `.agents/` and `AGENTS.md` in the tarball, or the scaffold copies from `<packageRoot>/.agents` find nothing (`cli.ts:613-624`, `ControlPlaneMigrationService.ts:694`).

## Adversarial Synthesis

Key risk: calling `bootstrapControlPlaneLayout` would re-run the projection the start path already does and downgrade the protocol refresh from content-based to absence-gated. Mitigation: add the missing pieces inline — dirs, `ensureWorkspaceIdentity`, version stamp — and do not call `bootstrapControlPlaneLayout`.

## Proposed changes

1. **`src/standalone/bootstrap.ts`** — add the missing scaffold pieces alongside the existing projection.
   After `projectControlPlane` (:877), create `.switchboard/plans/`, `.switchboard/inbox/`,
   `.switchboard/archive/`, `worktrees/` via `mkdirSync` (idempotent). Call `ensureWorkspaceIdentity`
   (imported from `WorkspaceIdentityService`) to write the `workspace_id` config row. Create
   `.agent_version.json` with the version stamp. Do NOT call `bootstrapControlPlaneLayout` — the
   projection already handles `.agents/` and `.claude/`, and calling both risks conflict. Print a
   one-line report of what was created (nothing, when there was nothing to create).

2. **`src/standalone/cli.ts`** — `--no-scaffold` in `parseArgs` (:166) and in `usage()`. When set,
   skip the scaffold pieces added in step 1 (plans/inbox/archive dirs, workspace_id, version stamp).
   The projection (`projectControlPlane`) and protocol refresh (`scaffoldProtocolLayers`) still run —
   they are part of the board's normal operation, not optional scaffolding.

3. **`src/standalone/bootstrap.ts`** — register `switchboard.setup` in the standalone command registry
   alongside the existing commands (:1799-1824), delegating to the same scaffold logic the start path
   uses so the browser Setup button does what its label says. It must resolve the workspace root the way
   the neighbouring handlers do rather than closing over the boot-time root, because the board can be
   scoped to a mapped child workspace.

4. **Protocol refresh on upgrade — SHIPPED.** `scaffoldProtocolLayers` at `bootstrap.ts:899` does
   content-based refresh on every start. No further action needed.

## Verification plan

### Automated Tests

1. **Fresh directory.** Temp dir, no git, no `.switchboard/`. Run the built CLI with `--no-open`. Assert on
   disk: `.agents/`, `AGENTS.md`, `CLAUDE.md` carrying the managed markers, `.claude/skills/`,
   `.switchboard/{plans,inbox,archive}`, `worktrees/`, `.switchboard/kanban.db`,
   `.switchboard/.agent_version.json`. Assert the DB has a `workspace_id` config row.
2. **Idempotency.** Add a marker line to `AGENTS.md`, restart, assert the marker survives and no duplicate
   managed block appears.
3. **Refusal.** Run with `--workspace $HOME`. Assert the location guard blocks the scaffold and the result
   is a printed refusal, not a partial tree.
4. **`--no-scaffold`.** Assert only `.switchboard/` + the DB appear (plus the projection, which is not
   gated by `--no-scaffold`), and that a subsequent bare start scaffolds the rest.
5. **Browser Setup verb.** With the server running against an unscaffolded root, POST the `runSetup` setup
   verb; assert the tree appears and the response reports it. Today this returns success having done
   nothing but log `not bridged`.
6. **Regression.** `npx switchboard init` in a fresh directory still produces its existing report (the
   smoke from the init-scaffolding work).

### Goal Invariants

- `.switchboard/plans/` exists after a bare `npx switchboard` in a fresh directory.
- `workspace_id` config row exists in the DB after a bare `npx switchboard` in a fresh directory.
- `switchboard.setup` is registered in the standalone command registry (resolves, does not fall through to the shim).
- `runSetup` verb via the browser scaffolds the workspace (assert `.switchboard/plans/` appears).
- `--no-scaffold` prevents `.switchboard/plans/` creation (assert it is absent).
- `AGENTS.md` managed block is refreshed on boot when the bundled version differs (assert content matches `managedInner` after a boot with a changed bundle).

## Out of scope

- **npm publishing and tarball contents** — already planned in detail in `b4-npx-distribution-publish.md`.
  Note the hard dependency, though: the scaffold copies from `<packageRoot>/.agents` and
  `<packageRoot>/AGENTS.md` (`repoRoot = path.resolve(__dirname, '..', '..')`, `cli.ts:588`), so a tarball
  that omits those two turns this plan's scaffold into a warning and nothing else (`cli.ts:613-624`,
  `ControlPlaneMigrationService.ts:694`). B4 must ship them.
- **The `scaffold` / `control-plane` multi-repo commands** — shipped, and deliberately excluded from the
  cwd `mkdir` (`cli.ts:384-386`). Untouched here.
- **DB creation parity between `init` and start** — a separate, verified divergence; see
  `standalone-start-path-db-creation-parity.md`.

## Metadata
- **Tags:** cli, devops, infrastructure, reliability
- **Complexity:** 4
