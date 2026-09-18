# Remote Sync Refactor (3/3): Config Consolidation + Remote-Tab Ingest/Full UX

> **Scope update (2026-07-01):** The Remote-tab UX built here targets the Remote tab's **new home in `project.html`** — so the Project Context Hub epic's STEP 0 (lock project.html IA) must land first. The consolidated config contract is **smaller than originally scoped** — the audit found remote-control config is already a single blob (~2 surfaces, not 4). The dependent epics add only a few keys (startup reconcile, auto-archive rule, project-context sync). Since the remote-sync surface is **experimental/unshipped, this is a clean break — no migration** (disregard the body's ~4,000-install migration language). See `feature_plan_20260701_remote-control-production-sequencing.md`.

## Goal

Collapse the scattered sync config into **one per-board sync contract**, reconcile the two overlapping pull loops, and ship the **Remote-tab UX** the whole refactor was for: an **Ingest | Full** mode radio plus **comment polling** and **push** controls that the declared-capability matrix can honestly enable, disable, or gray out per provider. Because plans 1–2 made push real and provider-symmetric, **no toggle lies**.

### Core problem & background

The original request was a lightweight remote model — an *ingest-biased* mode where the remote is just a plan source and local Automation does the reacting, versus *full* remote control. The clean user-facing model is two modes (Ingest, Full) with two addons (push, comments). That model is correct but couldn't be shipped because push wasn't a Remote-tab concept (full analysis: `docs/remote_sync_architecture_refactor_analysis.md`). Plans 1–2 fix that. This plan delivers the UX on top.

The blocker this plan removes is **config fragmentation** — at least four surfaces touch sync with no single source of truth:

- `remote.config` (Remote tab, per-workspace DB) — provider, boards, silentSync, ping frequency (poll).
- `realTimeSyncEnabled` (Setup, global JSON `~/.switchboard/integration-config.json`) — whether push runs at all, per Linear/ClickUp service.
- `completeSyncEnabled` (Setup / Linear config, global JSON) — whether terminal-column status push runs.
- Auto-Pull modal (`kanban.html:3069`) — a **separate** background pull + interval, distinct from the Remote-tab ping loop.

A user reasoning about "is my board syncing, and which way?" must consult four places, two of which aren't even on the Remote tab.

### Root cause

Each capability was added in its own layer with its own config home, and the two pull mechanisms (Remote-tab ping vs. Auto-Pull modal) were never reconciled. The behavioral gates (mode = skip `_applyStateMirror`; comments = skip `_pollComments`) are individually trivial single-service changes in `RemoteControlService`; the real work is unifying config and not breaking ~4,000 existing installs.

## Metadata

- **Tags:** [backend, frontend, ui, refactor, reliability]
- **Complexity:** 8

## User Review Required

Yes — three decisions need review:

1. **Two pull loops are NOT redundant**: Code exploration confirms the Remote-tab ping loop (`RemoteControlService._poll()`, `:192`, 30–120s interval) does **state mirroring + comment polling** for existing linked plans, while the Auto-Pull modal (`IntegrationAutoPullService`, 5–60min interval) does **issue import** — discovering new tasks from ClickUp/Linear and creating local plans. They serve **different purposes**. The original plan says "fold into one" — but merging them would conflate two distinct behaviors. **Recommendation**: keep them as separate mechanisms but surface both in the Remote tab's unified config. The "reconcile" should mean "unify the config surface," not "merge the loops." Confirm this interpretation.

2. **Config storage location**: `remote.config` lives in per-workspace DB (`kanban.db` config table), while `realTimeSyncEnabled` / `completeSyncEnabled` live in machine-global JSON (`~/.switchboard/integration-config.json`). The new per-board sync contract should live in the **per-workspace DB** (same as `remote.config`), since sync settings are per-board. But this means the migration must read from **two different storage layers** (DB + global JSON) and write to one (DB). Confirm this is acceptable.

3. **`completeSyncEnabled` mapping**: This flag gates terminal-column (DONE/COMPLETED/ARCHIVED) status push. In the new contract, there's no explicit "push terminal columns" toggle. Options: (a) fold it into the `push` toggle (push = push all columns including terminal), (b) add a `pushTerminalColumns` sub-toggle, (c) keep it as a hidden behavior with no UI (always on). **Recommendation**: option (a) — the `push` toggle covers all columns; users who want to suppress terminal-column push can disable push entirely. This simplifies the UX. Confirm this is acceptable, noting that Linear users with `completeSyncEnabled = false` will see a behavior change (terminal columns now pushed) unless they disable push.

## Complexity Audit

### Routine
- Adding `mode: 'ingest' | 'full'` field to the sync contract and gating `_applyStateMirror` (`RemoteControlService.ts:288`) on it — single if-check
- Adding `comments: boolean` field and gating `_pollComments` (`RemoteControlService.ts:316`) on it — single if-check
- Adding the Ingest | Full radio + comment-polling toggle + push control to the Remote tab HTML (`kanban.html:2547-2620`)
- Graying out controls based on `provider.capabilities` (e.g., Full mode disabled for push-only providers, push toggle disabled for pull-only providers)

### Complex / Risky
- **Config consolidation migration (~4,000 installs)**: Must read `remote.config` from per-workspace DB, `realTimeSyncEnabled` / `completeSyncEnabled` from global JSON, and Auto-Pull config from global JSON — then map to one per-board contract in the DB. The migration runs on first load after upgrade. Must handle: (a) users who never set `realTimeSyncEnabled` (defaults differ: Linear `false`, ClickUp `false`), (b) users who set it on one service but not the other, (c) multiple workspaces sharing one global JSON, (d) the `completeSyncEnabled` default difference (Linear `true`, ClickUp `false`).
- **Two storage layers → one**: The migration reads from global JSON (`GlobalIntegrationConfigService.loadConfig()`) and per-workspace DB (`db.getConfig('remote.config')`), then writes the merged contract to the DB. Legacy global JSON keys must be archived (not deleted) per CLAUDE.md migration rules.
- **Auto-Pull modal integration**: The Auto-Pull modal (`kanban.html:3069-3097`) has its own state (`integrationState` at `:3787`), save handler (`:4411`), and message handler (`KanbanProvider.ts:5754`). Folding its config into the Remote tab means either (a) moving its controls to the Remote tab, or (b) keeping the modal but reading/writing through the unified contract. Option (b) is less disruptive.
- **`RemoteProviderKind` and ClickUp**: The Remote tab provider selector (`kanban.html:2564`) offers Linear/Notion only. ClickUp is push-only and not a Remote-tab control provider. The new push control must work for ClickUp users even though ClickUp isn't in the provider dropdown — ClickUp push is configured through Setup, not the Remote tab. The unified contract must accommodate this asymmetry.
- **Setup screen changes**: `realTimeSyncEnabled` / `completeSyncEnabled` checkboxes in Setup (`setup.html:2615-2638`) must either be removed (replaced by Remote-tab controls) or kept as a secondary config surface. Removing them is cleaner but changes the Setup flow for existing users.

## Edge-Case & Dependency Audit

### Race Conditions
- **Migration on first load**: If the user opens a workspace while the migration is running, the old config may be partially read. The migration must be atomic — read all sources, compute the new contract, write it in one `setConfig` call. Use a `syncContractMigrated` flag in the DB to prevent re-running.
- **Config change during active poll**: If the user switches mode from Full to Ingest while `_poll()` is mid-`_applyStateMirror`, the in-flight mirror completes but the next poll respects the new mode. This is safe — the mode check is at the top of each poll cycle.
- **Push toggle change during active push**: If the user disables push while a `debouncedSync` is pending, the debounce fires but the provider's `pushState` should check the push flag. **Recommendation**: check the push flag at the trigger site (in `_queueLinearSync` / `_queueClickUpSync` / `ContinuousSyncService`), not inside the provider — this is where `realTimeSyncEnabled` is checked today.

### Security
- No new credential handling. The unified contract stores behavior toggles, not credentials. Credentials remain in `SecretStorage` and `GlobalIntegrationConfigService`.

### Side Effects
- **Removing Setup checkboxes**: If `realTimeSyncEnabled` / `completeSyncEnabled` checkboxes are removed from Setup (`setup.html:2615-2638`), users who go to Setup to configure push will find it gone. The Setup summary rendering (`:2643-2717`) must be updated to point users to the Remote tab.
- **Global JSON legacy keys**: `realTimeSyncEnabled` / `completeSyncEnabled` in `~/.switchboard/integration-config.json` must be preserved (archived) after migration — not deleted. The `GlobalIntegrationConfigService` should keep reading them for backward compatibility, but the Remote tab becomes the source of truth.
- **Auto-Pull modal orphaning**: If the Auto-Pull modal's controls are moved to the Remote tab, the modal HTML (`kanban.html:3069-3097`) and its JS (`:4388-4423`) become dead code. Either remove them or keep the modal as a secondary surface that reads/writes through the unified contract.
- **Default mode change**: Existing users with `realTimeSyncEnabled = true` (push active) will be migrated to `mode: 'full'` (to preserve their push behavior). New users default to `mode: 'ingest'`. This means existing push users see no behavior change, but new users get the lighter Ingest mode by default.

### Dependencies & Conflicts
- **Plan 1** (provider capabilities + unified push) — **hard dependency**. The `capabilities` field on each provider is what gates the UI controls.
- **Plan 2** (Notion push) — **hard dependency**. The push control must be honest for all providers; if Notion push doesn't exist, the push toggle lies for Notion.
- **`GlobalIntegrationConfigService`** (`src/services/GlobalIntegrationConfigService.ts`) — reads/writes global JSON. The migration reads from this; the unified contract may still write to it for backward compat.
- **`IntegrationAutoPullService`** (`src/services/IntegrationAutoPullService.ts`) — the Auto-Pull background loop. Must be reconfigured to read from the unified contract instead of its own config.
- **`KanbanDatabase.migrateJsonFileToConfig`** (`:3034-3057`) — the established migration pattern (rename to `.migrated.bak`). The config migration should follow this pattern for any file-based legacy config.

## Dependencies

- **Plan 1** (provider capabilities + unified push) and **Plan 2** (Notion push) — both required. The push control and per-provider mode gating are only honest once push is real and symmetric across providers.

## Adversarial Synthesis

Key risks: (1) the two pull loops serve different purposes (state mirroring vs. issue import) — "folding into one" would conflate distinct behaviors and break Auto-Pull users; (2) the migration reads from two storage layers (per-workspace DB + global JSON) with different default values per service (Linear `completeSyncEnabled: true`, ClickUp: `false`), creating a mapping ambiguity when the board's provider isn't the same as the service whose flag was set; (3) removing Setup checkboxes changes the configuration flow for ~4,000 existing users who learned to configure push in Setup. Mitigations: keep the loops separate and unify only the config surface; map per-service flags to the contract based on the board's active provider; keep Setup checkboxes as a secondary surface (read-only summary pointing to Remote tab) rather than removing them outright.

## Proposed Changes

### `src/services/RemoteControlService.ts` (`:34-45`, `:288`, `:316`)
- **Context**: `RemoteConfig` interface at `:34-45` defines `{ provider, boards, silentSync, pingFrequencySeconds }`. `_applyStateMirror` at `:288` mirrors remote state changes. `_pollComments` at `:316` polls comments. `getConfig()` at `:92` reads from DB key `'remote.config'`.
- **Logic**:
  1. **Extend `RemoteConfig`** to include `mode: 'ingest' | 'full'`, `push: boolean`, `comments: boolean`. Keep existing fields. The new shape: `{ provider, boards, silentSync, pingFrequencySeconds, mode, push, comments }`.
  2. **Gate `_applyStateMirror`** (`:288`): Add `if (config.mode === 'ingest') { return; }` at the top of `_pollState` (or before calling `_applyStateMirror`). In Ingest mode, state *import* (`_pollState` → `importRemotePlan`) still runs, but state *mirror* (column move + agent dispatch) is skipped.
  3. **Gate `_pollComments`** (`:316`): Add `if (!config.comments) { return; }` at the top of `_pollComments`.
  4. **Gate push at trigger sites**: The `push` flag is checked at the push trigger sites (see KanbanProvider and ContinuousSyncService changes below), not in `RemoteControlService`.
  5. **Update `getConfig()`** (`:92`) and `setConfig()` (`:111`) to handle the new fields with defaults: `mode: 'ingest'`, `push: false`, `comments: true` (comments default on to preserve current behavior).
- **Edge Cases**: 
  - In Ingest mode, `_pollState` still imports new remote plans (items with no local plan). Only the state *mirror* (existing plan column changes) is skipped.
  - The `silentSync` field is preserved — it controls whether sync runs while pinging is off. It's orthogonal to mode.

### `src/services/KanbanProvider.ts` (`:1892`, `:1924`, `:5754`)
- **Context**: Push trigger sites `_queueClickUpSync` (`:1892`) and `_queueLinearSync` (`:1924`) check `realTimeSyncEnabled` from the per-service config. Auto-Pull message handler at `:5754`.
- **Logic**:
  1. **Replace `realTimeSyncEnabled` check** in `_queueLinearSync` (`:1931`) and `_queueClickUpSync` (`:1904`) with a check against the unified contract's `push` field. Read the contract from `RemoteControlService.getConfig()` (or the DB). If `push === false`, skip. If `push === true`, proceed to `provider.pushState`.
  2. **Keep `completeSyncEnabled` logic** inside `syncPlan` (it's a sub-gate of push for terminal columns). Per User Review Required decision 3, if option (a) is chosen, `completeSyncEnabled` is effectively always `true` when `push` is `true` — but the gate inside `syncPlan` can remain as a no-op (always passes) or be removed.
  3. **Auto-Pull message handler** (`:5754`): Update to read/write through the unified contract. The Auto-Pull toggle and interval become part of the contract (or a separate section of it). The `IntegrationAutoPullService` is reconfigured from the contract, not from per-service config.
- **Edge Cases**: If the unified contract doesn't exist yet (pre-migration), fall back to reading `realTimeSyncEnabled` from the per-service config. This ensures no breakage during the migration window.

### `src/services/ContinuousSyncService.ts` (`:847`, `:874`)
- **Context**: `_syncToClickUp` (`:847`) and `_syncToLinear` (`:874`) check `realTimeSyncEnabled` from per-service config.
- **Logic**: Replace the `realTimeSyncEnabled` check with a check against the unified contract's `push` field. If `push === false`, skip content sync.
- **Edge Cases**: Same fallback as KanbanProvider — if contract doesn't exist, fall back to `realTimeSyncEnabled`.

### `src/webview/kanban.html` (`:2547-2620`, `:3069-3097`)
- **Context**: Remote tab UI at `:2547-2620` with provider selector, boards, silentSync, ping controls. Auto-Pull modal at `:3069-3097`. Config collection JS at `:7044` (`remoteCollectConfig`).
- **Logic**:
  1. **Add Ingest | Full radio** to the Remote tab (after the provider selector, `:2567`). Two radio buttons: "Ingest" (default) and "Full".
  2. **Add comment-polling toggle** (checkbox, after the silentSync checkbox, `:2583`). Label: "Poll comments". Default: checked.
  3. **Add push toggle** (checkbox, after the comment toggle). Label: "Push status & content to remote". Default: unchecked. **Disabled and grayed out** if `provider.capabilities.push === false`.
  4. **Gray out Full mode** if the provider doesn't support pull (`capabilities.pull === false`) — though ClickUp isn't in the provider dropdown, so this is defensive.
  5. **Update `remoteCollectConfig()`** (`:7044`) to include `mode`, `push`, `comments` in the returned config object.
  6. **Update `renderRemoteConfig()`** (`:6990`) to populate the new controls from config and apply capability-based disabling.
  7. **Auto-Pull modal**: Either (a) move the Auto-Pull toggle + interval into the Remote tab as an "Import" section, or (b) keep the modal but have it read/write through the unified contract. **Recommendation**: option (b) — less disruptive, keeps the modal for users who know it.
- **Edge Cases**: No confirmation dialogs (house rule). All toggles apply immediately via the existing autosave mechanism (`:7070`).

### `src/webview/setup.html` (`:2615-2638`, `:2643-2717`)
- **Context**: Setup checkboxes for `realTimeSyncEnabled` and `completeSyncEnabled` at `:2615-2638`. Summary rendering at `:2643-2717`.
- **Logic**:
  1. **Keep the checkboxes** but make them **read-only** (or add a note: "Push is now configured on the Remote tab"). The checkboxes still reflect the current state but changes are made on the Remote tab.
  2. **Update the summary** (`:2643-2717`) to say "Configure push on the Remote tab" instead of showing the checkbox state.
  3. **Alternatively**: Remove the checkboxes entirely and replace with a text note. This is cleaner but changes the Setup flow.
- **Edge Cases**: If keeping checkboxes read-only, ensure the setup save handler doesn't overwrite the unified contract's `push` field.

### Migration: `src/services/KanbanDatabase.ts` (`:3034-3057`) + `src/services/RemoteControlService.ts`
- **Context**: The established migration pattern (`migrateJsonFileToConfig`, `:3034-3057`) renames legacy files to `.migrated.bak`. Config is stored in DB (`getConfig`/`setConfig`, `:2982-3010`).
- **Logic**:
  1. **On extension activation** (in `KanbanProvider` or `RemoteControlService` init), check if `syncContractMigrated` flag exists in DB.
  2. **If not migrated**:
     a. Read old `remote.config` from DB: `db.getConfig('remote.config')` → parse to get `{ provider, boards, silentSync, pingFrequencySeconds }`.
     b. Read `realTimeSyncEnabled` from global JSON: `GlobalIntegrationConfigService.loadConfig('linear')` / `loadConfig('clickup')` → get `realTimeSyncEnabled` for the board's provider.
     c. Read `completeSyncEnabled` from global JSON: same service config.
     d. Read Auto-Pull config from global JSON: `autoPullEnabled`, `pullIntervalMinutes`.
     e. **Map to new contract**:
        - `mode`: if `realTimeSyncEnabled === true` → `'full'` (preserve push behavior); else → `'ingest'`.
        - `push`: `realTimeSyncEnabled === true`.
        - `comments`: `true` (comments were always on — no existing toggle to read from).
        - Keep `provider`, `boards`, `silentSync`, `pingFrequencySeconds` from old `remote.config`.
        - Add `autoPullEnabled`, `pullIntervalMinutes` from Auto-Pull config (or keep separate).
     f. **Write new contract** to DB: `db.setConfig('remote.config', JSON.stringify(newContract))`.
     g. **Set migration flag**: `db.setConfig('syncContractMigrated', 'true')`.
     h. **Archive legacy keys**: Do NOT delete `realTimeSyncEnabled` / `completeSyncEnabled` from global JSON. Mark them as migrated by setting a `migrated` flag in the global JSON, or simply leave them — the code now reads from the contract, not from these keys.
  3. **If already migrated**: Read the unified contract from DB. Ignore legacy keys.
  4. **Edge Cases**:
  - **No existing `remote.config`**: User never configured the Remote tab. Create a default contract: `{ provider: 'linear', boards: [], silentSync: false, pingFrequencySeconds: 60, mode: 'ingest', push: false, comments: true }`.
  - **`realTimeSyncEnabled` set on both Linear and ClickUp**: Use the flag from the service matching the board's `provider` field. If provider is `'notion'`, default `push: false` (Notion push didn't exist before this refactor).
  - **Multiple workspaces**: Each workspace has its own DB, so the migration runs per-workspace. The global JSON is shared, but the migration reads the relevant service's flag based on each workspace's `provider`.
  - **Corrupt or missing global JSON**: If `GlobalIntegrationConfigService.loadConfig()` returns null, default `push: false`, `mode: 'ingest'`.

## Verification Plan

### Automated Tests
- **Skipped per session directive** — the test suite will be run separately by the user.

### Manual Verification
- **Migration verification**: On a workspace with existing `remote.config` and `realTimeSyncEnabled = true`:
  1. Upgrade to the new version.
  2. Confirm the migration runs on first load (check for `syncContractMigrated` flag in DB).
  3. Confirm the new contract has `mode: 'full'`, `push: true` (preserving the user's push behavior).
  4. Confirm legacy global JSON keys are preserved (not deleted).
- **Ingest mode verification**:
  1. Set mode to Ingest on the Remote tab.
  2. Change a card's column in the remote (Linear/Notion).
  3. Confirm the next poll imports the plan if it's new (state import still works).
  4. Confirm the poll does NOT mirror the column change locally (state mirror skipped).
  5. Confirm comments still poll (if comments toggle is on).
- **Full mode verification**:
  1. Set mode to Full.
  2. Change a card's column in the remote.
  3. Confirm the poll mirrors the column change and dispatches the agent.
- **Push toggle verification**:
  1. Disable push on the Remote tab.
  2. Move a card locally.
  3. Confirm no push fires to the remote.
  4. Enable push.
  5. Move a card locally.
  6. Confirm the push fires.
- **Capability gating verification**:
  1. Select Notion as provider.
  2. Confirm the push toggle is enabled (Notion now has `push: true` after Plan 2).
  3. Confirm Full mode is enabled.
  4. (If ClickUp were in the dropdown) Confirm Full mode is grayed out for ClickUp (pull: false).
- **Auto-Pull verification**:
  1. Confirm the Auto-Pull modal still works (if kept as secondary surface).
  2. Confirm Auto-Pull config is read from / written to the unified contract.
- **No confirmation dialogs**: Confirm all toggles apply immediately with no `confirm()` or modal gate.
- **TypeScript compilation**: Skipped per session directive.

## Uncertain Assumptions

None — all config storage mechanisms, flag locations, UI structure, and migration patterns have been verified against the current source. The two-pull-loop finding (they serve different purposes) is confirmed by code exploration and is addressed in User Review Required.

## Decisions (already settled — do not re-litigate)

- **Refactor-first, no stopgap.** Do not ship the ingest/full toggle before plans 1–2 land; a premature toggle would present a push story that's a dead end for Notion.
- **Default mode is Ingest.**
- **ClickUp stays push-only** — it never appears as a Remote-tab control provider; the capability matrix grays it out of Full/pull honestly.
- **No confirmation dialogs** anywhere in the new UI (house rule; `confirm()` is also a silent no-op in webviews).

## Dependencies

- **Plan 1** (provider capabilities + unified push) and **Plan 2** (Notion push) — both required. The push control and per-provider mode gating are only honest once push is real and symmetric across providers.

## Source

Derived from `docs/remote_sync_architecture_refactor_analysis.md` (Sequencing → Plan 3; open questions #3, #5). Base-level plan — run `/improve-plan` to deepen before execution.

## Recommendation

Complexity 8 → **Send to Lead Coder**. The config consolidation touches four config surfaces across two storage layers, carries a ~4,000-install migration with per-service default differences, and ships new UI with capability-based gating. The behavioral gates themselves are trivial, but the migration and config unification require careful coordination and migration testing. A lead coder with migration experience should execute this plan.
