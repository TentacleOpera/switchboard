# Switchboard Remote Manager — Complete Verb Surface & Console UX

**Complexity:** 6

## Goal

Make /switchboard-manage a genuinely complete manager while VS Code runs minimised. Two stacked deliverables: a generic allowlist-gated verb passthrough that exposes all ~600 webview verbs over HTTP in five edits (the engine), and a UX overhaul of the Manage skill that replaces the entry wall-of-text and narrow action list with a concise snapshot and a broad categorized menu, while eliminating the sidebar Guided Setup button by subsuming onboarding and a guided tour into the skill (the interface).

## How the Subtasks Achieve This

- **Feature A · A2b — Generic Verb Passthrough (VS Code running)** (the engine): Exposes all ~600 catalogued webview verbs over HTTP by collapsing each of the 5 providers' `handleServiceVerb` switches into a generic, allowlist-gated passthrough into `_handleMessage` — five small edits, not 600. The allowlist is auto-generated from `protocol-catalog.json`, the shim twins are deleted, read-verb results are delivered over the WS hub, and the parity gate is rewritten to check real reachability instead of counting case-labels. This is what makes "advance a plan to coding," feature ops, design verbs, etc. actually callable from outside the webview while VS Code runs minimised.
- **/switchboard-manage — Skill UX Overhaul** (the interface): Makes the now-reachable surface usable. Kills the entry wall-of-text (concise one-line board snapshot, no recent-features dump), replaces the flat 6-item list with a broad categorized menu (Plan / Code / Design & Artifacts / Features & Board / External PM / Automation / Setup & Tour), and eliminates the sidebar Guided Setup button by subsuming onboarding + a guided tour into the skill itself, leaving the relabeled "Get Started / Manage" launcher as the single front door.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [x] [Feature A · A2b — Generic Verb Passthrough (VS Code running)](../plans/a2b-generic-verb-passthrough-vscode-running.md) — **DONE**
- [x] [/switchboard-manage — Skill UX Overhaul](../plans/switchboard-manage-skill-ux-overhaul.md) — **DONE**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ship **A2b (the passthrough) first** — it makes the verbs reachable. The **Manage UX overhaul** can be authored in parallel but must land with its Design & Artifacts / plan-actioning / settings menu items flagged as "gated until transport-parity lands"; once the passthrough ships, those gating flags come off. The UX plan is written to be honest before the passthrough exists, so it never offers an action the surface can't yet perform. Both are self-contained within this feature — no cross-feature dependency.

## Completion Report

**Both subtasks landed. All gates green.**

### Subtask 1: A2b — Generic Verb Passthrough

**Generator + allowlist:**
- New script `scripts/generate-verb-allowlist.js` reads `protocol-catalog.json` and emits `src/generated/verbAllowlist.ts` with one `Set<string>` per provider (`KANBAN_VERBS`, `PLANNING_VERBS`, `DESIGN_VERBS`, `TASKVIEWER_VERBS`, `SETUP_VERBS`).
- Wired into `catalog:generate` (writes) and `catalog:check` (drift gate) in `package.json`. Allowlist can never drift from catalog — drift = CI red.

**5 dispatchers collapsed:**
- `DesignPanelProvider`, `PlanningPanelProvider`, `TaskViewerProvider`, `SetupPanelProvider`, `KanbanProvider` — each `handleServiceVerb` replaced with: allowlist check → `this._handleMessage({ ...payload, type: verb })`. Zero `case` labels remain. `type` set LAST so payload `type` can never override the allowlist-checked verb.

**Shim service twins deleted:**
- `planningService.ts`, `designService.ts`, `taskViewerService.ts` — deleted entirely (pure forwarders, no genuine methods).
- `kanbanService.ts` — shrunk to 10 genuine methods only (`selectPlan`, `openPlanByPath`, `refresh`, `scanFoldersNow`, `focusTerminal`, `fileExists`, `getRemoteConfig`, `getSetting`, `saveSetting`, `setRemoteConfig`).
- `setupService.ts` — shrunk to 2 genuine methods only (`getStartupCommands`, `saveStartupCommands`).
- `_init*Service` methods in Design/Planning/TaskViewer stripped to just seams+broadcaster setup (service creation removed).

**Parity gate rewritten:**
- `scripts/check-protocol-parity.js` now checks: (a) allowlist ≡ catalog drift, (b) zero case labels + allowlist check present in each `handleServiceVerb`, (c) smoke dispatch of a known verb per provider, (d) direction-split report (request-response vs push/broadcast).

**Gates passed:**
- `catalog:check` ✅ — 609 arms, 521 verbs, no drift.
- `parity:check` ✅ — all 5 providers: allowlist ≡ catalog, generic dispatchers in place.
- `mirror:check` ✅ — .claude/skills matches .agents (47 files).
- `npm run compile` (webpack) ✅ — compiled with 0 errors (3 pre-existing optional-dep warnings).

### Subtask 2: Skill UX Overhaul

**SKILL.md rewritten (both copies — `.agents/` and `.claude/`):**
- Entry protocol: concise one-line board snapshot (column counts collapsed, terminal columns to single total), setup-gap detection (terminal agent / plans / constitution), no feature list, no UUIDs.
- Flat 6-item action list → broad categorized menu: Plan / Code / Design & Artifacts / Features & Board / External PM / Automation / Setup & Tour.
- Read/write contract documented: command verbs actionable via `POST /<panel>/verb/<name>`; read verbs return `{success:true}` only (data on WS hub) → use dedicated GET endpoints.
- New §5: Guided Setup & Tour — interactive, one step at a time (replaces clipboard-prompt flow). Same doc-section curriculum as the deleted `_handleGuidedSetup`.
- New §6: Column Oversight — attended sequential pass (WIP=1, mtime completion signal, durable state file + audit log, end-of-pass digest reads card content).
- New §7: Project Pipeline — manage a project start to end (thin orchestration over Column Oversight).
- Hard rules updated: "You are the manager, never the coder" added as rule #1; capability ceiling updated to reflect complete command verb surface.

**Guided Setup button + plumbing removed:**
- `implementation.html`: `btn-guided-setup` button element deleted, JS click handler deleted, `hideGuidedSetupSetting` message handler deleted.
- `setup.html`: "Hide the Guided Setup button" toggle deleted, JS change handler deleted, `getHideGuidedSetupSetting` request deleted, `hideGuidedSetupSetting` hydration handler deleted.

**Manage launcher tooltip updated:**
- `implementation.html`: `btn-quick-manage` label kept as "Manage"; tooltip updated to mention onboarding + board driving as the single front door.

