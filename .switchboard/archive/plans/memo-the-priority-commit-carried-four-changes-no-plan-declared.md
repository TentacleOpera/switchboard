# The Priority Commit Carried Four Changes No Plan Declared

## Goal

Reconcile the priority work that shipped in `4df54319` and `c0ea0b26` with the plans that authorised it: document what was added outside scope, decide the semantics that were chosen by accident, and fix the ordering fields the change left unset.

### Problem analysis

Four reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. All four concern the priority feature, which shipped recently and well — these are its edges, not a criticism of it.

The pattern is undeclared scope: a commit whose plan describes a card field also changed the markdown that ClickUp imports produce, added a plan-file metadata line documented nowhere, chose creation-only semantics without saying so, and left one dispatch path without any ordering fields at all.

## Metadata

- **Complexity:** 4
- **Tags:** priority, integrations, plans, bugfix

## User Review Required

Change 2 contains one decision: whether `**Priority:**` is creation-only by design.

## Proposed Changes

### 1. The ClickUp import stub body was rewritten as undeclared scope

`git show 4df54319 -- src/services/ClickUpSyncService.ts` adds exactly `'## Goal',` and `description || '_No description provided._'`, now at `:3319-3321`. Neither priority plan mentions the stub format.

Every ClickUp import since produces different markdown than before, which changes what agents read and what any downstream parser sees. Confirm the new shape is wanted and record it as the intended format, or revert it to what the plans described.

### 2. `**Priority:**` is parsed, creation-only, and documented nowhere **[decision]**

`planMetadataUtils.ts:119-136` parses a `**Priority:**` line from plan files. `KanbanDatabase.ts:2569` lists `priority` in the INSERT columns, while the `DO UPDATE SET` at `:2574-2591` **omits it**.

So the field applies when a plan is first imported and is ignored on every re-import. That may be deliberate — it stops a stale file overwriting a priority set on the board, which is the same reasoning that protects other fields. But nobody wrote it down, and a plan author editing the line will see nothing happen.

Grep of `.agents/`, `CLAUDE.md`, `AGENTS.md` and `docs/` for `**Priority:**` returns nothing. Decide the semantics, then document them in the plan-authoring surfaces so an agent knows the line exists and what it does.

### 3. Inbound tracker priority is effectively unreachable

`LiveSyncTypes.ts:48` defaults `autoConflictCheckEvery` to `0`. `ContinuousSyncService.ts:477` gates the only sync-loop call to `_detectExternalConflict`, which is the sole caller of `_fetchExternalDescription`, where the inbound priority write lives at `:737-772`.

With the default in place, a priority changed in ClickUp or Linear reaches `plans.priority` only through remote-control mode or a re-import. The mapping was built and is unreachable on a normal poll.

Either add a poll that reads it, or state in the integration docs that inbound priority is import-and-remote-control only. Do not leave a mapping that looks live.

### 4. Expanded feature subtasks carry no ordering fields at all

`BatchPromptPlan` in `agentPromptBuilder.ts` declares `priorityStarred`, `priority`, `queuePosition`, `columnOrder` and `columnEnteredAt`. The object literal in `expandFeatureSubtaskPlans` (`KanbanProvider.ts:4645-4658`) sets **none** of them, while the two board builders at `:2184-2209` and `:4072-4097` set them all.

So a dispatch that expands a feature into its subtasks orders them on comparator fallbacks under every order-by mode, including the priority mode that just shipped.

This sits next to the one-shared-comparator decision from the board hygiene pass but is a different defect: that one is about the comparator, this one is about an input that arrives empty. Fixing the comparator does not fix this.

## Verification Plan

1. A ClickUp import produces the documented stub format, and that format is stated in a plan or doc rather than only in the code.
2. `**Priority:**` semantics are decided and documented in the plan-authoring surfaces; a plan author editing the line either sees the effect or is told there is none.
3. A priority changed in the tracker reaches `plans.priority` on a normal poll, or the docs state that it does not.
4. Dispatching a feature orders its expanded subtasks the same way the board orders them, under each order-by mode.
