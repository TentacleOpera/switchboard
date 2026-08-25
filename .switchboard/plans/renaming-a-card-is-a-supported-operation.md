# Renaming a card is a supported operation

**Project:** Browser Switchboard

## Goal

Give the board a rename that survives. One verb that writes the card's topic and the plan file's `# H1` together, so a renamed card stays renamed instead of reverting the next time the watcher touches its file.

### Problem Analysis

**There is no rename verb.** `src/generated/verbAllowlist.ts` contains `renameTerminal` and nothing else matching rename, topic, or title across any verb set. An agent asked to rename a card has no supported path, so it reaches for the database.

**The database write is real, and temporary.** `UPSERT_PLAN_SQL` overwrites the topic on every file re-import, unguarded:

```
ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
    topic = excluded.topic,           -- no guard
    ...
    kanban_column = CASE ... END,     -- guarded against re-import
    column_entered_at = CASE ... END  -- guarded against re-import
```

`kanban_column` and `column_entered_at` are both protected — a file re-import must never yank a card out of its column — because both were, at some point, lost that way. `topic` was never given the same protection. So a DB-only rename lives until the watcher next imports that file, which can be seconds: the topic is re-derived from the file's H1 by `extractTopic` (`PlanFileImporter.ts:206`) and written straight over the rename.

**Nothing reports the failure, which is why it keeps happening.** The `UPDATE` succeeds and returns true, so the agent reports a successful rename in good faith. The revert arrives later, out of band, from a different subsystem. From the user's side the rename simply never happens; from the agent's side it always worked. That asymmetry is why the same request fails repeatedly without anyone finding the cause.

**The durable pattern already exists, in one place, correctly, and is unreachable.**

> **Superseded:** `KanbanProvider.ts:13838-13858`, inside `promoteToFeature`, updates the DB topic AND rewrites the file's first H1 — and its own comment states the defect exactly.
> **Reason:** The line range is wrong. Lines 13838+ are the file-move/slug logic (`featureDir`, `slug`, `updatePlanFileByPlanId`, `fs.promises.rename`). The actual DB-topic-plus-H1 block is **`KanbanProvider.ts:13823-13836`** — `if (customName && customName !== plan.topic)` through the closing `catch` brace. An implementer following the old citation would extract the move logic, not the rename logic.
> **Replaced with:** `KanbanProvider.ts:13823-13836`, inside `promoteToFeature`. That block writes `db.updateTopicByPlanFile` (13825) then rewrites the first H1 (13827-13833), and its inline comment (13817-13821) states the durability defect exactly:

> *"DB-only is NOT durable: the next re-import re-derives topic from the heading (`extractTopic`) and overwrites the DB topic via `insertFileDerivedPlan`'s `ON CONFLICT ... DO UPDATE SET topic = excluded.topic`."*

That block only runs when a plan is being promoted to a feature and an optional `name` was supplied. It cannot be reached to rename anything else.

> **Superseded:** Three of the four callers write the DB alone. `SessionActionLog.ts:585` and `TaskViewerProvider.ts:16523` and `:16581` all call `updateTopicByPlanFile` with no H1 write. Every one of those renames is on a timer.
> **Reason:** Two errors. (1) The TaskViewerProvider line numbers are wrong — the calls are at **`:16533`** and **`:16591`**, not `:16523`/`:16581`. (2) Those two calls are NOT DB-only renames. They write `meta.topic`, which is the result of `parsePlanMetadata(mirrorContent, relativeMirror)` (`TaskViewerProvider.ts:16530`) — i.e. the topic **parsed from the mirror file's own content**. The file already carries the H1; the DB write is a file→DB import sync, which is durable by construction (the file is the source of truth). Characterising them as "renames that write the DB alone" inverts the data flow. They are also driven by `stagingWatcher` (a file watcher), not a timer.
> **Replaced with:** Of the four `updateTopicByPlanFile` callers, only **one** writes the DB alone with no file backing: `SessionActionLog.ts:585`, which writes `next.topic` — a value mutated by a runsheet `updater` callback (`SessionActionLog.ts:559`), not derived from the plan `.md` file. That is the genuine DB-only topic write that reverts on the next import. The two `TaskViewerProvider` callers (`:16533`, `:16591`) are file→DB mirror syncs (the file is the source, so they are durable). `promoteToFeature` (`:13825`) is the one correct two-home writer. The helper's danger is not that it has many rename callers — it is that it is named and shaped as though a DB write were a complete rename, so the next agent (or the runsheet sync) reaches for it and gets a revert.

### Root Cause

The topic has two homes — the file's H1 and the `plans.topic` column — and the file is authoritative on every import. One writer understood that and handled both; the shared helper it sits next to handles only one, is the obvious thing to call, and is named as though it were sufficient.

## Metadata

**Complexity:** 4

> **Superseded:** Complexity 3.
> **Reason:** The work spans four files (`KanbanProvider.ts` extract + verb arm, `KanbanDatabase.ts` docblock, `verbSchemas.ts` schema entry, `verbAllowlist.ts` regeneration), with one race-sensitive write-ordering decision and an error-handling semantic change (swallow-and-continue → fail-and-report). That is mixed (multi-file, moderate logic), not the single-file routine that 3 implies.
> **Replaced with:** Complexity 4 — multi-file change reusing existing patterns, with one well-scoped ordering/error-handling risk.

**Tags:** bugfix, backend, api

> **Superseded:** Tags: bug, backend, agents.
> **Reason:** `bug` and `agents` are not in the allowed tag list (`bugfix`, `backend`, `api`, `frontend`, `auth`, ...). Inventing tags outside the list is a schema violation.
> **Replaced with:** Tags: bugfix, backend, api — `bugfix` is the allowed synonym for `bug`; `api` covers the new HTTP-reachable verb; `agents` has no allowed equivalent and is dropped.

## User Review Required

- None.

## Settled Design

- **One rename operation, writing both homes.** DB topic and file H1, keyed on `plan_file`. Anything that writes only one is not a rename.
- **Extract the working block from `promoteToFeature` rather than write a second copy.** It is already correct; a parallel implementation is how the two drift and one of them regresses to DB-only.
- **`updateTopicByPlanFile` stops being callable as a rename.** It becomes the DB half of the pair, named and documented so the next reader does not mistake it for the whole operation.
- **The verb is generated into the allowlist.** `handleServiceVerb` throws on anything absent from `KANBAN_VERBS` (`KanbanProvider.ts:9127-9128`), so an ungenerated verb works in the VS Code webview and is dead in the browser cockpit.
- **The verb payload is schema-validated.** `handleServiceVerb` calls `validateVerbPayload('kanban', verb, payload)` (`:9132`) before dispatch. A write verb reachable at `/kanban/verb/renamePlan` over HTTP must declare a schema so untrusted payloads are rejected, not passed through by the generic-dispatch contract.
- **No confirm gate.** Renames apply immediately (project rule).

## Complexity Audit

### Routine

- One shared helper extracted from an existing correct block (mechanical move).
- One verb arm following the `setPriorityStarred` pattern (`KanbanProvider.ts:12271-12282`).
- One docblock update on `updateTopicByPlanFile`.
- One `verbSchemas.ts` entry mirroring `promoteToFeature`'s shape.
- One allowlist regeneration (`npm run catalog:generate`).

### Complex / Risky

- **The H1 rewrite must not create a second heading.** The existing block handles both cases: replace the first `^#\s+.+$` if present, prepend one if absent, and strip newlines from the incoming name first so a multi-line value cannot inject a heading. Carry that behaviour across unchanged rather than re-deriving it.
- **A failed H1 write must not leave a rename that silently reverts.** The existing block catches the write error, logs it, and keeps the DB topic — which is precisely the state that reverts on the next import. The extracted helper must report failure to its caller so the verb returns an error, rather than reporting a success that expires.
- **Order matters against the watcher.** Writing the file first fires a watcher import that re-derives the topic from the new H1; writing the DB first leaves a window where an import could revert it before the file is written. Write the file first, then the DB, so the two converge on the same value whichever path wins. (Note: the in-place H1 edit to the old path does NOT need watcher suppression — the imported topic matches the new H1, so the import is a no-op write of the same value. `promoteToFeature` already relies on this.)
- **The filename is not part of the rename.** `promoteToFeature` slugs the topic into a new filename because it is relocating the file into `features/`. A rename must not move or re-slug anything — the slug is frozen at creation, the H1 is authoritative, and renaming the file would break `plan_file` as the upsert key and orphan the card.
- **Features carry the same shape.** A feature's file is a feature file and its topic comes from its H1 identically, so one operation covers both. The auto-generated `<!-- BEGIN SUBTASKS -->` block must not be touched — only the first H1.

## Edge-Case & Dependency Audit

**Migration.** None. No schema change, no state.

**Security.** The name is written into a file the workspace already owns. Strip newlines (the existing block does) so the value cannot inject a second heading or trailing markdown. The `verbSchemas.ts` entry makes `name` a required string so an empty/missing name is rejected at the HTTP boundary before it reaches the file write.

**Side effects.** Renames become durable, which is the point. Existing cards whose renames were lost are not restored — they were reverted to their H1, which is now the authoritative value and the thing this operation edits.

**Ordering.** None. Independent of the mission and grouping work.

**Race conditions.** A rename and a concurrent file edit both write the same file. Last write wins on the H1, and the DB follows the H1 on the next import either way, so the two converge rather than diverging — which is the property the current DB-only path lacks.

**Dependencies & Conflicts.** None beyond the related plan below.

## Dependencies

- **Related to** `feature-titles-and-prose-must-be-true-of-the-plans-inside.md` — that plan governs whether a title is *correct*; this one governs whether a correction *sticks*. A rename that reverts makes that plan unenforceable in practice.

## Adversarial Synthesis

Key risks: (1) a second implementation is written instead of extracting the working one, and the copy regresses to DB-only — the exact defect, reintroduced beside its own fix; (2) the extracted helper keeps `promoteToFeature`'s swallow-and-continue error handling, so a failed H1 write still reports a successful rename that expires; (3) the verb is not regenerated into the allowlist and the rename is dead in the browser host; (4) the verb ships without a `verbSchemas.ts` entry, so an untrusted HTTP payload reaches the file write unvalidated. Mitigations: the plan requires extraction with `promoteToFeature` repointed at it, the helper returns failure rather than logging it, allowlist membership is asserted by test, and a schema entry is added so `validateVerbPayload` rejects malformed payloads at the boundary.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — extract the durable rename

**Context:** `:13823-13836`, the DB-topic-plus-H1 block inside `promoteToFeature` (the `if (customName && customName !== plan.topic)` branch).

**Logic:**
- Extract as `renamePlanByPlanFile(workspaceRoot, planFile, workspaceId, name)`: strip newlines from `name` (`replace(/[\r\n]+/g, ' ').trim()`); resolve the absolute path; replace the first `^#\s+.+$` or prepend `# name` if absent; write the file; then `db.updateTopicByPlanFile`. Return failure if either write fails — do not log and continue.
- **Order:** file write first, then DB write. A DB-write failure is self-healing (the next watcher import re-derives topic from the new H1); a file-write failure must abort before the DB is touched, so no false-success state is left behind.
- Repoint `promoteToFeature` at it so there is one implementation. Its later slug/move logic is untouched and keeps using `customName`.

**Edge Cases:**
- The in-place H1 edit fires a watcher import on the old path; the imported topic equals the new H1, so the import is a no-op. No suppression registration needed for the rename itself (`promoteToFeature`'s move suppression is separate and unchanged).
- A feature file's `<!-- BEGIN SUBTASKS -->` block is outside the first H1 and is untouched by the regex.

### 2. `src/services/KanbanProvider.ts` — the verb arm

**Context:** The `_handleMessage` switch (`:9209`), alongside `setPriorityStarred` (`:12271-12282`). Note: `handleServiceVerb` (`:9119`) is the allowlist-gated entry that validates the payload and delegates to `_handleMessage` (`:9150`); the case arm goes in `_handleMessage`.

**Logic:**
- `case 'renamePlan'`: resolve the workspace root and the plan by `planId` then `sessionId` (the card id is `planId || sessionId`, and `_persistedUpdate` reports success on zero rows — the same trap `setPriorityStarred` fell into at `:8538-8544`). Reject an empty/whitespace name. Call `renamePlanByPlanFile`, post a board refresh, and surface a failure through `this.postMessage({ type: 'showStatusMessage', message: ..., isError: true })` (the `setPriorityStarred` pattern).
- Return `{ success: false, error }` on failure so the HTTP rail serializes it as a non-2xx body (the return-in-body contract, `:16011-16013`), not a silent false-success.

### 3. `src/services/verbSchemas.ts` — validate the verb payload

**Context:** The `kanban` schema block, alongside `promoteToFeature` (`:222-228`).

**Logic:**
- Add a `renamePlan` entry:
  ```typescript
  renamePlan: {
      fields: {
          planId: { type: 'string', required: true },
          name: { type: 'string', required: true },
          workspaceRoot: { type: 'string' },
      },
  },
  ```
- `name` is required (unlike `promoteToFeature` where it is optional) — a rename with no name is a no-op and must be rejected at the boundary, not inside the arm.

### 4. `src/services/KanbanDatabase.ts` — stop the helper reading as sufficient

**Context:** `updateTopicByPlanFile` (`:3283`).

**Logic:**
- Docblock: this writes the DB half only and is reverted by the next re-import, because `UPSERT_PLAN_SQL` sets `topic = excluded.topic` unguarded. Callers renaming a card must use `renamePlanByPlanFile`. Name the one current DB-only caller (`SessionActionLog.ts:585`) so it is found the next time someone traces a lost rename. Note that the `TaskViewerProvider` callers (`:16533`, `:16591`) are file→DB mirror syncs and are durable by construction.

### 5. Regenerate the allowlist

**Logic:**
- `npm run catalog:generate`, then confirm `npm run catalog:check` and `npm run parity:check` pass.

## Verification Plan

### Goal Invariants

- A renamed card keeps its name across a re-import (the file's first H1 and the DB `plans.topic` match after import).
- Exactly one implementation writes both homes — `promoteToFeature` calls the shared helper and contains no inline H1 rewrite of its own.
- A rename that cannot write the file reports failure and writes nothing to the DB.

### Automated Tests

- **A rename survives re-import:** rename a card, re-import its file, assert the topic is the new name. This fails against every DB-only path and is the whole point.
- **Both homes are written:** assert the file's first H1 and the DB topic match after a rename.
- **One implementation:** assert `promoteToFeature` calls the shared helper and contains no inline H1 rewrite of its own. A duplicated block passes behavioural tests right up until one copy regresses.
- **A failed file write fails the rename:** make the file unwritable; assert the verb returns an error and does not report success. The current block logs and continues, leaving a rename that expires — the exact state this plan removes.
- **No second heading:** rename a file with no H1, and one with an H1 that is not the first line; assert exactly one `# ` heading afterwards. Rename with a name containing a newline; assert it is stripped.
- **The filename does not move:** assert `plan_file` is unchanged by a rename — re-slugging would break the upsert key and orphan the card.
- **A feature renames the same way, and its auto-block survives:** rename a feature; assert the topic changes and the `<!-- BEGIN SUBTASKS -->` block is byte-identical.
- **Reachable in both hosts:** assert `renamePlan` is present in `KANBAN_VERBS`. Absent, it works in the VS Code webview and throws on `/kanban/verb/*` in the browser cockpit.
- **Payload validated at the boundary:** assert `validateVerbPayload('kanban', 'renamePlan', {})` rejects (missing required `name`), and a valid payload passes.

### Manual Verification

- Rename a card, touch its plan file, refresh the board; confirm the new name is still there.
- Rename a feature; confirm its subtask list is unchanged.
