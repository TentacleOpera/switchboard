# Restore The Optimistic Card Move On Planned-Column Copy-Prompt Buttons

## Goal

> **DISPATCH is retired — no migration, no compat arm.** The `DISPATCH` display mode was
> replaced by a real `STAGING` column in commit `52404992`. At HEAD there are **zero**
> `'DISPATCH'` references in `src/` (`kanban.html` included), `DISPATCH` is not in
> `VALID_KANBAN_COLUMNS`, and no card is in it. The feature never shipped to users, so
> there is nothing to migrate and no legacy arm to carry: write `STAGING` only, and do
> not add a `|| 'DISPATCH'` fallback, an alias normaliser, or a read-time coercion.

Make a card advanced from the **Planned** column (or the Dispatch view of it) via a copy-prompt button jump to its new column *on click*, the way every other column's copy-prompt button still does — instead of sitting still until the backend's DB write comes back.

> **Line-citation sweep:** every `file:line` in this plan was re-verified against `d9d0a9d3` during the improve pass. The pre-improve draft's `kanban.html` citations were ~70 lines low and its `KanbanProvider.ts` citations ~100–650 lines low (the code was unchanged — only the offsets had drifted). All citations below are current.

### The problem

Reported from UAT: *"optimistically moved cards on kanban with copy prompt buttons do not seem to appear in the new column straight away anymore, waiting for db."*

The optimistic-move machinery is intact and still works — for cards in **New**, **Reviewed**, **Acceptance Tested** and custom columns. What changed is that the **Planned column path deliberately opts out of it**, and the Planned column is exactly where the copy-prompt button is used most (it is the plan → coder hand-off). The card therefore appears to hang until `promptSelected` finishes generating the prompt, writing the clipboard, and running the per-card DB moves — and only then does the backend's `moveCards` delta relocate it.

The latency the user is watching is real and large. `promptSelected` (`KanbanProvider.ts:9966`) does, in order: resolve the next column (`:9987`), **generate the prompt** (`:9990` — reads plan files), **write the clipboard** (`:9991`), resolve the dispatch spec (`:10003`), complexity-route each session (`:10042` → `_partitionByComplexityRoute` → one plan-file read per card), `await moveCardToColumn` per card (`:10053` — a sql.js export each), record a run sheet per card (`:10054`), collect cascade ids per card (`:10055`) — and only then posts `{ type: 'moveCards' }` (`:10058`). Every one of those is ahead of the first visual acknowledgement the user gets.

### Root cause: two deliberate suppressions, both introduced to hide a mis-prediction

The backend complexity-routes a `PLAN REVIEWED` advance per card (`_partitionByComplexityRoute`, `KanbanProvider.ts:7469`), so the webview cannot advance the card to a single fixed "next column". Rather than predict the route, both call sites were changed to **not move the card at all**:

| Surface | Code | Behaviour |
| :-- | :-- | :-- |
| Column-header `moveSelected` / `moveAll` / `promptSelected` / `promptAll` | `kanban.html:6594`, `:6613`, `:6637`, `:6656` — `if (nextCol && column !== 'PLAN REVIEWED')` | **Never** optimistically moves a Planned batch. Comment: *"a single optimistic target would bounce mixed-complexity batches. Let the backend deltas drive."* |
| Per-card copy-prompt button (`runCopyPrompt`) | `kanban.html:7509-7540` | Predicts the route, but sets `nextCol = null` — no move at all — when `isNaN(score) \|\| pairModeActive \|\| score < 1 \|\| score > 10` (`:7517`). |

Both landed in **`3a1030ee`** (*Manager Console UX & Self-Service*, 2026-07-11). Before that commit all five sites read a plain `if (nextCol) { … moveCardsOptimistically(…) }`.

> **Superseded:** "**`3b3c6367`** (2026-08-11) then extended the per-card suppression to `column === 'DISPATCH'`, which is why the regression became obvious while testing the Dispatch view — that surface lost its optimistic move four days ago."
> **Reason:** Wrong commit. `git log -S "column === 'DISPATCH') && dynamicComplexityRoutingEnabled" -- src/webview/kanban.html` returns exactly one commit, and it is not `3b3c6367`. The narrative is right; the SHA and the date are not.
> **Replaced with:** **`fd6da162`** (*standalone push-path parity, terminal seating, panel extraction residue*, **2026-08-10**) widened the per-card gate from `column === 'PLAN REVIEWED'` to `(column === 'PLAN REVIEWED' || column === 'DISPATCH')`. Before it, a `DISPATCH` card fell through to the plain `if (nextCol)` branch and *did* move optimistically (to `getNextColumn('PLAN REVIEWED')`, which the backend then re-routed). `fd6da162` removed the bounce by removing the move — which is why the Dispatch view is where the regression is most visible.

### Why the suppression is the wrong shape (not the wrong instinct)

The instinct — *"a wrong optimistic target is worse than none, because the backend delta visibly bounces the card"* — is right. The implementation throws away three facts that make a safe move available in almost every real configuration:

1. **The coder lanes are collapsed by default.** `collapseCodersEnabled` defaults to `true` (`kanban.html:4959`) and `resolveDomColumn` maps all three of `LEAD CODED` / `CODER CODED` / `INTERN CODED` onto the single synthetic `col-CODED_AUTO` container (`:4977-4981`). While collapsed, **every** complexity route resolves to the same DOM container — so a mis-predicted *lane* is not merely tolerable, it is **invisible**. There is nothing to bounce.
2. **`pairModeActive` is not a routing unknown.** The backend's pair-programming rule is exactly one line: `if (isPairMode && role === 'intern') role = 'coder'` (`KanbanProvider.ts:1422-1427`). It is trivially mirrorable. Blanket-suppressing on pair mode discards a fully-determined prediction.
3. **`moveCardElements` already accepts per-entry targets** (`kanban.html:5977`, `@param {Array<{id, targetColumn, sourceColumn?}>}` at `:5972`). The "mixed-complexity batch" objection applies only to `moveCardsOptimistically`'s *shared*-target signature (`:6075`), not to the DOM primitive underneath it. A mixed batch can be moved correctly today; nobody wired it up.

### What genuinely cannot be predicted

Three divergences are real and must be respected rather than papered over.

**1. The backend routes on the plan file, not the DB column.** `_resolveComplexityRoutedRole` (`KanbanProvider.ts:7407`) resolves the plan file and calls `getComplexityFromPlan(...)` (`:7439`) — it re-reads the **plan file on disk**. The webview only has `card.complexity` (the DB column), and the two are synced opportunistically. So the score the webview sees can be stale.

**2. The webview's default routing map disagrees with the backend's default at score 4.** `resolveRoutedRole` (`KanbanProvider.ts:1401`) applies the custom routing map **only when one is persisted**; otherwise it falls through to `scoreToRoutingRole` (`complexityScale.ts:61`), which is **1-4 → intern, 5-6 → coder, 7-10 → lead**. The webview's hardcoded default (`kanban.html:5256`) is `{ lead: [7,8,9,10], coder: [4,5,6], intern: [1,2,3] }` — score **4** routes to `coder` in the webview and `intern` in the backend. The webview only overwrites the constant when the backend actually pushes one (`if (msg.routingConfig)`, `:8691`), and `_routingMapForScope` returns `null` when nothing is persisted — so on a stock install the divergence is live. (This is a pre-existing bug in the current `runCopyPrompt` predictor at `:7527`; the fix below closes it rather than inheriting it.)

**3. A custom user column immediately after Planned bypasses complexity routing — but only on the prompt paths.** The four backend arms are *not* symmetric:

| Arm | Custom-user `nextCol` | Behaviour from `PLAN REVIEWED` |
| :-- | :-- | :-- |
| `moveSelected` (`:9655`) | checked only in the `else` | **Always** complexity-routes |
| `moveAll` (`:9799`) | checked only in the `else` | **Always** complexity-routes |
| `promptSelected` (`:10007`, `:10039`) | checked **first** | Custom-user → whole batch to `nextCol`; otherwise complexity-routes |
| `promptAll` (`:10116`, `:10144`) | checked **first** | Custom-user → whole batch to `nextCol`; otherwise complexity-routes |

So the prompt family and the move family disagree exactly when the user has inserted a custom column between Planned and Lead Coder. The fix must carry that distinction; a single shared rule silently mispredicts one family across DOM containers.

That is why the fix below is built on *display equivalence* rather than on prediction accuracy: move the card when either (a) the prediction is exact, or (b) every candidate lane renders into one container so accuracy is irrelevant. Both conditions are checkable in the webview with no new backend traffic.

### Two backend behaviours the fix must not fight

- **Unknown-complexity skip.** When `kanban.allowUnknownComplexityAutoMove` is `false`, `_filterUnknownComplexitySessions` (`KanbanProvider.ts:7490`) drops unscored cards and the backend **advances nothing** for them. Optimistically moving such a card would strand it (see "the ledger has no expiry" below). The webview already mirrors the setting in `allowUnknownComplexityAutoMove` (`kanban.html:4955`, kept fresh by `allowUnknownComplexityAutoMoveState`, `:9017`), so this is a cheap pre-check.
- **No coding agent enabled.** All four arms return an error *without* posting `moveCardsFailed` when `lead`/`coder`/`intern` are all hidden (`:9663`, `:9807`, `:10044`, `:10149`). There is no revert delta to catch, so the webview must not move in that case either.

### The ledger has no expiry — an unconfirmed optimistic move strands permanently

This is the reason the two pre-checks above are load-bearing rather than tidy, and it is the reason this plan now touches the backend.

`armOptimisticGuard` (`kanban.html:5055`) writes each moved id into `pendingOptimisticMoves`. `applyPendingOptimisticMoves` (`:6243`) then overlays that target column onto **every** subsequent `updateBoard` payload. Entries leave the ledger only via `resolveOptimisticGuard` (`:5081`, called from `case 'moveCards'` `:8558` and `case 'moveCardsFailed'` `:8611`) or `clearOptimisticGuard` (`:5072`, called only on `updateColumns`). **There is no time-based eviction** — `optimisticMoveUntil` expires after 2000 ms, but the ledger does not. And the guard-expiry `refresh` (`:5063-5069`) only fires when `suppressedRenderPending` is true, which is set only *inside* the `moveCards` / `moveCardsFailed` handlers.

Consequence: an optimistic move that the backend never confirms **and** never fails leaves the card rendered in the predicted column forever, on every refresh, until the board's columns change.

The prompt family is exactly that hole. `moveSelected` (`:9676`) and `moveAll` (`:9820`) use `moveCardToColumnWithReason` and post `moveCardsFailed` on a failed write. `promptSelected` (`:10053`) and `promptAll` (`:10163`) call bare `moveCardToColumn`, ignore the result, and post **no** failure delta. Today that asymmetry is harmless because the prompt path never moves optimistically. This plan makes it move — so the failure channel has to exist before the move does.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Replacing the four `column !== 'PLAN REVIEWED'` gates with a shared entry-builder call.
- Mirroring `resolveRoutedRole`'s intern→coder pair-mode bypass — a one-line rule with a known verbatim source.
- Adding the `allowUnknownComplexityAutoMove` and "any coder lane visible" pre-checks; both variables already exist in the webview and are already kept in sync by existing messages.
- Adding the `moveCardToColumnWithReason` + `moveCardsFailed` failure channel to the two prompt arms — a verbatim copy of the block already in `moveSelected` (`:9674-9691`).

### Complex / Risky

- **The certainty gate is the whole design.** `certain || coderLanesShareOneContainer()` is what keeps a stale-score card from visibly bouncing. Getting the second half wrong (e.g. deriving lane visibility from `columns` instead of `lastVisibleAgents`) reintroduces the exact bounce `3a1030ee` was written to remove. See the dependency audit below — `columns` is *not* a proxy for agent visibility.
- **Prompt-vs-move asymmetry on a custom next column.** The entry builder must know whether the caller copies a prompt, because only the prompt arms hand a custom-user `nextCol` the whole batch. Collapsing the two families onto one rule mispredicts one of them *across DOM containers* — the one failure mode display-equivalence cannot absorb.
- **A move with no failure channel strands the card permanently** (see above). The backend change is not optional polish; without it a failed sql.js write on the copy-prompt path leaves the card in the wrong column until the board's columns change.
- **Model/DOM divergence inside the guard window.** An optimistic move writes `cardData.column` and arms `pendingOptimisticMoves` (`kanban.html:5055`), which overlays incoming `updateBoard` payloads for `OPTIMISTIC_MOVE_WINDOW_MS` (2000 ms, `:5047`). If the predicted lane is wrong-but-same-container, the *logical* column is wrong for up to 2 s: `buildPositionSignature` (`:6235`) will disagree, `suppressedRenderPending` flips true, and the guard-expiry `refresh` repairs it. That is an accepted, bounded cost — but it must be stated, not discovered.
- **`moveCardsOptimistically` is pinned by a source-text contract test.** `dispatch-view-contract.test.js:80-92` asserts the literal string `updateDispatchToggleCount(` appears **inside the body of** `function moveCardsOptimistically(`. Refactoring it into a thin delegator that calls a new helper **fails that test** even though the behaviour is identical. The calls must stay literally in both function bodies.
- **The Dispatch-view `renderBoard` fallback is pre-existing and correct.** With `showingDispatch` true, `resolveDisplayColumn('PLAN REVIEWED')` returns `null` (`kanban.html:5954-5956`), so a New→Planned advance cannot place the element, `unresolvedNeedsRender` fires, and the card correctly vanishes behind the Dispatch toggle. **Do not "fix" this** — a Planned card is not displayed in Dispatch view by design.

## Edge-Case & Dependency Audit

| Case | Expected behaviour after the fix |
| :-- | :-- |
| Planned card, scored 1-10, coders collapsed (default) | Moves instantly into **AUTOCODE**. Backend lane choice is invisible. |
| Planned card, `complexity = 'Unknown'`, coders collapsed, `allowUnknownComplexityAutoMove = true` | Moves instantly into AUTOCODE. Backend advances it too (default `lead` when no plan file / unparseable score, `KanbanProvider.ts:7435-7437`) — same container. |
| Planned card, `complexity = 'Unknown'`, `allowUnknownComplexityAutoMove = false` | **No optimistic move.** The backend will skip it; the prompt still copies. Matches `_filterUnknownComplexitySessions`. |
| Planned card, coders **expanded**, scored | Moves instantly into the predicted lane. A stale plan-file score can still bounce one lane — the pre-`3a1030ee` behaviour, now narrowed to expanded-view + stale-score only. |
| Planned card, coders **expanded**, unscored | **No optimistic move** (uncertain *and* multiple containers). This is the only case that keeps today's "wait for the DB" behaviour, by design. |
| Pair-programming mode on, score routes to `intern` | Predict **CODER CODED** (mirrors `resolveRoutedRole`'s bypass), not "suppress everything". |
| **Score 4, no custom routing map persisted** | Predict **INTERN CODED** — `scoreToRoutingRole` owns the default, not the webview's display constant. Getting this wrong is a *silent* one-lane bounce on a stock install (invisible collapsed, visible expanded). |
| Only one coder agent visible (e.g. intern + coder hidden) | `coderLanesShareOneContainer()` is true (single candidate lane) → always moves, even unscored. |
| All three coder agents hidden | **No optimistic move.** All four arms error out with no `moveCardsFailed` delta, so there would be nothing to revert against. |
| Mixed-complexity multi-select via the column-header `promptSelected` / `moveSelected` | Per-card targets. Each card goes to its own lane; collapsed view puts them all in AUTOCODE anyway. |
| **Custom user column inserted directly after Planned — `moveSelected` / `moveAll`** | Backend still complexity-routes (`:9655`, `:9799`). Predict the routed coder lane, **not** `nextCol`. |
| **Custom user column inserted directly after Planned — `promptSelected` / `promptAll`** | Backend moves the whole batch to `nextCol` (`:10007`, `:10116`). Predict `nextCol` — the plain non-routed path, which is now *correct* rather than suppressed. |
| Custom column after Planned that resolves **no** dispatch spec (role-less, `dragDropMode: 'cli'`) | `_resolveKanbanDispatchSpec` returns `null` (`:6475-6477`), so `promptSelected` falls into the complexity branch (`!dispatchSpec`) while the webview predicts `nextCol`. Residual one-time misprediction; the `moveCards` delta corrects it and the guard absorbs the render. Accepted — the alternative (suppressing all custom-column advances) costs the common case to protect a configuration with no role. |
| Staging column, per-card copy prompt on a `STAGING` card | Same treatment as Planned. `STAGING` is a real column at HEAD (`agentConfig.ts:154`, `kind: 'staging'`), not a display mode of Planned, so it has its own container and its own count — the old `resolveDisplayColumn('DISPATCH')` billing of the Planned container no longer applies. Verify the source-column decrement against the STAGING container. |
| Backend confirms a **different** lane than predicted | `case 'moveCards'` (`:8521`) computes an entry only when `card.column !== targetCol` (`:8535`), then `moveCardElements` relocates within the same DOM container — a ts-ordered re-insert, no cross-column motion. `resolveOptimisticGuard` (`:8558`) clears the ledger. |
| Backend refuses the move | `moveCardsFailed` (`:8579`) reverts per-card to its own `sourceColumn`. **Requires Proposed Change 5** — the prompt arms do not emit this delta today. |
| `dynamicComplexityRoutingEnabled === false` | Backend returns `'lead'` for everything (`KanbanProvider.ts:7409-7411`). `getNextColumn('PLAN REVIEWED')` walks to the first *listed* coded column, which is **not** necessarily `LEAD CODED`. Predict `LEAD CODED` explicitly (degraded to the nearest visible lane) in this branch — the predictor owns it, so the call site must **not** gate on the flag. |

**Dependencies / landmines**

- **`columns` is not a visibility proxy.** The webview's `columns` array is rebuilt from the backend payload on `updateColumns` (`kanban.html:8949-8951`), and the backend's `_filterDynamicColumns` (`KanbanProvider.ts:3976-3981`) *keeps* a hidden agent's column when cards still occupy it. Any lane-visibility check must read `lastVisibleAgents` (`kanban.html:4945`, merged by `case 'visibleAgents'` `:9121` and the setup sync at `:9293`) — the same map the backend's `_validateOrDegradeCodingColumn` (`:7706`) uses. The current `runCopyPrompt` predictor gets this wrong today (`kanban.html:7530` tests `columnDefinitions.some(...)`).
- **Routing-map iteration order.** The backend checks `intern`, then `coder`, else `lead` (`KanbanProvider.ts:1410-1417`). The current webview mirror iterates `Object.entries(routingMapConfig)` in `{lead, coder, intern}` declaration order (`kanban.html:7527`) and takes the first hit. These agree only while the map is a strict partition (`_updateRoutingConfig` enforces that for *persisted* maps, `:7447-7458`, but nothing enforces it for a payload the webview merely receives). Write the mirror in the backend's explicit order.
- **`routingMapConfig` is never null in the webview.** The `updateBoard` handler guards with `if (msg.routingConfig)` (`:8691`), so a `null` from `_routingMapForScope` leaves the hardcoded default in place. The predictor may dereference it without a null check — but it must **not** treat the default as authoritative (see the score-4 case above).
- **`routingMapConfig` scope.** `resolveRoutedRole` takes an optional `initiatorProject`, but `_partitionByComplexityRoute` calls it **without** one (`:7441`), so the singleton map applies on this path — the webview's `routingMapConfig` is the right source. Do not add project-scoped resolution here.
- **`degradeToVisibleCoderColumn`'s tie-break must stay `<`, not `<=`.** The backend breaks a distance tie toward the **lower** index in `['lead','coder','intern']` (`:7726`). Forward iteration with a strict `<` reproduces that exactly. Flipping to `<=` silently inverts the tie and sends degraded cards to `intern` instead of `lead`.
- **`functionBody('function moveCardsOptimistically(')` will not match the new helper.** `dispatch-view-contract.test.js` slices by `source.indexOf(declaration)`, and `'function moveCardsOptimistically('` is **not** a substring of `'function moveCardsOptimisticallyByEntry('` (the char after `…Optimistically` is `B`, not `(`). No rename is needed — and none should be applied "defensively", because the test also pins the original name.
- **Migration:** the backend change touches only in-flight `postMessage` traffic and a return-value check. No schema, no persisted state, no verb-allowlist entry, no settings key. Nothing to migrate.

## Dependencies

- None. This plan is self-contained against `d9d0a9d3`.

## Adversarial Synthesis

Key risks: (1) the certainty gate is the entire safety argument, and the plan's own headline UAT case runs in collapsed view where *any* target passes — so prediction accuracy is nearly untested unless the expanded-lane cases are exercised deliberately; (2) the backend's four arms are asymmetric about custom next-columns, so one shared prediction rule mispredicts one family across DOM containers; (3) `pendingOptimisticMoves` has no time-based eviction, so an optimistic move the backend neither confirms nor fails strands the card permanently — and the two prompt arms are exactly the ones with no failure delta. Mitigations: gate uncertain routes on `coderLanesShareOneContainer()`, thread a `copiesPrompt` flag through the entry builder, mirror `scoreToRoutingRole` when no custom map is persisted, add the `moveCardToColumnWithReason` + `moveCardsFailed` block to both prompt arms, and assert *positively* in the contract test that the four arms call the entry builder (a negative "the old gate is gone" assertion passes for code that moves nothing).

## Proposed Changes

### 1. `src/webview/kanban.html` — new prediction helpers (place directly after `resolveDisplayColumn`, ~line 5963)

```js
/**
 * Visible coder lanes, mirroring the backend's visibleAgents map rather than
 * `columns` — _filterDynamicColumns KEEPS a hidden agent's column while it still
 * holds cards, so `columns.includes(...)` over-reports visibility.
 * Returned in CODED_IDS order (lead, coder, intern) — degradeToVisibleCoderColumn
 * depends on that ordering for its tie-break.
 */
function visibleCoderColumns() {
    const roleOf = { 'LEAD CODED': 'lead', 'CODER CODED': 'coder', 'INTERN CODED': 'intern' };
    return CODED_IDS.filter(id => lastVisibleAgents[roleOf[id]] !== false);
}

/**
 * True when every visible coder lane renders into ONE DOM container — i.e. the
 * collapsed AUTOCODE view, or a single-lane setup. While true, a mis-predicted
 * lane is invisible on screen, so an uncertain route is still safe to move.
 */
function coderLanesShareOneContainer() {
    const lanes = visibleCoderColumns();
    if (lanes.length <= 1) return true;
    return new Set(lanes.map(id => resolveDisplayColumn(id))).size === 1;
}

/**
 * Mirror of KanbanProvider._validateOrDegradeCodingColumn (KanbanProvider.ts:7706):
 * nearest visible lane, ties broken toward the LOWER index in lead→coder→intern
 * order. The strict `<` below is what reproduces that tie-break — do not relax it
 * to `<=`, which silently inverts it.
 */
function degradeToVisibleCoderColumn(targetColumn) {
    const order = CODED_IDS;   // ['LEAD CODED', 'CODER CODED', 'INTERN CODED']
    const lanes = visibleCoderColumns();
    if (lanes.includes(targetColumn)) return targetColumn;
    const targetIdx = order.indexOf(targetColumn);
    let best = null, bestDist = Infinity;
    order.forEach((id, i) => {
        if (!lanes.includes(id)) return;
        const dist = Math.abs(i - targetIdx);
        if (dist < bestDist) { bestDist = dist; best = id; }
    });
    return best;   // null when every coder agent is hidden — caller must not move
}

/**
 * Score → role, mirroring KanbanProvider.resolveRoutedRole (KanbanProvider.ts:1401).
 *
 * The backend applies the custom routing map ONLY when one is persisted; with none
 * it falls through to complexityScale.scoreToRoutingRole (1-4 intern, 5-6 coder,
 * 7-10 lead). The webview's `routingMapConfig` constant is a DISPLAY default for
 * the routing-map modal and disagrees with that fallback at score 4, so it must not
 * be treated as authoritative until the backend has actually pushed one.
 */
function roleForComplexityScore(score) {
    if (routingMapIsCustom) {
        if ((routingMapConfig.intern || []).includes(score)) return 'intern';
        if ((routingMapConfig.coder  || []).includes(score)) return 'coder';
        return 'lead';                                   // backend order: intern → coder → lead
    }
    if (score >= 1 && score <= 4) return 'intern';       // complexityScale.ts:61-65
    if (score >= 5 && score <= 6) return 'coder';
    return 'lead';
}

/**
 * Predict the coder column a PLAN REVIEWED / STAGING advance lands in.
 * Mirrors resolveRoutedRole (including the pair-programming intern→coder bypass)
 * and _validateOrDegradeCodingColumn.
 *
 * `certain` is false when the score is unusable. It is NOT a promise of
 * exactness even when true: the backend re-reads complexity from the PLAN FILE
 * (_resolveComplexityRoutedRole), so a stale DB value can still disagree. Callers
 * pair it with coderLanesShareOneContainer() before trusting a single lane.
 */
function predictComplexityRoutedColumn(card) {
    if (!dynamicComplexityRoutingEnabled) {
        // KanbanProvider._resolveComplexityRoutedRole:7409 — everything routes to lead.
        return { target: degradeToVisibleCoderColumn('LEAD CODED'), certain: true };
    }
    const score = parseInt(card?.complexity, 10);
    const certain = !isNaN(score) && score >= 1 && score <= 10;
    // Backend default for an unresolvable score: no plan file → 'lead' (:7435-7437);
    // unparseable content → parseComplexityScore returns 0 → scoreToRoutingRole 'lead'.
    let role = certain ? roleForComplexityScore(score) : 'lead';
    const pairModeActive =
        (document.getElementById('pairProgrammingModeSelect')?.value || 'off') !== 'off';
    if (pairModeActive && role === 'intern') role = 'coder';   // KanbanProvider.ts:1422-1427
    const roleMap = { lead: 'LEAD CODED', coder: 'CODER CODED', intern: 'INTERN CODED' };
    return { target: degradeToVisibleCoderColumn(roleMap[role]), certain };
}

/**
 * Per-card optimistic entries for a forward advance. PLAN REVIEWED / STAGING
 * cards are complexity-routed per card by the backend, which used to mean NO
 * optimistic move at all. Each card now gets its own predicted target, and
 * uncertain routes move only when every coder lane shares one container.
 * Returns [] when nothing can be moved safely.
 *
 * `copiesPrompt` selects between the two ASYMMETRIC backend families:
 *   moveSelected/moveAll   (:9655, :9799) — always complexity-route from Planned.
 *   promptSelected/promptAll (:10007, :10116) — hand a CUSTOM-USER nextCol the whole
 *   batch instead, and only complexity-route when nextCol is a built-in coded lane.
 */
function optimisticEntriesForAdvance(ids, column, nextCol, { copiesPrompt = false } = {}) {
    const plainEntries = () => (nextCol ? ids.map(id => ({ id, targetColumn: nextCol })) : []);

    const routedSource = (column === 'PLAN REVIEWED' || column === 'STAGING');
    if (!routedSource) return plainEntries();

    // Prompt arms defer to a custom next column; move arms never do.
    if (copiesPrompt && !CODED_IDS.includes(nextCol)) return plainEntries();

    if (visibleCoderColumns().length === 0) return [];   // backend errors out; no revert delta exists

    const oneContainer = coderLanesShareOneContainer();
    const entries = [];
    ids.forEach(id => {
        const card = currentCards.find(c => (c.planId || c.sessionId) === id);
        const { target, certain } = predictComplexityRoutedColumn(card);
        if (!target) return;
        // The backend skips unscored plans entirely when the setting is off — moving
        // one here would strand it: pendingOptimisticMoves has no time-based eviction.
        if (!certain && !allowUnknownComplexityAutoMove) return;
        if (certain || oneContainer) entries.push({ id, targetColumn: target });
    });
    return entries;
}
```

> **Superseded:** the pre-improve `predictComplexityRoutedColumn` resolved the role inline as `if ((routingMapConfig.intern || []).includes(score)) role = 'intern'; else if ((routingMapConfig.coder || []).includes(score)) role = 'coder';` with `let role = 'lead'` as the base.
> **Reason:** `routingMapConfig` is a *display* default when no custom map is persisted, and it disagrees with the backend's real fallback (`scoreToRoutingRole`) at score 4 — coder in the webview, intern in the backend. The predictor would report `certain: true` on a wrong lane for every score-4 card on a stock install.
> **Replaced with:** `roleForComplexityScore(score)`, which uses the persisted map only when one has actually arrived (`routingMapIsCustom`) and otherwise mirrors `complexityScale.scoreToRoutingRole` verbatim.

> **Superseded:** the pre-improve `optimisticEntriesForAdvance(ids, column, nextCol)` treated every `PLAN REVIEWED` / `STAGING` (then `DISPATCH`) advance as complexity-routed, ignoring `nextCol` entirely.
> **Reason:** `promptSelected` (`:10007`) and `promptAll` (`:10116`) check `dispatchSpec?.source === 'custom-user'` **before** the complexity branch, so with a custom user column inserted after Planned they move the whole batch to `nextCol`. The prediction would send the card to a coder lane instead — a cross-container bounce, the one failure display-equivalence cannot hide.
> **Replaced with:** a `copiesPrompt` option that falls back to the plain per-card `nextCol` entries when the caller copies a prompt and `nextCol` is not a built-in coded lane. This also makes the custom-column advance move optimistically (correctly) instead of being suppressed.

### 2. `src/webview/kanban.html` — track whether a custom routing map has arrived (next to `routingMapConfig`, ~line 5256)

```js
let routingMapConfig = { lead: [7, 8, 9, 10], coder: [4, 5, 6], intern: [1, 2, 3] };
// The constant above is the routing-map MODAL's display default. The backend only
// applies a routing map when one is persisted (KanbanProvider._routingMapForScope
// returns null otherwise) and falls through to complexityScale.scoreToRoutingRole,
// which disagrees with it at score 4. Track whether a real map arrived so the
// optimistic-move predictor can mirror the correct source.
let routingMapIsCustom = false;
```

and at the existing `updateBoard` merge (`:8691-8694`):

```js
if (msg.routingConfig) {
    routingMapConfig = msg.routingConfig;
    routingMapIsCustom = true;
    updateRoutingMapButtonIndicator();
}
```

The local save path (`:10061-10093`, `saveRoutingMap`) must set `routingMapIsCustom = true` as well — it writes `routingMapConfig` from the modal and posts `updateRoutingConfig`, and the board's next push will confirm it.

### 3. `src/webview/kanban.html` — per-entry optimistic move (next to `moveCardsOptimistically`, ~line 6103)

```js
/**
 * Optimistic move with a per-card target. moveCardElements has always accepted
 * per-entry targets; only the shared-target wrapper above forced a whole batch
 * onto one column, which is what made mixed-complexity Planned batches opt out
 * of the optimistic move entirely.
 *
 * No `if (!targetBody) return` pre-check like moveCardsOptimistically's: with
 * per-entry targets there is no single container to test, and moveCardElements
 * already reports unplaceable ids through `unresolved`.
 */
function moveCardsOptimisticallyByEntry(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;

    // Before the model mutation, so each source column resolves from currentCards.
    const unresolved = moveCardElements(entries);

    entries.forEach(({ id, targetColumn }) => {
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === id);
        if (cardData) cardData.column = targetColumn;
    });

    lastBoardSignature = buildBoardSignature(currentCards);
    armOptimisticGuard(entries);

    if (unresolvedNeedsRender(unresolved)) {
        renderBoard(currentCards);
        lastBoardSignature = buildBoardSignature(currentCards);
    }
    updateDispatchToggleCount();
    updateDispatchViewInfo();
}

/** Highlight every distinct DOM container a per-card entry set lands in. */
function highlightOptimisticTargets(entries) {
    new Set(entries.map(e => resolveDisplayColumn(e.targetColumn) || resolveDomColumn(e.targetColumn)))
        .forEach(domCol => {
            const body = domCol ? document.getElementById('col-' + domCol) : null;
            if (!body) return;
            body.classList.add('highlight');
            body.addEventListener('animationend', () => body.classList.remove('highlight'), { once: true });
        });
}
```

`moveCardsOptimistically` (`:6075`) stays as-is. **Do not** rewrite it to delegate to `moveCardsOptimisticallyByEntry` — `dispatch-view-contract.test.js:80-92` slices its function body by brace matching and asserts the literal `updateDispatchToggleCount(` is inside it. (The slice keys on `'function moveCardsOptimistically('`, which does not substring-match the new `…ByEntry(` declaration, so no rename is required.)

### 4. `src/webview/kanban.html:6588-6673` — four column-header actions

Replace the identical gate in `moveSelected` (`:6594`), `moveAll` (`:6613`), `promptSelected` (`:6637`) and `promptAll` (`:6656`). Shown for `promptSelected`; `moveSelected`/`moveAll` pass `copiesPrompt: false`, and `moveAll`/`promptAll` use `getAllInColumn(column)`:

```js
case 'promptSelected': {
    const ids = getSelectedInColumn(column);
    if (ids.length === 0) return;
    // Per-card targets: a Planned batch is complexity-routed per card by the
    // backend, which used to mean NO optimistic move at all. Each card now gets
    // its own predicted target, and uncertain routes are only moved when every
    // coder lane shares one container (see optimisticEntriesForAdvance).
    const entries = optimisticEntriesForAdvance(ids, column, nextCol, { copiesPrompt: true });
    if (entries.length) {
        highlightOptimisticTargets(entries);
        moveCardsOptimisticallyByEntry(entries);
    }
    postKanbanMessage({ type: 'promptSelected', column: backendColumn, sessionIds: ids });
    ids.forEach(id => selectedCards.delete(id));
    break;
}
```

Note `column` on this path is the DOM column id (`def.id`), so it is `'PLAN REVIEWED'` even in Dispatch view; `getSelectedInColumn` / `getAllInColumn` read `col-PLAN REVIEWED`, which holds the DISPATCH cards there.

### 5. `src/webview/kanban.html:7509-7540` — `runCopyPrompt`

Replace the whole suppression block with the shared predictor:

```js
// PLAN REVIEWED / DISPATCH advances are complexity-routed by the BACKEND
// (_partitionByComplexityRoute). Predict the lane; move whenever the prediction
// is exact OR every visible coder lane renders into one container, in which case
// a wrong lane cannot be seen. Only a genuinely ambiguous route (expanded coder
// lanes + unusable score) declines the move.
if (column === 'PLAN REVIEWED' || column === 'STAGING') {
    const entries = optimisticEntriesForAdvance([sessionId], column, nextCol, { copiesPrompt: true });
    nextCol = entries.length ? entries[0].targetColumn : null;
}
```

The existing `if (nextCol) { …highlight…; moveCardsOptimistically([sessionId], column, nextCol); }` block below (`:7542-7550`) is unchanged, and so is the `postKanbanMessage({ type: 'promptSelected', … })` that follows (`:7553-7558`) — the backend contract does not move.

> **Superseded:** the pre-improve replacement kept the flag on the condition — `if ((column === 'PLAN REVIEWED' || column === 'DISPATCH') && dynamicComplexityRoutingEnabled) { … }`.
> **Reason:** it contradicts this plan's own `dynamicComplexityRoutingEnabled === false` edge case. With the flag off the block is skipped, so `nextCol` stays at `getNextColumn('PLAN REVIEWED')` — the next *listed* column, which is not necessarily `LEAD CODED` (a hidden-but-occupied lane still sits in `columns`, and a custom column can sit there too), while the backend routes everything to `lead`. `predictComplexityRoutedColumn` already handles the flag-off case correctly on its first line, so the call site must not second-guess it.
> **Replaced with:** the unconditional source-column test above.

### 6. `src/services/KanbanProvider.ts` — give the prompt arms a failure channel

`promptSelected` (`:10052-10057`) and `promptAll` (`:10162-10166`) call bare `moveCardToColumn` and discard the result, so a failed write produces no `moveCardsFailed`. With this plan's optimistic move in place, that leaves the card overlaid into the predicted column on every subsequent `updateBoard` — permanently, because `pendingOptimisticMoves` has no time-based eviction (`kanban.html:5072-5087`).

Mirror the block already in `moveSelected` (`:9674-9691`) verbatim. For `promptSelected`:

```ts
const movedSids: string[] = [];
const failures: { id: string; sourceColumn: string; reason: string }[] = [];
for (const sid of sids) {
    const outcome = await this.moveCardToColumnWithReason(workspaceRoot, sid, targetCol);
    if (outcome.ok) {
        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
        const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
        movedSids.push(...cascadeIds);
    } else {
        failures.push({ id: sid, sourceColumn: 'PLAN REVIEWED', reason: outcome.detail });
    }
}
if (movedSids.length > 0) {
    this.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
}
if (failures.length > 0) {
    this.postMessage({ type: 'moveCardsFailed', failures });
}
```

Apply the same shape to `promptAll`'s loop, preserving its existing run-sheet write. **Keep the `moveCards` post ahead of the trailing `copyPlanLinkResult` posts** in both arms — `kanban-card-button-drag-guard.test.js:99-105` asserts that the *last* `type: 'moveCards'` in the `promptSelected` arm precedes the last `type: 'copyPlanLinkResult'`, over a fixed 8000-character slice from `case 'promptSelected':`.

> **Superseded:** "No backend, schema, verb-allowlist, DB or persisted-state change. Webview-only, so no migration concern."
> **Reason:** the plan's own edge-case table promises "Backend refuses the move → `moveCardsFailed` reverts per-card". That is true for `moveSelected`/`moveAll` and **false** for the two prompt arms this plan is actually fixing — they never emit the delta. Introducing an optimistic move on a path with no revert channel converts a transient DB failure into a permanently mis-rendered card.
> **Replaced with:** one backend change — `moveCardToColumnWithReason` + a `moveCardsFailed` post in `promptSelected` and `promptAll`, copied from the block already in `moveSelected`. Still no schema, verb-allowlist, settings or persisted-state change, so there is still nothing to migrate.

### 7. `src/test/kanban-optimistic-advance-contract.test.js` — new source-text contract

Mirrors the house pattern (`kanban-render-guard-contract.test.js`, `dispatch-view-contract.test.js`): slice function bodies out of `kanban.html` and assert the properties that a future "simplification" would silently drop.

```js
// 1. The regression itself: no call site may gate an optimistic move on the
//    source column being PLAN REVIEWED.
assert.strictEqual(
    /if\s*\(nextCol\s*&&\s*column\s*!==\s*'PLAN REVIEWED'\)/.test(kanbanHtml),
    false,
    "the `column !== 'PLAN REVIEWED'` optimistic-move gate is the 3a1030ee regression — Planned batches must use per-card targets"
);

// 1b. POSITIVE counterpart. Assertion 1 alone is satisfied by deleting the gates
//     and moving nothing — the exact failure this plan exists to prevent.
for (const action of ['moveSelected', 'moveAll', 'promptSelected', 'promptAll']) {
    const arm = caseBody(kanbanHtml, `case '${action}': {`);
    assert.strictEqual(arm.includes('optimisticEntriesForAdvance('), true,
        `${action} must build per-card optimistic entries`);
    assert.strictEqual(arm.includes('moveCardsOptimisticallyByEntry('), true,
        `${action} must perform the per-entry optimistic move`);
    assert.strictEqual(/copiesPrompt:\s*(true|false)/.test(arm), true,
        `${action} must declare copiesPrompt — the prompt and move backend families diverge on a custom nextCol`);
}

// 2. Pair mode narrows a role, it does not suppress a move.
const predictBody = functionBody(kanbanHtml, 'function predictComplexityRoutedColumn(');
assert.strictEqual(/pairModeActive\s*&&\s*role\s*===\s*'intern'/.test(predictBody), true,
    'pair-programming must mirror the backend intern→coder bypass (KanbanProvider.resolveRoutedRole)');
assert.strictEqual(/nextCol\s*=\s*null/.test(predictBody), false,
    'the predictor must return a target + certainty, never suppress');
assert.strictEqual(/dynamicComplexityRoutingEnabled/.test(predictBody), true,
    'the predictor owns the routing-disabled case (backend returns lead for everything)');

// 2b. The routing-disabled case must NOT be re-gated at the call site.
assert.strictEqual(
    /column === 'STAGING'\)\s*&&\s*dynamicComplexityRoutingEnabled/.test(kanbanHtml),
    false,
    'runCopyPrompt must not gate the predictor on dynamicComplexityRoutingEnabled — the predictor handles it'
);
// NOTE: this regex MUST name STAGING, not the retired DISPATCH. `kanban.html` has zero
// 'DISPATCH' occurrences at HEAD, so a DISPATCH-spelled negative assertion passes
// vacuously — green whether or not the defect it guards against is present.

// 3. Lane visibility comes from lastVisibleAgents, not `columns`
//    (_filterDynamicColumns keeps a hidden column while it holds cards).
const lanesBody = functionBody(kanbanHtml, 'function visibleCoderColumns(');
assert.strictEqual(lanesBody.includes('lastVisibleAgents'), true,
    'lane visibility must read lastVisibleAgents');
assert.strictEqual(/columns\.includes|columnDefinitions/.test(lanesBody), false,
    '`columns`/`columnDefinitions` over-report visibility — _filterDynamicColumns keeps occupied hidden columns');

// 4. The two backend refusals must be honoured, or the card strands
//    (pendingOptimisticMoves has no time-based eviction).
const entriesBody = functionBody(kanbanHtml, 'function optimisticEntriesForAdvance(');
assert.strictEqual(entriesBody.includes('allowUnknownComplexityAutoMove'), true,
    'unscored cards must not move when the backend will skip them');
assert.strictEqual(entriesBody.includes('visibleCoderColumns().length === 0'), true,
    'no visible coder lane means the backend errors with no moveCardsFailed to revert against');
assert.strictEqual(/copiesPrompt\s*&&\s*!CODED_IDS\.includes\(nextCol\)/.test(entriesBody), true,
    'the prompt arms defer a custom-user nextCol to the plain path (KanbanProvider promptSelected:10007)');

// 5. Score→role mirrors the backend's DEFAULT, not the modal's display constant.
//    scoreToRoutingRole is 1-4 intern / 5-6 coder; routingMapConfig's default puts 4 on coder.
const roleBody = functionBody(kanbanHtml, 'function roleForComplexityScore(');
assert.strictEqual(roleBody.includes('routingMapIsCustom'), true,
    'the persisted map applies only when one has actually been pushed');
assert.strictEqual(/score\s*>=\s*1\s*&&\s*score\s*<=\s*4/.test(roleBody), true,
    'the no-custom-map fallback must mirror complexityScale.scoreToRoutingRole (1-4 → intern)');
assert.strictEqual(roleBody.indexOf('intern') < roleBody.indexOf('coder'), true,
    'role resolution order must be intern → coder → lead (KanbanProvider.resolveRoutedRole:1410-1417)');

// 6. Tie-break parity with _validateOrDegradeCodingColumn (ties to the lower index).
const degradeBody = functionBody(kanbanHtml, 'function degradeToVisibleCoderColumn(');
assert.strictEqual(/dist\s*<\s*bestDist/.test(degradeBody), true,
    'strict < reproduces the backend tie-break; <= inverts it');

// 7. The dispatch-view contract's literal still holds after the refactor.
assert.strictEqual(
    functionBody(kanbanHtml, 'function moveCardsOptimistically(').includes('updateDispatchToggleCount('),
    true, 'moveCardsOptimistically must keep the literal call (dispatch-view-contract.test.js pins it)');

// 8. Both prompt arms emit a revert channel, or an optimistic move can strand
//    (pendingOptimisticMoves is cleared only by moveCards/moveCardsFailed/updateColumns).
for (const arm of ["case 'promptSelected': {", "case 'promptAll': {"]) {
    const body = caseBody(kanbanProvider, arm);
    assert.strictEqual(body.includes('moveCardToColumnWithReason'), true,
        `${arm} must use moveCardToColumnWithReason so a failed write is observable`);
    assert.strictEqual(body.includes("type: 'moveCardsFailed'"), true,
        `${arm} must post moveCardsFailed — the webview has no other way to revert an optimistic move`);
}
```

`functionBody` is copied from `dispatch-view-contract.test.js:15-30`; `caseBody` is the same brace-matcher seeded on a `case '<name>': {` declaration.

**Registration is two edits, not one:**
1. `package.json` — add `"test:contract:optimistic-advance": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/kanban-optimistic-advance-contract.test.js"` alongside `test:contract:render-guard` (`:867`) and `test:contract:dispatch-view` (`:869`).
2. `.github/workflows/integration-tests.yml` — add a step running that script, alongside the existing `npm run test:contract:render-guard` (`:278`) and `npm run test:contract:dispatch-view` (`:297`).

## Verification Plan

**Automated**

1. `node src/test/kanban-optimistic-advance-contract.test.js` — new; must fail at HEAD (assertion 1 hits the four live gates) and pass after the change.
2. `node src/test/dispatch-view-contract.test.js` — must stay green; it is the trap for refactoring `moveCardsOptimistically` into a delegator.
3. `node src/test/kanban-render-guard-contract.test.js` — must stay green; `moveCardsOptimisticallyByEntry` adds a second `armOptimisticGuard` caller, and this test pins that `optimisticMoveUntil = Date.now() +` appears exactly once (inside `armOptimisticGuard`, `:101-106`) and `optimisticMoveUntil = 0;` only twice (`:109-114`).
4. `node src/test/kanban-card-button-drag-guard.test.js` — must stay green; `runCopyPrompt` keeps its name and its pointerdown-stream binding, and the backend change must not move the last `moveCards` post after the last `copyPlanLinkResult` post inside the first 8000 characters of the `promptSelected` arm.
5. `node src/test/kanban-batch-prompt-regression.test.js` and `node src/test/kanban-coded-auto-prompt-mode-regression.test.js` — the two other suites that read the prompt/advance path; must stay green.

*(Per the dispatching directive this run skips `npm run compile` and skips executing the automated tests; the list above is the contract the implementer runs.)*

**UAT — build a VSIX, install it, and drive the real board** (`dist/` in the repo is not what runs)

6. **The headline case.** Coders collapsed (default AUTOCODE view). Click a Planned card's *Copy coder prompt*. The card must land in AUTOCODE **on the click**, with the drop pulse and the column highlight — no wait. The clipboard must still hold the coder prompt.
7. **Dispatch view.** Toggle DISPATCH on the Planned column, click a staged card's copy-prompt button. Same instant move. The staged count in the Dispatch header must decrement immediately (`updateDispatchViewInfo` runs inside the per-entry mover).
8. **Mixed batch.** Select three Planned cards with scores routing to three different lanes; use the column-header *Copy prompt for selected*. All three move instantly; when the backend deltas arrive there is no visible re-shuffle across columns.
9. **Expanded lanes, scored — the accuracy check.** Turn off Collapse Coders. Drive **one card per lane** (a score routing to lead, one to coder, one to intern). Each must land in its predicted lane instantly and stay there once the backend confirms. *This is the only UAT step that tests prediction accuracy at all — steps 6-8 and 12 pass even with a 100% wrong predictor, because collapsed view hides the lane.*
10. **Score 4 specifically, expanded lanes, no custom routing map.** Reset the routing map to default (or use a fresh profile). A card scored **4** must land in **Intern**, not Coder — and must not bounce when the backend confirms.
11. **Expanded lanes, unscored.** Same view, a card with `Complexity: Unknown`. No optimistic move (documented behaviour) — the prompt still copies and the card advances when the backend confirms. It must **not** flicker into a lane and back.
12. **Unknown-complexity guard.** Setup → turn *Include plans with unknown complexity in batch moves* **off**. An unscored Planned card must not move optimistically, and the status message must still report it as skipped.
13. **Pair-programming mode.** Set pair mode to any non-off value, then copy-prompt a card whose score routes to `intern`. It must move immediately to the coder lane (collapsed: AUTOCODE) and stay there — no bounce when the backend's bypass lands.
14. **No coder agent.** Hide lead, coder and intern in Setup. Copy-prompt a Planned card: no optimistic move, and the existing "No coding agent is currently enabled" error appears. The card must remain in Planned.
15. **Custom column after Planned.** Add a custom user column immediately after Planned. (a) *Copy prompt* on a Planned card must move it instantly into the **custom column** (matching `promptSelected`'s custom-user branch). (b) *Move selected* on the same card must move it into the **coder lane** (matching `moveSelected`, which complexity-routes regardless). Neither may bounce.
16. **Failure channel.** With the backend change in, force a move failure (e.g. delete the plan's DB row out from under the board, or point the workspace at a read-only DB) and copy-prompt the card. It must visibly revert to Planned with the "not advanced" status message — not sit in the coder lane.
17. **Regression sweep on the unaffected columns.** Copy-prompt from New, Reviewed and Acceptance Tested still move instantly and land in the right column — the shared `optimisticEntriesForAdvance` short-circuit must not disturb the non-routed path.

---

**Recommendation: Send to Coder** (complexity 6).
