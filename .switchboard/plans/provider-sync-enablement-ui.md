---
description: "Expose the provider-sync opt-in flags in the setup UI so the (already-built, correct, but dormant) Provider Sync — Full Parity engine can actually be turned on. Add setup.html toggles + handler wiring for Notion realTimeSync/deleteSync/inboundDelete and ClickUp/Linear inboundDelete, and confirm/repair the existing ClickUp/Linear deleteSync wiring. Standalone follow-on to the Provider Sync feature — NOT one of its subtasks."
---

# Provider Sync — Enablement UI (opt-in toggles for full parity)

## Goal

Give the user a way to turn on the Provider Sync — Full Parity capabilities. The sync engine (Notion outbound create/archive/push, all-three simultaneous push, and inbound-delete reconcile-sweep) is merged, reviewed, and correct — but **inert**, because none of its opt-in flags has a setter. This plan adds the setup-UI toggles and their handler wiring so the flags can be flipped to `true`, keeping every capability opt-in and default-off (the ~4,000 existing installs stay unchanged until a user enables them).

### Core problem / root cause (verified against merged source, 2026-07-21)

The provider-sync review found the engine complete but unreachable. The gating flags are only ever **read** (config load) or **preserved-on-rerun** — never written to `true` by any UI or message handler:

- **Notion `realTimeSyncEnabled` / `deleteSyncEnabled` / `inboundDeleteEnabled`** ([notionRemoteConfig.ts:31-43](../../src/services/remote/notionRemoteConfig.ts#L31)) — `saveNotionRemoteSetup` is only ever called with `{plansDatabaseId, commentsDatabaseId, botId}` ([NotionBackupService.ts:370](../../src/services/NotionBackupService.ts#L370)); Notion has **no** sync-options toggles in `setup.html` at all.
- **ClickUp / Linear `inboundDeleteEnabled`** ([ClickUpSyncService.ts:44](../../src/services/ClickUpSyncService.ts#L44), [LinearSyncService.ts:34](../../src/services/LinearSyncService.ts#L34)) — added to the config interface + `loadConfig` parse, but never mapped from any setup message.
- **ClickUp / Linear `deleteSyncEnabled`** — checkboxes exist ([setup.html:2798](../../src/webview/setup.html#L2798), [:2818](../../src/webview/setup.html#L2818)) and are sent in the setup message, but the only `config.deleteSyncEnabled` assignments found in the handler hardcode `false` (the Bug-Triage path, [TaskViewerProvider.ts:6174](../../src/services/TaskViewerProvider.ts#L6174)/[:6214](../../src/services/TaskViewerProvider.ts#L6214)). The end-to-end wiring for the existing delete-sync checkbox is **suspect** and must be confirmed (and repaired if broken) before layering inbound-delete beside it.

Consumers that already read these flags and will light up once a setter exists: `_queueNotionSync` (realTimeSyncEnabled, [KanbanProvider.ts:2997](../../src/services/KanbanProvider.ts#L2997)); `PlanIngestionEngine.runPurgeSweep` (deleteSyncEnabled, [:485](../../src/services/PlanIngestionEngine.ts#L485)); `RemoteControlService._reconcileSweep` via `_getInboundDeleteEnabled` (inboundDeleteEnabled, [KanbanProvider.ts:2136](../../src/services/KanbanProvider.ts#L2136)).

## Metadata
- **Tags:** frontend, webview, integrations, config
- **Complexity:** 4
- **Project:** Browser Switchboard
- **Release phase:** Follow-on to the merged Provider Sync — Full Parity feature. Touches the shipped setup surface (~4,000 installs) → every new toggle defaults OFF and existing ClickUp/Linear behaviour must stay byte-compatible.

## User Review Required
- **Placement of the Notion toggles:** a new "Notion remote sync options" section in `setup.html` (mirroring the ClickUp/Linear option blocks) vs. surfacing them wherever Notion remote control is configured today. Recommend mirroring the existing ClickUp/Linear option-block pattern for consistency. Decide before build.

## Scope

### ✅ IN SCOPE
- **Notion sync-options toggles:** add `realTimeSyncEnabled`, `deleteSyncEnabled`, `inboundDeleteEnabled` checkboxes to `setup.html`, carried in the Notion setup/save message, applied via `saveNotionRemoteSetup` (which already preserves-on-rerun, so pass the explicit booleans).
- **ClickUp / Linear `inboundDeleteEnabled` toggle:** one checkbox each beside the existing delete-sync checkbox, mapped through the same setup message/handler that carries `deleteSyncEnabled`.
- **Confirm/repair ClickUp/Linear `deleteSyncEnabled` wiring:** trace the `clickup-option-delete-sync` / `linear-option-delete-sync` checkbox → message → `config.deleteSyncEnabled`; if it isn't actually applied (only the hardcoded-false path was found), wire it through properly.
- **State round-trip:** ensure the current flag values are pushed back to the webview so the checkboxes reflect persisted state on open (mirror the `clickupState` / `linearState` state push at [KanbanProvider.ts:2658](../../src/services/KanbanProvider.ts#L2658)/[:2672](../../src/services/KanbanProvider.ts#L2672) for a Notion equivalent).

### ⚙️ OUT OF SCOPE
- Any change to the sync engine itself (create/archive/push, reconcile-sweep) — it is done and reviewed. This plan only wires the toggles.
- New default-on behaviour — every toggle ships OFF.
- Provider setup/auth flows (folder/list/database selection) beyond adding the opt-in checkboxes.

## Implementation Steps
1. **Confirm the existing ClickUp/Linear delete-sync path.** Trace the setup message from the `clickup-option-delete-sync` / `linear-option-delete-sync` checkboxes to where `config.deleteSyncEnabled` is (or should be) set. If broken, repair it — this is the pattern the new toggles copy.
2. **Add ClickUp/Linear `inboundDeleteEnabled` checkboxes** to `setup.html` beside delete-sync; carry the value in the setup message; map it in the handler (`config.inboundDeleteEnabled = … === true`).
3. **Add the Notion sync-options section** to `setup.html` (3 checkboxes) + a message handler that loads the Notion setup blob, sets the three flags, and saves via `saveNotionRemoteSetup` with explicit booleans (so preserve-on-rerun doesn't mask an intentional disable).
4. **Wire the Notion state push** so the checkboxes render persisted values on open.
5. **Verify each toggle gates its consumer:** realTimeSync → `_queueNotionSync` pushes; deleteSync → `runPurgeSweep` archives; inboundDelete → the reconcile-sweep runs for that provider.

## Verification Plan

> Compilation and automated-test runs are the implementer's responsibility.

### Manual
- With each toggle OFF (default): no Notion push, no archive-on-delete, no inbound-delete sweep — identical to today.
- Toggle Notion real-time sync ON → a local column move pushes to the Notion page (and create-if-missing fires for a page-less plan).
- Toggle delete-sync ON (each provider) → deleting a local plan archives the remote card.
- Toggle inbound-delete ON (each provider) → deleting the remote card tombstones the mapped local plan; leaving it OFF takes no destructive action.
- Reopen setup → checkboxes reflect the persisted flag values.

## Recommendation

**Send to Coder** (Complexity 4). Small, pattern-following webview + handler wiring; the risk is byte-compat on the shipped ClickUp/Linear setup path, not novelty. Ship independently of the Provider Sync feature — it unblocks that feature's dormant engine.

**Stage Complete:** CREATED
