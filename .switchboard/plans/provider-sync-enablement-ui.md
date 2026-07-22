---
description: "Expose the provider-sync opt-in flags in the setup UI so the (already-built, correct, but dormant) Provider Sync — Full Parity engine can actually be turned on. Add setup.html toggles + handler wiring for Notion realTimeSync/deleteSync/inboundDelete and ClickUp/Linear inboundDelete, and repair the broken ClickUp deleteSync wiring (Linear deleteSync already works). Standalone follow-on to the Provider Sync feature — NOT one of its subtasks."
---

# Provider Sync — Enablement UI (opt-in toggles for full parity)

## Goal

Give the user a way to turn on the Provider Sync — Full Parity capabilities. The sync engine (Notion outbound create/archive/push, all-three simultaneous push, and inbound-delete reconcile-sweep) is merged, reviewed, and correct — but **inert**, because none of its opt-in flags has a setter. This plan adds the setup-UI toggles and their handler wiring so the flags can be flipped to `true`, keeping every capability opt-in and default-off (the ~4,000 existing installs stay unchanged until a user enables them).

### Core problem / root cause (verified against merged source, 2026-07-21; re-verified 2026-07-22)

The provider-sync review found the engine complete but unreachable. The gating flags are only ever **read** (config load) or **preserved-on-rerun** — never written to `true` by any UI or message handler:

- **Notion `realTimeSyncEnabled` / `deleteSyncEnabled` / `inboundDeleteEnabled`** ([notionRemoteConfig.ts:31-43](../../src/services/remote/notionRemoteConfig.ts#L31)) — `saveNotionRemoteSetup` is only ever called with `{plansDatabaseId, commentsDatabaseId, botId}` ([NotionBackupService.ts:370](../../src/services/NotionBackupService.ts#L370)); Notion has **no** sync-options toggles in `setup.html` at all.
- **ClickUp / Linear `inboundDeleteEnabled`** ([ClickUpSyncService.ts:44](../../src/services/ClickUpSyncService.ts#L44), [LinearSyncService.ts:34](../../src/services/LinearSyncService.ts#L34)) — added to the config interface + `loadConfig` parse, but never mapped from any setup message.
- **ClickUp / Linear `deleteSyncEnabled`** — checkboxes exist ([setup.html:2798](../../src/webview/setup.html#L2798), [:2818](../../src/webview/setup.html#L2818)) and are sent in the setup message, but the only `config.deleteSyncEnabled` assignments found in the handler hardcode `false` (the Bug-Triage path, [TaskViewerProvider.ts:6174](../../src/services/TaskViewerProvider.ts#L6174)/[:6214](../../src/services/TaskViewerProvider.ts#L6214)). The end-to-end wiring for the existing delete-sync checkbox is **suspect** and must be confirmed (and repaired if broken) before layering inbound-delete beside it.

> **Superseded:** "The end-to-end wiring for the existing delete-sync checkbox is suspect and must be confirmed (and repaired if broken)" — treated as symmetric across ClickUp and Linear.
> **Reason:** Re-verification (2026-07-22) settles it asymmetrically: **ClickUp `deleteSyncEnabled` is confirmed broken**, **Linear `deleteSyncEnabled` is confirmed working**. The ClickUp checkbox value is collected at setup.html:2798 and sent in the `applyClickUpConfig` message, but `ClickUpApplyOptions` ([ClickUpSyncService.ts:124-131](../../src/services/ClickUpSyncService.ts#L124)) does not include `deleteSyncEnabled`, so `handleApplyClickUpConfig` ([TaskViewerProvider.ts:5939](../../src/services/TaskViewerProvider.ts#L5939)) passes `options` without the field, and `ClickUpSyncService.applyConfig` (~[:2680](../../src/services/ClickUpSyncService.ts#L2680)) never assigns `config.deleteSyncEnabled` from it — the value dies at the interface boundary. Linear, by contrast, has `deleteSyncEnabled` in `LinearApplyOptions` ([LinearSyncService.ts:48](../../src/services/LinearSyncService.ts#L48)) and `applyConfig` assigns it at [:2146](../../src/services/LinearSyncService.ts#L2146).
> **Replaced with:** The repair is **ClickUp-specific**: add `deleteSyncEnabled` (and `inboundDeleteEnabled`) to `ClickUpApplyOptions` and assign both in `ClickUpSyncService.applyConfig`. Linear needs only `inboundDeleteEnabled` added to `LinearApplyOptions` and assigned in `LinearSyncService.applyConfig`. The hardcoded-false lines at 6174/6214 live in a **separate** function, `handleEnableTriagePipeline` (a one-click preset that intentionally disables delete-sync for the triage workflow) — leave it untouched.

Consumers that already read these flags and will light up once a setter exists: `_queueNotionSync` (realTimeSyncEnabled, [KanbanProvider.ts:2997](../../src/services/KanbanProvider.ts#L2997)); `PlanIngestionEngine.runPurgeSweep` (deleteSyncEnabled, [:485](../../src/services/PlanIngestionEngine.ts#L485)); `RemoteControlService._reconcileSweep` via `_getInboundDeleteEnabled` (inboundDeleteEnabled, [KanbanProvider.ts:2136](../../src/services/KanbanProvider.ts#L2136)).

## Metadata
- **Tags:** frontend, ui, feature, bugfix
- **Complexity:** 5

> **Superseded:** Complexity 4.
> **Reason:** Re-verification expanded the blast radius: eight files touched (`setup.html`, `TaskViewerProvider.ts`, `SetupPanelProvider.ts`, `ClickUpSyncService.ts`, `LinearSyncService.ts`, `KanbanProvider.ts`, `NotionBackupService.ts`, `notionRemoteConfig.ts`), a confirmed bugfix on a 4,000-install shipped ClickUp path, and a 3-hop boolean thread for Notion (`runNotionRemoteSetup` → `remoteRunNotionSetup` → `setupRemoteControl` → `saveNotionRemoteSetup`). Not single-file routine.
> **Replaced with:** Complexity 5 (Mixed: majority routine pattern-following + one moderate, well-scoped risk — repairing the shipped ClickUp deleteSync path).

- **Project:** Browser Switchboard
- **Release phase:** Follow-on to the merged Provider Sync — Full Parity feature. Touches the shipped setup surface (~4,000 installs) → every new toggle defaults OFF and existing ClickUp/Linear behaviour must stay byte-compatible.

## User Review Required
- **Placement of the Notion toggles:** a new "Notion remote sync options" section in `setup.html` (mirroring the ClickUp/Linear option blocks) vs. surfacing them wherever Notion remote control is configured today. Recommend mirroring the existing ClickUp/Linear option-block pattern for consistency. Decide before build.

## Scope

### ✅ IN SCOPE
- **Notion sync-options toggles:** add `realTimeSyncEnabled`, `deleteSyncEnabled`, `inboundDeleteEnabled` checkboxes to `setup.html`, carried in the `runNotionRemoteSetup` message, threaded through `KanbanProvider.remoteRunNotionSetup` → `NotionBackupService.setupRemoteControl` → `saveNotionRemoteSetup` (which already preserves-on-rerun, so pass the explicit booleans).
- **ClickUp / Linear `inboundDeleteEnabled` toggle:** one checkbox each beside the existing delete-sync checkbox, mapped through the same `applyClickUpConfig` / `applyLinearConfig` message/handler that carries `deleteSyncEnabled`.
- **Repair ClickUp `deleteSyncEnabled` wiring (confirmed broken):** add `deleteSyncEnabled` to `ClickUpApplyOptions` and assign `config.deleteSyncEnabled = options.deleteSyncEnabled === true` in `ClickUpSyncService.applyConfig`. Linear `deleteSyncEnabled` already works — no change.
- **State round-trip:** extend `NotionSetupState` ([TaskViewerProvider.ts:237-239](../../src/services/TaskViewerProvider.ts#L237)) with the three flags, load `loadNotionRemoteSetup` inside `getIntegrationSetupStates` (~[:5822](../../src/services/TaskViewerProvider.ts#L5822)), and add the flags to the `notionState` push. Extend `ClickUpSetupState` / `LinearSetupState` (~[:200-235](../../src/services/TaskViewerProvider.ts#L200)) with `inboundDeleteEnabled` (and ClickUp `deleteSyncEnabled`) and surface them in the existing `clickupState` / `linearState` push at [KanbanProvider.ts:2658](../../src/services/KanbanProvider.ts#L2658)/[:2672](../../src/services/KanbanProvider.ts#L2672).

### ⚙️ OUT OF SCOPE
- Any change to the sync engine itself (create/archive/push, reconcile-sweep) — it is done and reviewed. This plan only wires the toggles.
- New default-on behaviour — every toggle ships OFF.
- Provider setup/auth flows (folder/list/database selection) beyond adding the opt-in checkboxes.
- The `handleEnableTriagePipeline` preset ([TaskViewerProvider.ts:6136-6254](../../src/services/TaskViewerProvider.ts#L6136)) — its hardcoded `deleteSyncEnabled = false` is intentional for the triage workflow; leave it untouched.

## Implementation Steps

### Step 0 — Repair ClickUp `deleteSyncEnabled` (the pattern the new toggles copy; do this first)
1. Add `deleteSyncEnabled?: boolean` and `inboundDeleteEnabled?: boolean` to `ClickUpApplyOptions` ([ClickUpSyncService.ts:124-131](../../src/services/ClickUpSyncService.ts#L124)).
2. In `ClickUpSyncService.applyConfig` (~[:2680](../../src/services/ClickUpSyncService.ts#L2680)), assign `config.deleteSyncEnabled = options.deleteSyncEnabled === true;` and `config.inboundDeleteEnabled = options.inboundDeleteEnabled === true;` beside the existing `realTimeSyncEnabled`/`autoPullEnabled` assignments.
3. Confirm the `clickup-option-delete-sync` checkbox value (collected at [setup.html:2798](../../src/webview/setup.html#L2798)) now reaches `config.deleteSyncEnabled` end-to-end via `handleApplyClickUpConfig` ([TaskViewerProvider.ts:5939](../../src/services/TaskViewerProvider.ts#L5939)) → `applyConfig`.

### Step 1 — Add ClickUp / Linear `inboundDeleteEnabled` checkboxes
1. Add a `clickup-option-inbound-delete` checkbox in `setup.html` beside `clickup-option-delete-sync` (~[:950](../../src/webview/setup.html#L950)); collect it in `collectClickupApplyOptions` (~[:2791-2802](../../src/webview/setup.html#L2791)) as `inboundDeleteEnabled`.
2. Add a `linear-option-inbound-delete` checkbox beside `linear-option-delete-sync` (~[:1155](../../src/webview/setup.html#L1155)); collect it in `collectLinearApplyOptions` (~[:2804-2822](../../src/webview/setup.html#L2804)) as `inboundDeleteEnabled`.
3. Add `inboundDeleteEnabled?: boolean` to `LinearApplyOptions` ([LinearSyncService.ts:41-51](../../src/services/LinearSyncService.ts#L41)); assign `config.inboundDeleteEnabled = options.inboundDeleteEnabled === true;` in `LinearSyncService.applyConfig` (~[:2146](../../src/services/LinearSyncService.ts#L2146)) beside the existing `deleteSyncEnabled` assignment.

### Step 2 — Add the Notion sync-options section + thread the booleans
1. Add a "Notion remote sync options" block to `setup.html` with three checkboxes: `notion-option-realtime-sync`, `notion-option-delete-sync`, `notion-option-inbound-delete` (mirror the ClickUp/Linear option-block layout).
2. Add a `collectNotionRemoteSetupOptions()` helper (mirror `collectClickupApplyOptions`) that reads the three checkboxes into `{ realTimeSyncEnabled, deleteSyncEnabled, inboundDeleteEnabled }`.
3. Update the `btn-notion-remote-setup` click handler ([setup.html:5504-5509](../../src/webview/setup.html#L5504)) to include the collected options in the `runNotionRemoteSetup` message.
4. Thread the options through the handler chain:
   - `SetupPanelProvider.ts` `case 'runNotionRemoteSetup'` (~[:1357-1365](../../src/services/SetupPanelProvider.ts#L1357)) → pass `message.options` into `remoteRunNotionSetup`.
   - `KanbanProvider.remoteRunNotionSetup` (~[:2356-2373](../../src/services/KanbanProvider.ts#L2356)) → forward `options` into `backup.setupRemoteControl(...)`.
   - `NotionBackupService.setupRemoteControl` ([NotionBackupService.ts:282-379](../../src/services/NotionBackupService.ts#L282)) → pass the three booleans into the `saveNotionRemoteSetup(kanbanDb, { plansDatabaseId, commentsDatabaseId, botId, realTimeSyncEnabled, deleteSyncEnabled, inboundDeleteEnabled })` call at [:370](../../src/services/NotionBackupService.ts#L370). `saveNotionRemoteSetup` already accepts and preserves-on-rerun these fields ([notionRemoteConfig.ts:71-101](../../src/services/remote/notionRemoteConfig.ts#L71)) — no signature change needed.

### Step 3 — Wire the state round-trip
1. Extend `NotionSetupState` ([TaskViewerProvider.ts:237-239](../../src/services/TaskViewerProvider.ts#L237)) with `realTimeSyncEnabled`, `deleteSyncEnabled`, `inboundDeleteEnabled`.
2. In `getIntegrationSetupStates` (~[:5822](../../src/services/TaskViewerProvider.ts#L5822)), load the Notion remote setup via `loadNotionRemoteSetup` and populate the three flags on `notionState` (note: these live in the **remote setup blob**, a different store than the ClickUp/Linear config — use the remote-setup load, not the integration config).
3. Extend `ClickUpSetupState` / `LinearSetupState` (~[:200-235](../../src/services/TaskViewerProvider.ts#L200)) with `inboundDeleteEnabled` (and ClickUp `deleteSyncEnabled`); surface them in the `clickupState` / `linearState` push at [KanbanProvider.ts:2658](../../src/services/KanbanProvider.ts#L2658)/[:2672](../../src/services/KanbanProvider.ts#L2672).
4. In `setup.html`, render the checkboxes' `checked` state from the pushed `notionState` / `clickupState` / `linearState` payloads on open.

### Step 4 — Verify each toggle gates its consumer
- `realTimeSync` → `_queueNotionSync` ([KanbanProvider.ts:2997](../../src/services/KanbanProvider.ts#L2997)) pushes.
- `deleteSync` (each provider) → `runPurgeSweep` ([PlanIngestionEngine.ts:485](../../src/services/PlanIngestionEngine.ts#L485)) archives.
- `inboundDelete` (each provider) → `_reconcileSweep` via `_getInboundDeleteEnabled` ([KanbanProvider.ts:2136](../../src/services/KanbanProvider.ts#L2136)) runs for that provider.

## Complexity Audit

### Routine
- Adding checkboxes to `setup.html` beside existing option blocks (pattern-copy from `clickup-option-delete-sync`).
- Collecting checkbox values into the existing apply/setup message payloads.
- Adding optional fields to `ClickUpApplyOptions` / `LinearApplyOptions` and assigning them in `applyConfig` (one-line each, beside existing assignments).
- Extending `*SetupState` types and populating the state-push objects.

### Complex / Risky
- **Repairing the shipped ClickUp `deleteSyncEnabled` path** (4,000 installs): the checkbox was already collected and sent but silently dropped at the `ClickUpApplyOptions` boundary. Repairing it changes ClickUp behaviour for any user who previously ticked the box expecting delete-sync — previously a silent no-op, now actually archives on delete. Byte-compat for users who left it OFF is preserved; users who ticked it ON get the behaviour they expected (arguably a fix, not a regression, but it is a behaviour change on a shipped path).
- **3-hop Notion boolean thread** (`runNotionRemoteSetup` → `remoteRunNotionSetup` → `setupRemoteControl` → `saveNotionRemoteSetup`): each hop currently accepts only the basic setup fields; threading new optional fields through without disturbing the existing derive-internally flow for `plansDatabaseId`/`commentsDatabaseId`/`botId`.
- **`notionState` loads from a different store** than `clickupState`/`linearState`: the Notion flags live in the remote-setup blob (`loadNotionRemoteSetup`), not the integration config — a different load call in a different branch of `getIntegrationSetupStates`.

## Edge-Case & Dependency Audit

- **Race Conditions:** Toggling a flag ON then immediately triggering a sync action before `saveNotionRemoteSetup` flushes — consumers read the flag from the **persisted** blob, so an in-flight toggle that hasn't flushed is a benign no-op (the next sync picks it up). Not a corruption risk; document as expected UX (toggle, then action).
- **Security:** No new attack surface — toggles are local-only config booleans, no network input handling added. The `runNotionRemoteSetup`/`apply*Config` messages originate from the trusted webview; no untrusted-input boundary crossed (the A2b per-verb schema validation is out of scope here).
- **Side Effects:** Repairing ClickUp `deleteSyncEnabled` activates a previously-dormant archive-on-delete for any user who had ticked the box. Mitigation: default OFF is preserved; only users who explicitly ticked the box (and previously saw no effect) are affected — they get the behaviour they requested.
- **Dependencies & Conflicts:**
  - **A2b — Host-Agnostic Verb Engine (PRD `browser-switchboard/prd.md`):** A2b refactors the `_handleMessage` arms of `SetupPanelProvider` / `TaskViewerProvider` in-place (INVERT-AND-INJECT). This plan extends the option shapes flowing through `applyClickUpConfig` / `applyLinearConfig` / `runNotionRemoteSetup` — the same arms A2b touches. **A2b's Setup/TaskViewer burndown is already in flight → this plan lands AFTER it**, on the refactored arms. The changes are additive (new optional fields on `ClickUpApplyOptions`/`LinearApplyOptions` + a new `options` arg on the Notion setup chain), so they apply cleanly to seam-injected arms; the coder must re-resolve exact line numbers against the post-A2b source. A2b's byte-compat contract is not broken either way.
  - **Provider Sync — Full Parity feature (merged):** this plan is its enablement follow-on; the engine is done and reviewed. No code dependency on unmerged work.

## Dependencies
- Provider Sync — Full Parity feature (merged, reviewed) — provides the consumers that read these flags.
- A2b Host-Agnostic Verb Engine (PRD) — in flight; this plan lands after A2b's Setup/TaskViewer burndown, on the refactored arms. See Edge-Case & Dependency Audit.

## Adversarial Synthesis
Key risks: (1) the ClickUp `deleteSyncEnabled` repair activates a previously-dormant archive-on-delete for users who had ticked the box — a behaviour change on a 4,000-install shipped path, mitigated by default-OFF preservation; (2) the Notion boolean thread is 3 hops through a message chain that today carries only `workspaceRoot` — under-specified in the original plan, now spelled out per hop; (3) `notionState` must load from the remote-setup blob, a different store than the ClickUp/Linear config the state-push pattern was built for. Mitigations: repair ClickUp first as the pattern template, thread the Notion booleans explicitly per hop, and extend `NotionSetupState` with its own `loadNotionRemoteSetup` call.

## Proposed Changes

### `src/services/ClickUpSyncService.ts`
- **Context:** `ClickUpApplyOptions` ([:124-131](../../src/services/ClickUpSyncService.ts#L124)) lacks `deleteSyncEnabled` and `inboundDeleteEnabled`; `applyConfig` (~[:2680](../../src/services/ClickUpSyncService.ts#L2680)) never assigns them. This is the confirmed-broken delete-sync path.
- **Logic:** Add `deleteSyncEnabled?: boolean` and `inboundDeleteEnabled?: boolean` to `ClickUpApplyOptions`. In `applyConfig`, assign `config.deleteSyncEnabled = options.deleteSyncEnabled === true;` and `config.inboundDeleteEnabled = options.inboundDeleteEnabled === true;` beside the existing `realTimeSyncEnabled`/`autoPullEnabled` assignments.
- **Implementation:** Two interface fields + two assignments.
- **Edge Cases:** Users who previously ticked `clickup-option-delete-sync` and saw no effect will now get archive-on-delete. Default-OFF users unaffected.

### `src/services/LinearSyncService.ts`
- **Context:** `LinearApplyOptions` ([:41-51](../../src/services/LinearSyncService.ts#L41)) has `deleteSyncEnabled` (assigned at [:2146](../../src/services/LinearSyncService.ts#L2146)) but lacks `inboundDeleteEnabled`.
- **Logic:** Add `inboundDeleteEnabled?: boolean` to `LinearApplyOptions`; assign `config.inboundDeleteEnabled = options.inboundDeleteEnabled === true;` in `applyConfig` beside the existing `deleteSyncEnabled` assignment.
- **Implementation:** One interface field + one assignment.
- **Edge Cases:** None — additive, default-OFF.

### `src/webview/setup.html`
- **Context:** ClickUp/Linear delete-sync checkboxes exist (~[:950](../../src/webview/setup.html#L950), [:1155](../../src/webview/setup.html#L1155)) and are collected (~[:2798](../../src/webview/setup.html#L2798), [:2818](../../src/webview/setup.html#L2818)). No Notion sync-options UI exists; the Notion save button dispatches only `{type:'runNotionRemoteSetup', workspaceRoot}` ([:5504-5509](../../src/webview/setup.html#L5504)).
- **Logic:**
  - Add `clickup-option-inbound-delete` + `linear-option-inbound-delete` checkboxes beside their delete-sync counterparts; collect into `collectClickupApplyOptions` / `collectLinearApplyOptions` as `inboundDeleteEnabled`.
  - Add a "Notion remote sync options" block with three checkboxes (`notion-option-realtime-sync`, `notion-option-delete-sync`, `notion-option-inbound-delete`); add `collectNotionRemoteSetupOptions()`; include the result in the `runNotionRemoteSetup` message.
  - Render all new checkboxes' `checked` state from the pushed `clickupState` / `linearState` / `notionState` payloads on open.
- **Implementation:** ~5 new checkbox elements + 1 new collect helper + 1 message-shape extension + state-render glue.
- **Edge Cases:** Toggles must default unchecked on first open (persisted flag absent → false).

### `src/services/SetupPanelProvider.ts`
- **Context:** `case 'runNotionRemoteSetup'` (~[:1357-1365](../../src/services/SetupPanelProvider.ts#L1357)) calls `remoteRunNotionSetup(message.workspaceRoot)` and ignores any options.
- **Logic:** Forward `message.options` into `remoteRunNotionSetup`.
- **Implementation:** One argument addition.
- **Edge Cases:** `message.options` may be undefined for older webview payloads — `remoteRunNotionSetup`/`setupRemoteControl` must treat undefined booleans as "preserve-on-rerun" (which `saveNotionRemoteSetup` already does).

### `src/services/KanbanProvider.ts`
- **Context:** `remoteRunNotionSetup` (~[:2356-2373](../../src/services/KanbanProvider.ts#L2356)) calls `backup.setupRemoteControl(root, boards, columns)` without sync options. `clickupState`/`linearState` push at [:2658](../../src/services/KanbanProvider.ts#L2658)/[:2672](../../src/services/KanbanProvider.ts#L2672) lacks `inboundDeleteEnabled` (and ClickUp `deleteSyncEnabled`).
- **Logic:** Forward the `options` arg through `remoteRunNotionSetup` into `setupRemoteControl`. Add `inboundDeleteEnabled` (and ClickUp `deleteSyncEnabled`) to the `clickupState`/`linearState` push objects.
- **Implementation:** One forwarded arg + two state-push field additions.
- **Edge Cases:** None — additive.

### `src/services/NotionBackupService.ts`
- **Context:** `setupRemoteControl` ([:282-379](../../src/services/NotionBackupService.ts#L282)) calls `saveNotionRemoteSetup(kanbanDb, { plansDatabaseId, commentsDatabaseId, botId })` at [:370](../../src/services/NotionBackupService.ts#L370) — no sync booleans.
- **Logic:** Accept an `options` arg on `setupRemoteControl` and pass `realTimeSyncEnabled`/`deleteSyncEnabled`/`inboundDeleteEnabled` into the `saveNotionRemoteSetup` call. `saveNotionRemoteSetup` already accepts and preserves-on-rerun these fields — no signature change to it.
- **Implementation:** One new param + three fields in the call object.
- **Edge Cases:** Undefined options → omit the fields → `saveNotionRemoteSetup` preserves existing values (no regression for callers that don't pass options).

### `src/services/TaskViewerProvider.ts`
- **Context:** `NotionSetupState` ([:237-239](../../src/services/TaskViewerProvider.ts#L237)) has only `setupComplete`; `getIntegrationSetupStates` (~[:5822](../../src/services/TaskViewerProvider.ts#L5822)) builds `notionState` from it. `ClickUpSetupState`/`LinearSetupState` (~[:200-235](../../src/services/TaskViewerProvider.ts#L200)) lack `inboundDeleteEnabled` (and ClickUp `deleteSyncEnabled`). `handleEnableTriagePipeline` ([:6136-6254](../../src/services/TaskViewerProvider.ts#L6136)) hardcodes `deleteSyncEnabled = false` at 6174/6214 — out of scope, leave untouched.
- **Logic:** Extend `NotionSetupState` with the three flags; load `loadNotionRemoteSetup` in `getIntegrationSetupStates` and populate them. Extend `ClickUpSetupState`/`LinearSetupState` with `inboundDeleteEnabled` (and ClickUp `deleteSyncEnabled`); populate from config in the existing state-build.
- **Implementation:** Type extensions + one new `loadNotionRemoteSetup` call + state-object field additions.
- **Edge Cases:** `loadNotionRemoteSetup` may return null (no remote setup yet) → flags default false.

### `src/services/remote/notionRemoteConfig.ts`
- **Context:** Interface ([:31-43](../../src/services/remote/notionRemoteConfig.ts#L31)) and `saveNotionRemoteSetup` ([:71-101](../../src/services/remote/notionRemoteConfig.ts#L71)) already accept and preserve-on-rerun the three booleans.
- **Logic:** No change required — verified. The gap is solely at the call site (`NotionBackupService.setupRemoteControl:370`).
- **Implementation:** None.
- **Edge Cases:** N/A.

## Verification Plan

> Compilation and automated-test runs are the implementer's responsibility. Per session directives, do NOT run compilation or automated tests as part of this plan's verification.

### Manual
- With each toggle OFF (default): no Notion push, no archive-on-delete, no inbound-delete sweep — identical to today.
- Toggle Notion real-time sync ON → a local column move pushes to the Notion page (and create-if-missing fires for a page-less plan).
- Toggle delete-sync ON (each provider) → deleting a local plan archives the remote card. **Pay special attention to ClickUp** — this is the repaired path; verify the archive actually fires (previously a silent no-op).
- Toggle inbound-delete ON (each provider) → deleting the remote card tombstones the mapped local plan; leaving it OFF takes no destructive action.
- Reopen setup → checkboxes reflect the persisted flag values (state round-trip for all three providers, including Notion's remote-setup blob).
- Toggle a flag ON, then immediately trigger a sync action before reopen → benign no-op until the persisted blob is read on the next sync cycle (expected UX, not a bug).

## Recommendation

**Send to Coder** (Complexity 5). Pattern-following webview + handler wiring across eight files, with one confirmed bugfix (ClickUp `deleteSyncEnabled`) on a shipped path and a 3-hop Notion boolean thread. The risk is byte-compat on the shipped ClickUp/Linear setup path, not novelty. Ship independently of the Provider Sync feature — it unblocks that feature's dormant engine — and **after** A2b's Setup/TaskViewer verb-engine burndown (already in flight); the coder must re-resolve exact line numbers against the post-A2b source, since the arms this plan extends will have been seam-injected in-place.

**Stage Complete:** CREATED

## Review Findings

Reviewer pass (in-place) — implementation is correct end-to-end, **no code fixes needed**. Verified: the ClickUp `deleteSyncEnabled` repair works with **no zero-out** (setup.html still collects it at line 2850, `message.options` is passed wholesale through the `applyClickUpConfig` arm → `handleApplyClickUpConfig` spread → `applyConfig` now consumes it), the new `inboundDelete`/Notion checkboxes + collectors + state round-trip (`notionState` loading from the correct `loadNotionRemoteSetup` blob) are all wired, and both changed signatures (`setupRemoteControl`, `remoteRunNotionSetup`) are optional params so the second `remoteRunNotionSetup(workspaceRoot)` caller (KanbanProvider:7453) correctly falls to preserve-on-rerun. Regression traces clean: only two `applyConfig` callers (both fed the full option set), no other message sender, and the return-contract ratchet stays green (this plan's edits to the just-converted Setup/TaskViewer did not reintroduce a `break`). Files changed by implementation: `setup.html`, `ClickUpSyncService.ts`, `LinearSyncService.ts`, `KanbanProvider.ts`, `NotionBackupService.ts`, `SetupPanelProvider.ts`, `TaskViewerProvider.ts` (`notionRemoteConfig.ts` correctly untouched); no review edits applied. Remaining risks (NIT only, not fixed — consistent with the pre-existing toggle pattern): `applyConfig` force-assigns the flags so a partial-options sender would reset them (none exists), and the Notion UI is authoritative so it relies on checkboxes being pre-rendered before a re-run; compilation skipped per directive, ratchet gate run directly.

## Completion Report

Implemented setup UI opt-in toggles and state round-trip wiring for Provider Sync capabilities (`realTimeSyncEnabled`, `deleteSyncEnabled`, and `inboundDeleteEnabled`) across Notion, ClickUp, and Linear. Repaired ClickUp `deleteSyncEnabled` option drop bug at interface boundary and added `inboundDeleteEnabled` support. Modified files: `src/services/ClickUpSyncService.ts`, `src/services/LinearSyncService.ts`, `src/webview/setup.html`, `src/services/SetupPanelProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/NotionBackupService.ts`, `src/services/TaskViewerProvider.ts`. No unexpected issues encountered.
