# Plan: Remote Control Epic-Aware State Mirroring

## Goal

Make the Remote Control polling loop **epic-aware** so that when the remote agent creates or changes a parent/child relationship in Linear or Notion, the local board mirrors the epic structure — not just the column state. Today, `RemoteControlService._pollState` (RemoteControlService.ts:252) detects column changes on individual cards but is blind to epic structure: an epic and its subtasks are just independent entries in `_indexByRemoteId` (line 220), and a new parent/child link created by the remote agent is invisible to the poll.

**Core problem / root cause.** The `RemoteProvider` interface (RemoteProvider.ts:38-63) models state deltas as `{ remoteId, stateKey }` — a single card's column change. It has no concept of *relationship* deltas. The providers' delta queries reflect this:

1. **Linear** (`LinearRemoteProvider.fetchStateDeltas`, line 27): queries `issues(filter:{ updatedAt:{ gt: cursor } })` and returns `id` + `state { id }`. It does NOT request `parent { id }`, so a parent/child change (setting `parentId` on a child issue) is detected as a state delta on the child — but the poll only reads the column, not the parent. The parent link is silently dropped.

2. **Notion** (`NotionRemoteProvider.fetchStateDeltas`, line 83): queries the plans DB by `last_edited_time` and reads `Kanban Column` select. The Notion plans DB (created by `NotionBackupService.autoCreateDatabase`, line 151) has **no `Is Epic` or `Epic` properties** — so even if the remote agent wanted to express epic structure, there's no schema for it. (This gap is addressed by the companion plan `notion-backup-epic-schema-and-remote-orientation.md`.)

3. **The cascade works by accident.** When the poll mirrors a column change on an epic card, `onColumnMove` → `moveCardToColumnByPlanFile` (KanbanProvider.ts:4895-4906) cascades subtask moves. But this only works if the local plan is *already* marked `isEpic=1` with linked subtasks. If the remote agent creates the epic relationship in Linear/Notion, the local plans aren't linked — so the cascade fires on a "lone" card and subtasks don't move.

The fix: extend the state-delta model to carry **relationship deltas** alongside column deltas, and mirror them locally before dispatching.

## Metadata

**Tags:** [backend, sync, remote-control, feature]
**Complexity:** 7
**Repo:** (single-repo)
**Depends on:** `notion-remote-control-and-delta-polling.md` (shipped — `RemoteControlService` + providers exist)
**Related:** `epic-sync-outbound.md` (outbound direction), `notion-backup-epic-schema-and-remote-orientation.md` (Notion schema — Plan 5)

## User Review Required

Yes — confirm:
1. Should a remote-driven epic linkage create a local epic *immediately* (during the poll), or should it require a separate "confirm" step? This plan proposes **immediate mirror** — the remote agent is an authorized operator; if it sets a parent in Linear/Notion, Switchboard trusts it and links locally. No confirmation gate (consistent with how column moves work today — no confirm, just mirror).
2. For Linear: when the remote agent creates a NEW issue with a parent (a new subtask of an existing epic), should the poll import it as a local plan? Today, remote control only mirrors *changes to already-tracked cards* — new issues are not imported (that's the batch import path's job). This plan proposes **no new-issue import via remote control** — if the remote agent creates a new Linear sub-issue, it must be batch-imported separately. Remote control only mirrors relationship changes on *already-tracked* cards. This keeps the poll loop fast and avoids conflating import with mirroring.

## Context

The remote control poll cycle (RemoteControlService.ts:192-217):

```
1. config = getConfig()
2. provider = getProvider(config.provider)
3. allPlans = db.getAllPlans(workspaceId)
4. byRemoteId = _indexByRemoteId(provider.kind, allPlans, boardSet)
5. _pollState(db, provider, byRemoteId)    ← column mirrors
6. _pollComments(db, provider, byRemoteId) ← comment routing
```

`_indexByRemoteId` (line 220) builds `Map<remoteId, KanbanPlanRecord>` — every tracked card keyed by its `linearIssueId` or `notionPageId`. Epics and subtasks are all just entries in this map. There's no grouping.

`_pollState` (line 252) calls `provider.fetchStateDeltas(cursor)`, iterates the deltas, and for each: looks up the local plan via `byRemoteId`, maps the state key to a column, and calls `_applyStateMirror`. The mirror calls `onColumnMove` → `moveCardToColumnByPlanFile`, which cascades subtask moves IF the plan is already `isEpic`. The gap is: the poll never creates or updates the `isEpic`/`epicId` linkage.

Key existing infrastructure:
- `KanbanDatabase.updateEpicStatus(planId, isEpic, epicId)` (line 1455) — sets both fields in one call.
- `KanbanDatabase.getPlanByPlanId(planId)` — look up any plan by its planId.
- `KanbanDatabase.getSubtasksByEpicId(epicPlanId)` (line 3795) — fetch subtasks.
- `moveCardToColumnByPlanFile` (KanbanProvider.ts:4871) — already cascades on `isEpic`.

---

## What Gets Built

### 1. Extend `RemoteStateDelta` to carry relationship info

**File:** `src/services/remote/RemoteProvider.ts`

Add an optional `parentRemoteId` field to `RemoteStateDelta`:

```ts
export interface RemoteStateDelta {
    remoteId: string;
    stateKey: string;
    /** If the remote card's parent changed, the new parent's remote id (or '' if unparented).
     *  Undefined = no parent change detected (provider didn't query it). */
    parentRemoteId?: string;
    /** If the remote card is itself a parent (has children), mark it as an epic candidate.
     *  Undefined = provider didn't query it. */
    isEpicCandidate?: boolean;
}
```

This is additive — existing providers that don't populate the new fields still work (undefined = no relationship change to mirror).

### 2. `LinearRemoteProvider` — query `parent` and `children`

**File:** `src/services/remote/LinearRemoteProvider.ts`

Extend the state-delta GraphQL query (line 39-45) to also fetch `parent { id }` and `children { nodes { id } }`:

```graphql
query {
  issues(filter: { updatedAt: { gt: ${since} } }, first: 100) {
    nodes { id updatedAt state { id } parent { id } children { nodes { id } } }
  }
}
```

For each returned node:
- `parentRemoteId = node.parent?.id || ''` (empty string = unparented; undefined would mean "didn't query", but we always query now — use `''` for explicitly-no-parent).
- `isEpicCandidate = (node.children?.nodes?.length || 0) > 0` — if the issue has children in Linear, it's a parent.

Linear's `updatedAt` bumps on `parentId` changes (it's an issue property update — unlike comments, which don't bump it). So a parent/child link change IS detected by the existing `updatedAt` delta query. No separate query needed.

### 3. `NotionRemoteProvider` — read `Is Epic` and `Epic` properties

**File:** `src/services/remote/NotionRemoteProvider.ts`

This depends on Plan 5 (`notion-backup-epic-schema-and-remote-orientation.md`) adding `Is Epic` (checkbox) and `Epic` (relation) properties to the Notion plans DB. Once those properties exist:

- In `fetchStateDeltas` (line 83-98), for each returned row, also read:
  - `isEpicCandidate = row.properties?.['Is Epic']?.checkbox === true`
  - `parentRemoteId = row.properties?.['Epic']?.relation?.[0]?.id || ''` (the related page's Notion id)
- A `last_edited_time` bump on a page covers property edits (setting `Is Epic` or the `Epic` relation), so the existing delta query detects these changes. No new query needed.

If the properties don't exist yet (setup ran before Plan 5 shipped), the reads return undefined/falsy — no relationship mirroring occurs. This is a safe degradation.

### 4. `RemoteControlService._pollState` — mirror relationship changes

**File:** `src/services/RemoteControlService.ts`

After looking up the local plan for each state delta (line 268), and BEFORE calling `_applyStateMirror`, check for relationship changes:

```ts
for (const d of deltas) {
    const plan = byRemoteId.get(d.remoteId);
    if (!plan) { continue; }

    // NEW: mirror epic structure changes before column dispatch.
    if (d.parentRemoteId !== undefined || d.isEpicCandidate !== undefined) {
        await this._mirrorEpicStructure(db, provider, plan, d, byRemoteId);
    }

    const column = provider.stateKeyToColumn(d.stateKey);
    if (!column) { continue; }
    await this._applyStateMirror(provider, plan, column);
}
```

New private method `_mirrorEpicStructure`:

```ts
private async _mirrorEpicStructure(
    db: KanbanDatabase,
    provider: RemoteProvider,
    plan: KanbanPlanRecord,
    delta: RemoteStateDelta,
    byRemoteId: Map<string, KanbanPlanRecord>
): Promise<void> {
    // 1. If this card is a parent (isEpicCandidate), ensure it's marked isEpic locally.
    if (delta.isEpicCandidate === true && !plan.isEpic) {
        await db.updateEpicStatus(plan.planId, 1, '');
        this._log(`Epic mirror: ${plan.planId} marked as epic (remote says it has children).`);
    }

    // 2. If this card's parent changed, link/unlink locally.
    if (delta.parentRemoteId !== undefined) {
        if (delta.parentRemoteId === '') {
            // Unparented remotely → unlink locally
            if (plan.epicId) {
                await db.updateEpicStatus(plan.planId, 0, '');
                this._log(`Epic mirror: ${plan.planId} unlinked from epic ${plan.epicId}.`);
            }
        } else {
            // Parented remotely → find the parent's local plan by remote id
            const parentPlan = byRemoteId.get(delta.parentRemoteId);
            if (parentPlan && parentPlan.planId !== plan.planId) {
                if (plan.epicId !== parentPlan.planId) {
                    await db.updateEpicStatus(plan.planId, 0, parentPlan.planId);
                    this._log(`Epic mirror: ${plan.planId} linked to epic ${parentPlan.planId}.`);
                }
            } else if (!parentPlan) {
                // Parent isn't tracked locally — can't link. Log (don't fail).
                this._log(`Epic mirror: parent ${delta.parentRemoteId} not tracked locally — cannot link ${plan.planId}.`);
            }
        }
    }
}
```

Key design points:
- **Idempotent:** only writes if the local state differs from the delta. `if (!plan.isEpic)` / `if (plan.epicId !== parentPlan.planId)` guards.
- **Parent not tracked:** if the remote parent isn't in `byRemoteId` (not on a selected board, or never imported), the link can't be mirrored. Log and continue — don't fail the poll.
- **Self-parenting guard:** `parentPlan.planId !== plan.planId` prevents a card from being its own epic.
- **No board refresh here:** the refresh happens once after all deltas are processed (or in `_applyStateMirror`). The relationship change is a DB write; the board refresh picks it up.

### 5. Echo guard for relationship changes

The existing echo guard (line 281-294) handles column loops: if Switchboard pushes a column change to Linear, the next poll sees it and no-ops because `targetColumn === plan.kanbanColumn`.

For relationship changes, the echo guard needs similar protection: if Switchboard's outbound sync (from `epic-sync-outbound.md`) sets a Linear parent, the next poll sees the `parent { id }` change and tries to mirror it back — but the local plan is already linked. The idempotency guard (`if (plan.epicId !== parentPlan.planId)`) handles this: the local state already matches, so no write occurs. No additional echo-guard machinery needed.

---

## Critical Files

| File | Change |
|------|--------|
| `src/services/remote/RemoteProvider.ts` | Add `parentRemoteId?` and `isEpicCandidate?` to `RemoteStateDelta` |
| `src/services/remote/LinearRemoteProvider.ts` | Extend GraphQL query to fetch `parent { id }` + `children { nodes { id } }`; populate new delta fields |
| `src/services/remote/NotionRemoteProvider.ts` | Read `Is Epic` checkbox + `Epic` relation from delta-query rows (depends on Plan 5 for the properties to exist) |
| `src/services/RemoteControlService.ts` | Add `_mirrorEpicStructure()` private method; call it from `_pollState` before `_applyStateMirror` |

---

## Key Reuse (do not reinvent)

- `KanbanDatabase.updateEpicStatus(planId, isEpic, epicId)` (line 1455) — single call sets both fields
- `_indexByRemoteId` (RemoteControlService.ts:220) — the `byRemoteId` map already has every tracked card; reuse it to look up the parent's local plan
- `moveCardToColumnByPlanFile` (KanbanProvider.ts:4871) — already cascades on `isEpic`; once `_mirrorEpicStructure` sets `isEpic=1`, the existing cascade works
- Existing echo-guard pattern (column equality + TTL) — relationship idempotency is simpler (exact `epicId` match), no TTL needed

---

## Complexity Audit

### Routine
- Adding two optional fields to `RemoteStateDelta` (additive, no breaking change)
- Extending the Linear GraphQL query (add `parent` + `children` to the node selection)
- Reading two Notion properties from delta-query rows (same `_queryDelta` method, just reads more fields)
- The `_mirrorEpicStructure` method (straightforward DB writes with idempotency guards)

### Complex / Risky
- **Linear `updatedAt` on parent change:** Linear's `updatedAt` DOES bump on `parentId` changes (unlike comments, which don't). This is the key assumption — if wrong, parent/child changes would be invisible to the state-delta query. The existing plan (`notion-remote-control-and-delta-polling.md`) already confirmed that `updatedAt` tracks "issue property changes: state, priority, assignee, description, title" — `parentId` is an issue property, so it should bump `updatedAt`. But this should be verified during implementation with a real Linear test.
- **Notion property addition dependency:** the Notion provider can only read `Is Epic`/`Epic` if Plan 5 has added those properties to the plans DB. If Plan 5 isn't shipped, the Notion reads return falsy and relationship mirroring is a no-op. This is a safe degradation but must be documented.
- **Parent not tracked locally:** the remote parent might be on a different board (not in `config.boards`), or might have been filtered out. The link can't be mirrored. This is an inherent limitation of the board-scoped poll — not a bug, but the remote agent must be told (in the orientation skill) to only create parent/child links between cards on the same synced board.
- **Cascade timing:** `_mirrorEpicStructure` runs BEFORE `_applyStateMirror`. So if a card is both marked-as-epic AND has a column change in the same delta, the epic mark is applied first, then the column move cascades to (now-linked) subtasks. This is the correct order. If the subtasks were linked in a *previous* poll cycle, the cascade already works today; this just ensures it works on the *same* cycle the epic is detected.

---

## Edge-Case & Dependency Audit

- **Remote agent unparents a subtask:** `parentRemoteId = ''` → `_mirrorEpicStructure` sets `epicId = ''` locally. The subtask is now standalone. The epic's subtask count decreases. Correct.
- **Remote agent reparents (moves subtask from epic A to epic B):** `parentRemoteId = epicBRemoteId` → `_mirrorEpicStructure` sets `epicId = epicB.planId`. The subtask moves from A to B. Correct. (The `epic_lock_columns` guard is NOT checked here — remote control trusts the remote agent. If the epic is in a locked column, the remote agent shouldn't be moving its subtasks. This is a policy difference from the local `assignPlansToEpic` which checks locks.)
- **Remote agent creates a new issue with a parent (new subtask):** the new issue isn't in `byRemoteId` (never imported) → `byRemoteId.get(d.remoteId)` returns undefined → the delta is skipped entirely. The new subtask must be batch-imported separately. This is the explicit scope cut (User Review Required #2).
- **Parent and child both have state changes in the same poll:** both are in the `deltas` array. The parent's `isEpicCandidate=true` is mirrored first (if it comes first in the array — Linear returns by `updatedAt` ascending, so the parent's change might come before or after the child's). If the child's delta is processed before the parent's, the parent isn't marked as epic yet — but the child's `parentRemoteId` is still mirrored (the parent plan exists in `byRemoteId`, it just isn't `isEpic` yet). The parent's `isEpicCandidate` is then set when its own delta is processed. Both writes are independent and order-independent.
- **Notion `Epic` relation to a page on a different board:** the parent page's `notionPageId` won't be in `byRemoteId` (board filter). Link can't be mirrored. Log and continue.
- **Echo from outbound sync:** `epic-sync-outbound.md` pushes local epic structure to Linear/ClickUp. The next remote-control poll sees the `parent` change and calls `_mirrorEpicStructure`. The idempotency guard (`plan.epicId !== parentPlan.planId`) prevents a redundant write. No echo loop.

---

## Dependencies

- `notion-remote-control-and-delta-polling.md` — shipped (RemoteControlService + providers exist).
- `notion-backup-epic-schema-and-remote-orientation.md` (Plan 5) — needed for the Notion provider to read `Is Epic`/`Epic` properties. The Linear provider works independently (no schema changes needed — Linear's `parent`/`children` are native GraphQL fields).
- No new npm packages.

---

## Adversarial Synthesis

**Risk Summary:** (1) The key assumption — Linear `updatedAt` bumps on `parentId` changes — is reasonable but should be verified with a real API test. If it doesn't bump, parent/child changes are invisible to the state-delta query and a separate relationship-delta query would be needed (scope expansion). (2) The Notion provider depends on Plan 5 for the `Is Epic`/`Epic` properties — without it, Notion relationship mirroring is a no-op. (3) The "parent not tracked locally" case is an inherent limitation of board-scoped polling — the orientation skill must document it. (4) The `epic_lock_columns` guard is intentionally NOT checked in remote-driven mirroring — this is a policy decision (the remote agent is trusted). If this is wrong, add the guard.

---

## Proposed Changes

### `src/services/remote/RemoteProvider.ts`
- Add `parentRemoteId?: string` and `isEpicCandidate?: boolean` to `RemoteStateDelta` (lines 17-22). Additive — existing providers that don't populate them still compile and work.

### `src/services/remote/LinearRemoteProvider.ts`
- **Context:** `fetchStateDeltas` (line 27-62), GraphQL query at line 39-45.
- **Logic:** Extend the query node selection to include `parent { id } children { nodes { id } }`. For each node, set `parentRemoteId = String(node.parent?.id || '')` and `isEpicCandidate = (node.children?.nodes?.length || 0) > 0` on the delta.
- **Edge Cases:** Node with no parent → `parentRemoteId = ''` (explicitly unparented, not undefined). Node with no children → `isEpicCandidate = false`.

### `src/services/remote/NotionRemoteProvider.ts`
- **Context:** `fetchStateDeltas` (line 83-98), row iteration at line 90-97.
- **Logic:** For each row, also read `isEpicCandidate = row.properties?.['Is Epic']?.checkbox === true` and `parentRemoteId = String(row.properties?.['Epic']?.relation?.[0]?.id || '')`. These properties are added by Plan 5's `setupRemoteControl` extension. If the properties don't exist (pre-Plan-5 setup), the reads return falsy — safe degradation.
- **Edge Cases:** Property doesn't exist on the DB → `undefined` → no relationship mirroring. Page with `Epic` relation pointing to a deleted/archived page → `parentRemoteId` is set but `byRemoteId.get(parentRemoteId)` returns undefined → log and skip.

### `src/services/RemoteControlService.ts`
- **Context:** `_pollState` (line 252-279), delta loop at line 267-273.
- **Logic:** Add the `_mirrorEpicStructure` private method (as specified in §4 above). Call it from the delta loop, before `_applyStateMirror`:
  ```ts
  if (d.parentRemoteId !== undefined || d.isEpicCandidate !== undefined) {
      await this._mirrorEpicStructure(db, provider, plan, d, byRemoteId);
  }
  ```
- **Edge Cases:** `byRemoteId` is passed to `_mirrorEpicStructure` for parent lookup. Parent not found → log, skip. Self-parenting → guard. Idempotency → only write if local state differs.

---

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the suite separately.)*

### Manual Verification
1. **Linear — epic detection:** In Linear, create a parent issue with a child issue. Both must be on a synced board. Wait for the poll. Confirm: the parent's local plan is marked `isEpic=1`, the child's local plan has `epicId` set to the parent's planId.
2. **Linear — column cascade after epic detection:** After step 1, move the parent issue to a new state in Linear. Wait for the poll. Confirm: the child's local card also moves (cascade fires because the parent is now `isEpic`).
3. **Linear — unparent:** Remove the parent link on the child in Linear. Wait for the poll. Confirm: the child's `epicId` is cleared locally.
4. **Notion — epic detection (requires Plan 5):** In Notion, check `Is Epic` on a page and set the `Epic` relation on another page pointing to it. Wait for the poll. Confirm: the local plans mirror the epic/subtask linkage.
5. **Notion — pre-Plan-5 degradation:** on a Notion DB without `Is Epic`/`Epic` properties, confirm the poll still works (no crash, no relationship mirroring, column mirroring unaffected).
6. **Echo guard:** create an epic locally (via `create-epic.js`), which pushes to Linear via `epic-sync-outbound.md`. Wait for the next poll. Confirm: the poll sees the parent change but the idempotency guard prevents a redundant write (no log of "linked to epic" because `plan.epicId === parentPlan.planId` already).
7. **Parent not tracked:** in Linear, set a child issue's parent to an issue on a DIFFERENT board (not in `config.boards`). Wait for the poll. Confirm: log message "parent X not tracked locally — cannot link Y" appears, no crash, no link created.

---

## Recommendation

Complexity is **7** (new delta fields, new mirroring logic, cross-provider coordination, but all additive and the cascade infrastructure already exists). **Send to Coder** after user confirms the two review questions (immediate mirror vs. confirm; no new-issue import via remote control). The Notion side should be implemented alongside or after Plan 5.
