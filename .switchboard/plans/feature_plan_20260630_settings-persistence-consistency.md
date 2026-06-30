# Settings Persistence Consistency: Global Scoping & Pair-Programming Key Cleanup

## Metadata
**Complexity:** 5
**Tags:** refactor, bugfix, backend

## Goal

Make Switchboard's user-preference settings persist where users expect (globally, across workspaces) and remove a tangle of inconsistent/dead persistence code uncovered during the theme-toggle audit. Three threads:

1. **Migrate genuine user-preference settings from Workspace → Global** (theme selection, status-bar/display prefs).
2. **Resolve "split-brain" settings** written to *different* `ConfigurationTarget`s from different UIs (Kanban vs Setup panel), so the two UIs agree.
3. **Clean up aggressive-pair-programming**, which is split across two key names *and* two scopes, with a dead/orphaned path on the Setup-panel side. Per direction: **aggressive pair programming is only validly set from the Kanban, not the Setup panel** — so this is a straight code cleanup, not a behavior change.

> **Coordination:** the companion plan `feature_plan_20260630_claudify-pixel-font-and-afterburner-ultracode-toggles.md` already migrates `theme.disableCyberAnimation`, `theme.disableCyberScanlines`, and `theme.colourKanbanIcons` to Global. This plan deliberately **excludes** those three to avoid overlap and covers everything else.

### Problem / background / root-cause analysis

VS Code's `config.update(key, value, target)` takes a target of `Global`, `Workspace`, or `WorkspaceFolder` (a boolean `true`/`false` is shorthand for Global/Workspace). Switchboard settings were added incrementally by different UIs without a single convention, producing three failure modes:

- **User prefs silently stuck per-workspace.** Settings a user reasonably expects to be account-wide were written to `Workspace`, so they don't follow the user to other projects. The most surprising case: **`theme.name`** (the Afterburner/Claudify selection itself) is workspace-scoped (`TaskViewerProvider.ts:4412`).
- **Split-brain (same key, two targets).** Several workflow flags are written `Global` from the Kanban but `Workspace` from the Setup panel. Because reads via `inspect()` prefer `workspaceValue` over `globalValue`, the two UIs disagree and a value can appear to "jump" or get stuck.
- **Key-name divergence + dead code (aggressive pair).** Two different config keys exist for one concept; only one is read, the *registered* one is never read, and the Setup-panel control behind it has already been removed, leaving orphaned plumbing.

The codebase already documents the intended convention at `PlanningPanelProvider.ts:2332`: `// MUST be Global — user preference, not workspace`. This plan applies that convention consistently.

## Findings (audit recap)

**A. User prefs currently Workspace → should be Global**
| Setting | Write site |
| :--- | :--- |
| `theme.name` | `TaskViewerProvider.ts:4412` |
| `statusBar.showAgentOpenToggle` | `TaskViewerProvider.ts:4080` |
| `statusBar.showTerminalControls` | `:4089` |
| `statusBar.showKanbanButton` | `:4098` |
| `statusBar.showArtifactsButton` | `:4107` |
| `statusBar.showDesignButton` | `:4116` |
| `statusBar.showProjectButton` | `:4125` |
| `statusBar.showMemoButton` | `:4134` |
| `excludeReviewedBacklogFromDropdown` | `:4071` |

**B. Split-brain (Global from Kanban, Workspace from Setup)**
| Setting | Global write | Workspace write |
| :--- | :--- | :--- |
| `accurateCoding.enabled` | `KanbanProvider.ts:3675` | `TaskViewerProvider.ts:7930` |
| `reviewer.advancedMode` | `KanbanProvider.ts:3678` | `:7937` |
| `leadCoder.inlineChallenge` | `KanbanProvider.ts:3681` | `:7944` |
| `planner.designDocEnabled` | `KanbanProvider.ts:3687` | `:7974`, `PlanningPanelProvider.ts:6564`, `DesignPanelProvider.ts:1488` |
| `planner.designDocLink` | `KanbanProvider.ts:3690` | `:7982`, Planning/Design providers, `:9769` |

**C. Aggressive pair programming — crossed wires**
- Registered setting: `switchboard.pairProgramming.aggressive` (`package.json:296`). Written to **Workspace** by Setup-panel handler (`TaskViewerProvider.ts:7963`). **Never read anywhere.**
- Actual live key: `aggressivePairProgramming.enabled` — written **Global** and read (as prompt-build fallback) by the Kanban (`KanbanProvider.ts:3684` / `:3370`). **Not registered in `package.json`.**
- The Setup-panel UI control is already gone: `aggressive-pair-toggle` appears only in an orphaned message handler (`setup.html:4542`); there is no `<input>` element and no change-handler/save payload feeding it. The `getAggressivePairSetting`/`aggressivePairSetting` round-trip (`SetupPanelProvider.ts:550`, `setup.html:4540`) and `handleGetAggressivePairSetting` are dead.
- Note: the pair-programming **on/off + mode** (`pairProgrammingMode`) lives in `autobanState` (`workspaceState`), not in settings — out of scope here.

## Proposed Changes

### Phase 1 — Migrate user prefs to Global (Findings A)
1. Change the write target from `ConfigurationTarget.Workspace` to `Global` for `theme.name` and the eight status-bar/display settings listed in Finding A.
2. **Migration nuance (published, ~4k installs):** reads prefer `workspaceValue`. If we only switch *writes* to Global, a user's pre-existing workspace value will shadow the new global one and the control will look stuck. So in each setter, after writing Global, also **clear the workspace value**: `await config.update(key, undefined, ConfigurationTarget.Workspace)`. This makes Global authoritative without discarding the user's actual choice (we write their current value to Global first).
3. Confirm the corresponding `getEffective*` / read sites don't hard-prefer `workspaceValue` in a way that defeats step 2 (e.g. anything modeled on `getEffectiveColourKanbanIcons` in `themeBodyClass.ts`). For `theme.name`, verify the first-paint resolver and the `affectsConfiguration('switchboard.theme.name')` broadcasts (`KanbanProvider.ts:358`, `PlanningPanelProvider.ts:389`) still fire correctly after the target change.

### Phase 2 — Resolve split-brain workflow flags (Findings B)
4. Pick a single target per setting and apply it in **both** the Kanban and Setup/Planning/Design write sites, plus clear the stale other-scope value (as in step 2).
   - `accurateCoding.enabled`, `reviewer.advancedMode`, `leadCoder.inlineChallenge` → **Global** (they're agent-behavior preferences; Kanban already treats them as Global). *Recommended.*
   - `planner.designDocEnabled` / `planner.designDocLink` → **OPEN DECISION** (see below). A design-doc *link* is plausibly project-specific (→ Workspace), which would mean the Kanban's Global write is the bug, not the Setup write. Do not change these until the direction is confirmed.

### Phase 3 — Aggressive-pair cleanup (Findings C) — Kanban is the sole owner
5. **Remove the dead Setup-panel path entirely:**
   - Delete the `data.aggressivePairProgramming` write block at `TaskViewerProvider.ts:7961–7973` (the `pairProgramming.aggressive` Workspace write). Confirm whether the trailing `autobanState` update (lines 7967–7972) is reachable from any *current* Setup message; if nothing sends `data.aggressivePairProgramming`, remove the whole block. If something does still send it, remove only the dead config write and keep/redirect the autobanState update as appropriate.
   - Remove `handleGetAggressivePairSetting` (TaskViewerProvider) and the `getAggressivePairSetting` → `aggressivePairSetting` round-trip (`SetupPanelProvider.ts:550–555`).
   - Remove the orphaned `case 'aggressivePairSetting'` handler and the `aggressive-pair-toggle` `getElementById` reference in `setup.html` (~4540–4543).
6. **Fix the key name / registration mismatch (Kanban side):** decide the canonical key and make it consistent:
   - Either (a) **rename** the live key to the registered name — change `KanbanProvider.ts:3684`/`:3370` from `aggressivePairProgramming.enabled` to `pairProgramming.aggressive`, keeping it Global, so the registered `package.json:296` setting is the one actually used; **migrate** any existing `aggressivePairProgramming.enabled` value forward on read (one-time fallback) since this key may have shipped; or
   - (b) **register** `aggressivePairProgramming.enabled` in `package.json` and remove the unused `pairProgramming.aggressive` entry.
   - **Recommended: (a)** — `pairProgramming.aggressive` is the cleaner, already-registered name; (b) leaves a slightly awkward key. Whichever is chosen, end state = exactly one key, registered, written+read at Global, set only from the Kanban.

### Phase 4 — Verification
7. Build only if producing a VSIX (`dist/` not authoritative per CLAUDE.md); otherwise test from `src/` via installed VSIX.
8. Checks:
   - Set theme + each status-bar toggle in workspace A; open workspace B → values carry over. Confirm a pre-existing workspace value no longer shadows a new global change (migration step 2).
   - Toggle each split-brain workflow flag from the Kanban and from the Setup panel → both reflect the same state on reopen.
   - Aggressive pair: toggling in the Kanban persists and affects prompts (via `aggressivePairProgramming` in autoban/role state, fallback to the single config key); confirm the Setup panel no longer references it and no console errors from removed message handlers; confirm a one-time read migration (if 6a) picks up any old `aggressivePairProgramming.enabled` value.
   - Grep the tree for the removed identifiers (`pairProgramming.aggressive` orphan reads, `getAggressivePairSetting`, `aggressive-pair-toggle`) → no stragglers.

## Open Decisions
- **D1 — `planner.designDoc*` target:** Global (user pref, matches Kanban) **or** Workspace (a design-doc link is arguably project-specific, making the Kanban write the bug)? This is the one genuinely ambiguous case in Findings B; everything else has a clear answer. *Needs your call before Phase 2 touches these two keys.*
- **D2 — aggressive-pair canonical key:** rename to registered `pairProgramming.aggressive` (recommended) vs register `aggressivePairProgramming.enabled`.

## Migration Considerations (published extension, ~4k installs)
- Per CLAUDE.md: settings shipped in a released version must be migrated, not dropped. `theme.name`, the status-bar keys, the workflow flags, and `aggressivePairProgramming.enabled` have all shipped, so:
  - Write-target changes carry the user's current value forward to Global first, *then* clear the workspace value — never blind-clear.
  - For the aggressive-pair key rename (D2 option a), add a one-time read fallback so an existing `aggressivePairProgramming.enabled` value is honored under the new key.
  - No setting is unregistered/removed from `package.json` without confirming nothing reads it (the `pairProgramming.aggressive` orphan is safe to remove only after the rename path is in place).

## Files Touched (anticipated)
- `package.json` — aggressive-pair key registration cleanup.
- `src/services/TaskViewerProvider.ts` — target changes (theme.name, status-bar group, workflow flags), remove dead aggressive-pair setter/getter.
- `src/services/KanbanProvider.ts` — workflow-flag target alignment, aggressive-pair key rename + read fallback.
- `src/services/SetupPanelProvider.ts` — remove `getAggressivePairSetting`/`aggressivePairSetting` plumbing.
- `src/services/PlanningPanelProvider.ts`, `src/services/DesignPanelProvider.ts` — `planner.designDoc*` target alignment (pending D1).
- `src/webview/setup.html` — remove orphaned aggressive-pair message handler + element reference.
