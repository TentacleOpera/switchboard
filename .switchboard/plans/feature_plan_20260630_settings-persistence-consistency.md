# Settings Persistence Consistency: Global Scoping & Pair-Programming Key Cleanup

**Plan ID:** 2a6d7f11-c4c1-45d0-a0a2-c80a34b8daff

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

- **User prefs silently stuck per-workspace.** Settings a user reasonably expects to be account-wide were written to `Workspace`, so they don't follow the user to other projects. The most surprising case: **`theme.name`** (the Afterburner/Claudify selection itself) is workspace-scoped (`TaskViewerProvider.ts:4401`).
- **Split-brain (same key, two targets).** Several workflow flags are written `Global` from the Kanban but `Workspace` from the Setup panel. Because reads via `inspect()` prefer `workspaceValue` over `globalValue`, the two UIs disagree and a value can appear to "jump" or get stuck.
- **Key-name divergence + dead code (aggressive pair).** Two different config keys exist for one concept; each is read by a *different* subsystem, so they can silently disagree. The Setup-panel control behind the registered key has already been removed, leaving orphaned plumbing on both the write and read/hydration sides.

The codebase already documents the intended convention at `PlanningPanelProvider.ts:2402`: `// MUST be Global — user preference, not workspace`. This plan applies that convention consistently, via a single guiding principle (below).

### Guiding principle: "whether" vs "what"

Two levels often get conflated into one setting pair:

1. **"Whether" — behavior/preference toggles** (do I want X to happen, how should the agent behave): these are **user preferences → Global**. Examples: `designSystemDocEnabled`, `accurateCoding.enabled`, `reviewer.advancedMode`, theme/status-bar prefs.
2. **"What" — project-specific resource identity** (the actual path, link, or doc reference that only makes sense for one project): these are **per-project → Workspace**. Examples: `designSystemDocLink`, `kanban.dbPath`, `kanban.controlPlaneRoot`.

The two stay orthogonal at read time (the toggle *gates*, the link *provides*), so an `enabled=true` preference in a project with no link simply no-ops. Every target decision below follows this principle.

## User Review Required

Yes — before implementation, confirm:
- The aggressive-pair **one-time read fallback** should run at *both* live read sites (`TaskViewerProvider.ts:464` seed and `:15932` `_isAggressivePairProgrammingEnabled`), or be centralized in a single helper, so the TaskViewer seed honors a retired `aggressivePairProgramming.enabled` value until the rename migration completes. (See Finding C correction.)
- Ordering: run `feature_plan_20260630_remove-legacy-planner-design-doc.md` **before** this plan so the `planner.designDoc*` writes disappear and don't interfere with the `designSystemDoc*` scope split.

## Complexity Audit

### Routine
- Flipping `ConfigurationTarget.Workspace` → `ConfigurationTarget.Global` on ~9 user-preference setters (theme.name + 8 status-bar/display toggles).
- Aligning 3 Setup-panel workflow-flag writes (`accurateCoding.enabled`, `reviewer.advancedMode`, `leadCoder.inlineChallenge`) from Workspace → Global to match the Kanban's existing Global writes.
- Removing dead Setup-panel aggressive-pair plumbing (handler, getter, state-post, webview case).
- Grep-sweep for removed identifiers.

### Complex / Risky
- **Aggressive-pair key unification (D2):** two keys (`aggressivePairProgramming.enabled` unregistered/Global, `pairProgramming.aggressive` registered/Workspace) are each read by a different subsystem. Renaming the Kanban live key to the registered name + one-time read fallback must cover *both* read sites or the TaskViewer seed at `:464` will keep reading the stale registered key and diverge from the Kanban.
- **Migration write-forward-then-clear:** for every target flip, the setter must write the user's current value to Global *first*, then clear the Workspace value (`config.update(key, undefined, ConfigurationTarget.Workspace)`), or a pre-existing workspace value shadows the new global one and the control looks stuck for ~4k installed users.
- **`designSystemDocEnabled`/`Link` co-write scope split:** `setActivePlanningContext` writes both in one handler; splitting enabled→Global / link→Workspace means two targets in one handler, and the clear-stale-scope step must clear Global-link and Workspace-enabled without blanking the just-written value.

## Edge-Case & Dependency Audit

**Race Conditions**
- Config `update()` calls are async and sequential per key. In setters that write Global then clear Workspace, the two awaits must stay ordered (Global write awaited *before* the Workspace clear) or the clear can race ahead and the read may momentarily see no value. No parallelism across the two targets for the same key.
- The aggressive-pair one-time fallback write-forward (read old key → write new key at Global) must complete before any subsequent read of the new key in the same activation flow; the `:464` seed runs early in construction, so centralize the fallback so it resolves before the seed.

**Security**
- No secrets involved. Settings are booleans and string paths. No injection surface.

**Side Effects**
- Clearing a Workspace value emits an `onDidChangeConfiguration` event. The `affectsConfiguration('switchboard.theme.name')` broadcasts (`KanbanProvider.ts:358`, `PlanningPanelProvider.ts:397/585/712`) will fire on the clear — they re-read via plain `get<>()` which returns the Global value after clear. Benign re-broadcast, but expect an extra theme re-apply cycle per migration.
- Removing the `:7954` Setup write block removes an `autobanState` persist + `_postAutobanState()` call. Since the block is unreachable (setup.html sends no `data.aggressivePairProgramming`), no runtime behavior changes.
- Removing the `:4510-4513` state-post stops one `aggressivePairSetting` message per setup-state push. The webview handler at `setup.html:4507` targets a non-existent `#aggressive-pair-toggle`, so removing the post loses nothing.

**Dependencies & Conflicts**
- **Hard dependency:** `feature_plan_20260630_remove-legacy-planner-design-doc.md` must run first — it removes `planner.designDocEnabled`/`planner.designDocLink` (settings + writes at `KanbanProvider.ts:3687/3690` and `TaskViewerProvider.ts:7967-7979`). This plan explicitly excludes `designDoc*`; running them concurrently risks double-editing the same handler.
- **Soft dependency / no-overlap:** `feature_plan_20260630_claudify-pixel-font-and-afterburner-ultracode-toggles.md` owns `theme.disableCyberAnimation`, `theme.disableCyberScanlines`, `theme.colourKanbanIcons`. This plan must not touch those three keys.
- **Already-completed dependency:** `feature_plan_20260630154140_remove-agent-file-open-guard.md` already removed `statusBar.showAgentOpenToggle` and `preventAgentFileOpening` from source. This plan must not re-add or migrate that removed key (see Finding A correction).

## Dependencies
- `feature_plan_20260630_remove-legacy-planner-design-doc.md` — removes legacy `planner.designDoc*` (run first)
- `feature_plan_20260630_claudify-pixel-font-and-afterburner-ultracode-toggles.md` — owns the 3 excluded theme keys (no overlap)
- `feature_plan_20260630154140_remove-agent-file-open-guard.md` — already removed `statusBar.showAgentOpenToggle` (completed; informs Finding A correction)

## Findings (audit recap)

**A. User prefs currently Workspace → should be Global**
> Line numbers refreshed to current source. `statusBar.showAgentOpenToggle` was removed by the completed agent-file-open-guard plan and is **no longer present in source** — it is excluded from this table.

| Setting | Write site (current) |
| :--- | :--- |
| `theme.name` | `TaskViewerProvider.ts:4401` |
| `statusBar.showTerminalControls` | `:4078` |
| `statusBar.showKanbanButton` | `:4087` |
| `statusBar.showArtifactsButton` | `:4096` |
| `statusBar.showDesignButton` | `:4105` |
| `statusBar.showProjectButton` | `:4114` |
| `statusBar.showMemoButton` | `:4123` |
| `excludeReviewedBacklogFromDropdown` | `:4067` |

**B. Split-brain (Global from Kanban, Workspace from Setup)**
| Setting | Global write | Workspace write |
| :--- | :--- | :--- |
| `accurateCoding.enabled` | `KanbanProvider.ts:3675` | `TaskViewerProvider.ts:7923` |
| `reviewer.advancedMode` | `KanbanProvider.ts:3678` | `:7930` |
| `leadCoder.inlineChallenge` | `KanbanProvider.ts:3681` | `:7937` |
| `planner.designDocEnabled` | `KanbanProvider.ts:3687` | `:7968`, `PlanningPanelProvider.ts:6564`, `DesignPanelProvider.ts:1488` |
| `planner.designDocLink` | `KanbanProvider.ts:3690` | `:7976`, Planning/Design providers, `:9769` |

> **`planner.designDoc*` is OUT OF SCOPE** here — removed entirely by `feature_plan_20260630_remove-legacy-planner-design-doc.md` (run first). Listed only to document the existing split; do not re-scope these two keys in this plan.

**C. Aggressive pair programming — crossed wires (CORRECTED)**
- Registered setting: `switchboard.pairProgramming.aggressive` (`package.json:286`). Written to **Workspace** by the Setup-panel handler (`TaskViewerProvider.ts:7955`). **Read at two sites**: the activation seed `TaskViewerProvider.ts:464` (`_autobanState.aggressivePairProgramming = config.get('pairProgramming.aggressive', false)`) and the fallback in `_isAggressivePairProgrammingEnabled()` at `:15932`. It is **not** "never read" — it is read by the TaskViewer/sidebar subsystem.
- Actual live key (Kanban side): `aggressivePairProgramming.enabled` — written **Global** (`KanbanProvider.ts:3684`) and read for prompt-build fallback by the Kanban (`KanbanProvider.ts:3370`). **Not registered in `package.json`.**
- **Net state:** two keys, each live in a different subsystem, that can silently disagree. Toggling in the Kanban writes `aggressivePairProgramming.enabled` (Global); the TaskViewer seed at `:464` reads `pairProgramming.aggressive` (only written from the Setup path) and stays `false`.
- The Setup-panel **write** path is dead: `setup.html` sends no `data.aggressivePairProgramming` (grep-confirmed). The `:7954` block (config write + `autobanState` update + persist + post) is unreachable and can be removed entirely.
- The Setup-panel **read/hydration** path is dead UI: `handleGetAggressivePairSetting` (`TaskViewerProvider.ts:4055`) → state-post at `:4510-4513` (`aggressivePairSetting`) → `setup.html:4507` `case 'aggressivePairSetting'` sets `#aggressive-pair-toggle`, an element that does not exist. The `getAggressivePairSetting` → `aggressivePairSetting` round-trip (`SetupPanelProvider.ts:550-555`) is dead.
- Note: the pair-programming **on/off + mode** (`pairProgrammingMode`) lives in `autobanState` (`workspaceState`), not in settings — out of scope here.

## Adversarial Synthesis
Key risks: (1) the plan's original "registered key never read" claim was false — `pairProgramming.aggressive` is read at `TaskViewerProvider.ts:464` and `:15932`, so the D2 rename fallback must cover both read sites or the TaskViewer seed diverges from the Kanban; (2) the write-forward-then-clear migration must stay ordered (Global write awaited before Workspace clear) or ~4k users see stuck controls; (3) the `designSystemDocEnabled`/`Link` co-write splits two targets in one handler and the clear-stale-scope step must not blank the just-written value. Mitigations: centralize the aggressive-pair read fallback; keep target writes sequential; spell out the co-write clear order per handler.

## Proposed Changes

### Phase 1 — Migrate user prefs to Global (Findings A)
1. Change the write target from `ConfigurationTarget.Workspace` to `Global` for `theme.name` (`TaskViewerProvider.ts:4401`) and the seven status-bar/display settings listed in Finding A (`:4067`, `:4078`, `:4087`, `:4096`, `:4105`, `:4114`, `:4123`).
2. **Migration nuance (published, ~4k installs):** reads prefer `workspaceValue`. If we only switch *writes* to Global, a user's pre-existing workspace value will shadow the new global one and the control will look stuck. So in each setter, after writing Global, also **clear the workspace value**: `await config.update(key, undefined, ConfigurationTarget.Workspace)`. Keep the two awaits **ordered** (Global write awaited first). This makes Global authoritative without discarding the user's actual choice (we write their current value to Global first).
3. Confirm the corresponding read sites don't hard-prefer `workspaceValue` in a way that defeats step 2. The only `inspect()`-based hard-prefer in this area is `getEffectiveColourKanbanIcons` in `themeBodyClass.ts:30-38` — that key is owned by the companion plan and excluded here. For `theme.name`, all reads use plain `get<>()` (`KanbanProvider.ts:359/5133`, `PlanningPanelProvider.ts:398/422/586/683/713/7413`) which returns the effective value (workspace > global); after the Workspace clear, they return Global. Verify the `affectsConfiguration('switchboard.theme.name')` broadcasts (`KanbanProvider.ts:358`, `PlanningPanelProvider.ts:397/585/712`) still fire correctly after the target change — they will, because the clear emits a config event.

### Phase 2 — Resolve split-brain workflow flags (Findings B)
4. Apply the "whether vs what" principle per field, in **both** the Kanban and Setup/Planning/Design write sites, plus clear the stale other-scope value (as in step 2, ordered: write new target first, then clear old).

   **"Whether" toggles → Global:**
   - `accurateCoding.enabled`, `reviewer.advancedMode`, `leadCoder.inlineChallenge` — Kanban already Global (`KanbanProvider.ts:3675/3678/3681`); align the Setup-panel Workspace writes (`TaskViewerProvider.ts:7923/7930/7937`) to Global + clear Workspace.
   - `planner.designSystemDocEnabled` — currently **Workspace** at `DesignPanelProvider.ts:1473/1489` → change to Global + clear Workspace.

   **"What" resource pointers → Workspace:**
   - `planner.designSystemDocLink` — already Workspace at `DesignPanelProvider.ts:1470/1492` (correct); no change, but verify no other site writes it Global (Kanban only *reads* it at `:3119/3376`; no Global write found).

   **Co-write handler note (`DesignPanelProvider.ts:1462-1484` `setActivePlanningContext`):** this handler writes `designSystemDocLink` (Workspace) and `designSystemDocEnabled` (Workspace) together. After the split it writes `enabled`→Global and `link`→Workspace. The clear-stale-scope step must clear `Global` for the link and `Workspace` for `enabled` — do **not** clear the scope you just wrote. In `disableDesignDoc` (`:1486-1494`): write `enabled=false`→Global + clear Workspace enabled; clear Workspace link (already Workspace, just set undefined).

   > **Note:** `planner.designDoc*` (the legacy planner design-doc pointer) is **not** in this plan's scope — it is being **removed entirely** by `feature_plan_20260630_remove-legacy-planner-design-doc.md`. Do that removal first; do not migrate `designDoc*` scopes here.

### Phase 3 — Aggressive-pair cleanup (Findings C) — Kanban is the sole owner
5. **Remove the dead Setup-panel write path entirely:**
   - Delete the `if (typeof data.aggressivePairProgramming === 'boolean') { ... }` block at `TaskViewerProvider.ts:7954-7965` (the `pairProgramming.aggressive` Workspace write **and** the trailing `autobanState` update + `_persistAutobanState()` + `_postAutobanState()`). **Confirmed dead:** `setup.html` sends no `data.aggressivePairProgramming` (grep-verified), so the entire block is unreachable — remove it wholesale, including the autobanState update.
6. **Remove the dead Setup-panel read/hydration path:**
   - Remove `handleGetAggressivePairSetting` (`TaskViewerProvider.ts:4055-4057`) and the state-post at `:4510-4513` that emits `aggressivePairSetting` to the setup panel (otherwise it posts a message nothing handles).
   - Remove the `getAggressivePairSetting` → `aggressivePairSetting` round-trip (`SetupPanelProvider.ts:550-555`).
   - Remove the orphaned `case 'aggressivePairSetting'` handler and the `aggressive-pair-toggle` `getElementById` reference in `setup.html` (`:4507-4513`).
7. **Fix the key name / registration mismatch (Kanban side)** — RESOLVED (D2): **rename the live key to the registered name.** Change `KanbanProvider.ts:3684` (write) and `:3370` (read) from `aggressivePairProgramming.enabled` to the registered `pairProgramming.aggressive` (`package.json:286`), keeping it Global. Add a **one-time read fallback** so any existing shipped `aggressivePairProgramming.enabled` value is honored under the new key. **The fallback must cover both live read sites of the registered key** — `TaskViewerProvider.ts:464` (activation seed) and `:15932` (`_isAggressivePairProgrammingEnabled`) — either by centralizing it in a single helper used by all three read sites (`:464`, `:15932`, `KanbanProvider.ts:3370`), or by running the write-forward once at activation before the `:464` seed. End state = exactly one key (`pairProgramming.aggressive`), registered, written+read at Global, set only from the Kanban; the unregistered `aggressivePairProgramming.enabled` is fully retired.

### Phase 4 — Verification
8. Build only if producing a VSIX (`dist/` not authoritative per CLAUDE.md); otherwise test from `src/` via installed VSIX.
9. Checks:
   - Set theme + each status-bar toggle in workspace A; open workspace B → values carry over. Confirm a pre-existing workspace value no longer shadows a new global change (migration step 2).
   - Toggle each split-brain workflow flag from the Kanban and from the Setup panel → both reflect the same state on reopen.
   - Aggressive pair: toggling in the Kanban persists and affects prompts (via `aggressivePairProgramming` in autoban/role state, fallback to the single config key); confirm the Setup panel no longer references it and no console errors from removed message handlers/state-posts; confirm the one-time read migration picks up any old `aggressivePairProgramming.enabled` value at **both** the Kanban read and the TaskViewer `:464`/`:15932` reads.
   - Grep the tree for the removed identifiers (`getAggressivePairSetting`, `aggressivePairSetting`, `aggressive-pair-toggle`, `aggressivePairProgramming.enabled`) → no stragglers.

## Resolved Decisions
- **D1 — `planner.designDoc*` is removed, not re-scoped.** Superseded by the per-project PRD; full removal is covered by `feature_plan_20260630_remove-legacy-planner-design-doc.md` (run first). The "whether vs what" split therefore applies here only to the design-*system* doc: `designSystemDocEnabled` → **Global**, `designSystemDocLink` → **Workspace**.
- **D2 — aggressive-pair canonical key → `pairProgramming.aggressive`** (the registered name), Global, with a one-time read fallback from the retired `aggressivePairProgramming.enabled`. The fallback must cover all read sites (`TaskViewerProvider.ts:464`, `:15932`, `KanbanProvider.ts:3370`).
- **D3 — `statusBar.showAgentOpenToggle` is excluded.** Already removed from source by the completed agent-file-open-guard plan; not present to migrate.

## Migration Considerations (published extension, ~4k installs)
- Per CLAUDE.md: settings shipped in a released version must be migrated, not dropped. `theme.name`, the status-bar keys, the workflow flags, and `aggressivePairProgramming.enabled` have all shipped, so:
  - Write-target changes carry the user's current value forward to Global first, *then* clear the workspace value — never blind-clear. Keep the two awaits ordered (Global before Workspace clear).
  - For the aggressive-pair key rename (D2), add a one-time read fallback so an existing `aggressivePairProgramming.enabled` value is honored under the new key — at all read sites, not just the Kanban.
  - No setting is unregistered/removed from `package.json` without confirming nothing reads it. `pairProgramming.aggressive` is registered and read at `:464`/`:15932`; after the rename unifies reads onto it, the unregistered `aggressivePairProgramming.enabled` is safe to retire (it remains readable as a fallback during the transition window, then the fallback can be removed in a later release).

## Files Touched (anticipated)
- `package.json` — aggressive-pair key registration cleanup (confirm `pairProgramming.aggressive` at `:286` is the sole key; no unregistered key to add).
- `src/services/TaskViewerProvider.ts` — target changes (theme.name `:4401`, status-bar group `:4067-4123`, workflow flags `:7923/7930/7937`), remove dead aggressive-pair setter block (`:7954-7965`), remove `handleGetAggressivePairSetting` (`:4055`) + state-post (`:4510-4513`), update `:464`/`:15932` reads to use the unified key + fallback.
- `src/services/KanbanProvider.ts` — workflow-flag target alignment, aggressive-pair key rename (`:3684`/`:3370`) + read fallback.
- `src/services/SetupPanelProvider.ts` — remove `getAggressivePairSetting`/`aggressivePairSetting` plumbing (`:550-555`).
- `src/services/DesignPanelProvider.ts` — `designSystemDocEnabled` → Global (`:1473/1489`); `designSystemDocLink` stays Workspace (`:1470/1492`); mind the co-write clear order in `setActivePlanningContext`/`disableDesignDoc`.
- `src/webview/setup.html` — remove orphaned aggressive-pair message handler + element reference (`:4507-4513`).

## Verification Plan

### Automated Tests
Per session directive, automated tests (unit, integration, e2e) and compilation are **skipped** here — the user runs the suite separately. No test authoring is required from this plan.

### Manual Verification (per Phase 4 step 9)
- Cross-workspace carry-over for theme + status-bar toggles (workspace A → B).
- Split-brain workflow flags agree between Kanban and Setup on reopen.
- Aggressive-pair Kanban toggle persists + affects prompts; Setup panel clean; one-time fallback honored at all read sites.
- Grep sweep for removed identifiers returns zero matches.

## Recommendation
Complexity is **5** (mixed: routine target flips + moderate key-unification with migration risk). **Send to Coder.**
