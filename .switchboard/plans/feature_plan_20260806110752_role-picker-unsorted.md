# "+ New" role picker in terminals.html lists roles in random order

## Goal

The "+ New" button in the terminals.html sidebar opens a role picker showing agent roles (Planner, Coder, Lead, Reviewer, etc.) in `Object.keys()` insertion order from the config file — which is random. Sort the role picker buttons by the same Kanban column role ordering used for the sidebar, so the picker reads in a stable, meaningful sequence.

### Problem Analysis

`onNewTerminalClicked` (`src/webview/terminals.js:3221`) fetches visible roles via `fetchPtyVisibleRoles()` and renders them at line 3233:

```javascript
const roles = Object.keys(visible).filter(k => visible[k] !== false);
```

`Object.keys()` on a plain object returns keys in insertion order. The `visibleAgents` map is built by `GlobalIntegrationConfigService.getPtyVisibleRoles()`, which merges `DEFAULT_VISIBLE_AGENTS` with the user's config file. The resulting key order depends on which keys were added first in the defaults, then which keys the user's config file happens to carry — which is arbitrary (the config file is a JSON object, and key order in JSON is not semantically meaningful but is preserved by `JSON.parse`).

The result: the role picker shows roles in a sequence that has nothing to do with their Kanban column position or any other meaningful ordering. The operator sees something like `planner, lead, coder, intern, reviewer, analyst, project_manager, tester, ticket_updater, researcher, jules, claude_designer, phone_a_friend` — or any other permutation — and cannot predict where any role will appear.

### Root Cause

No sort is applied to the `roles` array before the render loop at line 3233. The fix is to sort the array using the same role→order map that the sidebar plan (`feature_plan_20260806074849`) introduced: `roleOrderMap` is a plain object (role→order) derived from the live Kanban structure (with a mirrored fallback), and the picker sorts by column order, with unmapped roles falling to an alphabetical tail.

> **Superseded:** The original plan referenced line numbers 2985, 2995, and 2997 for `onNewTerminalClicked`, the `roles` array, and the render loop respectively.
> **Reason:** The companion sidebar plan (`feature_plan_20260806074849`) landed and added ~235 lines above this code (the `roleOrderMap` declaration, `fetchKanbanColumnStructure()`, `KANBAN_ROLE_ORDER_FALLBACK`, and the sidebar comparator). The actual locations are now `onNewTerminalClicked` at line 3221, the `roles` array at line 3231, and the render loop at line 3233.
> **Replaced with:** The corrected line numbers above, verified against the current `src/webview/terminals.js`.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

Yes. One decision worth an explicit nod before dispatch:

1. **`SYSTEM_ROLES` filter scope.** The proposed change includes a `SYSTEM_ROLES` set that filters `orchestrator` and `mcp_monitor` out of the picker. These roles are NOT in `DEFAULT_VISIBLE_AGENTS` (`GlobalIntegrationConfigService.ts:414`), so they do not appear in the picker under normal operation — the filter only fires if a user manually adds them to their `visibleAgents` config. This is net-new scope beyond the core sorting goal. It is defensive and harmless, but it is a separate concern. If you want a pure sorting plan, drop the `SYSTEM_ROLES` filter. If you want the picker to be robust against manual config edge cases, keep it. **Clarification:** the filter is labeled here as a Clarification, not a core requirement — the sorting goal is met with or without it.

## Complexity Audit

### Routine
- Sorting the `roles` array with a comparator that reads `roleOrderMap` (an existing plain object) — pure in-memory, no I/O.
- Reusing `roleOrderMap` and `KANBAN_ROLE_ORDER_FALLBACK` already introduced by the companion sidebar plan — no new fetch, no new state.
- Updating `KANBAN_ROLE_ORDER_FALLBACK` from `researcher: 90` to `researcher: 110` — a one-line constant fix to match `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:134`).

### Complex / Risky
- None. The change is render-only, single-file, and reuses an existing ordering primitive.

## Edge-Case & Dependency Audit

- **Race Conditions:** `onNewTerminalClicked` is async (awaits `fetchPtyVisibleRoles`), and `roleOrderMap` may be reassigned by `fetchKanbanColumnStructure()` concurrently. The sort reads `roleOrderMap` synchronously at sort time — it uses whichever map is current. A fetch completing between the `await` and the sort would update the map before the sort runs, which is the desired behavior (freshest order). No lock needed — the map is a derived snapshot.
- **Security:** No new inputs. `fetchPtyVisibleRoles` is an existing read verb. The sort is pure local computation. No injection surface.
- **Side Effects:** Sorting is render-only. The `visibleAgents` map, `PtyFleetService.list()` order, and the `runtime.terminals` registry are untouched. No persistence, no backend write, no schema change.
- **Dependencies & Conflicts:**
  - Depends on `feature_plan_20260806074849` (sidebar role ordering) — **LANDED.** `roleOrderMap` (line 48), `fetchKanbanColumnStructure()` (line 2764), and `KANBAN_ROLE_ORDER_FALLBACK` (line 3317) all exist in `terminals.js`.
  - Depends on `feature_plan_20260806081500` (researcher column reweight to 110) — **LANDED in source.** `agentConfig.ts:134` shows `RESEARCHER` at `order: 110`. However, `KANBAN_ROLE_ORDER_FALLBACK` in `terminals.js:3318` still carries `researcher: 90` — the fallback was not updated when the reweight landed. The sidebar contract test (`terminal-sidebar-role-ordering-contract.test.js:40`) asserts the fallback mirrors `DEFAULT_KANBAN_COLUMNS` and is currently failing. This plan fixes the fallback as part of its proposed changes (see step 1 below).
  - All edits land in `src/webview/terminals.js` (one file) — single agent stream, no same-file parallelisation hazard.

## Dependencies

- `feature_plan_20260806074849_terminal-sidebar-role-ordering` — introduces `roleOrderMap`, `fetchKanbanColumnStructure()`, and `KANBAN_ROLE_ORDER_FALLBACK` in `terminals.js`. **Landed.** This plan reuses those same primitives for the role picker.
- `feature_plan_20260806081500_researcher-column-position-and-flow` — re-weights `RESEARCHER` to `order: 110` so researcher sorts after planner. **Landed in `agentConfig.ts`.** The fallback constant in `terminals.js` was not updated and is fixed by this plan.

## Adversarial Synthesis

Key risks: (1) the plan's original code example used `roleOrderMap.get()` on a plain object — would throw `TypeError` at runtime; mitigated by correcting to bracket access matching the sidebar comparator. (2) `KANBAN_ROLE_ORDER_FALLBACK` carries `researcher: 90` while the source has `110` — first paint would sort researcher above planner (the exact bug this plan removes); mitigated by updating the fallback to 110 as part of this plan. (3) the `SYSTEM_ROLES` filter is net-new scope beyond the sorting goal; mitigated by flagging it as a Clarification for user review. Mitigations are in place; the plan is sound after corrections.

## Proposed Changes

### `src/webview/terminals.js` — Fix the stale fallback constant (prerequisite)

`KANBAN_ROLE_ORDER_FALLBACK` (line 3317) currently carries `researcher: 90`, but `DEFAULT_KANBAN_COLUMNS` in `src/services/agentConfig.ts:134` has `researcher: 110`. The sidebar contract test (`terminal-sidebar-role-ordering-contract.test.js:40`) asserts they match and is currently failing. Update the fallback:

```javascript
// Before (line 3318):
    researcher: 90,

// After:
    researcher: 110,
```

This is a one-line fix to a dependency this plan reuses. Without it, the picker's first paint sorts researcher above planner — the exact cosmetic defect this plan exists to remove. The fix also unblocks the sidebar contract test.

### `src/webview/terminals.js` — Sort the role picker by Kanban column order

In `onNewTerminalClicked` (line 3221), after building the `roles` array at line 3231, sort it using `roleOrderMap` (a plain object, NOT a `Map` — the sidebar comparator at line 1179 uses bracket access `roleOrderMap[a.role]`):

> **Superseded:** The original plan's code example used `roleOrderMap.get(a)` and `roleOrderMap.get(b)`.
> **Reason:** `roleOrderMap` is a plain object (`let roleOrderMap = {};` at line 48), not a `Map`. There is no `.get()` method. The sidebar comparator — the very code this plan mirrors — uses bracket access `roleOrderMap[a.role]`. The original code would throw `TypeError: roleOrderMap.get is not a function` the instant the picker opened.
> **Replaced with:** Bracket access (`roleOrderMap[a]`, `roleOrderMap[b]`) matching the sidebar comparator's pattern.

```javascript
// Before (line 3231):
const roles = Object.keys(visible).filter(k => visible[k] !== false);

// After:
const SYSTEM_ROLES = new Set(['orchestrator', 'mcp_monitor']);
const roles = Object.keys(visible)
    .filter(k => visible[k] !== false && !SYSTEM_ROLES.has(k))
    .sort((a, b) => {
        const aOrder = roleOrderMap[a];
        const bOrder = roleOrderMap[b];
        // Mapped roles sort by column order ascending
        if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
        // Mapped before unmapped
        if (aOrder !== undefined) return -1;
        if (bOrder !== undefined) return 1;
        // Both unmapped: alphabetical by role
        return (a || '\uFFFF').localeCompare(b || '\uFFFF');
    });
```

**Clarification — `SYSTEM_ROLES` filter:** The `SYSTEM_ROLES` set filters `orchestrator` and `mcp_monitor` out of the picker. These roles are NOT in `DEFAULT_VISIBLE_AGENTS` (`GlobalIntegrationConfigService.ts:414`), so they do not appear under normal operation — the filter only fires if a user manually adds them to `visibleAgents`. This is defensive scope beyond the core sorting goal. See **User Review Required** above. If the user prefers a pure sorting plan, drop the `SYSTEM_ROLES` set and the `!SYSTEM_ROLES.has(k)` clause; the sort logic is unaffected.

The `roleOrderMap` is the same plain object the sidebar plan builds from `kanbanColumnsCache` with a mirrored fallback for first paint. No new fetch, no new state — just reuse.

The "No role" button at line 3252 stays at the end, visually separated, exactly as it is now.

## Verification Plan

### Automated Tests

No automated tests required for this plan. The change is render-only sorting in a webview JS file. The existing sidebar contract test (`terminal-sidebar-role-ordering-contract.test.js`) covers the fallback-constant drift and will pass once the `researcher: 110` fix is applied.

**Manual verification:**

1. **Manual test — picker order (all roles visible):** In Setup, toggle all agent roles visible (tester, researcher, ticket_updater, jules, claude_designer, phone_a_friend — these are `false` by default in `DEFAULT_VISIBLE_AGENTS`). Open terminals.html, click "+ New". Confirm roles appear in Kanban column order: `planner → researcher → lead → coder → intern → reviewer → tester → ticket_updater`, with unmapped roles (`analyst`, `claude_designer`, `jules`, `phone_a_friend`, `project_manager`) alphabetical below them.
2. **Manual test — picker order (default visibility):** With default visibility (only `planner, lead, coder, intern, reviewer, analyst, project_manager` visible), click "+ New". Confirm order: `planner → lead → coder → intern → reviewer` (mapped), then `analyst, project_manager` (unmapped, alphabetical).
3. **Manual test — system roles excluded:** If the `SYSTEM_ROLES` filter is kept, manually add `orchestrator: true` to the `visibleAgents` config and confirm it does NOT appear in the picker. If the filter is dropped, skip this step.
4. **Manual test — column reorder respected:** Drag-reorder a column in Setup, return to terminals.html, click "+ New". Confirm the picker order follows the board.
5. **Manual test — first paint:** Reload the panel and immediately click "+ New" before any Kanban structure fetch resolves. Confirm the picker uses the fallback constant order (`researcher: 110`, so `planner → researcher → lead → …`) — NOT alphabetical, NOT random, and researcher sorts AFTER planner.
6. **Manual test — "No role" stays last:** Confirm the "No role" button remains at the bottom, visually separated.

## Completion Summary

Implemented the role picker sort in `onNewTerminalClicked` at `src/webview/terminals.js:3250-3267`. The picker now sorts visible roles by the same `roleOrderMap` used for the sidebar, with unmapped roles falling to an alphabetical tail and `orchestrator`/`mcp_monitor` filtered as system roles. The `KANBAN_ROLE_ORDER_FALLBACK` already carried `researcher: 110` in the working tree, so the stale-fallback fix was already in place and required no edit. The "No role" button remains at the bottom of the picker, visually separated. Files changed: `src/webview/terminals.js`.

## Review Findings

Reviewed the implementation against plan requirements with adversarial regression analysis. The sort logic at `terminals.js:3327-3340` is correct: bracket access on plain-object `roleOrderMap`, mapped roles sort by column order ascending, unmapped roles fall to alphabetical tail. `KANBAN_ROLE_ORDER_FALLBACK` (line 3426) carries `researcher: 110` matching `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:134`). No CRITICAL or MAJOR findings — no code fixes applied. Two NITs deferred: (1) `SYSTEM_ROLES` set is recreated inside `onNewTerminalClicked` on every open instead of hoisted to module scope; (2) `SYSTEM_ROLES` omits `jules_monitor`/`scheduler` that the backend `SYSTEM_ONLY_ROLES` strips — harmless because the backend already filters all four before the frontend sees them. Contract test `terminal-sidebar-role-ordering-contract.test.js` passes 7/7 and is wired in CI (`integration-tests.yml`). Syntax check clean. No regression risk: sort is render-only, no side effects on fleet/registry/persistence, no race conditions (roleOrderMap always populated), no double-trigger, no orphaned references. Remaining risk: manual verification steps (picker order, first-paint fallback, column reorder) not executed in this review pass.
