---
description: "Feature A (Remote Control), subtask A3: make feature management usable by agents — address plans by file path/slug instead of DB UUIDs, add an idempotent POST /kanban/features/reconcile that converges the whole feature structure in one atomic call, add a split-plan primitive, and revise the existing feature scripts/skills to match."
---

# Feature A · A3 — Declarative, Path-Addressed Feature Management

## Goal

Make **feature management usable by an agent** (the central operation of `/switchboard-manage`). Replace the current UUID-choreography with a **declarative, path/slug-addressed** interface and revise the existing feature scripts/skills to match.

### Problem & root cause
Reorganizing features from outside the webview is currently unusable — verified 2026-07-08 while trying to split one feature into two:
- Every feature op (`create-feature.js`, `assign-to-feature.js`, `remove-from-feature.js`, `split-feature.js`) is keyed on **opaque DB-assigned `planId` UUIDs** that are **not knowable from files**, forcing an `POST /kanban/plans/import` → `get-state.js` → parse-UUIDs → imperative-verb pipeline against a live extension.
- The `create_feature` file-write skill can create a feature *shell* but **cannot link existing plans** headlessly — it punts to `assign-to-feature.js` or drag-and-drop.
- You **cannot re-home an existing plan by editing files** (membership is DB-authoritative + apply-if-empty). Renaming a plan file **orphans** it (path-keyed import). There is **no "split a plan" primitive** at all.
- Commit `a9693f5` ("Agent Clarity", 2026-07-05) added the remove/delete/split verbs — **primitives, not ergonomics**; the shape is unchanged.

**Root cause:** the feature surface was built **button-first** (the webview already knows every card's identity); the script/HTTP path is a retrofit that exposes low-level, UUID-keyed verbs with no declarative, intent-level, file-addressable operation. See memory `feature-ops-uuid-choreography-bad-for-agents`.

## Metadata
- **Tags:** backend, api, refactor
- **Complexity:** 6
- **Release phase:** Near-term (Feature A — Switchboard Remote-Control API). Consumed by `/switchboard-manage` (A0); benefits every external agent host.

## User Review Required
- None. (Path/slug addressing + declarative reconcile decided 2026-07-08.)

## Scope

### ✅ IN SCOPE
- **Path/slug addressing across the feature API.** Every feature endpoint/script accepts a plan **file path or slug** in addition to `planId`; the extension resolves it server-side (imports are already `plan_file`-path-keyed). An agent never handles a UUID. Applies to `create`/`assign`/`remove`/`split` and the new reconcile below.
- **`POST /kanban/features/reconcile` — one idempotent, intent-level endpoint.** Body = the *desired* structure:
  ```json
  { "features": [ { "name": "…", "description": "…", "subtasks": ["<path|slug|planId>", { "slug": "…", "title": "…", "body": "…" }] } ] }
  ```
  The extension diffs desired-vs-current and performs every create / assign / remove / move needed to converge — **atomically** — and returns the resulting structure (feature ids, member ids). No `import`→`get-state` round trip; the agent declares the end state, the extension owns the verbs.
- **Inline plan-splitting.** A `subtasks` member may be a **new plan defined in the call** (`{slug,title,body}`); reconcile writes the file, imports it, and links it — removing the manual file-surgery + orphan-on-rename footgun. (Optionally expose a standalone `POST /kanban/plans/split` too.)
- **Revise the existing feature scripts + skills to the new model:** `kanban_operations` verb scripts accept path/slug and print human-readable results (never require the caller to supply a UUID); `create_feature` skill rewritten around reconcile (its file-only fallback keeps working when the extension is down); `group-into-features` updated to emit a reconcile manifest instead of a create→assign sequence.
- **Clean machine-readable stdout for read tools (root cause of the ID-lookup pain):** `get-state.js` — the only *documented* headless ID lookup — currently interleaves a shared `[KanbanDatabase] Resolved DB path…` log line on **stdout**, which breaks `JSON.parse`/`jq` and forces agents onto slower paths. Route that log (and its peers emitted during standalone DB resolution) to **stderr** so `node get-state.js | jq` works. (The offline `.switchboard/kanban-state-<column>.md` `<!-- planId:… -->` index is already documented in `kanban_operations/SKILL.md` as of 2026-07-08; this makes the *scripted* path work too.)
- **Dispatch/prompt builders inject the authoritative `PLAN_ID` — no agent ever looks up or fabricates an ID:** whenever the system builds an agent-facing prompt (coder/lead/intern/reviewer dispatch, orchestration fan-out, single-column autoban), it already knows the plan's real DB `planId` — stamp it into the prompt (`PLAN_ID=<real id>` + the plan file path) so the dispatched agent acts on the exact plan with no lookup. Today this is only partial: `POST /kanban/orchestration/dispatch` promises `planId` in the prompt, but the general `agentPromptBuilder` path references the plan by file/topic only. Make it uniform across every dispatch path. (This is the *push* complement to the state-file `planId` index's *pull* side — together they mean an agent never invents an ID.)

### ⚙️ OUT OF SCOPE
- The full 706-verb transport migration (A2) — this is only the feature/plan-structure verbs.
- The `/switchboard-manage` skill persona itself (A0) — it *consumes* this.

## Implementation Steps
1. **Path/slug resolver** in `KanbanProvider`/`KanbanDatabase` — resolve `path|slug|planId` → planId (reuse the `plan_file`-path import key). Shared by all feature ops.
2. **`reconcile` service method** — compute the diff (desired features/members vs current), apply create/assign/remove/move atomically, handle inline new-plan creation (write file → import → link), return the resulting structure. Reuse the extracted `create`/`assign`/`remove`/`split` methods from `a9693f5`.
3. **`POST /kanban/features/reconcile`** route + `LocalApiServer` option, following the existing injected-callback pattern; wire in `TaskViewerProvider`.
4. **Optional `POST /kanban/plans/split`** primitive (or fold into reconcile only).
5. **Revise scripts/skills** — verb scripts accept path/slug; rewrite `create_feature.md` and `group-into-features` around reconcile.
6. **Fix stdout hygiene** — move the `[KanbanDatabase] Resolved DB path…` log (and peers) from stdout to stderr so `get-state.js` (and any read script) emits parseable JSON; verify `node get-state.js <root> | jq .` succeeds.
7. **Dispatch ID injection** — every prompt-building path (`agentPromptBuilder` + the dispatch callers in `TaskViewerProvider`/`KanbanProvider`) stamps `PLAN_ID=<real DB id>` + the plan file path into the agent prompt; no path leaves the ID for the agent to discover or invent.
8. **Cheatsheet** — one end-to-end "reorganize features" recipe in `kanban_operations/SKILL.md` (replaces the scattered per-verb docs that cost an agent minutes to assemble).

## Edge cases & risks
- **Idempotency:** re-running the same reconcile is a no-op (converges to the same state) — required so an agent can retry safely.
- **Destructive moves:** reconcile that *removes* a plan from a feature detaches (never tombstones) unless explicitly told; report every mutation in the response.
- **Extension required:** reconcile spans DB + file writes + linking; no direct-DB fallback (same constraint as `create-feature.js`). Path/slug resolution + inline split must be transactional enough that a mid-way failure doesn't orphan a half-created plan.
- **Cross-column membership:** preserve the existing cross-column warning (assigning a CREATED plan to a PLAN REVIEWED feature) in the reconcile response.
- **Users on older installs:** additive endpoint + additive script args; no shipped-state migration.

## Complexity Audit
### Routine
- Path/slug resolver extension on the existing `getPlanByPlanFile` method (`KanbanDatabase.ts:3420`) — additive, patterned.
- `POST /kanban/features/reconcile` route arm following the existing injected-callback pattern (`LocalApiServer.ts:11-136`, handler template at `:405-447`).
- Script/skill revisions — documentation + argument-shape changes, no new logic.
- Stdout hygiene fix — moving a `console.log` to `console.error` (`KanbanDatabase.ts:902`).
### Complex / Risky
- **Private method access** — `_removeSubtaskFromFeature` (line 10339) and `_deleteFeature` (line 10385) are underscore-prefixed (private). The plan says "reuses extracted methods already public" but these two are NOT public. Public wrappers must be added before reconcile can call them from an HTTP handler.
- **Non-atomic primitives** — `assignPlansToFeature` (line 10740) loops calling `db.updateFeatureStatus` separately; NO transaction wrapping. `splitFeature` (line 10799) creates two features then deletes the source — if the second create fails, the source may already be deleted. Reconcile must wrap all DB operations in a single `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` transaction.
- **File-write + DB-write atomicity** — inline plan creation writes a `.md` file then imports it then links it. File writes are NOT transactional with DB writes. A crash between file write and DB link orphans a plan file on disk. Needs a compensating-action strategy (unlink on failure).
- **Slug derivation** — `slug` exists for `imported_docs` table only (line 377), NOT for plans. Slug addressing must derive slug from the plan filename. The derivation rule must be defined explicitly or every agent invents its own.

## Dependencies
- Reuses the extracted `create`/`assign`/`remove`/`split` methods from commit `a9693f5` — **but `_removeSubtaskFromFeature` (line 10339) and `_deleteFeature` (line 10385) are underscore-prefixed (private).** Public wrappers must be added before reconcile can call them. `createFeatureFromPlanIds` (line 10525), `assignPlansToFeature` (line 10740), and `splitFeature` (line 10799) ARE public.
- Builds on the existing `getPlanByPlanFile` method (`KanbanDatabase.ts:3420`) which resolves by `plan_file` + `workspace_id` — extend it for slug, don't duplicate it.
- Independent of A1/A2 for the endpoint itself, but ships as part of Feature A. `/switchboard-manage` (Manage) depends on this for a good feature-management UX.

## Adversarial Synthesis

Key risks: (1) **Private methods block the HTTP handler** — `_removeSubtaskFromFeature` (10339) and `_deleteFeature` (10385) are underscore-prefixed; the plan claims they're public but they're not. Reconcile cannot call private methods from an HTTP handler — public wrappers are a prerequisite. (2) **Existing path resolver duplicated** — `getPlanByPlanFile` (3420) already resolves `plan_file` → planId; the plan says "no existing path→planId resolution" but it exists. Build on it, extend for slug, don't reinvent. (3) **Slug is not an existing concept for plans** — `slug` exists only for `imported_docs`; slug addressing must derive from filename with a defined rule. (4) **Non-atomic composition** — the existing feature primitives don't wrap in transactions; reconcile must add its own `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` boundary, plus compensating-action (unlink) for file writes. Mitigations: add public wrappers as step 0; extend `getPlanByPlanFile` for slug (rule: slug = filename without `.md`, lowercased); wrap reconcile DB ops in a single transaction with file-write rollback.

## Proposed Changes

### `src/services/KanbanProvider.ts`
- **Context:** Feature methods from commit `a9693f5`: `createFeatureFromPlanIds` (public, line 10525), `assignPlansToFeature` (public, line 10740), `_removeSubtaskFromFeature` (**private**, line 10339), `_deleteFeature` (**private**, line 10385), `splitFeature` (public, line 10799). All keyed on UUID `planId` only.
- **Logic:** (1) Add public wrappers `removeSubtaskFromFeature` and `deleteFeature` that delegate to the existing private methods. (2) Add a `reconcileFeatures(workspaceRoot, desiredStructure)` public method that diffs desired-vs-current and converges atomically. (3) Accept path/slug/planId in all feature methods — extend the resolution to use `getPlanByPlanFile` for paths and a slug derivation for slugs.
- **Implementation:** `reconcileFeatures`: parse the desired structure → for each feature: resolve members (path/slug/planId → planId via `getPlanByPlanFile` or slug resolver), compute diff against current state, apply create/assign/remove/move inside a single `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` transaction. For inline new plans (`{slug, title, body}`): write the `.md` file, import it, link it — on DB failure, `unlink` the file (compensating action). Return the resulting structure (feature ids, member ids, mutations list).
- **Edge cases:** Idempotency — re-running the same reconcile is a no-op (converges to the same state). Destructive moves — removing a plan from a feature detaches (never tombstones) unless explicitly told; report every mutation in the response. Cross-column membership — preserve the existing cross-column warning (assigning a CREATED plan to a PLAN REVIEWED feature). Bad path → clear 400, not a silent orphan. Slug derivation: slug = plan filename without `.md` extension, lowercased, hyphens preserved (same convention as feature file naming).

### `src/services/KanbanDatabase.ts`
- **Context:** `getPlanByPlanFile` (line 3420) resolves by `plan_file` + `workspace_id`. `resolvePlanByAnyId` (line 3405) tries `plan_id` then `session_id`. No slug resolution exists. `slug` field exists only for `imported_docs` (line 377). 88 `console.log` statements; the confirmed stdout contaminator is at line 902 (`[KanbanDatabase] Resolved DB path...`).
- **Logic:** (1) Extend `getPlanByPlanFile` (or add a sibling `resolvePlanByPathOrSlug`) to also resolve by slug — derive slug from the plan filename (without `.md`, lowercased). (2) Move the `console.log` at line 902 (and any peers in the DB-resolution path) from `stdout` to `stderr` so `node get-state.js | jq .` works.
- **Implementation:** Slug resolver: given a slug, scan `plan_file` column for a matching filename (normalized: lowercase, strip `.md`). If multiple matches, return the first + a warning. Stdout fix: change `console.log('[KanbanDatabase] Resolved DB path...')` to `console.error('[KanbanDatabase] Resolved DB path...')` at line 902. Audit the other 87 `console.log` sites: route any that emit during `get-state.js`'s DB-resolution path to `stderr`.
- **Edge cases:** Slug collision (two plans with the same filename in different workspaces) → resolve by `workspace_id` context. No match → return null (caller returns 400). The stdout audit must be conservative: only move logs that fire during the DB-resolution path (before JSON output), not logs that fire during normal extension operation (where stdout is fine).

### `src/services/LocalApiServer.ts`
- **Context:** Feature endpoints at lines 1913-1924 (`/kanban/feature`, `/feature/assign`, `/feature/remove`, `/feature/delete`, `/feature/split`). Handler template at lines 405-447 (`_handleKanbanCreateFeature`). Injected-callback options at lines 11-136.
- **Logic:** Add `reconcileFeatures?` callback to options. Add `_handleReconcileFeatures` handler mirroring `_handleKanbanCreateFeature`. Add route arm: `else if (pathname === '/kanban/features/reconcile' && req.method === 'POST')`. Optionally add `POST /kanban/plans/split` (or fold split into reconcile only).
- **Implementation:** Handler parses the desired structure from the request body, calls `reconcileFeatures(workspaceRoot, desiredStructure)`, returns `{ success: true, data: { features: [...], mutations: [...] } }`. On error → `{ success: false, error }`.
- **Edge cases:** Large reconcile body (many features/subtasks) → no size limit needed (localhost). Missing `workspaceRoot` → 400 (same as existing handlers). Callback not wired (extension not running) → 503.

### `src/services/TaskViewerProvider.ts`
- **Context:** LocalApiServer constructed at lines 1039-1167. Existing feature callbacks passed in the options object.
- **Logic:** Add `reconcileFeatures: async (root, desired) => this._kanbanProvider.reconcileFeatures(root, desired)` to the options. Ensure `reconcileFeatures` is accessible (it's on `KanbanProvider`, which is reachable from `TaskViewerProvider`).
- **Implementation:** 1 line added to the options object.
- **Edge cases:** None — follows the existing callback wiring pattern.

### `.agents/skills/kanban_operations/` (scripts)
- **Context:** Scripts: `create-feature.js`, `assign-to-feature.js`, `remove-from-feature.js`, `split-feature.js`, `get-state.js` — all require UUID `planId` arguments.
- **Logic:** Update each script to accept path/slug in addition to UUID. The script resolves path/slug → planId before calling the existing API/DB method. Print human-readable results (never require the caller to supply a UUID).
- **Implementation:** Add a shared `resolvePlanId(input, workspaceRoot)` helper that tries UUID first, then `getPlanByPlanFile`, then slug. Each script calls it before its existing logic. Backward compatible: UUID still works.
- **Edge cases:** Ambiguous input (could be UUID or path) → try UUID first (it's a specific format), then path, then slug. Bad input → clear error message with the expected formats.

### `.agents/skills/kanban_operations/SKILL.md`
- **Context:** Documents the offline `<!-- planId:... -->` index (lines 16-20). Per-verb docs are scattered across the skill file.
- **Logic:** Add one end-to-end "reorganize features" cheatsheet using `POST /kanban/features/reconcile` — replaces the scattered per-verb docs that cost an agent minutes to assemble.
- **Implementation:** New section with a complete reconcile call example (path/slug addressing, inline plan-split, idempotent re-run). Reference the existing per-verb docs for fallback when the extension is down.
- **Edge cases:** None — additive documentation.

### `.claude/skills/create-feature/SKILL.md` and `.agents/skills/group-into-features/SKILL.md`
- **Context:** `create_feature` writes a feature file directly but cannot link existing plans headlessly (lines 96-102 — punts to `assign-to-feature.js`). `group-into-features` emits a create→assign sequence.
- **Logic:** Rewrite `create_feature` around reconcile (its file-only fallback keeps working when the extension is down). Update `group-into-features` to emit a reconcile manifest instead of a create→assign sequence.
- **Implementation:** `create_feature`: when the extension is running, call `POST /kanban/features/reconcile` with path/slug members instead of writing a shell file + punting to assign. When the extension is down, keep the file-write fallback. `group-into-features`: replace the `create-feature.js` + `assign-to-feature.js` sequence with a single reconcile call.
- **Edge cases:** Extension down → `create_feature` falls back to file-write (existing behavior preserved). `group-into-features` must detect extension availability before choosing the path.

### `src/services/agentPromptBuilder.ts` + dispatch callers (`TaskViewerProvider.ts` / `KanbanProvider.ts`)
- **Context:** Dispatch prompts are built from the plan's file/topic; the card carries the real DB `planId` at dispatch time but it is not uniformly surfaced in the prompt text. `POST /kanban/orchestration/dispatch` includes it; the general autoban/coder path does not.
- **Logic:** Every prompt-building path prepends an authoritative `PLAN_ID=<real id>` (plus the plan file path) so the agent references the exact plan without a lookup or a guess.
- **Implementation:** Thread the dispatch card's `planId` into `agentPromptBuilder` and prepend it to the built prompt; audit the dispatch callers so none omit it.
- **Edge cases:** Legacy cards with only a `sessionId` → fall back to `sessionId`, labelled as such. Never emit a placeholder or blank ID.

## Verification Plan
### Automated Tests
- Skipped per session directive — no automated test run required.
### Manual Verification
- Reconcile from a single call turns {one feature, N subtasks} into {two features} with an inline-split plan — no UUID handled by the caller; re-running is a no-op.
- Path/slug and planId all resolve; a bad path → clear 400, not a silent orphan.
- Existing verb scripts still work (UUID) and now also accept path/slug.
- The 4-minute "read three skills to reorganize" experience is replaced by one documented call.
- `node .agents/skills/kanban_operations/get-state.js <root> | jq .` parses cleanly (no `[KanbanDatabase]` log on stdout); the same for every read script.
- A dispatched coder/reviewer prompt contains `PLAN_ID=<real DB id>` + the plan file path; no dispatch path references a plan by a fabricated or absent ID.
- Public wrappers for `_removeSubtaskFromFeature` / `_deleteFeature` are accessible from the HTTP handler (no private-method access error).
- Reconcile DB operations are wrapped in a single transaction — a mid-way failure rolls back (no half-assigned plans). Inline plan file creation failure → file is unlinked (no orphan on disk).

**Stage Complete:** PLAN REVIEWED
