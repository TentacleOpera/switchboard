---
description: "Make visibleAgents uniformly drive built-in role-column visibility on the kanban board: the agents-tab tick and the structure tab's SHOW/HIDE already write the same visibleAgents store, but the board push only honors it for the four hideWhenNoAgent-flagged columns — so unticked agents still show columns (user's complaint) while the flagged four can hide WITH cards inside and those cards masquerade in CREATED (the intern-column incident). One rule: role column visible iff agent ticked OR column occupied; routing degrades to the nearest visible coding column; webview never re-buckets unrendered columns into CREATED."
---

# Fix: Kanban Columns Must Follow Ticked Agents — One Visibility Rule, Applied Uniformly and Safely

## Goal

If the user runs 3 agents, the board should show those 3 agents' columns (plus the fixed
CREATED / COMPLETED endpoints) — not 6+ lanes for roles they never staffed. That is already
the *intended* design: the AGENT SETUP tick and the Setup tab's kanban-structure SHOW/HIDE
button write the **same** `visibleAgents` store, and the webview's own bootstrap filter
hides every role column whose agent is unticked. The bug is that the authoritative board
push only honors `visibleAgents` for the four columns flagged `hideWhenNoAgent`, producing
both observed failures: unticked agents still occupy board real estate (Coder/Lead
Coder/Planner/Reviewer columns never hide), while the flagged four can vanish — including
with cards inside, whereupon the webview silently renders those cards in the CREATED
bucket (the "feature moved backwards into CREATED" incident; the DB was correct
throughout). Replace the special-casing with one uniform, safe rule.

### The rule

> A built-in role column is rendered iff its agent is ticked (`visibleAgents[role] !==
> false`) **or** the column currently holds any card. Fixed columns (CREATED, COMPLETED —
> no role) always render. Routing and advance chains never target a hidden column.

The occupancy escape is what makes hiding safe: a column can only disappear when it is
empty, so no card can ever be stranded invisible or masquerade elsewhere.

### Problem / root cause (verified in source and installed dist 1.7.7, 2026-07-11)

- **One store, two UIs:** `handleToggleKanbanColumnVisibility`
  (`src/services/TaskViewerProvider.ts:9176-9193`) — the structure tab's SHOW/HIDE — writes
  `state.visibleAgents[columnId]` where "columnId is the role for built-in columns". The
  AGENT SETUP tick writes the same store. There is exactly one visibility source of truth.
- **The board push ignores it for most columns:** `_filterDynamicColumns`
  (`src/services/KanbanProvider.ts:3514-3528`) only consults `visibleAgents` for columns
  flagged `hideWhenNoAgent: true` — RESEARCHER, INTERN CODED, ACCEPTANCE TESTED,
  TICKET UPDATER (`src/services/agentConfig.ts:125-132`). PLAN REVIEWED, LEAD CODED,
  CODER CODED, CODE REVIEWED have no flag and render regardless of ticks — hence "I only
  want 3 agents, why 6+ columns".
- **The webview bootstrap contradicts the push:** `kanban.html:4014-4016` filters ALL role
  columns by `visibleAgents` — the front-end's initial model is the uniform rule — then the
  first `updateColumns` push (`:7072-7075`) overwrites it with the narrower server-side
  result. The codebase disagrees with itself; the user's expectation matches the bootstrap.
- **The flagged four hide unsafely:** the occupancy escape (`:3525`) is supposed to keep an
  occupied hidden column visible, but the INTERN CODED incident showed the column gone
  while holding four cards. And when a column is absent from the webview's `columns`
  array, the render bucketing fallback (`kanban.html:5754` —
  `columns.includes(col) ? col : 'CREATED'`) silently displays its cards in CREATED.
- **Routing is visibility-blind:** `_targetColumnForDispatchRole('intern')` returns
  `'INTERN CODED'` unconditionally (`KanbanProvider.ts:6416-6419`, also
  `resolveAutoDispatchColumn` `:6543`) — complexity bands 1-4 push cards into a column the
  board may not render. `_getNextColumnId`'s `shouldSkip` already skips hidden flagged
  columns for ordinary advances; routing has no such guard.
- **Why the incident looked agent-caused:** ungroomed features have Unknown complexity and
  are skipped from advancing (`_filterUnknownComplexitySessions`); after an agent stamped
  `**Complexity:** 4`, the intern route fired for the first time and cascaded the feature
  + subtasks into the hidden column.

## Metadata
- **Tags:** bugfix, ui, backend
- **Complexity:** 7

> **Superseded:** Complexity 6 → Send to Coder.
> **Reason:** The improve pass surfaced three risks the original scoping under-weighted: (a) render-hide and route-degrade must be two *different* predicates over one store (get it wrong → strand cards or feed unstaffed lanes); (b) `resolveAutoDispatchColumn` has three exits, two hardcoding `LEAD CODED`, all needing the degrade; (c) the routing change ripples an async `visibleAgents` argument through 5 dispatch call sites. That is multi-file coordination with a data-consistency trap that already fired in production — squarely 7 (High), not 6.
> **Replaced with:** Complexity 7 → Send to Lead Coder.

## User Review Required

- **Behavior change (explicitly requested):** unticking an agent now hides its (empty)
  built-in column for LEAD CODED / CODER CODED / PLAN REVIEWED / CODE REVIEWED too —
  previously these always rendered. Boards where users relied on dragging into an
  unstaffed lane will see that lane only while it holds cards.
- **Routing degrade policy needs a nod:** with the intern agent unticked, complexity 1-4
  cards route to the next visible coding column (coder, else lead). If NO coding agent is
  ticked, dispatch fails loudly (4xx / clear message) rather than stranding a card in a
  hidden lane. Confirm this degrade order matches expectations.

## Scope

### ✅ IN SCOPE
1. **Uniform visibility filter** — rewrite `_filterDynamicColumns`
   (`KanbanProvider.ts:3514`) to apply the rule to EVERY built-in role column;
   custom-user columns keep their existing config-driven behavior. Apply the same rule
   body at the other two call sites (`:3252`, `:3437` — same private method, so a single
   rewrite covers all three) and in `PlanningPanelProvider`'s equivalents (`:9793`, `:9800`).

   > **Superseded:** `visible = !col.role || visibleAgents[col.role] !== false || occupied(col.id)`
   > **Reason:** That one-liner is wrong in two ways verified against `KanbanProvider.ts:3520-3527`. (a) It drops the existing `featureOnly` branch (`:3522` — `if (col.featureOnly) return occupiedColumns.has(col.id);`), which must render feature-lane columns *only* when occupied; the `!col.role` disjunct would make a role-less `featureOnly` column always render, resurrecting a lane the current code correctly hides. (b) Ordering: `featureOnly` must be evaluated first, before the role check, exactly as today.
   > **Replaced with:** preserve the branch order, drop only the `hideWhenNoAgent` gate:
   > ```ts
   > const occupiedColumns = new Set(cards.map(c => c.column));
   > return columns.filter(col => {
   >     if (col.featureOnly) return occupiedColumns.has(col.id); // unchanged
   >     if (!col.role) return true;                               // fixed no-role columns (CREATED/COMPLETED) always render
   >     if (visibleAgents[col.role] !== false) return true;       // agent ticked
   >     return occupiedColumns.has(col.id);                       // occupancy escape
   > });
   > ```
   > The PlanningPanel equivalent (`:9791-9804`) has two arms — a no-plans arm (`:9792`, no occupancy) and an occupancy arm (`:9799`). Apply the same shape to both; the no-plans arm has no cards so `occupiedColumns` is empty and the trailing escape is a no-op there.
2. **Fix the occupancy source** — occupancy must be computed from the FULL workspace card
   set, not the project/repo-scope-filtered view (suspected cause of the intern column
   vanishing while occupied). Confirm what `cards` contains at each call site
   (`_refreshBoard:1679` et al.) and switch to unfiltered records where needed. A column
   with any card in it must always render, under every filter.
3. **Retire `hideWhenNoAgent`** — remove the flag from the four definitions
   (`agentConfig.ts:125-132`) and delete the flag-specific branches
   (`_filterDynamicColumns`, `_getNextColumnId.shouldSkip`, `KanbanProvider.ts:5171`,
   `PlanningPanelProvider`), since the uniform rule subsumes them. Keep the type field
   only if custom columns can set it today; otherwise drop it from the interface.
4. **Routing degrade** — `_targetColumnForDispatchRole` and `resolveAutoDispatchColumn`:
   when the resolved role's agent is unticked, degrade intern → coder → lead, i.e. the
   nearest visible coding column; if no coding agent is ticked, return a hard error
   surfaced to the caller (webview toast / API 4xx) — never move a card into a lane the
   board will not show. Mirror the same degrade in `_getNextColumnId.shouldSkip`.

   **Route/advance rule ≠ render rule (load-bearing distinction).** The render rule
   (Scope #1) has an *occupancy escape* — an unticked column still renders if it holds a
   card, so no card is ever stranded invisible. The route/advance rule must NOT inherit
   that escape: degrade past an unticked column **regardless of its current occupancy**.
   Rationale: unticking an agent means "send no new work to this role." Advancing/dispatching
   a *new* card into an occupied-but-unticked lane would pile more work into a role the user
   deliberately unstaffed. The occupied lane stays *visible* (render escape) so its existing
   card is fine; new work still degrades past it.

   > **Superseded:** "when the resolved role's agent is unticked (column would be hidden and empty), degrade …" and "`_getNextColumnId.shouldSkip` … skip role columns whose agent is unticked **and column empty**".
   > **Reason:** Conditioning the degrade/skip on "empty" is wrong. `shouldSkip` (`KanbanProvider.ts:5161-5175`) has no card/occupancy input today and gates purely on `visibleAgents[col.role] === false`. Adding an "and empty" qualifier would advance a card into an occupied-but-unticked lane — contradicting the intent of unticking (no new work there) and forcing `shouldSkip` to take a new occupancy argument it doesn't need. Occupancy is a *render* concern only.
   > **Replaced with:** degrade/skip keys on **ticked-only** (`visibleAgents[col.role] !== false`), no occupancy term. `shouldSkip` keeps its existing signature; just replace the `col.hideWhenNoAgent && col.role && visibleAgents[col.role] === false` branch (`:5171`) with `col.role && visibleAgents[col.role] === false` (drop the flag gate, keep the ticked check).

   **`resolveAutoDispatchColumn` has THREE exits, not one** (`KanbanProvider.ts:6534-6545`):
   routing-off → `LEAD CODED` (`:6536`), complexity-unknown → `LEAD CODED` (`:6540`), and the
   routed role → intern/coder/lead (`:6543`). The plan's degrade must wrap **all three**
   final `targetColumn` values through a single `validateOrDegradeCodingColumn(targetColumn,
   visibleAgents)` helper — otherwise the two hardcoded `LEAD CODED` fallbacks still target a
   hidden empty lead lane when lead is unticked. (`LEAD CODED` is not a safe default anymore.)

   **Signature ripple** — `_targetColumnForDispatchRole` (`:6416`) is currently sync and takes
   only `role`; making it visibility-aware means it needs `visibleAgents`, and it is called at
   five sites (`:7823`, `:7954`, `:8092`, `:8306`, `:8395`). Each is inside an async dispatch
   handler, so plumb `visibleAgents` (via `await this._getVisibleAgents(workspaceRoot)`) at
   each call site, or hoist the degrade into a shared async helper the five callers invoke.
   `resolveAutoDispatchColumn` is already sync-with-no-visibility — it must gain the same input.
5. **Webview hardening (kept from v1)** — the bucketing fallback
   (`kanban.html:5752-5758`) must never silently divert a card to CREATED: initialize
   buckets for `columns ∪ CODED_IDS` so coded-column cards always reach the AUTOCODE merge,
   and for any other unrendered column request a one-shot refresh instead of masquerading.
   With Scope #1/#2 the backend should make this unreachable; this is the belt-and-braces.
6. **Webview bootstrap/push agreement** — the bootstrap filter (`kanban.html:4014`) and the
   `visibleAgents` message handler stay as-is; verify the first `updateColumns` push now
   agrees with the bootstrap (same rule server-side), eliminating the flash of extra
   columns on load.

### ⚙️ OUT OF SCOPE
- Complexity bands / routing map values (1-4 intern, 5-6 coder, 7+ lead) — unchanged; only
  the degrade-when-hidden behavior is added.
- Custom-user columns and custom-agent columns — keep their existing visibility config;
  this plan unifies BUILT-IN role columns only.
- `_getNextColumnId`'s independent ACCEPTANCE TESTED gate (`acceptanceTesterActive`) —
  advance-chain policy, stays.
- The feature cascade / plan watcher machinery — investigated, not implicated (DB correct
  at every step of the incident).
- Autoban/watch configuration semantics — a hidden column can't accumulate cards (routing
  degrade + occupancy escape), so no autoban changes needed.

## Complexity Audit
### Routine
- Flag removal; filter-rule rewrite is small and centralized.
- Webview bucket initialization.
### Complex / Risky
- **Occupancy source (Scope #2):** must be unfiltered; using the filtered card set
  re-introduces the vanishing-occupied-column bug under project filters. This is the part
  that failed in the wild — needs explicit verification at every `_filterDynamicColumns`
  call site.
- **Routing degrade (Scope #4):** must key off the same visibleAgents+occupancy inputs the
  board push uses — a re-derivation that disagrees strands cards; and the no-coding-agent
  case must fail loudly, not default silently to LEAD CODED (which would resurrect the
  hidden-lane strand).
- **Behavior-change blast radius (Scope #1):** existing boards with unticked agents will
  drop empty columns on upgrade. Cards in those columns keep them visible (occupancy
  escape), so nothing disappears with content — but the layout change should be mentioned
  in release notes.
- **Two-store drift:** the structure tab writes `visibleAgents[role]` for built-ins —
  confirmed (`TaskViewerProvider.handleToggleKanbanColumnVisibility:9186`, `_filterVisibleColumns:2779`);
  no second `visible` flag lingers for built-ins. One store, verified.
- **Render rule vs route rule divergence (Scope #4):** the render filter has an occupancy
  escape; the route/advance path must NOT. Implementing both from a single mis-shared
  predicate would either strand cards (render inherits route's no-escape) or feed unstaffed
  lanes (route inherits render's escape). They must be two deliberately different predicates
  over the same `visibleAgents` input.
- **`resolveAutoDispatchColumn` three-exit trap:** two of its three exits hardcode
  `LEAD CODED`; a degrade applied only to the routed-role exit leaves the fallbacks pointing
  at a hidden empty lead lane. All exits must funnel through one validate/degrade step.
- **Signature ripple:** making dispatch routing visibility-aware touches 5 call sites plus
  `resolveAutoDispatchColumn`; a missed site silently keeps the old hidden-lane behavior.

## Edge-Case & Dependency Audit
- **Occupied-but-unticked column:** renders (occupancy escape) until its last card leaves,
  then hides — cards are never invisible; the incident's stranded feature displays
  correctly immediately after upgrade with no data migration.
- **Untick while cards in flight:** a dispatch mid-flight into a just-unticked role — the
  degrade check runs at dispatch time; a card already moved keeps its column visible via
  occupancy.
- **All coding agents unticked:** `POST /kanban/dispatch` and board advances fail with a
  clear "no coding agent is ticked" error; nothing moves.
- **Coder-collapse (AUTOCODE):** collapsed view merges only the VISIBLE coded columns;
  hidden-and-empty coded columns simply aren't in the merge; occupied ones are.
- **Project filter active:** occupancy comes from the full card set (Scope #2), so a column
  holding only filtered-out cards renders (empty-looking under the filter) rather than
  vanishing while "occupied".
- **Webview bootstrap flash:** bootstrap and push now apply the same rule — no
  columns-appear-then-vanish flash on load.
- **Older installed builds:** fixes take effect on rebuild/republish (running extension is
  the packaged 1.7.7 dist).
- **Dependencies:** none on other plans. No API/verb surface changes → no catalog regen;
  no skill files touched → no mirror sync.

## Dependencies
- None. No API/verb surface changes → no catalog regen; no skill files touched → no mirror
  sync. Self-contained to the visibility/routing code paths.

## Adversarial Synthesis

**Risk Summary:** Key risks — (1) occupancy source must be the FULL unfiltered workspace
card set at all three `_filterDynamicColumns` callers, or a project filter re-introduces the
vanishing-occupied-column incident; (2) the route/advance path must degrade past unticked
lanes with NO occupancy escape while the render path keeps one — two deliberately different
predicates over one `visibleAgents` store; (3) all three `resolveAutoDispatchColumn` exits
(including two hardcoded `LEAD CODED` fallbacks) plus the five `_targetColumnForDispatchRole`
call sites must funnel through one degrade helper, else a missed site silently feeds a hidden
lane. Mitigations — corrected `_filterDynamicColumns` snippet preserves the `featureOnly`
branch; a single `validateOrDegradeCodingColumn` helper is the one place render-hide and
route-degrade are reconciled; webview bucket init (`columns ∪ CODED_IDS`) is the belt-and-braces
so no card can masquerade in CREATED even if a backend site is missed.

## Proposed Changes
### src/services/agentConfig.ts
- `:125-132` — remove `hideWhenNoAgent: true` from RESEARCHER, INTERN CODED,
  ACCEPTANCE TESTED, TICKET UPDATER; retire the field per Scope #3.

### src/services/KanbanProvider.ts
- `_filterDynamicColumns` (`:3514-3527`) — uniform rule, preserving the `featureOnly`
  branch order (see corrected snippet in Scope #1): `featureOnly ⇒ occupied`; `no-role ⇒
  always`; `role ⇒ ticked OR occupied`. Occupancy from full unfiltered card set (Scope #2
  verification at `:1679`, `:3252`, `:3437` — all three are calls to this one method, so
  the fix is a single edit; the risk is in what `cards` holds at each caller).
- `_targetColumnForDispatchRole` (`:6416`) — becomes visibility-aware; degrade
  intern → coder → lead over TICKED agents (no occupancy term); hard error when no coding
  agent ticked. Plumb `visibleAgents` into the 5 call sites (`:7823`, `:7954`, `:8092`,
  `:8306`, `:8395`) or a shared async helper.
- `resolveAutoDispatchColumn` (`:6534-6545`) — route ALL THREE exits (routing-off `:6536`,
  unknown `:6540`, routed `:6543`) through the same degrade/validate; the two hardcoded
  `LEAD CODED` fallbacks are no longer safe defaults.
- `_getNextColumnId.shouldSkip` (`:5161-5175`, esp. `:5171`) — replace the
  `col.hideWhenNoAgent && col.role && visibleAgents[col.role] === false` branch with
  `col.role && visibleAgents[col.role] === false` (ticked-only; no occupancy, no flag).
  Keep the existing `featureOnly` (`:5162`) and `ACCEPTANCE TESTED` (`:5165`) branches.

### src/services/TaskViewerProvider.ts (NO change — conformance note)
- `_filterVisibleColumns` (`:2772-2784`) and `_buildSetupKanbanStructure` (`:2786`) — the
  Setup **structure tab** already filters built-in role columns by `visibleAgents[role] ===
  false` with NO `hideWhenNoAgent` gate. This surface is *already* the uniform rule (minus
  occupancy, which a config list doesn't need). It requires no change — but confirm it stays
  aligned and does not reference `hideWhenNoAgent` (verified: it does not). This is why the
  structure-tab HIDE and the agents-tab tick already agree today; the board push was the lone
  dissenter.
- `handleToggleKanbanColumnVisibility` (`:9176-9193`) — writes `state.visibleAgents[columnId]`
  where the inline comment confirms `columnId` is the role for built-in columns. One store,
  confirmed. No change.

### src/services/PlanningPanelProvider.ts
- `:9793`, `:9800` — same uniform-rule replacement.

### src/webview/kanban.html
- `:5736-5758` — buckets for `columns ∪ CODED_IDS`; unrendered-column cards never fall to
  CREATED (one-shot refresh request instead).
- Verify bootstrap filter (`:4014`) and `updateColumns` handler need no change (rule now
  matches server-side).

## Verification Plan
### Automated Tests
- None required for sign-off (per this session's SKIP TESTS / SKIP COMPILATION directive).
  Verification is behavioral, exercised against a rebuilt VSIX. If a regression test is later
  wanted, the highest-value unit target is a pure `validateOrDegradeCodingColumn(target,
  visibleAgents)` helper (table of ticked-sets → expected column / hard-error) and a
  `_filterDynamicColumns` fixture (featureOnly + occupied + unticked permutations).

### Manual / behavioral
- **Headline (user's ask):** tick only 3 agents (e.g. planner, lead, reviewer) → board
  shows CREATED, PLAN REVIEWED, LEAD CODED, CODE REVIEWED, COMPLETED and nothing else.
  Tick coder → CODER CODED appears immediately; untick → it hides (when empty).
- **Structure-tab parity:** HIDE on a built-in column in the Setup tab ≡ unticking its
  agent — both flip the same store and the board reacts identically.
- **Safety:** put a card in CODER CODED, untick coder → column stays visible with the card;
  move the card out → column hides. Repeat under an active project filter that excludes
  the card (column must still render).
- **Incident repro:** groom a feature to complexity ≤ 4, intern unticked, press "Copy coder
  prompt" from PLAN REVIEWED → routing degrades to CODER CODED (or LEAD CODED), the card
  renders exactly where the response says, nothing appears in CREATED, and
  `GET /kanban/board` agrees with the display.
- **Hard-fail case:** untick lead + coder + intern → dispatch/advance produces a clear
  error and no move.
- **Fallback-exit repro (new):** untick lead only, then dispatch (a) with dynamic complexity
  routing OFF and (b) a card whose complexity is Unknown — both currently resolve to
  `LEAD CODED`; confirm each degrades to the nearest ticked coding column (coder, else intern)
  instead of a hidden empty LEAD CODED, and that the response names where the card landed.
- **Ticket-updater board:** tick the ticket-updater agent → TICKET UPDATER column appears
  (order 9000, before Completed) and accepts advances — a valid dedicated-board setup.
- **Load flash:** reload the board — no transient extra columns between bootstrap and the
  first push.

---
**Recommendation:** Complexity 7 → Send to Lead Coder. (Was Coder; see the superseded
callout in Metadata — the render-vs-route predicate split and the multi-site routing degrade
warrant a lead.)

## Review Findings

Reviewer pass verified all six scope items are implemented correctly: uniform `_filterDynamicColumns` rule (preserves `featureOnly` order), unfiltered occupancy via `allCards` at the live `refreshWithData` call site, `hideWhenNoAgent` fully retired (interface + all four defs + all branches, repo-wide grep clean), `_validateOrDegradeCodingColumn` funnels all three `resolveAutoDispatchColumn` exits + all five `_targetColumnForDispatchRole` sites (each guarded by a pre-check + surfaced as API 400), `shouldSkip` ticked-only, and the webview `columns ∪ CODED_IDS` bucket hardening with one-shot refresh. **Fixed (MAJOR):** `sendVisibleAgents()` did not call `_markConfigDirty()`, so a tick/untick — which writes state.json/globalState but not the kanban DB — left both `dataVersion` and `configEpoch` unchanged, and the follow-on refresh was dropped by `refreshWouldBeNoOp` (columns never hid/showed on toggle, the plan's headline behavior); added the epoch bump so the toggle-triggered refresh re-pushes `updateColumns` (`KanbanProvider.ts:5705`). Files changed: `src/services/KanbanProvider.ts`. Validation: authoritative TS parse check clean (compile/tests skipped per session directive). Remaining risks (deferred, not fixed): (1) `getVisibleAgents` reads the machine-global `~/.switchboard` file first but board-toggle writes hit only globalState/state.json — for the ~mcp_monitor-only users whose file holds a `visibleAgents` key, toggles can be masked; a safe fix needs a migration folding existing toggles into the file, so it is out of this plan's declared "one store" scope; (2) two dead `_filterDynamicColumns` callers (`_refreshBoardImpl` tests-only, `_refreshBoardWithData` zero call sites) still pass the project-filtered card set for occupancy — latent only if re-wired live; (3) PlanningPanel's column-defs read visibleAgents from state.json only, a pre-existing source divergence the uniform rule amplifies.
