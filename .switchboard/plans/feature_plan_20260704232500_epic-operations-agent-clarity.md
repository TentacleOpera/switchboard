# Feature Operations Agent Clarity — Verb Scripts, API Endpoints & Intent→Action Cheatsheet

**Plan ID:** 9c4e7a1b-3f2d-4e81-9b6c-0d5a2f8e1c37
**Project:** switchboard

## Goal

Make "do X to the feature" a one-shot agent action with no handwringing. Today an agent asked to *remove a card from a feature*, *split a feature*, or *delete a feature* spends minutes grepping the codebase because the only mechanisms for those operations are webview message handlers reachable from the Features-tab UI — there is **no verb script, no HTTP API endpoint, and no agent-facing intent→action map** for them. The agent must reverse-engineer the codebase each time and then either tell the user "click the button in the UI" or improvise a raw-DB/git operation with no documented contract.

> **Terminology note (2026-07-04):** Switchboard is renaming the user-facing term "epic" → "feature" (see `rename-epics-to-features-user-facing.md`). This plan adopts `feature` terminology for ALL agent-facing surfaces (script filenames, HTTP path strings, cheatsheet title/rows, SKILL.md prose). Internal TS identifiers (option callback keys `removeFromEpic`/`deleteEpic`/`splitEpic`, `KanbanProvider` methods `_removeSubtaskFromEpic`/`_deleteEpic`/`_splitEpic`), SQLite columns (`is_epic`/`epic_id`), and the `.switchboard/epics/` on-disk path STAY `epic` — they are invisible to agents and carry churn/breakage risk. This mirrors the rename plan's boundary: agent-facing strings = `feature`, internal identifiers = `epic`. An agent hearing "feature" finds `remove-from-feature.js` + the "Feature Operations Cheatsheet" directly — no terminology cliff.
> **Forward-reference (cross-subtask):** the "STAY `epic`" statements above are TEMPORAL — they hold until Phase 2 (`rename-epics-to-features-internal-phase2.md`) lands, which renames the `.switchboard/epics/` directory → `.switchboard/features/`, the TS option-callback keys (`removeFromEpic`→`removeFromFeature` etc.), the KanbanProvider methods (`_removeSubtaskFromEpic`→`_removeSubtaskFromFeature` etc.), and the JSON request-body field names the new scripts send. This plan lands BEFORE Phase 2; do not read "STAY `epic`" as permanent.

### Problem Analysis & Root Cause

The agent confusion has three structural causes, all confirmed by codebase investigation:

**1. Incomplete verb-script + HTTP-API coverage for feature CRUD.**
The `kanban_operations` skill ships two feature verb scripts and the `LocalApiServer` exposes two matching endpoints (named in `feature` terminology per the rename plan; the TS option callback keys stay `epic`):
- `create-feature.js` → `POST /kanban/feature` (create feature from subtask planIds; TS callback `createEpic`) — <ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/kanban_operations/create-epic.js" /> (file will be renamed by the rename plan)
- `assign-to-feature.js` → `POST /kanban/feature/assign` (add plans to an existing feature; TS callback `assignToEpic`) — <ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/kanban_operations/assign-to-epic.js" /> (file will be renamed by the rename plan)

But the other feature operations exist **only as webview message handlers** with no script and no HTTP endpoint:
- **Remove/unlink a subtask from a feature** — `case 'removeSubtaskFromEpic'` in `KanbanProvider.ts` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" lines="9048-9056" />) and `PlanningPanelProvider.ts` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts" lines="3790-3805" />). Reachable ONLY from the Features-tab "Remove" button in `project.js` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js" lines="2698-2731" />).
- **Delete a feature** — `case 'deleteEpic'` in `KanbanProvider.ts` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" lines="9080-9116" />). UI-only.
- **Split a feature** — no operation exists at all. `improve-feature`'s high/low mode *consolidates* subtasks into two tier files (merge, not split); `switchboard-split` splits a single *plan*, not a feature.

So an agent has a script for "create" and "assign" but NOTHING for "remove", "delete", or "split" — it must grep, find a webview handler it cannot invoke, and stall.

**2. No intent→action decision tree in agent-facing docs.**
`AGENTS.md` / `CLAUDE.md` list feature skills by capability name (`create-feature`, `improve-feature`, `group-into-features`), but there is no table mapping a *user intent* ("remove a card from a feature", "split a feature", "delete a feature", "add a card to a feature") to the concrete mechanism (script name + args + remote-vs-local path). An agent that hears "remove a card from a feature" cannot resolve it from the skill table — it must read each skill file and grep the source. The `kanban_operations` SKILL.md documents create/assign but not remove/delete/split.

**3. Ambiguous semantics for "remove".**
"Remove a card from a feature" has two valid meanings, and no doc disambiguates:
- **Unlink** — clear `epic_id` on the subtask, keep the plan on the board (what the UI "Remove" button does: `db.updateEpicStatus(subtask.planId, 0, '')`).
- **Delete** — remove the plan from the feature AND tombstone it from the board (what `improve-feature`'s remote `git rm` guidance describes for restructuring).

An agent has no way to know which the user means, and the two paths have completely different implementations.

### Background Context

- Feature verb scripts route through the running extension's `LocalApiServer` (walk up for `.switchboard/api-server-port.txt`, health-check, POST). There is deliberately **no direct-DB fallback** for feature mutations because they must regenerate the feature markdown file (`_regenerateEpicFile` — internal method name stays `epic`), cascade worktree cleanup, and unlink external trackers — logic that lives in `KanbanProvider` and is unreachable from a standalone Node process. This is the established pattern in `create-feature.js` / `assign-to-feature.js` and the new scripts must follow it.
- The remote-only `create-feature` skill writes the feature file directly (to `.switchboard/epics/` — internal path stays `epic`) when the extension is unreachable; the new remove/delete/split scripts have no safe remote equivalent (they mutate DB + file + external links), so they fail with a clear "open VS Code" message, same as `assign-to-feature.js`.

## Metadata

**Tags:** ui, ux, refactor, docs, api
**Complexity:** 5

## User Review Required
No — maintainer confirmed (2026-07-04) the entire epic feature is unreleased experimental work, never shipped to the ~4,000 installs. The verb scripts + endpoints + cheatsheet operate on unreleased epic state (`.switchboard/epics/`, `is_epic`/`epic_id` columns) with no external migration risk. Design decisions resolved: internal TS identifiers (option callback keys, KanbanProvider methods) stay `epic`; agent-facing surfaces (script filenames, HTTP paths, cheatsheet) use `feature`; remove/delete/split scripts fail with "open VS Code" when the extension is unreachable (no direct-DB fallback, same as `assign-to-feature.js`); `deleteEpic` defaults to unlink-and-keep subtasks with an explicit `--delete-subtasks` flag for the destructive variant; `_splitEpic` re-parents via the existing `createEpicFromPlanIds` choke point (verified — it reassigns `epic_id` via `db.updateEpicStatus`).

## Complexity Audit

**Routine (can be coded by an Intern/Coder):**
- The three new verb scripts (`remove-from-epic.js`, `delete-epic.js`, `split-epic.js`) are near-mechanical copies of `assign-to-epic.js`'s scaffolding (arg parse, `findApiPort`, `httpJson`, `tryViaExtension`, fail-with-clear-message). Only the endpoint path and request body differ.
- The three new `LocalApiServer` handlers are mechanical copies of `_handleKanbanAssignEpic` (parse body, look up the `options` callback, call it, return JSON).
- The intent→action cheatsheet is pure documentation.

**Complex/Risky (needs a Coder/Lead):**
- Wiring the `LocalApiServer` `options` callbacks to the *existing* `KanbanProvider`/`PlanningPanelProvider` webview-handler logic without duplicating it. The handlers currently live inside `handleMessage` switch cases; the API server needs callable functions. This is the only place with real design risk — must extract or delegate without breaking the webview path.
- `split-epic` is the one genuinely new backend operation (create a second epic and reassign a subset of subtasks to it). Must decide the contract: agent passes a partition (two planId lists), or one list + the source epic id. Must preserve subtask worktree/integration semantics.
- Disambiguating "unlink" vs "delete" semantics in the remove script's CLI surface (two flags or two scripts).

**Routing recommendation:** Coder (4-6). The scripts and docs are routine; the handler-extraction + split-epic contract is the complex core but is bounded.

## Edge-Case & Dependency Audit

**Edge cases:**
- Removing the *last* subtask from an epic — the epic must remain on the board as an empty epic (the UI path already tolerates this; the script must not special-case it).
- Deleting an epic whose subtasks are mid-coding — `deleteEpic` has a `deleteSubtasks` flag (tombstone subtasks) vs unlink-and-keep. The script must expose this flag; default should be **unlink-and-keep** (least destructive), with an explicit `--delete-subtasks` flag for the destructive variant.
- Splitting an epic where a subtask has an active worktree — the subtask's `subtask_plan_id` worktree linkage must follow the subtask to the new epic; the convergence branch semantics must not break. Need to confirm `_regenerateEpicFile` + the worktree cleanup in `removeSubtaskFromEpic` are not disturbed by re-parenting.
- **Split via `createEpicFromPlanIds` — double-provisioning + source external-sync gap (verified against `KanbanProvider.ts:10011-10199`):** `createEpicFromPlanIds` reassigns `epic_id` via `db.updateEpicStatus(st.planId, 0, newEpicPlanId)` (line 10170) — so re-parenting works. BUT it ALSO calls `_provisionSubtaskWorktreeIfNeeded` (10174) for each linked subtask and `_syncEpicOutbound` (10198) for the NEW epic. Two risks the `_splitEpic` implementation must guard: (a) moved subtasks already have a worktree provisioned by the source epic — `_provisionSubtaskWorktreeIfNeeded` must detect the existing `subtask_plan_id` worktree and skip/re-attach rather than double-provision; (b) `createEpicFromPlanIds` syncs the new epic + moved subtasks outbound but does NOT unlink the moved subtasks from the SOURCE epic's external Linear/ClickUp parent — `_splitEpic` must explicitly re-sync the source epic externally (re-parent the moved subtasks away from the source's external parent), not just regenerate the source's markdown file. Verify by reading `_provisionSubtaskWorktreeIfNeeded` + `_regenerateEpicFile` + `_syncEpicOutbound` at implementation time.
- External tracker sync (Linear/ClickUp): `removeSubtaskFromEpic` already calls `unlinkSubtasksFromEpic` best-effort; `deleteEpic` unlinks all subtasks. The new endpoints must trigger the same sync fan-out, NOT silently skip it (a raw-DB unlink would orphan the Linear parent link).
- Remote sessions (extension unreachable): all three new scripts must fail with the same "no direct-DB fallback, open VS Code" message as `assign-to-epic.js`. Do NOT add a raw-DB fallback — it would skip epic-file regeneration and external sync.

**Dependencies:**
- Depends on the existing `LocalApiServer` options-callback pattern (`createEpic`, `assignToEpic` injected from the extension activation). The new endpoints need three new option callbacks (`removeFromEpic`, `deleteEpic`, `splitEpic`) wired at extension activation.
- Depends on `_regenerateEpicFile` being safe to call after a subtask set change (already proven by the webview path).
- No migration concern — these are new operations on existing epic state; no shipped data format changes.

**Ordering:** Land remove + delete first (they wrap existing handlers — lowest risk), then split (new backend logic), then the cheatsheet doc (depends on all scripts existing).

## Dependencies
- `rename-epics-to-features-user-facing.md` (Phase 1 — user-facing rename) — **MUST land first.** Phase 1 renames the existing `/kanban/epic` and `/kanban/epic/assign` HTTP route strings to `/kanban/feature` and `/kanban/feature/assign` (`LocalApiServer.ts:1108/1110`) and renames `create-epic.js`→`create-feature.js` + `assign-to-epic.js`→`assign-to-feature.js`. This plan's three new routes (`/kanban/feature/remove|delete|split`) and three new scripts use `feature` from creation to stay consistent. If this plan lands before Phase 1, it must also rename the two existing routes itself (else routes are mixed `epic`/`feature`).
- `rename-epics-to-features-internal-phase2.md` (Phase 2 — internal identifiers) — **MUST land after this plan.** Phase 2 renames the TS option-callback keys this plan adds (`removeFromEpic`→`removeFromFeature`, `deleteEpic`→`deleteFeature`, `splitEpic`→`splitFeature`) and the KanbanProvider methods (`_removeSubtaskFromEpic`→`_removeSubtaskFromFeature`, `_deleteEpic`→`_deleteFeature`, `_splitEpic`→`_splitFeature`) plus the JSON request-body field names the new scripts send (`epicPlanId`→`featurePlanId`, `sourceEpicPlanId`→`sourceFeaturePlanId`). The new scripts' body field names must update in lockstep with Phase 2's TS key rename.
- `sess_20260702_remoteEpicStructure — Notion + Linear epic-aware state mirroring (unreleased)` — the external-tracker sync (`unlinkSubtasksFromEpic`) this plan's remove/delete endpoints invoke comes from this work. Both unreleased; the new endpoints trigger the same fan-out, no schema change.

## Adversarial Synthesis
Key risks: (1) the split operation reuses `createEpicFromPlanIds` which blindly reassigns `epic_id` (`KanbanProvider.ts:10170`) but ALSO re-provisions subtask worktrees (`_provisionSubtaskWorktreeIfNeeded`) and re-syncs the new epic outbound (`_syncEpicOutbound`) per subtask — moved subtasks already provisioned by the source epic risk a worktree collision, and the source epic's external Linear/ClickUp parent link is NOT unlinked by `createEpicFromPlanIds`; (2) `removeSubtaskFromEpic`/`deleteEpic` exist in BOTH `KanbanProvider` (9048/9080, full worktree+sync logic) and `PlanningPanelProvider` (3790) — the extraction target must be `KanbanProvider` (canonical) with `PlanningPanelProvider` delegating, else two divergent code paths; (3) the "STAY `epic`" terminology note is temporal — Phase 2 renames the `.switchboard/epics/` path + TS keys this plan leaves as `epic`. Mitigations: guard `_splitEpic` against double worktree provisioning + explicitly re-sync the source epic externally; extract once into `KanbanProvider` and have `PlanningPanelProvider` delegate; forward-reference Phase 2 in the terminology note.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — add three feature endpoints + option callbacks

Add to the `LocalApiServerOptions` interface (alongside the existing `createEpic` / `assignToEpic` — internal TS keys stay `epic`):

```ts
removeFromEpic?: (
    workspaceRoot: string,
    subtaskPlanId: string
) => Promise<{ success: boolean; error?: string }>;

deleteEpic?: (
    workspaceRoot: string,
    epicPlanId: string,
    deleteSubtasks: boolean
) => Promise<{ success: boolean; error?: string }>;

splitEpic?: (
    workspaceRoot: string,
    sourceEpicPlanId: string,
    movedSubtaskPlanIds: string[],
    newEpicName: string
) => Promise<{ success: boolean; newEpicPlanId?: string; error?: string }>;
```

> **Identifier boundary:** the TS option-callback keys (`removeFromEpic`/`deleteEpic`/`splitEpic`) and the `KanbanProvider` methods they route to (`_removeSubtaskFromEpic`/`_deleteEpic`/`_splitEpic`) stay `epic` — internal identifiers, invisible to agents. Only the HTTP path strings (agent-facing) use `feature`.

Add three route handlers mirroring `_handleKanbanAssignEpic` (HTTP paths use `feature`):

```ts
// POST /kanban/feature/remove — unlink a subtask from its feature (keep on board)
} else if (pathname === '/kanban/feature/remove' && req.method === 'POST') {
    await this._handleKanbanRemoveFromEpic(req, res);

// POST /kanban/feature/delete — delete a feature (unlink or tombstone subtasks)
} else if (pathname === '/kanban/feature/delete' && req.method === 'POST') {
    await this._handleKanbanDeleteEpic(req, res);

// POST /kanban/feature/split — split a feature: move a subset of subtasks to a new feature
} else if (pathname === '/kanban/feature/split' && req.method === 'POST') {
    await this._handleKanbanSplitEpic(req, res);
```

Each handler parses the body, looks up the matching option callback (TS key `epic`), returns 503 if absent (headless) and 200/502 on success/failure — identical structure to `_handleKanbanAssignEpic` (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalApiServer.ts" lines="368-409" />). The existing `/kanban/epic` and `/kanban/epic/assign` routes MUST be renamed to `/kanban/feature` and `/kanban/feature/assign` by the rename plan (or in this pass if it lands first) — the three new routes use `feature` from creation to stay consistent.

### 2. `src/services/KanbanProvider.ts` (canonical extraction target) + `PlanningPanelProvider.ts` (must delegate) — extract callable feature-mutation functions (internal names stay `epic`)

> **Clarification (cross-subtask reconciliation):** `removeSubtaskFromEpic` and `deleteEpic` exist in BOTH providers — `KanbanProvider.ts:9048/9080` (full logic: worktree cleanup + `_regenerateEpicFile` + external `unlinkSubtasksFromEpic` fan-out) and `PlanningPanelProvider.ts:3790` (separate handler with a `deleteSubtasks` flag at 3810). **KanbanProvider is the canonical extraction target** — it owns the complete worktree + external-sync logic. The API-server callbacks route to the KanbanProvider extracted methods. `PlanningPanelProvider`'s handler MUST be rewritten to delegate to the same extracted KanbanProvider method (or audited for divergence and consolidated) — do NOT leave two divergent code paths or the API endpoint and the project.html UI will drift.

Extract the bodies of the existing `removeSubtaskFromEpic` and `deleteEpic` switch cases into callable private methods (TS method names stay `epic` — internal) so both the webview handler and the API-server callback can invoke them:

```ts
private async _removeSubtaskFromEpic(workspaceRoot: string, subtaskPlanId: string): Promise<{ success: boolean; error?: string }> {
    // body extracted from case 'removeSubtaskFromEpic' (lines 9048-9078)
    // returns { success: true } or { success: false, error }
}

private async _deleteEpic(workspaceRoot: string, epicPlanId: string, deleteSubtasks: boolean): Promise<{ success: boolean; error?: string }> {
    // body extracted from case 'deleteEpic' (lines 9080-9116)
    // deleteSubtasks replaces the msg.deleteSubtasks flag
}
```

The webview `case` blocks become one-line delegations to these methods. Add a new `_splitEpic` method:

```ts
private async _splitEpic(workspaceRoot: string, sourceEpicPlanId: string, movedSubtaskPlanIds: string[], newEpicName: string): Promise<{ success: boolean; newEpicPlanId?: string; error?: string }> {
    // 1. Validate source epic exists + each movedSubtaskPlanId is currently a subtask of it.
    // 2. Create the new epic via the existing createEpicFromPlanIds choke point
    //    (passing movedSubtaskPlanIds) — this links them to the NEW epic and unlinks
    //    from the source in one atomic step (createEpicFromPlanIds reassigns epic_id).
    // 3. Regenerate both epic files (_regenerateEpicFile for source + new).
    // 4. Return { success: true, newEpicPlanId }.
}
```

Wire the three option callbacks (TS keys `removeFromEpic`/`deleteEpic`/`splitEpic`) at extension activation (where `createEpic`/`assignToEpic` are already injected) to these methods.

### 3. New verb scripts (mirror `assign-to-feature.js`; filenames use `feature`)

`.agents/skills/kanban_operations/remove-from-feature.js`:
```js
// Usage: node remove-from-feature.js <subtask_plan_id> [workspace_root]
// POST /kanban/feature/remove { workspaceRoot, subtaskPlanId }
// Unlinks the subtask from its feature; the plan stays on the board.
// No direct-DB fallback (same reason as assign-to-feature.js).
```

`.agents/skills/kanban_operations/delete-feature.js`:
```js
// Usage: node delete-feature.js <epic_plan_id> [--delete-subtasks] [workspace_root]
// POST /kanban/feature/delete { workspaceRoot, epicPlanId, deleteSubtasks }
// Default: unlink subtasks (keep on board), tombstone only the feature.
// --delete-subtasks: tombstone the feature AND every subtask.
```

`.agents/skills/kanban_operations/split-feature.js`:
```js
// Usage: node split-feature.js <source_epic_plan_id> '<moved_plan_ids_json>' "<new_feature_name>" [workspace_root]
// POST /kanban/feature/split { workspaceRoot, sourceEpicPlanId, movedSubtaskPlanIds, newEpicName }
// Creates a new feature and reassigns the named subtasks to it; the source feature keeps the rest.
```

Each script is a copy of `assign-to-feature.js` with the endpoint path + body changed. Same `findApiPort` / `httpJson` / `tryViaExtension` / fail-with-clear-message structure. The request body field names (`epicPlanId`, `sourceEpicPlanId`) stay `epic` — they match the TS option-callback parameter names (internal contract). Only the script filename + HTTP path use `feature`.

### 4. `.agents/skills/kanban_operations/SKILL.md` — document all feature operations

Add three new sections (Remove a Subtask from a Feature / Delete a Feature / Split a Feature) with usage + examples, mirroring the existing "Create a Feature" and "Assign Plans to a Feature" sections. Add a consolidated **Feature Operations Cheatsheet** at the top of the feature-related sections:

```
| Intent | Script | Endpoint | Remote fallback |
|--------|--------|----------|-----------------|
| Create a feature from plans | create-feature.js | POST /kanban/feature | create-feature skill (file write) |
| Add plans to an existing feature | assign-to-feature.js | POST /kanban/feature/assign | none — open VS Code |
| Remove a subtask from a feature (keep on board) | remove-from-feature.js | POST /kanban/feature/remove | none — open VS Code |
| Delete a feature (unlink or delete subtasks) | delete-feature.js | POST /kanban/feature/delete | none — open VS Code |
| Split a feature (move subset to a new feature) | split-feature.js | POST /kanban/feature/split | none — open VS Code |
| Improve/restructure a feature's subtask set | (improve-feature skill) | n/a | git rm + manifest (remote) |
```

### 5. `AGENTS.md` + `CLAUDE.md` — surface the cheatsheet in the skill table

Add a one-line note under the Available Skills table pointing agents at the Feature Operations Cheatsheet in `kanban_operations/SKILL.md`, so an agent hearing "do X to the feature" resolves the intent in one lookup instead of reading every skill file. No new skill entries needed — the operations live under the existing `kanban_operations` skill.
> **Discovery mechanism note (cross-subtask):** the new verb scripts (`remove-from-feature.js`, `delete-feature.js`, `split-feature.js`) are discovered via the cheatsheet, NOT injected into `agentPromptBuilder.ts` prompt text. This is deliberate: `agentPromptBuilder.ts` only references `assign-to-feature.js` in the high-low planner consolidation directive (lines 519-520, renamed by Phase 1), because assign-to-feature is part of the high-low flow. Remove/delete/split are standalone agent operations triggered by user intent, resolved via the cheatsheet lookup. Do NOT add them to `agentPromptBuilder.ts` — that would pollute the high-low prompt with operations unrelated to tier consolidation.

## Verification Plan

### Automated Tests
- **None required.** Per session directive, automated tests are skipped and compilation is skipped (`src/` is the source of truth; `dist/` is not audited). The TypeScript compiler is the primary safety net for the option-callback wiring + method extraction — recommend running `npm run compile` manually after implementation to catch TS misses (recommendation, not a plan step). No existing test references the new endpoints/scripts (the operations are new).

### Manual Verification
1. **Unit/manual — scripts route correctly:** with the extension running, run each new script against a test feature in `.switchboard/epics/` and confirm:
   - `remove-from-feature.js <subtaskId>` → subtask's `epic_id` cleared in `get-state.js` output, plan still on the board, feature file regenerated without that subtask.
   - `delete-feature.js <epicId>` (default) → feature tombstoned, subtasks still on board unlinked; `--delete-subtasks` → feature + all subtasks tombstoned.
   - `split-feature.js <epicId> '["subA","subB"]' "New Feature"` → new feature file appears with subA/subB, source feature file regenerated with the remaining subtasks.
2. **External sync:** with real-time Linear/ClickUp sync enabled, confirm `remove-from-feature` and `delete-feature` trigger `unlinkSubtasksFromEpic` (check the sync service logs / the parent link is removed in the external tracker).
3. **Extension-unreachable path:** stop the extension, run each script, confirm it exits 1 with the "open VS Code" message and does NOT mutate the DB.
4. **Webview regression:** confirm the Features-tab "Remove" button and feature delete still work after extracting the handler bodies into callable methods (the `case` blocks now delegate).
5. **Agent clarity smoke test:** in a fresh agent session, say "remove card X from feature Y" and confirm the agent runs `remove-from-feature.js` directly from the cheatsheet without grepping the codebase — no terminology cliff between the user-facing "feature" term and the agent-facing script/cheatsheet naming.

## Review Findings
Reviewed against commit `a9693f5`. **MAJOR (fixed):** `KanbanProvider.splitFeature` deleted the source feature *before* creating the two new ones, so a failure in either `createFeatureFromPlanIds` left the source gone and every subtask orphaned with no rollback — reordered to create-both-then-delete-empty-source (`createFeatureFromPlanIds` reassigns `feature_id` unconditionally, so no pre-detach is needed). Verified the script→LocalApiServer-handler→option-callback→KanbanProvider-method contract is consistent for remove/delete/split (methods are `public`, body field names aligned end-to-end). The split contract intentionally diverged from the proposed `movedSubtaskPlanIds`/`newEpicName` to `keptPlanIds` + two feature names — accepted (internally consistent). Also fixed `an feature`→`a feature` grammar in the agent-facing API error strings; remaining risk: `createFeatureFromPlanIds` may double-invoke subtask worktree provisioning when re-parenting an already-provisioned subtask (pre-existing, unchanged by this work).
