# The Browser Host Honours Workspace Mappings

## Goal

Wire the workspace-mapping index into the standalone/browser composition root, so mappings configured in the extension are honoured when the board is served by `npx switchboard` — without exposing every workspace the database happens to remember.

### The problem

`buildMappingIndexFromDbs` (`src/services/WorkspaceIdentityService.ts:45`) has exactly one caller: `src/extension.ts:236`, inside `initializeMappingIndex`. `src/standalone/bootstrap.ts` never calls it. `src/standalone/cli.ts` contains no mapping references at all.

So in the standalone host the mapping index is **never built**. `getMappingsFromIndex()` returns `{ enabled: false, mappings: [] }` for the entire process lifetime, and every mapping-aware branch in every shared service quietly takes its no-mappings path. Workspace mappings are silently inert in the browser: grouping does nothing, and a board served from a group parent shows only that folder.

Nothing reports this. Every gate stays green.

### Root cause

This is the composition-root divergence class documented in `CLAUDE.md`, in its purest form. The failure is not a missing verb — `bootstrap.ts`'s `default:` arm delegates every unmatched verb to the provider, so verb-reachability audits pass. The failure is an **unwired service seam**: a `Promise<void>` initialiser where "never called" and "working correctly" are indistinguishable from the outside. `npm run standalone-parity:check` is scoped to the browser read-back path, not the composition root, so it cannot catch this.

This is the same shape as the 2026-08 `PlanIngestionEngine` precedent: four queue seams wired in `extension.ts` only, leaving standalone with no armed queue watch for a month.

### The trap this plan must avoid

Wiring the index up naively makes the browser **worse**, in two distinct ways.

**Ordering.** Today the browser sidesteps the first-match-wins redirect bug (Plan 1) purely by never building the index. Building it first imports that bug into a host that does not currently have it. Plan 1 must land first — this is not a preference.

**Visibility.** `buildWorkspaceItems()` (`src/services/workspaceUtils.ts:6`) currently takes its else-branch in standalone, emitting exactly the one launch folder. The moment the index exists and names that folder in any mapping, it flips to the mapped branch and emits `parentFolder` from **every** mapping in the payload. Because `SetupPanelProvider.ts:1216-1222` replicates the complete mappings list into every member's database, the browser would list every workspace in the group — including ones the user never opened. The launch folder defines the window; the database's memory does not.

### The rule

Standalone has exactly one root: `getWorkspaceRoots: () => [workspaceRoot]` (`src/standalone/hostServices.ts:446`), the folder `npx switchboard` was launched in. The visibility rule is the same one Plan 2 encodes for the extension:

> A workspace is visible iff it is one of the host's roots, or it is a member of a mapping whose parent is one of the host's roots.

| Launched in | Board shows |
| :--- | :--- |
| a group parent | that parent + its children |
| a member repo | just that repo |

## Metadata

**Tags:** backend, bugfix, infrastructure, reliability
**Complexity:** 5

## User Review Required

This turns mappings on in the browser host for the first time, for every install that has mappings configured. It is a live behaviour change on a shipped surface. Confirm the rollout posture before implementing: enabled unconditionally, or behind a setting defaulting to on with a documented opt-out.

## Complexity Audit

### Routine
- Add a standalone equivalent of `initializeMappingIndex`: resolve the DB path for `workspaceRoot`, open it if present, call `buildMappingIndexFromDbs`.
- Call `setHostWorkspaceRoots([workspaceRoot])` (from Plan 1) immediately before that call.

### Complex / Risky
- **DB discovery must not be copy-pasted.** `initializeMappingIndex` (`extension.ts:206-240`) resolves a DB path through three fallbacks: `readDbPointer` → the `switchboard.kanban.dbPath` setting → `<root>/.switchboard/kanban.db`. Standalone reads host settings through `StandaloneHostPathConfigProvider`, not `vscode.workspace.getConfiguration`. Duplicating the walk forks it; the two hosts will drift on the next change. Extract the per-folder resolution into one shared helper both roots call.
- **Migration discipline.** Mappings have shipped in released versions and the install base is ~4,000, many on much older builds. This changes how an existing configuration is *interpreted* in one host. It must not rewrite, normalise, or prune the stored `workspace_mappings` value — read-only adoption. Unknown/legacy keys in the payload must survive untouched.
- **No `.switchboard/` scaffolding.** `startHeadlessSwitchboard` already creates `<workspaceRoot>/.switchboard` unconditionally at `bootstrap.ts:203-206`, before any mapping is known. Once mappings are honoured, that folder may be a mapped child — and `switchboardLocationGuard.ts:17-27` treats a child owning a control-plane marker as an independent root forever after. Audit whether that unconditional `mkdirSync` needs to become guarded. **This is the highest-risk item in the plan** and may warrant splitting out if it proves non-trivial.
- **Rebuild triggers.** The extension rebuilds the index on `switchboard.mappingsChanged` (`extension.ts:1857`). Standalone has no equivalent. If mappings can be edited while the standalone server is running, it needs a rebuild path or it serves a stale index until restart.

## Edge-Case & Dependency Audit

### Race Conditions
- **Index build vs. first HTTP request.** The board is served over HTTP; a request arriving before the index is built sees `enabled: false` and renders the single-root view, then silently disagrees with later requests. Build the index before the server begins accepting connections, or gate the first board read on it.

### Security
- None directly. Note that honouring mappings widens the set of directories the standalone server reads plan files from — to folders reachable from the launch root via mappings. That is the intended feature, but it is a genuine scope widening for a process listening on a port, and worth stating explicitly.

### Side Effects
- **Grouping starts working in the browser.** For a user launching in a group parent, the board gains cards from member repos. Correct, but it will read as new behaviour.
- **Launching in a member repo is unchanged** — one root, its own board.

### Dependencies & Conflicts
- **Hard-blocked by Plan 1.** Without the precedence fix and openness gate, this plan imports first-match-wins into the browser. Do not ship before it.
- **Should follow Plan 2.** Plan 2 encodes the visibility rule in `buildWorkspaceItems` / `_getWorkspaceItems`. Landing this plan first means the browser lists every workspace in the payload until Plan 2 arrives. If this plan must ship earlier, its own diff has to carry the visibility rule.
- **Does not close the mega-workspace gap.** `HeadlessSwitchboardOptions.workspaceRoot` is singular (`bootstrap.ts:200`), so the browser still cannot render a multi-parent mega workspace. That is a separate feature (multi-root standalone), explicitly out of scope here.

## Dependencies

**Blocked by Plan 1.** Strongly recommended after Plan 2.

## Adversarial Synthesis

Key risks: (1) shipping before Plan 1 imports the redirect bug into a host that is currently immune; (2) shipping before Plan 2 makes the browser list every workspace in the database; (3) copy-pasting the DB-discovery walk forks it permanently between the two hosts; (4) the unconditional `.switchboard` mkdir at `bootstrap.ts:203` can mint a control-plane marker inside a mapped child, which the location guard then treats as an independent root forever; (5) a live behaviour change on ~4,000 installs with no opt-out.

Mitigations: enforce the ordering as a hard dependency, not a note; extract one shared DB-resolution helper called by both roots; audit and, if needed, guard the standalone `mkdirSync` before honouring mappings, and re-run the child-scaffold regression test; keep adoption strictly read-only against the stored payload; settle the rollout posture in User Review before implementing.

## Proposed Changes

### Shared — DB path resolution

Extract the per-folder DB resolution from `extension.ts:209-224` into a host-agnostic helper (pointer file → configured path → default), taking a config-reader callback so each host supplies its own settings source. Both composition roots call it. This is what stops the two walks drifting.

### `src/standalone/bootstrap.ts`

In `startHeadlessSwitchboard` (line 200), after `configProvider` is constructed and before the HTTP server accepts connections:

1. `setHostWorkspaceRoots([workspaceRoot])` — from Plan 1.
2. Resolve the DB path for `workspaceRoot` via the shared helper; if the file exists, open it with `KanbanDatabase.forWorkspace(...)`.
3. `await buildMappingIndexFromDbs(new Map([[workspaceRoot, db]]))`.
4. Log the outcome the way `initializeMappingIndex` does — DB found/not found, mapping count, `enabled` — so a misconfiguration is diagnosable from standalone's output rather than invisible.

Then audit the unconditional `.switchboard` creation at lines 203-206 against `isAllowedSwitchboardLocation`.

### `src/extension.ts`

Refactor `initializeMappingIndex` onto the shared helper. No behaviour change intended here; this is the anti-drift half.

## Files Changed

- `src/standalone/bootstrap.ts` — build the mapping index; inject the root set; audit the `.switchboard` mkdir
- `src/extension.ts` — adopt the shared DB-resolution helper
- `src/services/WorkspaceIdentityService.ts` or a new shared module — the extracted helper

## Verification Plan

### Automated Tests
- Unit: the shared DB-resolution helper across all three fallbacks (pointer file, configured path, default), for both hosts' config readers.
- Unit: standalone index build with (a) no DB present, (b) a DB with no mappings, (c) a DB with mappings naming the launch folder as parent, (d) as child. Assert the visibility rule holds in each.
- Regression: `src/test/child-switchboard-creation-regression.test.ts` — no `.switchboard/` is created in a mapped child by the standalone boot path.
- Parity: extend the composition-root check to assert both roots call the index builder. `npm run standalone-parity:check` does not cover this today; without a new assertion, the next regression is equally silent.

### Manual Verification
1. **Launch in a group parent.** `npx switchboard` → board shows the parent's cards **and** its member repos' cards. Before this plan it showed only the parent's.
2. **Launch in a member repo.** Board shows only that repo. It does **not** list the other group members.
3. **No new directories.** After both launches, confirm no `.switchboard/` appeared in any folder that lacked one.
4. **Extension parity.** Open the same folders in VS Code → the board content matches what the browser showed for the same root.
5. **Legacy payload survives.** Configure mappings on an older build, launch standalone, then re-open Setup in the extension → the stored `workspace_mappings` value is byte-identical. Adoption is read-only.
6. **Diagnosable.** With no DB present, standalone's log states the DB was not found and the index is empty — matching what `initializeMappingIndex` reports.

## Risks

- **Ordering is a correctness constraint, not sequencing preference.** Before Plan 1, this ships a bug into a host that does not have one.
- **The `mkdirSync` at `bootstrap.ts:203` is the sharpest edge.** Minting a control-plane marker inside a mapped child is a durable, hard-to-reverse state change under `switchboardLocationGuard`'s rules.
- **Live change on a shipped surface.** ~4,000 installs, many on older versions; settle the rollout posture first.
- **Parity check must be extended.** Otherwise the next unwired seam is just as invisible as this one was.
