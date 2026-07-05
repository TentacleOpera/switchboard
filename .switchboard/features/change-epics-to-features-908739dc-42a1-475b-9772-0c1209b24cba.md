# Change epics to features

**Plan ID:** 908739dc-42a1-475b-9772-0c1209b24cba
**Complexity:** 7

## Goal

Rename the parent-task concept currently called **"epic"/"epics"** to **"feature"/"features"** across every layer of Switchboard — user-facing display text, agent-facing verb scripts + HTTP endpoints + cheatsheet, and internal identifiers + persisted state — and close the agent-clarity gap that leaves remove/delete/split feature operations reachable only from the UI. The entire epic feature is **unreleased experimental work** (maintainer-confirmed 2026-07-04, never shipped to the ~4,000 installs), so the rename is a **clean break with no external migration** — the persisted-state layer (`.switchboard/epics/` directory, `is_epic`/`epic_id` SQLite columns, Notion `Is Epic`/`Epic` schema) carries zero migration risk.

### Problem / Background

"Epic" is outdated terminology for the parent-task grouping. The concept is deeply embedded (~6,000 raw matches), but it separates into three cleanly-bounded layers. Additionally, only create + assign have agent-facing verb scripts + HTTP endpoints — remove, delete, and split are UI-only, forcing agents to grep + stall. This epic pays both debts in a phased, ordered sequence so each plan owns a distinct layer once and the boundary between "what users/agents read" and "what code/disk stores" is held firmly through Phase 1, then collapsed in Phase 2.

## How the Subtasks Achieve This

1. **Phase 1 — `rename-epics-to-features-user-facing.md` (Complexity 5, Coder):** renames the ~70 user-facing display strings (webview labels/buttons/modals, VS Code notifications, docs), the slash commands + skill/workflow filenames + `ClaudeCodeMirrorService` registry, the two Notion property strings (`Is Epic`/`Epic` → `Is Feature`/`Feature`, clean break), AND the two agent-facing HTTP route strings (`/kanban/epic` → `/kanban/feature`, `/kanban/epic/assign` → `/kanban/feature/assign`) + the two existing verb-script filenames (`create-epic.js`→`create-feature.js`, `assign-to-epic.js`→`assign-to-feature.js`). Leaves internal TS identifiers, DB columns, the `.switchboard/epics/` path, and message-type constants as `epic` (churn/risk avoidance, not migration).
2. **Agent Clarity — `feature_plan_20260704232500_epic-operations-agent-clarity.md` (Complexity 5, Coder):** adds the three missing feature verb scripts (`remove-from-feature.js`, `delete-feature.js`, `split-feature.js`) + three matching HTTP endpoints (`/kanban/feature/remove|delete|split`) + the "Feature Operations Cheatsheet" in `kanban_operations/SKILL.md`. Extracts the existing `removeSubtaskFromEpic`/`deleteEpic` handler bodies (KanbanProvider canonical) into callable private methods so the API server and the webview share one implementation; adds the genuinely new `_splitEpic` (re-parents a subset of subtasks to a new feature via `createEpicFromPlanIds`). All agent-facing surfaces use `feature`; internal TS keys stay `epic` (deferred to Phase 2).
3. **Phase 2 — `rename-epics-to-features-internal-phase2.md` (Complexity 7, Lead Coder):** collapses the internal layer Phase 1 left as `epic`: `git mv .switchboard/epics → .switchboard/features` (~48 path refs), `ALTER TABLE RENAME COLUMN is_epic→is_feature / epic_id→feature_id` (sql.js, dev-only migration), the `> **Epic Plan ID:**` parsed marker, ~600 TS identifiers (incl. the 3 new methods + endpoint handlers the agent-clarity plan introduces), CSS classes/ids, and the ~20 webview↔extension message-type constants (dual-end, silently-breaking). Compiler catches TS misses; grep + manual review catch string/path/message-type misses.

## Dependencies & sequencing

**Strict order — do not land concurrently:**

Phase 1 (user-facing + routes + script filenames)
   → Agent Clarity (new verb scripts + endpoints + cheatsheet, uses `feature` routes from creation)
      → Phase 2 (internal identifiers + persisted state, renames what the prior two established)

- **Phase 1 → Agent Clarity:** Agent Clarity's three new routes use `feature` from creation; they require Phase 1's rename of the two existing routes to `feature` first (else routes are mixed `epic`/`feature`). If Agent Clarity lands first, it must rename the two existing routes itself.
- **Agent Clarity → Phase 2:** Phase 2 renames the TS option-callback keys (`removeFromEpic`→`removeFromFeature`, `deleteEpic`→`deleteFeature`, `splitEpic`→`splitFeature`) + KanbanProvider methods (`_removeSubtaskFromEpic`→`_removeSubtaskFromFeature`, `_deleteEpic`→`_deleteFeature`, `_splitEpic`→`_splitFeature`) that Agent Clarity creates, plus the JSON request-body field names the five verb scripts send. The scripts must update in lockstep with Phase 2's TS key rename.
- **`sess_20260702_remoteEpicStructure`** (Notion + Linear epic-aware mirroring, unreleased) — Phase 1 renames the Notion `Is Epic`/`Epic` schema this work introduced; Phase 2 renames `isEpicCandidate` on the shared `RemoteStateDelta`. Both unreleased; clean break.
- **Merge-order hazard:** Phase 1 and Phase 2 both edit `NotionRemoteProvider.ts:112` (Phase 1 = property string, Phase 2 = `isEpicCandidate` TS field, different tokens, same line). Parallel branches conflict at line 112 — Phase 2 rebases on Phase 1.

### Reconciled shared-surface end-state

| Surface | Owner | End-state |
|---|---|---|
| HTTP route strings `/kanban/feature*` | Phase 1 (2 existing) + Agent Clarity (3 new) | all 5 `feature` |
| Verb-script filenames `*-feature.js` | Phase 1 (2 renamed) + Agent Clarity (3 new) | all 5 `feature` |
| TS option-callback keys | Agent Clarity (adds 3 as `epic`) → Phase 2 (renames all 5 to `feature`) | `feature` after Phase 2 |
| KanbanProvider methods `_remove/_delete/_split` | Agent Clarity (creates as `epic`) → Phase 2 (renames to `feature`) | `feature` after Phase 2 |
| `.switchboard/epics/` path | Phase 1 (leaves) → Phase 2 (renames to `features/`) | `features/` after Phase 2 |
| `is_epic`/`epic_id` columns | Phase 2 only | `is_feature`/`feature_id` |
| Notion `Is Epic`/`Epic` | Phase 1 only | `Is Feature`/`Feature` |
| `isEpicCandidate` TS field | Phase 1 (leaves) → Phase 2 (renames) | `isFeatureCandidate` |
| Message-type constants | Phase 2 only (dual-end) | `feature` forms |
| `ClaudeCodeMirrorService` registry | Phase 1 only | `feature` forms |

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Rename "Epics" → "Features" (User-Facing Surfaces Only)](../plans/rename-epics-to-features-user-facing.md) — **CODE REVIEWED**
- [ ] [Feature Operations Agent Clarity — Verb Scripts, API Endpoints & Intent→Action Cheatsheet](../plans/feature_plan_20260704232500_epic-operations-agent-clarity.md) — **CODE REVIEWED**
- [ ] [Plan: Rename "Epics" → "Features" (Internal Identifiers + Persisted State — Phase 2)](../plans/rename-epics-to-features-internal-phase2.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
