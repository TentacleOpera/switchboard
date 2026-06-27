# Plan: Notion Backup Epic Schema + Remote Agent Epic Orientation

## Goal

Add epic structure to the Notion Remote Control surface so the remote agent (claude.ai driving Notion via MCP) can **see, create, and modify** epics and subtask assignments. Today, the Notion plans database (`NotionBackupService.autoCreateDatabase`, line 151) has properties for every `KanbanPlanRecord` field except `isEpic` and `epicId` — there is no `Is Epic` checkbox or `Epic` relation. The backup writes nothing about epic structure, the remote agent can't express it, and the poll (Plan 4) can't read it.

This plan adds two new Notion database properties, wires them through the backup/restore/write paths, and updates the remote orientation skill to teach the remote agent how to use them.

**Core problem / root cause.** Three gaps:
1. **Schema gap:** `autoCreateDatabase` (line 161-199) defines the DB properties but omits `Is Epic` and `Epic`. The `_planToNotionProperties` method (line 436-453) maps plan fields to Notion properties but doesn't include `isEpic`/`epicId`. And `_notionPageToPlanRecord` (line 456-494) reads properties back but doesn't read epic fields.
2. **Write gap:** even if the properties existed, `_upsertPlanToNotion` (line 394) writes the properties from `_planToNotionProperties` — so epic structure would never be backed up.
3. **Orientation gap:** the `switchboard_remote_notion.md` skill (58 lines) teaches the remote agent how to create pages, set columns, and post comments — but says nothing about epics. The remote agent doesn't know it can group work into epics or that moving an epic cascades subtasks locally.

## Metadata

**Tags:** [backend, sync, notion, remote-control, feature, docs]
**Complexity:** 5
**Repo:** (single-repo)
**Depends on:** `notion-remote-control-and-delta-polling.md` (shipped — Notion backup + remote setup exist)
**Related:** `remote-control-epic-aware-mirroring.md` (Plan 4 — reads the properties this plan creates), `epic-sync-outbound.md` (outbound Linear/ClickUp sync)

## User Review Required

Yes — confirm:
1. Should the `Epic` relation be a **single-property** relation (one epic per subtask) or a **multi-property** relation (a subtask can belong to multiple epics)? Switchboard's local model is single-epic (`epic_id` is a single string, `getSubtasksByEpicId` queries by exact match). This plan proposes **single-property** to match the local model. If multi-property is needed, the local schema and `updateEpicStatus` would need changes (out of scope).
2. Should `restoreFromNotion` (the "restore from backup" flow) apply epic structure from Notion back to the local DB? This plan proposes **yes** — it's a restore, so the Notion DB is the source of truth. But this means a user who manually un-checks `Is Epic` in Notion and then restores would lose the local epic. Acceptable (restore is an explicit destructive operation).

## Context

The Notion plans DB is created by `autoCreateDatabase` (NotionBackupService.ts:151) with a fixed set of properties. The remote-control setup (`setupRemoteControl`, line 234) reuses this DB, extends the `Kanban Column` select, backs up plans, and writes page ids back. The `Epic` relation needs to point to the *same* plans DB (a self-relation) — a subtask's `Epic` property points to its epic's page in the same database.

Notion self-relations are supported: `relation: { database_id: <same-db-id>, type: 'single_property', single_property: {} }`. The relation must be added AFTER the database is created (Notion requires the database to exist before a relation can point to it). So the `Epic` property is added in a PATCH to the database after `autoCreateDatabase` creates it — the same pattern `_ensureColumnSelectOptions` (line 335) uses to extend the select.

Key existing infrastructure:
- `_ensureColumnSelectOptions` (line 335) — PATCHes the database to extend the `Kanban Column` select. The `Epic` relation uses the same PATCH-database pattern.
- `_planToNotionProperties` (line 436) — maps `KanbanPlanRecord` → Notion properties. Add `Is Epic` + `Epic` here.
- `_notionPageToPlanRecord` (line 456) — maps Notion page → `KanbanPlanRecord`. Read `Is Epic` + `Epic` here.
- `KanbanPlanRecord.isEpic` (line 57) and `epicId` (line 58) — the local fields.
- `KanbanDatabase.findPlanByNotionPageId` (line 2623) — look up a local plan by its Notion page id (used to resolve the `Epic` relation back to a local `planId`).
- `KanbanDatabase.updateEpicStatus(planId, isEpic, epicId)` (line 1455) — set epic status + parent.

---

## What Gets Built

### 1. Add `Is Epic` and `Epic` properties to the Notion plans DB

**File:** `src/services/NotionBackupService.ts`

**In `autoCreateDatabase` (line 161-199):** Add two properties to the initial DB creation payload:
- `'Is Epic': { checkbox: {} }` — simple boolean.
- `'Epic': { relation: { database_id: <plansDatabaseId>, type: 'single_property', single_property: {} } }` — self-relation to the same DB.

**Problem:** the `Epic` relation needs the database's own id, but the database doesn't exist yet during creation. Notion's `POST /databases` creates the DB and returns its id. Two approaches:

**Approach A (preferred): create DB without `Epic`, then PATCH to add the relation.**
- `autoCreateDatabase` creates the DB with `Is Epic` (checkbox) but WITHOUT `Epic`.
- After creation, immediately PATCH the database to add the `Epic` self-relation: `PATCH /databases/${databaseId}` with `properties: { 'Epic': { relation: { database_id: databaseId, type: 'single_property', single_property: {} } } }`.
- This mirrors the `_ensureColumnSelectOptions` pattern (PATCH after create).

**Approach B (fallback): Notion supports self-referencing relations in the creation payload if the database_id is a placeholder.** This is undocumented and unreliable — use Approach A.

### 2. Extend `_ensureEpicProperties` — idempotent property addition for existing DBs

**File:** `src/services/NotionBackupService.ts`

Add a new private method `_ensureEpicProperties(databaseId: string)` that PATCHes the database to add `Is Epic` (checkbox) and `Epic` (relation) if they don't already exist. Idempotent — safe to call on every setup. Pattern mirrors `_ensureColumnSelectOptions` (line 335):

```ts
private async _ensureEpicProperties(databaseId: string): Promise<void> {
    try {
        const dbResult = await this._notionFetchService.httpRequest('GET', `/databases/${databaseId}`, undefined, 10000);
        if (dbResult.status !== 200) { return; }
        const props = dbResult.data?.properties || {};
        const patch: Record<string, any> = {};
        if (!props['Is Epic']) {
            patch['Is Epic'] = { checkbox: {} };
        }
        if (!props['Epic']) {
            patch['Epic'] = { relation: { database_id: databaseId, type: 'single_property', single_property: {} } };
        }
        if (Object.keys(patch).length > 0) {
            await this._notionFetchService.httpRequest('PATCH', `/databases/${databaseId}`, { properties: patch }, 10000);
        }
    } catch (e) {
        console.warn('[NotionBackupService] _ensureEpicProperties failed:', e);
    }
}
```

Call this from `setupRemoteControl` (line 234) after the plans DB is ensured (line 254), alongside `_ensureColumnSelectOptions` (line 262). This upgrades existing DBs in-place.

### 3. Write epic properties in `_planToNotionProperties`

**File:** `src/services/NotionBackupService.ts`

In `_planToNotionProperties` (line 436-453), add:

```ts
'Is Epic': { checkbox: Boolean(plan.isEpic) },
'Epic': plan.epicId ? {
    relation: [{ id: <epicPageId> }]
} : { relation: [] }
```

**Problem:** `plan.epicId` is a local `planId`, not a Notion page id. The `Epic` relation needs the epic's **Notion page id**. To resolve it: look up the epic's plan record by `planId`, read its `notionPageId`. This requires a DB lookup during property mapping.

Two options:
- **Option A:** pass a `epicIdToNotionPageId: Map<string, string>` into `_planToNotionProperties` (pre-built from all plans in the backup batch). Clean but changes the method signature.
- **Option B:** do a single `findPlanByNotionPageId`-style lookup inside the method. Simpler signature, but a per-plan DB query during backup (acceptable — backup is not performance-critical, and the ~350ms Notion rate limiter dominates).

This plan proposes **Option A** — build the map once in the backup/setup loop and pass it through. The `backupToNotion` method (line 48) and `setupRemoteControl` (line 234) both iterate `allPlans` — build `Map<planId, notionPageId>` from that array before the loop.

### 4. Read epic properties in `_notionPageToPlanRecord`

**File:** `src/services/NotionBackupService.ts`

In `_notionPageToPlanRecord` (line 456-494), add:

```ts
isEpic: p['Is Epic']?.checkbox ? 1 : 0,
epicId: '', // Can't resolve here — see below.
```

**Problem:** the `Epic` relation gives us the epic's **Notion page id**, not its local `planId`. But `KanbanPlanRecord.epicId` is a `planId`. We can't resolve it in `_notionPageToPlanRecord` (it's a pure mapping function with no DB access). The resolution must happen in the caller (`restoreFromNotion`, line 88).

In `restoreFromNotion` (line 88-147), after building `toRestore`, do a second pass:
- Build `Map<notionPageId, planId>` from the restored records (each record has `notionPageId = page.id` and `planId` from the `Plan ID` property).
- For each restored record with an `Epic` relation: look up the related page's `notionPageId` in the map → set `epicId = map.get(epicPageId)`.
- Then `upsertPlans` + `updateEpicStatus` for each linked record.

### 5. Write epic properties during setup sync

**File:** `src/services/NotionBackupService.ts`

In `setupRemoteControl` (line 234-303), the backup loop (line 267-278) calls `_upsertPlanToNotion` for each plan. After Plan 3's change, this writes `Is Epic` + `Epic` properties. But the `Epic` relation needs the epic's Notion page id, which might not exist yet (the epic might not have been backed up yet in the loop).

Solution: **two-pass setup sync:**
1. **Pass 1:** back up all plans (create pages, write page ids back). Don't write `Epic` relations yet — set `Is Epic` checkbox only.
2. **Pass 2:** for each plan with an `epicId`, PATCH its page to set the `Epic` relation (now that all pages exist and all page ids are known).

This is the same two-pass pattern as the ClickUp/Linear import plans (Plan 2/3) — relationships can't be written until all entities exist.

### 6. Update the remote orientation skill

**File:** `.agents/skills/switchboard_remote_notion.md`

Add an "Epics" section after step 6 ("Read results"):

```markdown
## Epics (grouping related work)

An **epic** is a parent card that groups related subtask cards. Moving an epic's
`Kanban Column` cascades the move to all its subtasks on the local machine — so you
can dispatch a whole group of work in one action.

### To create an epic
1. Create the epic's page in the plans DB (same as any card).
2. Check the **Is Epic** checkbox property.
3. The page is now an epic — it can have subtasks.

### To assign a subtask to an epic
1. Create or find the subtask's page.
2. Set its **Epic** relation property to point to the epic's page.
3. The local poll mirrors the link — the subtask now moves when the epic moves.

### To trigger a group of work
1. Set the `Kanban Column` on the **epic** page (not the subtasks).
2. The local cascade moves all subtasks to the same column and dispatches each
   subtask's column agent.

### Constraints
- A subtask can belong to only **one** epic (single-select relation).
- Only create epic/subtask links between pages on the **same synced board** —
  the local poll can only mirror links between cards it tracks.
- An epic with no subtasks is harmless (it just cascades to nothing).
```

### 7. Update `restoreFromNotion` to apply epic structure

**File:** `src/services/NotionBackupService.ts`

As described in §4: after the restore loop builds `toRestore`, do a second pass to resolve `Epic` relations to local `planId`s and call `updateEpicStatus`. This makes the restore path epic-aware.

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/NotionBackupService.ts` | Add `Is Epic` + `Epic` to DB creation; add `_ensureEpicProperties`; extend `_planToNotionProperties` + `_notionPageToPlanRecord`; two-pass setup sync; restore epic resolution |
| `.agents/skills/switchboard_remote_notion.md` | Add "Epics" section teaching the remote agent how to create/assign epics via Notion MCP |

---

## Key Reuse (do not reinvent)

- `_ensureColumnSelectOptions` (NotionBackupService.ts:335) — same PATCH-database pattern for `_ensureEpicProperties`
- `autoCreateDatabase` property payload (line 161-199) — extend with two new properties
- `_planToNotionProperties` (line 436) — add two fields to the mapping
- `_notionPageToPlanRecord` (line 456) — read two new properties
- `KanbanDatabase.updateEpicStatus` (line 1455) — apply epic structure on restore
- `KanbanDatabase.findPlanByNotionPageId` (line 2623) — resolve Notion page id → local plan
- Two-pass pattern from `clickup-import-epic-linking.md` (Plan 2) — write entities first, then relationships

---

## Complexity Audit

### Routine
- Adding two properties to the DB creation payload (mechanical)
- `_ensureEpicProperties` — mirrors `_ensureColumnSelectOptions` exactly
- Extending `_planToNotionProperties` — two new lines in the return object
- Extending `_notionPageToPlanRecord` — two new reads
- Skill markdown update — prose addition

### Complex / Risky
- **The `Epic` self-relation:** Notion relations that point to the same database require a PATCH after creation (the DB must exist before the relation can reference it). Approach A (create without `Epic`, PATCH to add) is the proven pattern.
- **The `planId` → `notionPageId` resolution in backup:** `_planToNotionProperties` needs the epic's Notion page id, but `KanbanPlanRecord.epicId` is a local `planId`. The `epicIdToNotionPageId` map (Option A) must be built before the backup loop and passed through. If the epic's page doesn't exist yet (not backed up), the `Epic` relation is empty for that subtask — it'll be set in Pass 2.
- **Two-pass setup sync:** the current `setupRemoteControl` backs up plans in a single loop. The two-pass split (entities first, relations second) adds a second loop but is the same pattern as the ClickUp/Linear import plans.
- **Restore epic resolution:** `restoreFromNotion` needs a second pass to resolve `Epic` relations (Notion page id → local planId). The `notionPageId → planId` map is built from the restored records themselves (each has both). This is a self-contained resolution — no external lookups needed.

---

## Edge-Case & Dependency Audit

- **Epic's page not yet backed up (Pass 1):** the subtask's `Epic` relation is empty in Pass 1. Pass 2 sets it after all pages exist. If the epic is filtered out (not on a selected board), its page isn't created — the subtask's `Epic` relation stays empty. The local `epicId` is preserved (it was set before the backup), but the Notion representation is incomplete. Acceptable — the remote agent can fix it by assigning the subtask to a visible epic.
- **Restore with `Is Epic` unchecked:** if a user manually un-checks `Is Epic` in Notion and restores, the local plan loses its `isEpic=1` status. Subtasks remain linked (their `epicId` is unchanged), but the epic no longer cascades. This is a user-initiated destructive action (restore) — acceptable.
- **Circular relation:** a page's `Epic` relation points to itself. Notion might allow this. The local `_mirrorEpicStructure` (Plan 4) has a self-parenting guard. The restore should also guard: skip `epicId` resolution if the `Epic` relation points to the same page.
- **`Epic` relation to a page in a different Notion DB:** the relation is scoped to the plans DB (self-relation), so this can't happen via the Notion UI. But if the DB is misconfigured, the relation target might not have a `Plan ID` property — the `notionPageId → planId` map won't have it. Skip and log.
- **Pre-existing DBs (upgrade path):** `setupRemoteControl` calls `_ensureEpicProperties` which PATCHes existing DBs to add the properties. Existing pages get `Is Epic = false` and `Epic = empty` by default. The next backup sync writes the correct values. No data loss.

---

## Dependencies

- `notion-remote-control-and-delta-polling.md` — shipped (Notion backup + remote setup exist).
- `remote-control-epic-aware-mirroring.md` (Plan 4) — reads the `Is Epic`/`Epic` properties this plan creates. Plan 4's Notion provider is a no-op without this plan, but degrades safely.
- No new npm packages.

---

## Adversarial Synthesis

**Risk Summary:** (1) The Notion self-relation requires a PATCH-after-create (Approach A) — the DB must exist before the `Epic` relation can reference it. This is the same pattern as `_ensureColumnSelectOptions` and is proven. (2) The `planId` → `notionPageId` resolution in backup requires a pre-built map (Option A) — if the epic's page doesn't exist yet, the subtask's relation is deferred to Pass 2. (3) The two-pass setup sync adds a second loop but is bounded by the number of plans (not performance-critical given the 350ms rate limiter). (4) The restore path needs a second pass for epic resolution — self-contained, no external lookups. (5) The skill update is prose — no code risk. Overall this is a low-risk, mostly-mechanical plan that extends existing patterns.

---

## Proposed Changes

### `src/services/NotionBackupService.ts`
- **`autoCreateDatabase` (line 151):** Add `'Is Epic': { checkbox: {} }` to the creation payload. Do NOT add `Epic` here (self-relation needs the DB id first).
- **New `_ensureEpicProperties(databaseId)`:** PATCH the database to add `Is Epic` (if missing) and `Epic` self-relation (if missing). Called from `setupRemoteControl` after the plans DB is ensured.
- **`_planToNotionProperties` (line 436):** Add `Is Epic` checkbox and `Epic` relation. Accept an optional `epicIdToNotionPageId?: Map<string, string>` parameter. If the map is provided and `plan.epicId` is in it, set the relation. If not, leave the relation empty (Pass 2 fills it).
- **`_notionPageToPlanRecord` (line 456):** Read `Is Epic` checkbox → `isEpic: 1/0`. Read `Epic` relation → store as `epicNotionPageId` (a transient field, not on `KanbanPlanRecord` — use a local variable in the caller). The caller (`restoreFromNotion`) resolves it to a `planId`.
- **`setupRemoteControl` (line 234):**
  1. Call `_ensureEpicProperties(plansDatabaseId)` after the plans DB is ensured (line 254).
  2. Build `epicIdToNotionPageId: Map<string, string>` from `allPlans` before the backup loop. (First pass: create pages and collect page ids. Second pass: PATCH pages with `Epic` relations.)
  3. Two-pass backup: Pass 1 creates/updates all pages (with `Is Epic` but no `Epic` relation). Pass 2 PATCHes each subtask page to set its `Epic` relation.
- **`restoreFromNotion` (line 88):** After building `toRestore`, build `Map<notionPageId, planId>` from the restored records. For each record with an `Epic` relation (read during `_notionPageToPlanRecord`), resolve the related page's `notionPageId` → `planId` and set `epicId`. Call `updateEpicStatus` for each. Guard against self-relations.

### `.agents/skills/switchboard_remote_notion.md`
- Add the "Epics" section (as specified in §6 above) after the existing "Read results" step. Register in `MIRROR_MANIFEST` (ClaudeCodeMirrorService.ts) — it's already registered (the skill exists); just update the content.

---

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification
1. Run "Notion setup sync" on a board with an epic + 2 subtasks. Confirm in Notion: the epic page has `Is Epic = true`, each subtask page has `Epic` relation pointing to the epic page.
2. In Notion, check `Is Epic` on a non-epic page and set another page's `Epic` relation to it. Wait for the poll (Plan 4). Confirm: the local board mirrors — the first plan becomes `isEpic=1`, the second gets `epicId` set.
3. In Notion, move the epic page's `Kanban Column` to a trigger column. Wait for the poll. Confirm: the epic and all its subtasks cascade to the new column locally.
4. Restore from Notion backup. Confirm: epic structure (`isEpic`, `epicId`) is restored to the local DB.
5. Pre-existing DB upgrade: run setup sync on a DB created before this plan shipped. Confirm: `_ensureEpicProperties` adds `Is Epic` + `Epic` to the existing DB without data loss. Existing pages get `Is Epic = false` and `Epic = empty` until the next backup writes the correct values.
6. Remote agent orientation: start a claude.ai session with Notion MCP. Follow the skill's epic instructions. Confirm: the remote agent can create an epic, assign subtasks, and trigger a cascade by moving the epic's column.

---

## Recommendation

Complexity is **5** (extending existing patterns — property addition, property read/write, two-pass sync, skill prose). The self-relation PATCH is the only novel piece, and it mirrors the proven `_ensureColumnSelectOptions` pattern. **Send to Coder** alongside or before Plan 4 (Plan 4's Notion provider is a no-op without these properties).
