# Standalone State Builders Fabricate the Board Payload — Delegate to `getFullStateMessages`

## Metadata

**Complexity:** 6
**Tags:** bug, backend, refactor, reliability
**Project:** Browser Switchboard
**Feature:** 2cfc1e45-9751-4902-aed4-3efd510b35b8
**Consolidated From:** `standalone-column-structure-ignores-custom-columns-and-visibility.md`, `standalone-routing-config-hardcoded-empty.md`, `standalone-cli-triggers-state-hardcoded-off.md`, `standalone-theme-hardcoded-afterburner.md`, `standalone-workspace-selection-fields-hardcoded.md`

## Goal

The standalone (browser) host hand-builds its board state payload from literals instead of reading live state. Custom columns, column visibility and order, dynamic complexity routing, the CLI-triggers toggle, the theme, repo-scope filtering and project context are all permanently fabricated in the browser: a user changes any of them, the write persists, and the next state push (~40 ms later) re-asserts the literal and reverts the UI.

Replace both hand-built state arrays with a delegation to the provider's existing `KanbanProvider.getFullStateMessages(wsRoot, scope)` — the method whose own docstring says it exists to serve "a browser WS resync (cockpit)" and to "fall back to the passed root (standalone, or before any selection)". Standalone keeps only the entries the provider does not produce (the theme) and the overrides that are genuinely host-specific (`dispatchAnalyzeAvailable`).

### Problem analysis and root cause

Both standalone state builders assemble the board payload themselves:

- `pushFullState` — `src/standalone/bootstrap.ts:365-374` (the state array at `:365-371`)
- `getFullState` — `src/standalone/bootstrap.ts:394-400`

```typescript
const state = [
    { type: 'updateColumns', columns: DEFAULT_KANBAN_COLUMNS, surface: SURFACES.kanban },
    { type: 'updateWorkspaceSelection', workspaceRoot, workspaces: workspaceItems, activeFilter: null, projectFilter, projects, allWorkspaceProjects, controlPlaneMode: 'none', controlPlaneRoot: null, effectiveControlPlaneRoot: workspaceRoot, explicitControlPlaneRoot: workspaceRoot, pendingCandidate: null, repoScopeFilter: null, projectContextEnabled: false, surface: SURFACES.kanban },
    { type: 'cliTriggersState', enabled: false, surface: SURFACES.kanban },
    { type: 'switchboardThemeNameSetting', theme: 'afterburner', surface: SURFACES.common },
    { type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: kanbanProvider.showingBacklog, showingDispatch: kanbanProvider.showingDispatch, dispatchAnalyzeAvailable: ptyReady, routingConfig: {}, featureWorktrees, surface: SURFACES.kanban },
];
```

The extension builds the same message list at `src/services/KanbanProvider.ts:1087-1185` (`getFullStateMessages`), from live state:

| Field | Standalone (fabricated) | Extension (`KanbanProvider.ts`) |
|---|---|---|
| `updateColumns.columns` | `DEFAULT_KANBAN_COLUMNS` (raw) | `filteredColumns` — `_buildKanbanColumns(customAgents, customKanbanColumns)` (`:1122`) then `_filterDynamicColumns(built, visibleAgents, cards)` (`:1124`) |
| `updateBoard.routingConfig` | `{}` | `this._routingMapForScope(scope)` (`:1143`) |
| `cliTriggersState.enabled` | `false` | `this._cliTriggersForScope(scope)` (`:1142`) |
| `updateWorkspaceSelection.activeFilter` | `null` | `this._repoScopeFilter \|\| null` (`:1161`) |
| `…controlPlaneMode` / `controlPlaneRoot` / `effectiveControlPlaneRoot` / `explicitControlPlaneRoot` / `pendingCandidate` / `repoScopeFilter` | `'none'` / `null` / `workspaceRoot` / `workspaceRoot` / `null` / `null` | `cpStatus.*` from `this.getControlPlaneSelectionStatus(root)` (`:1145`, `:1165-1170`) |
| `…projectContextEnabled` | `false` | `await this._resolveProjectContextEnabled(root)` (`:1146`, `:1171`) |
| `…workspaces` item shape | `{ value, label }` (`bootstrap.ts:362`) | `{ label, workspaceRoot }` from `this._getWorkspaceItems()` (`:1130`) |
| `switchboardThemeNameSetting.theme` | `'afterburner'` | not in this array; posted at `KanbanProvider.ts:7403` from the resolved setting |
| autoban entries | absent | `updateAutobanConfig` + `updatePairProgrammingMode` spread in at `:1179-1184` |

**Why this class of bug survived repeated audits.** `bootstrap.ts`'s `default:` arm (`:1062-1087` region, delegation to `kanbanProvider.handleServiceVerb`) makes every unmatched verb reachable in standalone, so every *write* lands. `saveKanbanColumn`, `deleteKanbanColumn`, `restoreKanbanDefaults`, `toggleKanbanColumnVisibility`, `updateKanbanStructure`, `toggleCliTriggers`, `toggleDynamicComplexityRouting`, `updateRoutingConfig` all execute, persist and return `{ success: true }`. An audit that asks "is the verb wired?" or "does the write persist?" returns green on a subsystem that is entirely dead in the browser. The dead half is the **read-back**, and it is dead because the payload is fabricated rather than read.

The same `default:` arm schedules a coalesced push after every non-read-only verb, so the literal is not merely a stale initial value — it is actively re-asserted `PUSH_COALESCE_MS = 40` ms (`bootstrap.ts:420`) after each user action. That is why these features do not merely fail to load; they visibly revert.

**Why one plan and not five.** All five fabricated regions live inside the *same two array literals* in the *same two functions*. Five separate plans would each expose a different private resolver publicly (`_buildKanbanColumns` + `_filterDynamicColumns`, `_routingMapForScope`, `_cliTriggersForScope`, `getControlPlaneSelectionStatus` + `_resolveProjectContextEnabled`, the theme resolution), each re-derive one field in `bootstrap.ts`, and each conflict with the other four on the same lines. The provider already assembles all of them in one public, scope-aware method built for exactly this caller. Five hand-wired accessors reproduce `getFullStateMessages` badly; calling it reproduces it exactly. Divergence between the hosts is the failure this project's anti-divergence contract exists to prevent, and five parallel derivations is divergence by construction.

> **Superseded:** Five separate plans, each exposing one private resolver on `KanbanProvider` and re-deriving one field inside `bootstrap.ts`'s hand-built state arrays (`standalone-column-structure-ignores-custom-columns-and-visibility.md`, `standalone-routing-config-hardcoded-empty.md`, `standalone-cli-triggers-state-hardcoded-off.md`, `standalone-theme-hardcoded-afterburner.md`, `standalone-workspace-selection-fields-hardcoded.md`).
> **Reason:** All five edit the same two array literals in the same two functions — guaranteed five-way merge conflict — and each proposed accessor is made dead by the existence of `KanbanProvider.getFullStateMessages(wsRoot, scope)` (`KanbanProvider.ts:1087`), which is already `public`, already assembles every one of those fields from live state, is already scope-aware, and whose docstring names standalone as an intended caller. Re-deriving the payload field-by-field in `bootstrap.ts` is a second implementation of a builder that already exists — the exact host divergence the PRD's anti-divergence contract forbids.
> **Replaced with:** One plan that deletes both hand-built arrays and delegates to `getFullStateMessages`, keeping only the entries the provider does not emit (theme) and the genuinely host-specific override (`dispatchAnalyzeAvailable: ptyReady`), and reconciling the three state-ownership conflicts delegation exposes (project filter, workspace-item shape, DB handle).

### What delegation exposes — three conflicts that must be resolved in this change

Delegation is not a drop-in. Three pieces of state are currently owned by `bootstrap.ts` and shadow the provider's own. Each must be resolved or the merge introduces a new instance of the very bug it fixes.

**1. `projectFilter` is a bootstrap-local closure variable.** `bootstrap.ts:333` declares `let projectFilter: string | null = null`, its own `case 'setProjectFilter'` arm (`:816-819`) assigns it, and it is read at `:883` (`db.getPlansByColumn(..., projectFilter)`) and `:1090` (`initiatorProject: projectFilter`). The provider has a real handler for the same verb plus `public getProjectFilter()` (`KanbanProvider.ts:6532`) and `public async setProjectFilter(filter)` (`:6753`), which **persists** the choice to the `kanban.activeProjectFilter` DB config key. Two consequences:
- Naive delegation would emit `projectFilter: this._projectFilter ?? null` from a provider whose `_projectFilter` standalone never sets — so the browser's project dropdown would reset on every push. A new reverting-toggle bug, introduced by this fix.
- Standalone's project filter is currently **not persisted** across restarts, while the extension's is. That is a pre-existing parity gap the shadowing arm caused.

Resolve by deleting bootstrap's shadowing `setProjectFilter` arm so the verb falls through to the provider, and repointing `:883` and `:1090` at `kanbanProvider.getProjectFilter()`. Note `_projectFilter` initialises to `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`'__unassigned__'`, `KanbanProvider.ts:227`, `KanbanDatabase.ts:856`), **not** `null` — verify the board and `getPlansByColumn` treat that sentinel as "no filter" the same way the extension does before assuming the swap is transparent.

**2. `workspaces` item shape is wrong today and delegation fixes it silently.** `bootstrap.ts:362` builds `{ value: workspaceRoot, label }`. `kanban.html` reads `item.workspaceRoot` throughout (`:4601`, `:4911-4912`, `:4927`, `:4952`, `:4987-4988`) — never `item.value`. So every workspace item in the standalone board currently carries `workspaceRoot === undefined`, and `allWorkspaceProjects[item.workspaceRoot]` misses. `_getWorkspaceItems()` returns the correct `{ label, workspaceRoot }` shape. Call this out explicitly in verification: it is a fix, but an unannounced one, and it changes the dropdown's behaviour.

**3. The DB handle and workspace root must resolve to the same objects.** `getFullStateMessages` resolves its root as `this.getCurrentWorkspaceRoot() || wsRoot` (`:1091`) — bootstrap sets `_currentWorkspaceRoot = workspaceRoot` at `:706`, so this is correct — and its DB via `this._getKanbanDb(root)`, which delegates to `KanbanDatabase.forWorkspace(resolved)`. That factory is backed by the static `KanbanDatabase._instances` cache keyed by resolved root, and bootstrap's own `db` is `KanbanDatabase.forWorkspace(workspaceRoot)` (`:286`) — **the same instance**. Confirm this holds rather than assuming it: a second DB handle would give the browser a different card set from the same file.

## User Review Required

None.

## Complexity Audit

### Routine
- Deleting two hand-built arrays and calling one existing public method.
- Appending the theme entry to the delegated list.
- Removing the shadowing `setProjectFilter` arm.

### Complex / Risky
- **Scope threading.** `wsHub` calls `getFullState(meta.project)` — the connection's declared scope (`wsHub.ts:254`). Bootstrap's `getFullState(scope)` accepts the argument today and ignores it entirely; every field it emits is scope-blind. `getFullStateMessages(root, scope)` consumes it (`:1142-1143`). Pass it through. Note `LocalApiServer`'s option type declares `getFullState?: () => Promise<any>` (`LocalApiServer.ts:325`) while `wsHub`'s declares `(scope?: string | null)` (`wsHub.ts:95`); tighten the `LocalApiServer` type to match, or the scope parameter stays invisible to a reader of the option surface.
- **`pushFullState` has no per-connection scope.** It broadcasts one payload to all clients. For the two scope-dependent fields the extension uses a **scoped-payload factory** — `this.postMessage((scope) => ({ …, routingConfig: this._routingMapForScope(scope) }))` (`KanbanProvider.ts:2025-2034`, `:2043-2046`) — and `wsHub.broadcast` renders a factory once per distinct declared scope (`wsHub.ts:303-338`). Decide explicitly: broadcast factories for `updateBoard`/`cliTriggersState` (correct, matches the extension) or accept singleton-tier values on the broadcast path (status quo, and a silent scope bug for project-scoped browser clients). **Recommendation: factories** — the mechanism already exists on both ends and the alternative reintroduces a fabricated-value bug in a different disguise.
- **`dispatchAnalyzeAvailable` must stay host-specific.** The provider hardcodes `true` (`:1174`); standalone must keep `ptyReady` (`bootstrap.ts:370`, `:399`, resolved at `:521`). Overriding a provider-produced field is the one place this plan deliberately keeps a standalone-only value — mark it as such so the parity guard reads it as a decision.
- **The theme entry is not produced by `getFullStateMessages`.** It is posted separately at `KanbanProvider.ts:7403` (`{ type: 'switchboardThemeNameSetting', theme: currentTheme }`). Standalone must keep emitting it, but from the resolved setting rather than `'afterburner'`, and **it is tagged `SURFACES.common`** — so this is the only entry in the payload whose value reaches *every* standalone panel, not just the board. Fall back to `'afterburner'` explicitly and comment the fallback so a future reader (and the parity guard) does not mistake a deliberate default for a reinstated hardcode.
- **Async assembly and broadcast ordering.** `getFullStateMessages` is `async` and internally awaits column building, project-context resolution and DB reads. `pushFullState` broadcasts its array in order (`bootstrap.ts:372-374`) and the board expects `updateColumns` before `updateBoard`. Preserve array order; do not parallel-map the broadcast.
- **Autoban entries newly appear.** `getFullStateMessages` conditionally spreads `updateAutobanConfig` and `updatePairProgrammingMode` when `this._autobanState` is set (`:1179-1184`). Standalone has never sent these. Confirm the board's handlers for both are safe when they arrive in the browser, and that an absent `_autobanState` (the likely standalone case) correctly yields no entry rather than `state: undefined`.
- **Newly-live behaviour, not just newly-correct display.** Repo-scope filtering becoming real changes *which cards the browser board shows*; CLI triggers becoming real means drag-dispatch in the browser can now launch terminal agents; `projectContextEnabled` becoming real can change generated prompts for browser-initiated dispatches; routing becoming real can land dispatched cards in a different coder column. Each is the intended fix and each is a visible behavioural change for existing standalone users. Release-note them together.

## Edge-Case & Dependency Audit

**Race Conditions**
- The post-verb coalesced push (`bootstrap.ts:420-436`) flips role: today it is the mechanism that *reverts* every toggle; after this change it is the mechanism that *delivers* them. Its trailing-edge/chained semantics are unchanged.
- `pushFullState`'s `if (!server) { return; }` guard (`:346`) must survive: `getFullStateMessages` can be called during the boot scan before `server` exists. Keep the guard ahead of the delegation.
- `ptyReady` is declared at `:521`, after `pushFullState`/`getFullState` are defined at `:342`/`:380`. This is safe only because both are called after boot completes — the `!server` guard is what makes it safe. Do not move the delegation ahead of that guard.

**Security** — no new endpoint, no new verb, no allowlist change. All reads are of workspace configuration the host already holds. Control-plane roots are filesystem paths the host already knows.

**Side Effects**
- A user of the standalone host with custom columns, hidden roles, a reordered board, a non-Afterburner theme, a repo-scope filter or configured routing will see the browser board change on first load after this lands. That is the fix.
- A custom column whose `kind` is not handled by a `switch` in `kanban.html` would newly reach the browser. Audit `kind` switches for a `default` arm before shipping.
- The theme entry is `SURFACES.common`: fixing it re-themes every standalone panel, not just the board.
- Deleting bootstrap's `setProjectFilter` arm makes the standalone project filter persist across restarts (it previously did not). Desirable, and a behaviour change.

**Dependencies & Conflicts**
- Serialises against any other work in `bootstrap.ts` (PRD orchestration discipline: one agent stream per provider file).
- Sequencing only, no code dependency: land after `standalone-push-parity-guard.md` so this plan's completion is demonstrated by a baseline dropping rather than by another manual assessment.

## Dependencies

- None (hard). Sequencing: after `standalone-push-parity-guard.md`; independent of `restore-backlog-view-to-standalone-host.md`.

## Adversarial Synthesis

**Risk Summary.** The largest risk is that delegation silently regresses the two fields `bootstrap.ts` legitimately owned — `projectFilter` (a shadowing closure variable the provider never sees) and `dispatchAnalyzeAvailable` (`ptyReady`, which the provider hardcodes `true`) — turning a fabricated-value fix into a fabricated-value bug wearing a different hat. Secondary risks are broadcast-path scope collapse (the singleton value delivered to project-scoped clients unless factories are used) and unaudited newly-arriving message types (`updateAutobanConfig`, `updatePairProgrammingMode`) reaching a browser board that has never received them. Mitigations: resolve all three state-ownership conflicts explicitly in the same change, use scoped-payload factories on the broadcast path exactly as `KanbanProvider.ts:2025-2046` does, and assert per-field in a headless test rather than eyeballing the payload.

## Proposed Changes

### `src/standalone/bootstrap.ts`
- **Context:** The standalone composition root; owns both board state builders and the coalesced push.
- **Logic:**
  - Replace the hand-built array in `pushFullState` (`:365-371`) and `getFullState` (`:394-400`) with `await kanbanProvider.getFullStateMessages(workspaceRoot, scope)`.
  - Append the `switchboardThemeNameSetting` entry (`SURFACES.common`) from the resolved theme setting, with an explicit, commented `'afterburner'` fallback.
  - Override `dispatchAnalyzeAvailable` on the `updateBoard` entry with `ptyReady`, commented as the deliberate standalone-only value.
  - Thread the connection scope: `getFullState(scope)` passes `scope` through; `pushFullState` broadcasts scoped-payload **factories** for the scope-dependent entries so `wsHub.broadcast` renders per declared scope.
  - Delete the shadowing `case 'setProjectFilter'` arm (`:816-819`) and the `projectFilter` closure variable (`:333`); repoint `:883` and `:1090` at `kanbanProvider.getProjectFilter()`.
- **Edge Cases:** Keep the `!server` guard ahead of the delegation; preserve `updateColumns` → `updateBoard` ordering; `_projectFilter` defaults to `'__unassigned__'`, not `null`.

### `src/services/KanbanProvider.ts`
- **Context:** Shared provider driving both hosts.
- **Logic:** No new accessors are expected — `getFullStateMessages`, `getProjectFilter`, `getControlPlaneSelectionStatus`, `_routingMapForScope` and `_cliTriggersForScope` are all already `public`. If the theme resolution used at `:7403` is not reachable publicly, expose that one and only that one. **Do not** add the per-field accessors the five superseded plans proposed — they are dead once the delegation lands.
- **Edge Cases:** Any accessor added here must be a wrapper over the existing derivation, never a reimplementation.

### `src/services/LocalApiServer.ts`
- **Logic:** Tighten the `getFullState` option type from `() => Promise<any>` (`:325`) to `(scope?: string | null) => Promise<any>` to match what `wsHub` actually calls (`wsHub.ts:95`, `:254`).

### `scripts/standalone-parity-allowlist.json`
- **Logic:** Record the two fields standalone deliberately keeps host-specific — `dispatchAnalyzeAvailable` (gated on `ptyReady`, not the provider's unconditional `true`) and the theme fallback — each with its one-line justification, so the parity guard reads them as decisions rather than residue.

## Verification Plan

Per `CLAUDE.md`, testing is via an installed VSIX / the running standalone host; `dist/` is not exercised in development. This session skips compilation and automated test execution — the automated checks below are specified for the implementing change, not run here.

### Automated (to be added by the implementing change)
1. `getFullState()`'s `updateColumns` entry reflects a custom column present in workspace config, and omits a role hidden via `visibleAgents`.
2. `getFullState()`'s `updateBoard.routingConfig` reflects configured routing rather than `{}`.
3. `getFullState()`'s `cliTriggersState.enabled` reflects the configured setting rather than a constant `false`.
4. `getFullState()`'s `updateWorkspaceSelection` reflects a configured repo-scope filter and a real `projectContextEnabled` rather than `null` / `false`.
5. `getFullState()`'s `workspaces` items carry a `workspaceRoot` key (not `value`).
6. The theme entry reflects a configured non-default theme, and resolves to `'afterburner'` — not `undefined` — when the setting is absent.
7. `dispatchAnalyzeAvailable` is `false` when `ptyReady` is false, proving the standalone override survived delegation.
8. `getFullState(scope)` with a declared project scope returns scope-resolved `routingConfig` and `cliTriggersState`, differing from the `undefined`-scope result when the two tiers differ.
9. Project filter round-trip: `setProjectFilter` via the verb rail, then `getFullState()` reports it — guarding the shadowing-arm removal.
10. Guard: `standalone-parity:check`'s hardcoded-field baseline drops to its post-delegation floor in the same change.

### Manual (standalone host in a browser)
1. **Custom column appears** — create one in the editor, reload the browser board; then create one *from* the browser and confirm it appears without a manual reload.
2. **Visibility respected** — hide a role; its column disappears from the browser board; unhide, it returns.
3. **Order and label respected** — reorder and rename; the browser matches the editor.
4. **Delete / restore defaults** behave identically in both hosts.
5. **Routing** — configure complexity routing in the editor, reload the browser: the Planned-column toggle reflects real state. Toggle from the browser: it survives a reload instead of reverting after ~40 ms. Dispatch a low-complexity plan with routing on → Coder column; with routing off → Lead Coder.
6. **CLI triggers** — enable in the editor, reload the browser: the control shows enabled. Toggle from the browser: state survives a reload. With node-pty available, drag-dispatch launches a terminal agent; with node-pty unavailable the affordance fails closed (no dead click).
7. **Theme** — set a non-Afterburner theme; the browser board renders in it, **and so do the other standalone panels** (`SURFACES.common`). Clear the setting → falls back to Afterburner with no console error.
8. **Repo scope** — set a repo-scope filter in the editor, reload the browser: the board shows the scoped card set, matching the editor. Clear it: the full set returns.
9. **Project context** — with it enabled, dispatch a card from the browser and confirm the generated prompt matches the editor's for the same card.
10. **Project filter** — select a project in the browser, confirm the card set filters, restart the standalone host, and confirm the selection persisted (new behaviour).
11. **Workspace dropdown** — confirm the workspace selector populates and its project sub-list resolves (the `value` → `workspaceRoot` shape fix).
12. **No unexplained literals remain** — read the final payload construction; every constant carries a stated reason and an allowlist entry.
13. **No collateral breakage** — exercise the board broadly (move cards, create a feature, complete a plan) and confirm the newly-arriving `updateAutobanConfig` / `updatePairProgrammingMode` messages produce no console error or spurious UI action.
14. **Extension unaffected** — repeat the editor-side equivalents; no regression.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The delegation itself is a deletion, but it is only correct once three state-ownership conflicts (project filter, workspace-item shape, DB handle) and two deliberate host-specific overrides (`ptyReady`, theme fallback) are resolved in the same change — and getting the scope threading wrong reintroduces a fabricated-value bug on the broadcast path.
