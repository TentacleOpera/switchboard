# Refresh-to-Delta (Part 2 of 2, BACKLOG): Complete/Recover/Archive Deltas + Structural Keep-List

## Goal

This is the **backlogged** second half of the Kanban refresh-to-delta work. Part 1 ([feature_plan_20260624212729_kanban-refresh-to-delta-hotpath.md](feature_plan_20260624212729_kanban-refresh-to-delta-hotpath.md)) downgrades the frequent move/dispatch handlers to targeted `moveCards` deltas. This part covers the remaining `_refreshBoard` call sites that Part 1 deliberately left alone:

- **Tier 3 — actionable but lower priority:** the complete / recover / archive / uncomplete handlers, which currently rely **solely** on a full `_refreshBoard` and have no webview delta. Downgrading them requires new `removeCards` / `upsertCards` delta message types.
- **Tier 4 — documented keep-list:** the structural refreshes that should **stay** on full refresh. Captured here so the decision is explicit and nobody "optimizes" them later and reintroduces desync bugs.

This is backlog: do it only if complete/recover/archive feel laggy after Part 1 ships. The frequency of these actions is far lower than moves/dispatches, so the payoff is smaller.

## Metadata

- **Tags:** `performance`, `refactor`, `kanban`, `KanbanProvider`, `kanban.html`, `backlog`
- **Complexity:** 5/10 (new delta infra on both sides + state-divergence risk)
- **Depends on:** Part 1 and the bounce-back plan (`feature_plan_20260624210141`) — reuses the planId-primary `moveCards` matching and the `_reloadLastCards` helper.

## Complexity Audit

**Moderate.** Unlike Part 1 (mostly deletions), Tier 3 needs **new code on both sides**: two new webview delta handlers (`removeCards`, `upsertCards`) and backend posts that carry enough card data for `upsertCards` to render a returning card correctly. The risk is state divergence — if an `upsertCards` payload omits a field `renderBoard` needs (complexity, epic flags, worktree id), the restored card renders wrong. Lower-frequency actions mean the testing surface is smaller, but the failure mode (a card that reappears subtly broken) is annoying.

## Edge-Case & Dependency Audit

- **`completePlan` / `completeSelected` / `completeAll`** ([5957](../../src/services/KanbanProvider.ts#L5957), [5979](../../src/services/KanbanProvider.ts#L5979), [5986](../../src/services/KanbanProvider.ts#L5986), [6009](../../src/services/KanbanProvider.ts#L6009)): COMPLETED is a real column, so a `moveCards` delta moves the card there — but the completed list has its own **`completedLimit`** ([_refreshBoardImpl:1982](../../src/services/KanbanProvider.ts#L1982)) and ordering. A delta that just sets `column='COMPLETED'` may show more completed cards than the limit would, until the next full refresh reconciles. Decide: accept transient over-display, or have the delta also evict the oldest completed card client-side.
- **`uncompleteCard`** ([6047](../../src/services/KanbanProvider.ts#L6047)): the card returns to an active column from COMPLETED — needs `upsertCards` (it may not currently be in `currentCards` if it was beyond the completed limit). The payload must include the full card shape.
- **`recoverSelected` / `recoverAll`** ([5201](../../src/services/KanbanProvider.ts#L5201), [5334](../../src/services/KanbanProvider.ts#L5334)): recovered plans reappear on the active board — needs `upsertCards` with full card data.
- **`archiveSelected`** (body at [5205](../../src/services/KanbanProvider.ts#L5205)): the card leaves the board entirely — needs `removeCards`.
- **planId-primary matching:** all new deltas must match `card.planId || card.sessionId` (and legacy `sessionId`), mirroring the bounce-back plan's `moveCards` fix, so file-based plans are handled.
- **Ghost-plan filter:** the full refresh filters out plans whose files no longer exist ([2028-2048](../../src/services/KanbanProvider.ts#L2028-L2048)). A `removeCards` delta for archive is consistent with that; `upsertCards` for recover must only re-add cards whose files exist (the backend already knows this at recover time).

## Tier 3 — Proposed Changes (actionable backlog)

### File 1: `src/webview/kanban.html`

Add two delta handlers next to `moveCards` ([6067](../../src/webview/kanban.html#L6067)):

```js
case 'removeCards': {            // archive — card leaves the board
    const ids = new Set(msg.sessionIds || []);
    const match = c => { const k = c.planId || c.sessionId; return ids.has(k) || (c.sessionId && ids.has(c.sessionId)); };
    const before = currentCards.length;
    currentCards = currentCards.filter(c => !match(c));
    if (currentCards.length !== before) { lastBoardSignature = buildBoardSignature(currentCards); renderBoard(currentCards); }
    break;
}
case 'upsertCards': {            // recover / uncomplete — card (re)appears or changes column
    const incoming = Array.isArray(msg.cards) ? msg.cards : [];
    if (!incoming.length) break;
    const keyOf = c => c.planId || c.sessionId;
    const byKey = new Map(currentCards.map(c => [keyOf(c), c]));
    incoming.forEach(c => byKey.set(keyOf(c), c));
    currentCards = [...byKey.values()];
    lastBoardSignature = buildBoardSignature(currentCards); renderBoard(currentCards);
    break;
}
```

### File 2: `src/services/KanbanProvider.ts`

- `archiveSelected`: after the DB archive, post `{type:'removeCards', sessionIds}` instead of `_refreshBoard`.
- `recoverSelected` / `recoverAll` / `uncompleteCard`: after the DB update, post `{type:'upsertCards', cards:[...]}` with the **full** card shape (planId, sessionId, topic, planFile, column, complexity, lastActivity, workspaceRoot, project, isEpic, epicId, subtaskCount) — build it the same way `_refreshBoardImpl` maps DB rows ([2063-2080](../../src/services/KanbanProvider.ts#L2063-L2080)). Factor that row→card mapping into a small helper so the delta and the full refresh stay in sync.
- `completePlan` / `completeSelected` / `completeAll`: post `{type:'moveCards', sessionIds, targetColumn:'COMPLETED'}`; if the completed-limit transient over-display (see edge cases) is unacceptable, also post a `removeCards` for any completed card pushed past the limit.
- Use `_reloadLastCards` for any in-handler `_lastCards` dependency.

## Tier 4 — Structural Keep-List (do NOT downgrade)

These `_refreshBoard` / `_scheduleBoardRefresh` sites change data the webview cannot derive from a card delta. **Leave them on full refresh.** Documented here so the choice is intentional, not an oversight.

| Handler / source | Site(s) | Why it must stay |
|---|---|---|
| File watchers | 461, 508, 1111 | External/structural change; already debounced — correct mechanism |
| `selectWorkspace` | 4781 | Whole board changes (different workspace) |
| `reassignPlansWorkspace` | 4723, 4728 | Cards move across workspaces; both boards change |
| `addProject` / `deleteProject` / `setProjectFilter` / `assignSelectedToProject` | 4798, 4815, 4824, 4835 | Projects dropdown + filter change |
| `saveCustomAgent` / `deleteCustomAgent` | 6658, 6673 | Column set changes (custom-agent columns) |
| Worktree creation (`createWorktreeForEpic` / `…ForProject` / `…ForAllEpics`) | 6841, 6876, 6923 | Worktree badges/associations change |
| Epic ops (`addSubtaskToEpic` / `promoteToEpic` / `createEpic` / `removeSubtaskFromEpic` / `deleteEpic`) | 7065, 7108, 7203, 7218, 7237 | Subtask counts, epic badges, membership change |
| Kanban structure ops (`saveKanbanColumn` / `deleteKanbanColumn` / `restoreKanbanDefaults` / `toggleKanbanColumnVisibility`) | (respective bodies) | Column structure → needs `updateColumns` + refresh |
| `createPlan` | (body) | New card with full shape; full refresh is simplest-correct |

Rationale: these are infrequent (you don't switch workspace or create an epic dozens of times a minute), and hand-rolling deltas for them risks stale counts/badges/ghost cards for negligible perf gain. The full refresh is the right tool.

## Verification Plan (Tier 3 only — Tier 4 is no-op)

**Step 1 — Archive.** Archive a card; confirm it disappears via `removeCards` with no full redraw; counts update; reload the board and confirm it's still gone (DB consistent).

**Step 2 — Recover / uncomplete.** Recover an archived plan and uncomplete a completed plan; confirm each reappears in the correct column via `upsertCards`, fully rendered (complexity, epic badge, worktree indicator all correct), with no full redraw.

**Step 3 — Complete.** Complete a card; confirm it moves to COMPLETED via delta; verify the completed-limit behavior matches the chosen approach (transient over-display vs client-side eviction); reload and confirm consistency.

**Step 4 — Divergence check.** After a sequence of archive/recover/complete deltas, trigger a real full refresh (e.g. external file change) and confirm the board does not change — i.e. the delta-maintained state already matched DB truth.

**Step 5 — Tier 4 untouched.** Confirm all keep-list actions still full-refresh and render correctly.

**Step 6 — Build & install.** Build, reload, re-run Steps 1–3 against the installed extension (not `dist/`).
