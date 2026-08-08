# Show the Live Plan Title in Each Terminals Pane Header

## Goal

Every terminal pane frame in `terminals.html` must display, at the top of the frame, the title of the plan that terminal is currently working on — resolved by the **same terminal→plan attribution the completion toast already uses** (`plans.dispatched_terminal` + a live `dispatched_at`, with a worktree fallback). When the plan completes or no plan is attributed, the line disappears.

### Problem

An operator watching a 2x3 grid of agents can see *which agent* is in each pane (`P3 · CLAUDE CLI · coder-2`) and *whether it is done* (the `DONE` badge), but not *what it is doing*. The plan title only ever appears for ~8 seconds, in a toast, **after** the work is finished (`showCompletionToast`, `terminals.js:5089`). During the entire run — the whole time the information is actually useful — the pane header is silent about the plan.

### Root Cause

The attribution machinery exists and is correct; it is simply only evaluated at the completion edge, and the title it produces is discarded immediately after the toast fades.

1. **The producers.** `TaskViewerProvider.broadcastAgentCompleted` (`src/services/TaskViewerProvider.ts:958-993`) and the standalone twin `broadcastAgentCompletedForRecord` (`src/standalone/bootstrap.ts:493-526`) build `{ planFile, planTitle: record.topic, role, worktreePath, terminalName }`. `terminalName` comes from `record.dispatchedTerminal`, falling back to a role+worktree match against the live fleet. Both fire **once**, fire-and-forget, from `PlanIngestionEngine`'s `setOnWorkingStateCleared` seam — i.e. the moment work *stops*.

2. **The consumer.** `handleAgentCompleted` (`terminals.js:5053`) reads `planTitle`, passes it to `showCompletionToast`, sets `terminalBadges.set(targetTerm, 'DONE')`, and keeps **no** record of the title. There is no `terminalPlanTitles` state anywhere in the panel.

3. **The header has no plan data to render.** `updatePaneElement` (`terminals.js:2417`) builds `.pane-title` (from `terminals.js:2469`) purely out of `fleetList` — and `fleetList` is verbatim the `ptyListTerminals` projection: `friendlyName, role, status, pid, startTime, worktreePath, cwd, lastDataAt` (`src/standalone/ptyHost.ts:89-113`, `src/standalone/bootstrap.ts:1200-1233`). That projection has **zero** plan linkage. The fleet is a process list; nothing joins it to the board.

4. **The join has a home, but that home is orphaned and its path tier is dead-by-data.**

   > **Superseded:** `KanbanDatabase.getActiveDispatchedByTerminal(workspaceId, terminalName)` (`src/services/KanbanDatabase.ts:9758`) is documented as "the primary terminal→plan attribution for any completion signal that identifies itself by terminal name — mechanism-agnostic". It is a *single-row* lookup, wrong shape for a 6-pane header render on a 5s poll, and it is never called from the list path.
   >
   > **Reason:** Verified against source. Two facts make the original statement misleading in a way that would have shaped the implementation wrongly:
   > (a) `getActiveDispatchedByTerminal` and `getActiveDispatchedByCwd` have **zero callers anywhere in the repo** — not just "never called from the list path". Their only caller was the removed `POST /agent/event` hook route (the same removal documented on `setBlockedState`, `KanbanDatabase.ts:9655-9663`). They are retained seams, not the live mechanism.
   > (b) `getActiveDispatchedByCwd`'s path tier keys on `plans.worktree_id` (`worktree_id IN (SELECT id FROM worktrees WHERE path = ?)`), and **no live code path ever writes `plans.worktree_id`**. Repo-wide, the only writes are `worktree_id = excluded.worktree_id` in the `upsertPlan` conflict clause, and the only value ever supplied by a caller is `existing.worktreeId` (preserve) or `null` (`TaskViewerProvider.ts:4145`, `14422`, `14511`). The column is V26-era vestigial. Any query joining `plans → worktrees` on `worktree_id` returns NULL for every row on a current install.
   >
   > **Replaced with:** The mechanism the completion toast **actually** uses is `record.dispatchedTerminal` for the name tier and `matchWorktreePath(await db.getWorktrees(), record)` — the shared `src/services/worktreeResolver.ts` resolver, which matches `worktrees.feature_id` then `worktrees.project` against the plan — for the worktree tier (`TaskViewerProvider.ts:965-969`, `bootstrap.ts:498-502`). This plan reuses **that** pair, which is what the Goal's "the same attribution the completion toast already uses" names. `getActiveDispatchedByTerminal` / `getActiveDispatchedByCwd` are left untouched and uncalled.

5. **Only two writers ever set `dispatched_at` non-null, and the panel's own primary dispatch flow is not one of them.** Repo-wide (`grep 'dispatched_at = '` over `KanbanDatabase.ts`) there are exactly two:
   - `updateDispatchInfoByPlanFile` (`:9647`) — one caller: the **standalone** `triggerAction` arm (`bootstrap.ts:1405`), which writes `dispatched_terminal = terminal.friendlyName`.
   - `attributePasteDispatch` (`:9678`) — one caller: the `attributePastedPrompt` verb (`KanbanProvider.ts:9714`), fired from the browser panel's paste detector (`terminals.js:4581`) on **both** hosts, which also writes `dispatched_terminal`.

   The terminals panel's own drag-a-card-onto-a-pane flow calls `/kanban/verb/promptSelected` (build prompt + advance column) then `/terminals/verb/ptySendPrompt` (`terminals.js:2200-2240`). `ptySendPrompt` writes server-side into the pty, so `term.onData` never observes it and the paste detector never arms; `promptSelected` writes no dispatch identity. **A drag-drop dispatch therefore records no `dispatched_at` and no `dispatched_terminal` on either host** — which is also why the board's activity light does not come on for it. Any header design that reads only from the DB shows nothing for the panel's primary dispatch gesture; any design that fakes it client-side shows a title that dies at the next poll. Closing that write is part of this plan (Change 6).

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, ui, feature, bugfix
- **Project:** Browser Switchboard

## User Review Required

One decision, already taken — stated here so it is easy to veto, not to defer:

**Change 6 makes a browser drag-drop dispatch write dispatch attribution, which lights the board card as "working".** Today that gesture leaves `dispatched_at` NULL, so the card never lights and no completion toast can ever fire for it. This plan fixes that by POSTing the existing, already-allowlisted, already-schema'd `attributePastedPrompt` verb after `ptySendPrompt` succeeds — the same writer the copy-and-paste flow uses. The consequence on the shipped extension host (~4,000 installs) is that cards dispatched by browser drag-drop now light up and now time out through `clearStaleWorkingState` like every other dispatch. That is the correct behaviour and it is required for this feature's own reload-survival requirement, but it *is* a visible board behaviour change. To veto: drop Change 6 and accept that the plan strip never appears for drag-drop dispatch (paste-dispatch and standalone board dispatch still work).

Nothing else needs a decision.

## Complexity Audit

### Routine
- The webview render change is additive: one new element in `createPaneElement`, one populate branch in `updatePaneElement`, one hide in `renderKanbanPane`, one new CSS rule. `.pane-header` already has a terse-layout variant and an ellipsis discipline to follow (`terminals.html:605-619`, `819-857`).
- The DB read is a single `SELECT` over `plans` with an existing index-shaped `WHERE` (`workspace_id`, `status`, `dispatched_at`). No schema change, **no migration**, no new column — `dispatched_terminal` shipped in V57, `feature_id` and `project` are long-established.
- The enrichment sites already exist and already do exactly this kind of work: `parents`/`parentRoot` enrichment is attached to the `ptyListTerminals` result in **both** hosts (`bootstrap.ts:1221-1231` and `TaskViewerProvider.ts:2101-2110`).
- The worktree tier is a call to an existing shared resolver (`matchWorktreePath`), not new matching logic.
- `attributePastedPrompt` already exists, is in `KANBAN_VERBS`, has a permissive schema (`verbSchemas.ts:307-315`), and is reachable on standalone through `kanbanVerb`'s `default:` delegation to `kanbanProvider.handleServiceVerb` (`bootstrap.ts:1140-1147`). Change 6 adds a caller, not a verb.

### Complex / Risky
1. **Two-host parity.** Switchboard has two independent `ptyListTerminals` arms plus a third DB-less arm in the pty child, and a documented history of one drifting from the other — `src/test/multi-parent-terminals-contract.test.js:176-190` exists precisely because of that. Mitigation: the matching logic lives in **one pure module** (`src/services/terminalPlanAttribution.ts`, modelled on `src/services/worktreeResolver.ts`, which exists for the identical "two callers must not drift" reason), both DB-bearing hosts call it, and a contract test asserts both call sites — and the *absence* of the third — by source text.
2. **Query cost on a 5s poll.** The fleet poll (`terminals.js:3118`, 5000ms, skipped while the tab is hidden) fires per open panel, and popped-out windows each poll. A per-terminal lookup would be N queries × M panels × every 5s against a sql.js WASM DB — the exact shape that produces the "disk I/O error" heap exhaustion this codebase has hit before. Mitigation: **two queries per list call, flat in N** — one bulk `SELECT` over `plans` plus the existing `getWorktrees()` — with all matching done in memory.
3. **A behaviour change on a shipped surface.** Change 6 turns on the board activity light for a gesture that previously left it dark. Contained by reusing the existing verb (no new writer, no new schema) and by the existing off-switches (`clearWorkingState` on plan-file advance, `clearStaleWorkingState` on timeout and on dead-terminal fast-clear) already covering that writer.
4. **Pane geometry.** The new line is a second row inside `.terminal-pane`'s flex column (`terminals.html:622-630`), so showing/hiding it changes the xterm viewport height. Mitigation: already handled — each terminal container carries its own debounced `ResizeObserver` → `startFitLadder` (`terminals.js:4497-4510`). The new row must be a **sibling above `.pane-content`**, inside the same flex column, so the observed container actually resizes. No new refit call.
5. **Reused pane elements.** Every stale-state bug in `terminals.js` traces to a closure or an element that outlived the render that built it. The row is created once and re-derived every reconcile; nothing closes over `assignedName`.

## Edge-Case & Dependency Audit

1. **Extension-host dispatch does not write `dispatched_terminal`.** `TaskViewerProvider.ts:955-957` says so explicitly. A name-keyed match alone would show **nothing** for that path, so the attributor carries the same second tier the completion broadcast carries: match rows with an **empty** `dispatched_terminal` by resolved worktree path against `terminal.worktreePath`. The restriction to empty-`dispatched_terminal` rows is preserved verbatim from `getActiveDispatchedByCwd`'s documented rule — a row that names its terminal is already resolvable by name, and letting it also match by path would paint terminal A's plan onto terminal B sharing that worktree.

2. **Ambiguity on the path tier is silence, not a coin flip.**

   > **Superseded:** Order rows `dispatched_at DESC` and let a path key bind to **at most one terminal** — the first (most recently dispatched) row claims it; a second terminal in the same worktree gets no title rather than a duplicate of its neighbour's.
   > **Reason:** That rule was written assuming a path tier keyed on `plans.worktree_id`, i.e. an (effectively) per-plan worktree, where a shared path is rare. The live resolver is `matchWorktreePath`, which matches on `worktrees.feature_id` then `worktrees.project` — so **every** live plan in one feature resolves to the *same* feature-worktree path. Shared paths are the common case, not the rare one, and "first claim wins in fleet-list iteration order" then hands the newest plan's title to whichever terminal happens to be listed first. That is a wrong title on a real pane, which the plan itself says is worse than no title.
   > **Replaced with:** A path tier match requires the path to be unambiguous on **both** sides: exactly one candidate row resolved to that path, **and** exactly one active, not-already-name-matched terminal seated at that path. Any other count yields no attribution for that path. The rule is order-independent and has no tie-break, so it cannot depend on fleet-list ordering.

3. **Role is not a tier here.** `broadcastAgentCompleted` has a role-only last-resort fallback because at completion time it must land *somewhere*. A continuously-rendered header has no such pressure: a role-only match across three coders in three checkouts would paint the wrong plan on two panes for the whole run. **Do not port the role-only tier.** Name → worktree path → nothing.

4. **Feature cards are in scope, and must be.**

   > **Superseded:** `WHERE ... AND is_feature = 0` on the bulk read, mirroring `getActiveDispatchedByTerminal`.
   > **Reason:** The terminals kanban pane deliberately hides subtasks — `getBoardCards` ends with `filtered = filtered.filter(c => !c.featureId)` (`KanbanProvider.ts:10777`) so a feature's subtasks are rolled up and only feature cards and loose plans are draggable. Dispatching a **feature** onto a pane is therefore a first-class gesture in this exact UI, and `triggerAction` writes `dispatched_terminal` on whichever record the caller named — the feature row (`is_feature = 1`). With the filter in place, the single most common drag in the panel produces an empty header, which is the precise failure this plan exists to remove.
   > **Replaced with:** No `is_feature` predicate. A feature row is attributed like any other. When a feature and one of its subtasks are both live-dispatched to the same terminal name, `dispatched_at DESC` + first-row-wins picks the newest, which is the correct answer either way; on the path tier, two candidate rows for one path fall under the ambiguity rule and yield nothing.

5. **Timeout basis divergence.** The board's `working` light uses a widened age basis (`MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at))` vs a cutoff, plus a 3× hard cap — `KanbanDatabase.ts:9840-9860`). This query uses plain `dispatched_at IS NOT NULL`, matching the two retained readers. Consequence: a wedged agent can show a title for slightly longer than its card stays lit. Self-healing: `PlanIngestionEngine`'s sweep calls `clearStaleWorkingState` which nulls `dispatched_at`, and the dead-agent fast-clear nulls it immediately for terminals the fleet reports as exited. Accept the divergence; do not reimplement the widened basis in a header query.

6. **Multi-workspace fleets.** Standalone resolves `parentRoot` per terminal across mapped roots, but reads one `db` and one `getWorkspaceId()`. A terminal spawned in a *different* mapped workspace has its plan under a different `workspace_id` and will resolve no title. This is a silent no-title, never a wrong title. Out of scope; the enrichment must not throw or degrade the rest of the payload when it happens.

7. **Kanban-mode panes.** `updatePaneElement` returns early into `renderKanbanPane` for kanban slots (`terminals.js:2444-2446`). `renderKanbanPane` rebuilds `.pane-title` only behind a skip-if-unchanged signature guard (`terminals.js:2785-2787`) and hides terminal-only actions by looping the actions row (`terminals.js:2871-2877`), while `updatePaneElement` re-shows `clear`/`model`/`hide` individually (`terminals.js:2537-2542`) precisely because panes are **reused, not rebuilt**. The strip must be hidden **unconditionally at the top of `renderKanbanPane`**, outside the signature guard — a hide placed inside it strands the strip on every tick where the picker options are unchanged, which is every tick.

8. **Empty / missing title.** `record.topic` can be empty for a malformed import. Treat empty-after-trim as "no attribution" — hide the row rather than render an empty strip.

9. **Old host, new panel.** A browser panel served by a host that predates this change gets terminals with no `planTitle` field. `terminals.js` must treat the field as optional (`fleetItem.planTitle || ''`) and render nothing — the same additive-on-the-wire contract the `agentCompleted` push already documents. The reverse (new host, old cached panel) is also safe: an unread extra field.

10. **`fleetList` consumers.** `postFleetStateToShell` (`terminals.js:659`) maps `fleetList` to `{name, role, worktreePath, light, iconUri}` for the cockpit strip. It must **not** gain the plan title: the 48px strip is icon-only by accepted design, and a wider rail or extra text is explicitly rejected. Leave `postFleetStateToShell` untouched.

11. **No `title=`-only affordances.** The full title may be set on the row via `.title` **in addition to** visible ellipsized text (matching the existing `titleEl.title` at `terminals.js:2503`), but nothing may be reachable *only* through `title=`, and no decorative Unicode glyph may be used as a marker — the panel font stack renders those as tofu.

12. **No new confirmation or dismissal gate.** The row is passive display. No close button, no "clear" affordance.

13. **Shift-drop is not attributed.** The shift-drop branch pastes the prompt over the raw input WebSocket **without** submitting, so the operator reviews and presses Enter themselves. The agent has not started, and the Enter keystroke is not observable as a paste commit. Change 6 attributes on the normal (submitting) drop only. Consequence: a shift-drop shows no strip until something else attributes the plan. This is correct — the strip means "working", and after a shift-drop nothing is working yet.

14. **Stated assumption — legacy `plans.worktree_id` data.** No current code writes the column, but an install upgraded from a pre-V26-era build could in principle carry non-NULL values from a code path that no longer exists. This plan does not read `worktree_id` at all, so stale values there are inert either way; no migration and no cleanup is proposed. Recorded because Root Cause §4's superseding argument rests on "never written", which is verified for *current* source, not for historical data.

15. **Dependency: `plan_id` is the canonical card identity.** Change 6 sends `planIds: [planId || sessionId]`, and `attributePastedPrompt` resolves those via `getPlanByPlanId`, which matches `plan_id` only (`KanbanDatabase.ts:4775-4780`). A card carrying only a legacy `sessionId` resolves nothing and the attribution silently skips (the verb already logs `cannot resolve Plan File` for its own fallback path). Board cards carry `planId`; do not add a `sessionId` lookup for this.

## Dependencies

- None. No prior session's output is required; every seam this plan touches (`worktreeResolver.ts`, `attributePastedPrompt`, the two `ptyListTerminals` enrichment blocks, `getWorktrees()`) is already merged at HEAD.

## Adversarial Synthesis

**Risk Summary.** The three real risks are: (1) the design as originally written read plan→worktree linkage from `plans.worktree_id`, a column nothing writes, which would have shipped a permanently-empty header on the extension host while every unit test passed — mitigated by switching the worktree tier to the live `matchWorktreePath` resolver and asserting the tier in the contract test with realistic feature/project rows; (2) a shared feature-worktree path makes multi-seat ambiguity the common case, so any tie-break would paint wrong titles — mitigated by requiring one-row-and-one-seat on both sides and returning nothing otherwise; (3) the panel's primary dispatch gesture writes no attribution at all, so a DB-read-only header would stay blank and an optimistic overlay would flash and die — mitigated by writing attribution through the existing `attributePastedPrompt` verb on drop, which also removes the need for any client-side title state. Secondary risks (5s query cost, pane refit, kanban-pane element reuse, old-host payloads) are each handled by an existing precedent in the touched file.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — one bulk live-dispatch read

Add next to `getActiveDispatchedByTerminal` / `getActiveDispatchedByCwd` (~line 9810), so the live-attribution readers sit together.

> **Superseded:** the original projection selected `(SELECT path FROM worktrees w WHERE w.id = plans.worktree_id) AS worktree_path` and filtered `AND is_feature = 0`.
> **Reason:** `plans.worktree_id` is never written (Root Cause §4b), so that subquery is NULL on every row and the path tier would never fire; and `is_feature = 0` excludes feature cards, which are the *only* feature-scoped rows the terminals kanban pane lets an operator drag (Edge Case 4).
> **Replaced with:** project `feature_id` / `project` and let the shared `matchWorktreePath` resolver derive the path in the pure module; drop the `is_feature` predicate.

```ts
/** One live-dispatched plan row, projected for terminal attribution. */
export interface LiveDispatchAttributionRow {
    planId: string;
    topic: string;
    dispatchedTerminal: string;   // '' when the dispatcher recorded no terminal
    dispatchedAt: string;
    featureId: string | null;
    project: string | null;
}

/**
 * Bulk live-dispatch read for the fleet-list terminal→plan enrichment: every
 * live-dispatched plan row for a workspace, newest first.
 *
 * ONE query, deliberately. A per-terminal lookup is correct for a single
 * completion signal but wrong for the fleet-list path, which runs every 5s per
 * open panel — N terminals x M panels of prepared statements against the sql.js
 * WASM heap is the shape that produces spurious "disk I/O error" failures.
 *
 * NO join to `worktrees`, and NO read of `plans.worktree_id`. That column is
 * V26-era vestigial: repo-wide the only write is `worktree_id =
 * excluded.worktree_id` in the upsert conflict clause, and the only value any
 * caller supplies is a preserved `existing.worktreeId` or null — so a join on it
 * returns NULL for every row on a live install. `feature_id` / `project` are
 * projected instead and the worktree path is derived by `matchWorktreePath`
 * (worktreeResolver.ts) in terminalPlanAttribution.ts — the SAME resolver the
 * completion broadcast uses (TaskViewerProvider.ts:965-969,
 * bootstrap.ts:498-502). Keep the two paths on one resolver.
 *
 * NO `is_feature` predicate, unlike getActiveDispatchedByTerminal. The terminals
 * kanban pane rolls subtasks up under their feature (getBoardCards' trailing
 * `filter(c => !c.featureId)`), so a FEATURE card is what an operator actually
 * drags onto a pane and what `triggerAction` stamps dispatch identity onto.
 * Filtering features out would blank the header for the panel's most common
 * dispatch.
 *
 * Liveness basis is plain `dispatched_at IS NOT NULL`, matching
 * getActiveDispatchedByTerminal — NOT the board's widened last_liveness_at
 * basis. The stale sweep is what retires a wedged row.
 */
public async getLiveDispatchAttribution(workspaceId: string): Promise<LiveDispatchAttributionRow[]> {
    const out: LiveDispatchAttributionRow[] = [];
    if (!(await this.ensureReady()) || !this._db || !workspaceId) return out;
    const stmt = this._db.prepare(
        `SELECT plan_id, topic, dispatched_terminal, dispatched_at, feature_id, project
         FROM plans
         WHERE workspace_id = ? AND status = 'active'
           AND dispatched_at IS NOT NULL
         ORDER BY dispatched_at DESC`,
        [workspaceId]
    );
    try {
        while (stmt.step()) {
            const row = stmt.getAsObject();
            out.push({
                planId: String(row.plan_id ?? ''),
                topic: String(row.topic ?? '').trim(),
                dispatchedTerminal: String(row.dispatched_terminal ?? '').trim(),
                dispatchedAt: String(row.dispatched_at ?? ''),
                featureId: row.feature_id ? String(row.feature_id) : null,
                project: row.project ? String(row.project) : null,
            });
        }
    } catch (error) {
        console.error('[KanbanDatabase] getLiveDispatchAttribution failed:', error);
    } finally {
        stmt.free();
    }
    return out;
}
```

### 2. `src/services/terminalPlanAttribution.ts` — NEW, the single pure matcher

Modelled on `src/services/worktreeResolver.ts`: a free function both DB-bearing hosts import, so the two `ptyListTerminals` arms cannot drift. It imports `matchWorktreePath` at runtime; `worktreeResolver.ts` has no runtime imports of its own (`import type { WorktreeRow }` is erased), so there is no import cycle.

```ts
import { matchWorktreePath } from './worktreeResolver';
import type { LiveDispatchAttributionRow, WorktreeRow } from './KanbanDatabase';

export interface TerminalPlanAttribution {
    planId: string;
    planTitle: string;
}

interface TerminalLike {
    friendlyName?: string;
    worktreePath?: string;
    status?: string;
}

/**
 * THE shared terminal->plan matcher for the fleet-list enrichment. Two tiers,
 * in strict order — deliberately NOT three:
 *
 *   1. name  — row.dispatchedTerminal === terminal.friendlyName
 *   2. path  — matchWorktreePath(worktrees, row) === terminal.worktreePath, and
 *              ONLY for rows whose dispatchedTerminal is empty (extension-host
 *              dispatch does not record a terminal name). A row that names its
 *              terminal is already resolvable by name; letting it also match by
 *              path would paint terminal A's plan onto terminal B sharing that
 *              worktree. Same restriction getActiveDispatchedByCwd documents.
 *
 * There is deliberately NO role-only tier. The completion broadcast has one
 * because it must land somewhere once; a header rendered for the whole run must
 * not guess — three coders in three checkouts would wear two wrong titles for
 * the entire session. No title beats a wrong title.
 *
 * The path tier requires the path to be unambiguous on BOTH sides: exactly one
 * candidate row resolved to it AND exactly one active, not-already-name-matched
 * seat at it. matchWorktreePath resolves on worktrees.feature_id then
 * worktrees.project, so EVERY live plan in one feature shares one path — a
 * shared path is the common case here, and any tie-break (newest row, first
 * terminal listed) would be a coin flip that puts a real wrong title on a real
 * pane. Ambiguity yields nothing, and the rule is order-independent by
 * construction.
 *
 * `rows` MUST be ordered dispatched_at DESC: the name tier takes the first row
 * per name, so ordering is what makes a re-dispatch win over a stale row.
 */
export function attributePlansToTerminals(
    rows: LiveDispatchAttributionRow[],
    worktrees: WorktreeRow[],
    terminals: TerminalLike[]
): Map<string, TerminalPlanAttribution> {
    const result = new Map<string, TerminalPlanAttribution>();
    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(terminals)) return result;

    // An exited seat is not working on anything. `status` absent = treat as live
    // (a host predating the field), matching how the panel reads it elsewhere.
    const live = terminals.filter(t => t && t.friendlyName && (!t.status || t.status === 'active'));
    if (live.length === 0) return result;

    // Tier 1 — name. First row per name wins (rows are dispatched_at DESC).
    const byName = new Map<string, LiveDispatchAttributionRow>();
    for (const row of rows) {
        if (!row || !row.topic || !row.dispatchedTerminal) continue;   // empty topic = no attribution
        if (!byName.has(row.dispatchedTerminal)) byName.set(row.dispatchedTerminal, row);
    }
    const unnamed: TerminalLike[] = [];
    for (const t of live) {
        const name = t.friendlyName as string;
        const named = byName.get(name);
        if (named) { result.set(name, { planId: named.planId, planTitle: named.topic }); }
        else { unnamed.push(t); }
    }

    // Tier 2 — worktree path, unambiguous on both sides only.
    const wts = Array.isArray(worktrees) ? worktrees : [];
    const rowsByPath = new Map<string, LiveDispatchAttributionRow[]>();
    for (const row of rows) {
        if (!row || !row.topic || row.dispatchedTerminal) continue;    // named rows are name-tier only
        const path = matchWorktreePath(wts, {
            featureId: row.featureId,
            project: row.project,
            planId: row.planId,
        });
        if (!path) continue;
        const list = rowsByPath.get(path);
        if (list) { list.push(row); } else { rowsByPath.set(path, [row]); }
    }
    if (rowsByPath.size === 0) return result;

    const seatsByPath = new Map<string, string[]>();
    for (const t of unnamed) {
        const path = t.worktreePath || '';
        if (!path) continue;
        const list = seatsByPath.get(path);
        if (list) { list.push(t.friendlyName as string); } else { seatsByPath.set(path, [t.friendlyName as string]); }
    }
    for (const [path, candidates] of rowsByPath) {
        const seats = seatsByPath.get(path);
        if (!seats || seats.length !== 1 || candidates.length !== 1) continue;
        result.set(seats[0], { planId: candidates[0].planId, planTitle: candidates[0].topic });
    }
    return result;
}
```

### 3. `src/standalone/bootstrap.ts` — enrich the standalone `ptyListTerminals` arm

In the existing arm (line 1220-1224), immediately after `parentMap` is built:

```ts
const dbMappings = await db.getWorkspaceMappings();
const { parents, parentMap } = resolveParentsForTerminals(dbMappings, root, rawTerminals);
// Plan attribution: the same terminal->plan join the completion broadcast uses
// (dispatched_terminal, then matchWorktreePath), evaluated continuously so the
// pane header can name the running plan. Best-effort by contract — a failure
// here must degrade to "no title", never take down the fleet list the whole
// panel depends on. Two queries, flat in terminal count; see
// getLiveDispatchAttribution on why this is not a per-terminal lookup.
let planMap = new Map<string, TerminalPlanAttribution>();
try {
    const wsId = await getWorkspaceId();
    if (wsId) {
        planMap = attributePlansToTerminals(
            await db.getLiveDispatchAttribution(wsId),
            await db.getWorktrees(),
            rawTerminals
        );
    }
} catch (e) {
    console.error('[bootstrap] plan attribution for ptyListTerminals failed:', e);
}
const terminals = rawTerminals.map(t => ({
    ...t,
    parentRoot: parentMap.get(t.cwd) ?? null,
    planId: planMap.get(t.friendlyName)?.planId ?? null,
    planTitle: planMap.get(t.friendlyName)?.planTitle ?? null,
}));
```

Add `import { attributePlansToTerminals, type TerminalPlanAttribution } from '../services/terminalPlanAttribution';` alongside the existing `matchWorktreePath` import. `getWorkspaceId` is the local closure at `bootstrap.ts:379`; `getWorktrees()` takes no arguments and already filters `status='active'` in SQL (see the comment at `bootstrap.ts:1382-1383`).

`src/standalone/ptyHost.ts` is **not** touched — that child process has no DB. Its arm stays the pure live-handle projection; enrichment is the proxy's job in both hosts.

### 4. `src/services/TaskViewerProvider.ts` — enrich the extension-host proxy

In `handlePtyVerb`'s existing `ptyListTerminals` block (line 2101-2110), which already attaches `parents`/`parentRoot`:

```ts
if (verb === 'ptyListTerminals' && result && result.success !== false && Array.isArray(result.terminals)) {
    const cfg = getMappingsFromIndex();
    const fallback = root || effectiveRoot;
    const { parents, parentMap } = resolveParentsForTerminals(cfg, fallback, result.terminals);
    // Mirrors the standalone arm verbatim — see terminalPlanAttribution.ts for
    // why the tiers are name-then-path, never role, and why path ambiguity
    // yields nothing.
    let planMap = new Map<string, TerminalPlanAttribution>();
    try {
        const db = await this._getKanbanDb(fallback);
        const wsId = await this._getWorkspaceIdForRoot(fallback);
        if (db && wsId) {
            planMap = attributePlansToTerminals(
                await db.getLiveDispatchAttribution(wsId),
                await db.getWorktrees(),
                result.terminals
            );
        }
    } catch (e) {
        console.error('[TaskViewerProvider] plan attribution for ptyListTerminals failed:', e);
    }
    result.parents = parents;
    result.terminals = result.terminals.map((t: any) => ({
        ...t,
        parentRoot: parentMap.get(t.cwd) ?? null,
        planId: planMap.get(t.friendlyName)?.planId ?? null,
        planTitle: planMap.get(t.friendlyName)?.planTitle ?? null,
    }));
}
```

`_getKanbanDb` returns `KanbanDatabase | undefined` (`:7837`) — the `if (db && wsId)` guard is load-bearing. `_getWorkspaceIdForRoot` (`:14078`) is cached per root, so the 5s poll does not re-resolve it.

This sits on `handlePtyVerb` — the HTTP seam — **not** on `_ptyHostVerb`. Internal callers (`broadcastAgentCompleted`, the liveness sweep, and the other five `_ptyHostVerb('ptyListTerminals')` sites) keep paying zero DB cost.

### 5. `src/webview/terminals.js` — render the row, with no new client state

> **Superseded:** a `terminalPlanTitles` Map next to `terminalBadges`, filled from `fleetList` in `fetchTerminalList` with an "authoritative wins / else delete" reconcile, cleared in `handleAgentCompleted`, and optimistically pre-set in the drop handler.
> **Reason:** That is two sources of truth for one string, and the overlay half cannot be made correct: with Change 6 writing real attribution on drop, the overlay is redundant, and without Change 6 the overlay is a title that appears and then vanishes at the next poll (its own reload-survival requirement, verification step 9, would fail either way). It also invents a reconcile asymmetry that has to be reasoned about on old hosts, and a clear-on-completion race with the poll.
> **Replaced with:** `planTitle` rides the fleet list and is read straight off `fleetList` at render time, exactly like `role` and `status` already are. No Map, no reconcile, no optimistic path, no clear-on-completion. Immediacy comes from refetching the list at the two moments the answer changes (after a drop's attribution write; on `agentCompleted`).

**(a) `createPaneElement`** — create the row **once**, as a sibling between the header and the content, inside the pane's flex column. Insert between `paneEl.appendChild(headerEl);` (line 2366) and `const contentEl = document.createElement('div');` (line 2368):

```js
headerEl.appendChild(titleEl);
headerEl.appendChild(actionsEl);
paneEl.appendChild(headerEl);

// Plan strip. Created once and reused like every other pane child; its text and
// visibility are re-derived on every reconcile in updatePaneElement. Sits BETWEEN
// the header and .pane-content so showing it actually shrinks the observed
// container and the per-terminal ResizeObserver refits xterm on its own.
const planEl = document.createElement('div');
planEl.className = 'pane-plan-title';
planEl.style.display = 'none';
paneEl.appendChild(planEl);
```

**(b) `updatePaneElement`** — inside the `if (assignedName)` branch, after `syncInputStateChip(...)` (line ~2521). `fleetItem` is already resolved in that branch (line 2477), so no extra lookup:

```js
// The fleet list is the ONLY source for this — same as role and status. A host
// predating this change sends no planTitle and the strip simply stays hidden.
const planEl = paneEl.querySelector('.pane-plan-title');
const planTitle = ((fleetItem && fleetItem.planTitle) || '').trim();
if (planTitle) {
    planEl.textContent = planTitle;
    planEl.title = planTitle;      // overflow reveal only — the visible text is the affordance
    planEl.style.display = '';
} else {
    planEl.textContent = '';
    planEl.removeAttribute('title');
    planEl.style.display = 'none';
}
```

Add the same three hide lines to the `else` (empty-slot) branch at line 2522. Resolve `planEl` with `paneEl.querySelector('.pane-plan-title')` in both places — never a captured reference.

**(c) `renderKanbanPane`** — hide the strip **unconditionally at the top** of the function (next to the `classList.remove('is-input-*')` call at line 2760), **not** inside the `pickerSig` guard. That guard skips on every unchanged tick, and panes are reused, so a hide placed inside it would strand the strip:

```js
const planEl = paneEl.querySelector('.pane-plan-title');
if (planEl) { planEl.style.display = 'none'; planEl.textContent = ''; planEl.removeAttribute('title'); }
```

**(d) `handleAgentCompleted`** — the plan is over. `clearWorkingState` nulls `dispatched_at` *before* the broadcast fires, so a refetch immediately after returns no title for that terminal. Replace the conditional refetch (line 5075-5078) with an unconditional one, so the strip disappears in the same beat as the `DONE` badge instead of up to 5s later:

```js
if (targetTerm) {
    terminalBadges.set(targetTerm, 'DONE');
    renderSidebarList();
    renderPaneGrid();
    postFleetStateToShell();

    // Unconditional, where this used to be gated on `!isKnown`. The completion
    // clear has already nulled dispatched_at, so this refetch is what retires the
    // plan strip; it also still covers the not-yet-listed terminal case.
    fetchTerminalList();
}
```

The toast is unchanged — it still names the plan, which is now the *handoff* from the strip to the notice rather than the only place the title ever appears.

### 6. `src/webview/terminals.js` — record attribution on drag-drop dispatch

In `wireTerminalDropTarget`'s `drop` handler, in the **normal** (non-shift) branch only, immediately after the `ptySendPrompt` success check (line ~2231). Without this, a drag-drop dispatch writes no `dispatched_at` at all (Root Cause §5) and the strip can never appear for the panel's primary gesture.

```js
// Attribution. ptySendPrompt writes into the pty server-side, so the paste
// detector on term.onData never sees this prompt and nothing records who is
// working on what — no dispatched_at, no plan strip, no activity light, and no
// completion toast for a drag-dropped plan. Reuse the SAME writer the paste path
// uses; then refetch so the strip appears now rather than up to 5s later.
// Best-effort: a failed attribution must not turn a delivered prompt into an
// error toast.
try {
    const role = (fleetList.find(t => t.friendlyName === targetName) || {}).role || '';
    await fetch('/kanban/verb/attributePastedPrompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            terminalName: targetName,
            role,
            planIds: [planId || sessionId].filter(Boolean),
            planFiles: [],
            workspaceRoot
        })
    });
} catch (err) {
    console.warn('[Terminals] drop attribution failed:', err);
}
fetchTerminalList();
```

`attributePastedPrompt` is already in `KANBAN_VERBS`, already has a permissive schema (`verbSchemas.ts:307-315`), and on standalone is reached through `kanbanVerb`'s `default:` delegation to `kanbanProvider.handleServiceVerb` (`bootstrap.ts:1140-1147`) — so one call site serves both hosts. No new verb, no new schema, no allowlist or catalog change.

Nothing is added to `dragData` and nothing is added to `postFleetStateToShell`.

### 7. `src/webview/terminals.html` — CSS

After the `.pane-badge` rule (line 850-857):

```css
/* Plan strip: what this agent is working on. One line, always ellipsised — a
   plan title is a sentence and must never wrap a pane into two heights. Hidden
   entirely (display:none from JS) when no plan is attributed, so an idle pane
   loses no terminal rows. */
.pane-plan-title {
    flex: 0 0 auto;
    height: 18px;
    line-height: 18px;
    padding: 0 8px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
}
.pane-grid.layout-2x3 .pane-plan-title,
.pane-grid.layout-3x3 .pane-plan-title {
    height: 16px;
    line-height: 16px;
    padding: 0 4px;
    font-size: 9px;
}
```

`--panel-bg2`, `--border-color` and `--text-secondary` are all defined in this file's `:root` block (lines 26, 27, 30).

### 8. `src/test/terminal-plan-attribution-contract.test.js` — NEW

Plus a `test:contract:terminal-plan-attribution` script entry in `package.json`, mirroring `test:contract:multi-parent-terminals`.

Unit tests against the compiled pure module (`require('../../out/services/terminalPlanAttribution')`), with **realistic worktree rows** (`{id, path, feature_id, project, status:'active'}`) so the path tier is exercised through the real `matchWorktreePath`:
- name tier wins over path tier for the same terminal;
- a row that names terminal A is **not** path-matched onto terminal B in the same worktree;
- feature tier: an unattributed row whose `featureId` matches a worktree's `feature_id`, with one seat there, resolves;
- project tier: an unattributed row whose `project` matches a worktree's `project`, with one seat there, resolves;
- **ambiguity — two candidate rows, one seat** in a shared feature worktree ⇒ no entry;
- **ambiguity — one candidate row, two seats** at the same path ⇒ no entry;
- one candidate row, two seats where one is already name-matched ⇒ the *other* seat resolves (name-matched seats are excluded from the seat count);
- an empty `topic` yields no entry;
- an `exited` terminal yields no entry, and a terminal with no `status` field is treated as live;
- a feature row (`is_feature = 1` upstream) is attributable — the module has no feature concept, so this is asserted at the query level instead: the SQL in `KanbanDatabase.ts` must contain no `is_feature` predicate inside `getLiveDispatchAttribution`;
- no role field is consulted at all (rows and terminals carrying conflicting roles change nothing);
- `worktrees` empty / undefined does not throw and yields name-tier results only.

Source-text parity assertions (the technique `multi-parent-terminals-contract.test.js:176-190` uses):
- `bootstrap.ts`'s `ptyListTerminals` arm calls `attributePlansToTerminals` and attaches `planTitle` per terminal;
- `TaskViewerProvider.ts`'s `handlePtyVerb` `ptyListTerminals` block does the same;
- `ptyHost.ts`'s arm does **not** (it has no DB — asserting its absence stops a future agent "fixing parity" in the wrong direction);
- `getLiveDispatchAttribution`'s body references neither `worktree_id` nor `is_feature` (both are the superseded design; a regression here is silent and total);
- `terminals.js` does not add `planTitle` to `postFleetStateToShell`'s projection;
- `terminals.js`'s drop handler POSTs `attributePastedPrompt` (Change 6 is the load-bearing write; without it the whole feature is dark for drag-drop).

## Verification Plan

*Note: this planning pass did not execute any build or test command — the session ran under SKIP COMPILATION / SKIP TESTS directives. The gates below are for the implementing agent.*

### Automated Tests
1. `npm run compile-tests` — types clean, including the new `LiveDispatchAttributionRow` export, the `TerminalPlanAttribution` import in both hosts, and the `WorktreeRow` type import in the new module.
2. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/terminal-plan-attribution-contract.test.js` — all new unit + parity assertions green.
3. `npm run test:contract:multi-parent-terminals` — the existing `ptyListTerminals` parity suite still passes (the arms gained fields; `cwd`/`parents`/`parentRoot` assertions must be untouched).
4. `npm run test:contract:pty-host-gating` and the pty route-surface contract — the verb rail is unchanged.
5. `npm run test:contract:paste-attribution` — `attributePastedPrompt`'s existing contract (catalog, allowlist, schema, `term.onData` call site) is unaffected by gaining a second caller.
6. `npm run parity:check` and `npm run push-routing:check` — no new raw `postMessage`, no catalog/allowlist drift.
7. `npm run lint`.
8. Before attributing any red test to this change, stash and re-run: this repo has known pre-existing failures at HEAD.

### Manual — standalone host (browser cockpit, the primary surface)
9. Start the standalone server, open the Terminals panel, seat two terminals in a 2x2 grid.
10. Drag a plan card from a kanban-mode pane onto terminal A. **Expect:** the plan strip appears in A's frame with the card's title within one refetch (Change 6's attribution write + immediate `fetchTerminalList`). Terminal B shows no strip. Confirm on the board that A's card is now lit as working — this is the behaviour change in "User Review Required", so see it deliberately.
11. Reload the page. **Expect:** A's strip is still there — this is the reload case a push-only or overlay-only design fails, and the reason the title rides the pulled fleet list.
12. Drag a **feature** card onto terminal B. **Expect:** the feature's title appears. This is the case the superseded `is_feature = 0` filter would have silently blanked, and the terminals kanban pane only ever offers feature cards for a feature's work.
13. Shift-drop a card onto an empty-stripped terminal. **Expect:** no strip (nothing is running until the operator presses Enter). After manually pressing Enter, the existing paste detector attributes and the strip appears on a later poll.
14. Let an agent finish (or touch the plan file to advance mtime). **Expect:** the completion toast fires as before, the `DONE` badge appears, and the strip disappears in the same beat. Confirm the xterm viewport grows back by one row and text is not clipped.
15. Switch the grid to 3x3. **Expect:** the strip shrinks to the 9px/16px variant and ellipsises; the pane header buttons still fit; no horizontal overflow.
16. Toggle a pane into kanban mode and back, then leave it in kanban mode across several 5s ticks. **Expect:** no stranded strip in kanban mode at any tick (this is the `pickerSig`-guard trap), and the strip returns correctly on the way back.

### Manual — extension host (VS Code webview)
17. Dispatch a plan from the **board** to a worktree agent in the extension host, where `dispatched_terminal` is not written, then seat that worktree's browser terminal in a pane. **Expect:** the strip appears, resolved by the worktree tier through `matchWorktreePath`. This is the case a name-only implementation silently fails and the case the superseded `worktree_id` join would have failed *invisibly*, so verify it explicitly rather than inferring it from step 10.
18. With two terminals seated in the **same** worktree and one unattributed live plan, confirm **neither** shows the strip — ambiguity is silence, not a guess. Then close one terminal and confirm the remaining seat picks the title up on the next poll.
19. Copy a dispatch prompt from the board and paste it into a pane manually. **Expect:** the strip appears on the next poll via the pre-existing paste-attribution path, unchanged by this work.

### Regression checks
20. Confirm the cockpit's left rail (`shell.js` strip) is visually unchanged — no title text, no widened rail.
21. Watch the standalone console across ~2 minutes of polling with 6 terminals seated: no `getLiveDispatchAttribution failed` lines, no sql.js "disk I/O error". Confirm the query count per poll is 2 and does not scale with terminal count.
22. Confirm `postFleetStateToShell`'s payload shape is unchanged (dev-tools: the `terminalFleetState` message still carries exactly `name, role, worktreePath, light, iconUri`).
23. Confirm the five internal `_ptyHostVerb('ptyListTerminals')` callers in `TaskViewerProvider.ts` still see an un-enriched payload — the enrichment is on `handlePtyVerb` only, so the completion broadcast and liveness sweep pay no DB cost.

---

**Recommendation: Send to Coder** (complexity 6).
