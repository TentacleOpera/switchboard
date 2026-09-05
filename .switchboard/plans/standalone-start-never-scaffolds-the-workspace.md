# A standalone-only install is never scaffolded, and the in-browser Setup button that would fix it is a no-op

## Goal

Make `npx switchboard` self-sufficient for a user who never opens the VS Code extension and never types
`init`: the workspace the server is asked to serve gets the same protocol layout the extension creates on
activation, and the Setup panel's "Run Setup" control in the browser actually scaffolds instead of
silently reporting success.

### Problem analysis (verified against HEAD 58c0030)

Three independent mechanisms, each sufficient on its own to leave a standalone user with a board that
renders and an orchestration contract that is entirely absent.

**1. The server-start path scaffolds nothing beyond one `mkdir`.**

`main()` creates a bare `.switchboard/` for every cwd-targeting subcommand (`cli.ts:384-389`) and that is
all. The server-start fall-through begins at `cli.ts:954` and runs straight into `findRunningInstance` →
`startHeadlessSwitchboard`. It never calls `ControlPlaneMigrationService.bootstrapControlPlaneLayout` —
the CLI's only caller is the `init` handler at `cli.ts:593` — and never calls `ensureWorkspaceIdentity`
(also `init`-only, `cli.ts:593-606`). So a fresh directory served by a bare `npx switchboard` ends up with
`.switchboard/` holding `kanban.db`, `logs/`, and the port/pid files, and nothing else.

Everything `init` produces and start does not (`ControlPlaneMigrationService._bootstrapControlPlaneLayout`,
`:677` onward):

- `.agents/` — the bundled personas, protocols, rules, scripts, skills and workflows
- `.switchboard/plans/`, `.switchboard/inbox/`, `.switchboard/archive/` (`:686`)
- `worktrees/` (`:686`)
- `AGENTS.md` (`:713`)
- the `CLAUDE.md` managed block (`:731`) and the `.claude/` skills mirror (`generateClaudeMirror`, `:743`)
- `.switchboard/.agent_version.json` — the stamp that gates every future refresh
- the `workspace_id` config row (`ensureWorkspaceIdentity`)

`.switchboard/plans/` is created lazily, but only by the create-a-plan path
(`bootstrap.ts:812-813`). A user who never authors a plan through the board never gets the directory the
plan watcher exists to watch, so "drop a `.md` in the plans folder and it imports itself" — the documented
way plans reach the board — has no folder to drop into.

**2. The in-browser Setup button cannot scaffold, and says nothing about it.**

The Setup panel *is* wired for standalone: `bootstrap.ts:2676-2677` exposes `setupVerb` →
`SetupPanelProvider.handleServiceVerb`, and `handleServiceVerb` (`SetupPanelProvider.ts:62`) validates the
verb and then dispatches into the same `_handleMessage` switch the VS Code webview uses. The `runSetup`
arm (`SetupPanelProvider.ts:651-652`) does exactly one thing:

```ts
case 'runSetup':
    await this._seams().commands.executeCommand('switchboard.setup');
```

`switchboard.setup` is registered only by the extension's activation. The standalone registry
(`bootstrap.ts:1104-1215`) registers fifteen commands — `switchboard.refreshUI`,
`switchboard.triggerAgentFromKanban`, `switchboard.importPlanFromClipboard`, the ticket-push and
attachment arms, `vscode.open`, `revealInExplorer`, `revealFileInOS` — and `switchboard.setup` is not
among them. Lookup is registry-first (`hostSeams.ts:327-336`) and falls through to the shim, which warns
once — `command 'switchboard.setup' is not bridged — the calling arm's side effect did not happen`
(`vscodeShim.ts:394-400`, mirrored at `hostServices.ts:412-421`) — and returns `undefined`. The verb
resolves successfully. So the single in-app recovery a standalone user would reach for reports nothing
and does nothing, which is worse than an error.

**3. There is no upgrade path for protocol content in a standalone-only install.**

`init`'s scaffolding seeds `AGENTS.md` and the `CLAUDE.md` managed block only when the file is absent
(`ControlPlaneMigrationService.ts:713`, `:731`). The extension does more: on every activation it runs a
version- and hash-gated refresh that rewrites the managed blocks in place
(`extension.ts:313-460` → `scaffoldProtocolLayers` at `:4048` → `ensureProtocolFile` at `:3864`). A
standalone-only install therefore freezes its protocol files at whatever the first `init` wrote. `.agents/`
content does refresh when the version gate opens (`_copyDirectoryRecursive` with
`{ overwrite: false, overwriteIfDiffers: true }`), but the managed blocks inside `AGENTS.md` / `CLAUDE.md`
are absence-gated only — a protocol-block change in a later release never reaches a standalone user.

**Confirmed instance, measured 2026-09-05 in the Switchboard repo itself.** This workspace is served by
a standalone host (`dist/standalone/cli.js tailnet`), and its `CLAUDE.md` managed block has never been
refreshed since before the 2026-08-23 cut:

```
CLAUDE.md block   18,407 chars, 174 lines   (markers at :76-250)
expected           527 chars                 (RESIDENT_PROTOCOL_BODY)
excess          17,880 chars of stale content
```

`843bae45` cut that block 14,826 → 611 chars in code. The constant is a `bodyOverride`, and
`buildManagedInner` discards the source entirely when one is supplied (`bodyOverride ?? sourceContent`),
so the correct emission is 527 characters. This install carries 35× that, re-presented to every agent on
every turn.

Two things this instance settles:

- **Running the scaffold is not a workaround.** Both writes are gated on `!fs.existsSync`
  (`ControlPlaneMigrationService.ts:713`, `:731`), so with the file present there is nothing to run. An
  operator asking "why do I have to keep scaffolding" is describing a fix that cannot work.
- **`AGENTS.md` is not affected and must not be "fixed".** It is `copyFile`d whole into target
  workspaces; the constant never applies to it. Its 21,311 bytes are by design, and shrinking it would be
  a different change with different consequences.

**Why this is the whole difference between "the board loads" and "Switchboard works."** Nothing errors.
The board renders, plans import once the folder exists, cards drag. But dispatch hands an agent a
workspace with no `AGENTS.md`, no `CLAUDE.md` block and no `.agents/` skills — the agent has no
instructions, and the failure surfaces as an agent that does something unhelpful rather than as a missing
file.

### Decision required (a design choice, not a discovered fact)

**Recommendation: scaffold on start, idempotently, with an opt-out.** Run the same three calls `init` runs,
on the server-start path, before `startHeadlessSwitchboard`.

Why this is safe rather than presumptuous: `bootstrapControlPlaneLayout` is already non-destructive
(recursive `mkdir`; the `.agents/` copy is absence-or-differs gated; both managed-block seeds are
file-absence gated), and it already refuses unsafe roots — `isAllowedSwitchboardLocation`
(`ControlPlaneMigrationService.ts:681-685`) blocks `$HOME` and the filesystem root, which is exactly the
"someone ran this in the wrong directory" case.

The two alternatives are worse. Refusing to boot until `init` has been run adds a mandatory step to every
first run and buys no safety the location guard doesn't already provide. Prompting on a TTY cannot work
for `--detach`, which is the headless case this CLI exists for.

Ship `--no-scaffold` for the "I only want to look at the board" case, and print a one-line report of what
was created (nothing, when there was nothing to create).

## Proposed changes

1. **`src/standalone/cli.ts`** — extract the `init` handler's scaffold body (`:588-606`:
   `bootstrapControlPlaneLayout` → `createIfMissing` → `ensureWorkspaceIdentity` → `flushWorkspaceDb`)
   into a shared `ensureWorkspaceScaffolded(workspaceRoot, repoRoot)`. `init` keeps its verbose,
   on-disk-verified report; the start path prints one line and stays silent when nothing was created.
2. **`src/standalone/cli.ts`** — `--no-scaffold` in `parseArgs` (`:85`) and in `usage()`.
3. **`src/standalone/bootstrap.ts`** — register `switchboard.setup` in the standalone command registry
   alongside the existing fifteen (`:1111-1215`), delegating to the same shared scaffold so the browser
   Setup button does what its label says. It must resolve the workspace root the way the neighbouring
   handlers do rather than closing over the boot-time root, because the board can be scoped to a mapped
   child workspace.
4. **Protocol refresh on upgrade** — bring the extension's version/hash-gated managed-block refresh to the
   standalone start path. This is the one step with real blast radius (it rewrites a file the user may
   have hand-edited), so it lands separately and behind the same gate the extension uses, never on every
   boot.

## Verification plan

1. **Fresh directory.** Temp dir, no git, no `.switchboard/`. Run the built CLI with `--no-open`. Assert on
   disk: `.agents/`, `AGENTS.md`, `CLAUDE.md` carrying the managed markers, `.claude/skills/`,
   `.switchboard/{plans,inbox,archive}`, `worktrees/`, `.switchboard/kanban.db`,
   `.switchboard/.agent_version.json`. Assert the DB has a `workspace_id` config row.
2. **Idempotency.** Add a marker line to `AGENTS.md`, restart, assert the marker survives and no duplicate
   managed block appears.
3. **Refusal.** Run with `--workspace $HOME`. Assert the location guard blocks the scaffold and the result
   is a printed refusal, not a partial tree.
4. **`--no-scaffold`.** Assert only `.switchboard/` + the DB appear, and that a subsequent bare start
   scaffolds the rest.
5. **Browser Setup verb.** With the server running against an unscaffolded root, POST the `runSetup` setup
   verb; assert the tree appears and the response reports it. Today this returns success having done
   nothing but log `not bridged`.
6. **Regression.** `npx switchboard init` in a fresh directory still produces its existing report (the
   smoke from the init-scaffolding work).

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
- **Complexity:** 6
