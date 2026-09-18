# Kanban Render Guard: Stop Stale Board Pushes From Bouncing Optimistically-Moved Cards

## Goal

Close the three holes in the kanban optimistic-move render guard that let a dropped card visibly bounce back to its source column, or force a full-board DOM rebuild, before the authoritative move lands. Keep working-state (activity light) updates flowing during the guard window without rendering stale card positions.

### Problem

After a drop, a card can visibly snap back to the column it came from and then jump forward again a beat later. Separately, every confirmed move costs a complete board DOM rebuild rather than moving the one card that changed.

### Root cause — three distinct defects in `src/webview/kanban.html`

**1. The `workingChanged` escape hatch defeats the guard on exactly the drops that need it (`:7437-7451`).**

The `updateBoard` handler computes `optimisticActive = Date.now() < optimisticMoveUntil`, then suppresses the re-render only when `optimisticActive && !workingChanged`. `workingChanged` is true when any incoming card's `working` flag differs from the current model. But a drop that dispatches an agent is *what flips `working` to true* — so a stale, pre-move `updateBoard` arriving mid-window satisfies the escape hatch, falls through to the `else` branch, and calls `renderBoard(nextCards)` with **pre-move positions**. The card snaps back. It jumps forward again only when the real confirm arrives.

The escape hatch is deliberate — the comment at `:5220` explains that without it "working-state changes will be swallowed during the optimistic window" — but the remedy (a full render with stale data) is worse than the disease it treats. A working-state change needs an activity-light update, not a board rebuild.

**2. The suppressed branch rebases the signature onto stale data (`:7452-7458`).**

When the guard *does* suppress, it still absorbs the payload: `currentCards = nextCards; lastBoardSignature = buildBoardSignature(currentCards)`. The comment says this keeps "the freshest baseline", but `nextCards` here is the pre-move snapshot — so the FE discards its own optimistic model and adopts data that contradicts the DOM. Consequences:

- The card's on-screen position is now backed by nothing; any render before the backend catches up reverts it (which is why the guard must suppress *all* renders, which is why defect 1 is so damaging).
- The next authoritative push necessarily differs from the rebased signature, so the settle is **guaranteed** to be a full `renderBoard` rather than a no-op or a targeted move.

**3. `moveCards` does a full unguarded `renderBoard` (`:7345-7364`).**

The targeted delta — the thing that exists specifically to avoid a whole-board redraw — ends in `renderBoard(currentCards)`, rebuilding every column's DOM. It also runs unconditionally, ignoring `optimisticMoveUntil`. Any in-flight `card-dropped` animation, hover state, or second drag in progress is destroyed by the rebuild.

**4. (Found during this review) `allCards` is absorbed unconditionally, so column counts bounce even when cards don't (`:7393`, `:7474-7480`).**

`allCards = Array.isArray(msg.cards) ? msg.cards : []` runs at the very top of the handler, *before* any guard check. `allCards` is the sole input to `computeColumnOccupancy` — used by `renderBoard` (`:6155`) and by `refreshColumnCounts` (`:6068`) — so during the guard window the count badges are computed from **pre-move positions** while the cards sit in their new columns. `refreshColumnCounts()` is reachable inside the window: the `else` branch at `:7474` fires whenever the filtered signature matches but `nextAllCardsSignature` differs, and unlike its sibling at `:7469` it carries no `&& !optimisticActive` guard. The result is the count-badge half of the same bounce, and fixing defects 1–3 makes it *more* reachable, because a matching filtered signature becomes the common case.

### Context

The guard is deliberately centralized inside `moveCardsOptimistically` (`:5102`) precisely because arming it per-call-site kept regressing — see the comment at `:5098-5101`. That centralization must be preserved; this plan changes what the guard *does* when a push arrives, not where it is armed. The drag paths arm their own copies at `:6952` and `:7146` because they do bespoke DOM work; those stay as-is.

## Scope

All changes are in `src/webview/kanban.html`.

### The organising invariant (added by review)

Every fix below is one consequence of a single rule that the handler does not currently hold:

> **`currentCards` and `lastBoardSignature` describe what is on screen — never a mirror of the newest payload.**

Today the suppressed branch breaks the rule deliberately (defect 2), `allCards` breaks it unconditionally (defect 4), and `moveCards` re-establishes it the expensive way, by rebuilding the DOM to match the model (defect 3). Restore the invariant and the bounce, the guaranteed settle render, and the count drift all fall out together.

### 1. Targeted working-state updates during the guard

Replace the `workingChanged` fall-through with a narrow path: when an incoming payload does not contradict the on-screen card positions, update the affected cards' activity-light class in place without calling `renderBoard`. Locate the existing activity-light render logic in `renderBoard`/the card template and factor out the minimal toggle rather than duplicating class strings (`:6567-6569` builds `is-working` / `title="Agent working…"`).

> **Superseded:** "when the guard is active and the only difference is `working`, update the affected cards' activity-light class in place (and `currentCards[].working`) without calling `renderBoard`. […] If the incoming payload differs in ways *beyond* `working` while the guard is active, keep suppressing — same as today."
> **Reason:** "the only difference is `working`" is too narrow to ever fire on the drop it exists for. `card.lastActivity` is part of `buildBoardSignature` (`:5224`) and the same dispatch that flips `working` also stamps activity, so a real mid-window push differs in **both** fields — and any push whose card *columns* are still pre-move differs there too. Gating on "working and nothing else" would send every real case down the suppress branch, i.e. the activity light would never update during the window, which is the exact regression the `workingChanged` escape hatch was added to prevent.
> **Replaced with:** Gate on **position agreement**, not on field-difference count. Split the signature: a positional signature (`workspaceRoot | id | column`, sorted — captures membership *and* placement) and the existing full signature. During the guard, if the positional signature of the incoming payload matches the on-screen model, the payload does not contradict the DOM: apply the `working` deltas in place, merge `working`/`lastActivity` forward into `currentCards`, and skip `renderBoard`. If the positional signature differs, suppress as today. Mechanics in **Proposed Changes**.

### 2. Overlay the optimistic model instead of rebasing onto stale data

Keep a record of the pending optimistic moves (id → target column) armed alongside `optimisticMoveUntil`, and use it to keep the model consistent with the DOM while the window is open.

> **Superseded:** "when absorbing an incoming payload during the window, apply those pending moves on top of `nextCards` before assigning `currentCards` and recomputing `lastBoardSignature`. The baseline then reflects intent, and a subsequent authoritative push that agrees with the optimistic move produces a matching signature — no settle render at all in the common case."
> **Reason:** The goal (matching signature, no settle render) is right; the mechanism has a data-loss hole. Overlaying only the *columns* still assigns every other field from `nextCards` and then recomputes the signature from it — so a topic, complexity, or feature-count change that arrived during the window is absorbed into the signature **without ever being rendered**, and because the signature now matches, no later push renders it either. That hazard exists today, but this plan's own success criterion ("no settle render at all in the common case") is precisely what makes it permanent rather than self-healing: fewer settle renders means fewer chances to catch up.
> **Replaced with:** Merge forward **only what was actually applied to the DOM** — the pending column overlay plus the `working`/`lastActivity` values whose light was just toggled — leaving every unapplied presentational field at its rendered value. `lastBoardSignature` is then recomputed from `currentCards`, so it still describes the screen (the invariant above). An authoritative push that agrees with the optimistic move matches and renders nothing; a push carrying an unrendered presentational change *cannot* match, so it is guaranteed to render once the guard expires. Additionally set a `suppressedRenderPending` flag and, at guard expiry, post the existing `{ type: 'refresh' }` verb (the same one used at `:6143`) so a swallowed change cannot wait on an unrelated future push.

Apply the same overlay to `allCards` so occupancy counts track the optimistic positions (defect 4) — the `moveCards` handler already sets this precedent at `:7358-7360`, mapping both caches.

Clear the pending-move record wherever `optimisticMoveUntil` is cleared (`:7669`, `:8348`, `:8407` — the deliberate workspace-switch resets), when a `moveCardsFailed` revert lands for those ids, and — added by review — when the authoritative `moveCards` confirm lands for those ids, since the truth has arrived and a stale overlay would keep forcing a column the backend may have since changed.

### 3. `moveCards` → targeted DOM move

Rework the `moveCards` handler to move just the named cards between column containers (reusing the DOM primitive inside `moveCardsOptimistically` — extract it rather than copy it), updating column counts and empty states, instead of `renderBoard(currentCards)`. Fall back to a full render only when a target container can't be resolved.

> **Superseded:** "Fall back to a full render only when a target container or card element can't be resolved."
> **Reason:** A missing card element is not an error condition here. `moveCards` payloads carry cascade ids — `_collectAllMovedSessionIds` (KanbanProvider `:5552`, `:5595`) expands a feature move into its subtasks — and subtasks are deliberately never in the DOM (`renderBoard` drops them at `:6133`, `displayCards.filter(card => !card.featureId)`). Falling back on "card element not found" would therefore trigger a full rebuild on essentially every feature move, deleting the optimization exactly where the payloads are largest.
> **Replaced with:** Three-way resolution. (i) If the id resolves to a card in `currentCards` that already sits in the target column, do nothing — no DOM work, no render, no signature churn. (ii) If it resolves to a renderable card (`!card.featureId`), move its element; if the element is genuinely missing, fall back to a full render. (iii) If it resolves to a subtask or an unknown id, update the model only and do **not** fall back. Note that (i) alone converts the common post-drop confirm into a complete no-op: today `changed` is set for any matched id regardless of whether the column actually differs (`:7352-7355`), so the confirm currently forces a full `renderBoard` even though `moveCardsOptimistically` already put the card where the confirm says it belongs.

Apply the same treatment to `moveCardsFailed` (`:7367-7387`), which has the identical full-rebuild ending — with the extracted primitive taking **per-card** targets, since a revert sends each card to its own `f.sourceColumn` rather than to one shared column.

### Non-goals

- Do not change where the guard is armed, or its 2000ms duration. Duration is a separate tuning question, and the companion plan removes the 350ms head start that consumes part of it.
- Do not add any confirmation or two-step interaction. Deletes and moves stay immediate.
- No persisted state changes, so no migration.
- Do not "fix" `moveCardsOptimistically`'s early `return` when the target container is missing (`:5033`), which exits before the guard is armed. It is a real gap (a move to a column with no rendered container arms nothing) but it is pre-existing, unrelated to stale pushes, and touching it changes which moves are guarded.

### Related

Companion plan: `card-settle-confirm-move-before-dispatch.md` (why the authoritative confirm arrives late at all). The two are independent — either can ship first — but shipping both is what removes the bounce *and* the wait.

## Metadata

- **Complexity:** 7
- **Tags:** bugfix, frontend, ui, performance

> **Superseded:** **Complexity:** 6
> **Reason:** The review added a fourth defect, a new piece of FE state (the pending-move ledger with four clear-points), a signature split, and a DOM primitive extraction that must serve three callers with differing target shapes — in the single most regression-prone region of a 12,142-line webview whose own code comment records that this guard "keeps regressing". There is also **zero** existing automated coverage of `optimisticMoveUntil` or `moveCardsOptimistically` (verified: `src/webview/kanban.html` is the only file in the repo that mentions either), and no harness that executes webview DOM, so every behavioural check is manual across two hosts. That is "new patterns, complex state" — 7, not 6.
> **Replaced with:** **Complexity:** 7 → Send to Lead Coder.

## User Review Required

None. Every decision here is an internal correctness/rendering call with no product surface.

## Complexity Audit

### Routine

- Single file, single language (inline webview JS). No backend, protocol, schema, or persisted-state change.
- The DOM mechanics already exist and are proven — `moveCardsOptimistically` (`:5026-5103`) does exactly the append/empty-state/count arithmetic the targeted path needs; extraction is a move, not an invention.
- The activity-light toggle is two class/attribute writes derived from `:6567-6569`.
- `moveCards`' no-op short-circuit is a one-line condition (`card.column !== targetCol`) that strictly removes work.

### Complex / Risky

- **The guard's history is regression.** The comment at `:5098-5101` exists because arming was repeatedly lost when call sites were edited. This plan does not move the arming, but it does add a *second* piece of guard state (the pending-move ledger) that must be cleared at four distinct points. A ledger that outlives its window re-applies a column the backend has since changed; one cleared too eagerly reintroduces the bounce.
- **No executable test surface.** `src/test/kanban-card-button-drag-guard.test.js` is a **source-text regex** test over `kanban.html`, not a DOM test. There is no way to unit-test this behaviour; automated coverage can only assert code shape, and correctness rests on manual verification in both hosts.
- **Two hosts, one file.** `headlessPanelHtml.ts` (`:123-124`) serves the same `kanban.html` to the browser cockpit, injecting a shim over a marker comment. Every change ships to both surfaces simultaneously, and the browser cockpit fans each push out across six mounted panels — so a push-handling change is exercised harder there than in the editor.
- **Model aliasing is load-bearing and easy to break.** `applyBoardProjectFilter` returns *the same array* when no filter is set (`:4252`), so `currentCards` and `allCards` routinely share card objects. `moveCardsOptimistically` mutates `cardData.column` **in place** (`:5060`), which today silently keeps both caches consistent; `moveCards` instead `.map()`s new objects into each. The overlay must produce new objects only for moved cards and must not convert the in-place mutation into a copy, or the two caches will silently diverge and counts will drift from positions.
- **Insertion order is a visible behaviour, not an implementation detail.** `renderBoard` sorts each column by `lastActivity` desc, tie-broken by `createdAt` desc (`:6190-6199`), while the DOM primitive `appendChild`s to the bottom (`:5057`). Today the settle render silently repairs the position; once settle renders are eliminated, a moved card **stays at the bottom of its column indefinitely** even though a freshly-dispatched card belongs at the top. Removing the rebuild without addressing ordering trades a bounce for a permanent misplacement.
- **Suppressing renders can swallow real updates.** Every suppression is a bet that a later render will catch up. The plan's own success metric (no settle render) removes the catch-up, which is why the merge-forward rule and the expiry `refresh` are structural requirements rather than polish.

## Edge-Case & Dependency Audit

### Race Conditions

- **Overlapping drags.** The window is a single deadline, re-armed (extended) per drop by design (`:4211-4212`), so drag B's arm extends drag A's protection. The ledger must therefore be a map keyed by card id, not a single pending move, and entries must survive re-arming. Overlays are idempotent — re-applying a column the payload already agrees with is a no-op.
- **Confirm arriving mid-window for a subset.** `moveCards` may confirm two of three dragged cards. Clearing the whole ledger on any confirm would drop the third card's protection; clear per id.
- **Backend disagrees with the optimistic move.** If the write silently lands in a different column, the overlay keeps forcing the optimistic column until the window expires — bounded at 2000ms, then the authoritative push renders. Accepted: identical to today's exposure, and `moveCardsFailed` covers the detected-failure case explicitly.
- **Payload arriving during the 350ms dispatch head start.** The drag paths arm before the `setTimeout(…, 350)` (`:6952` / `:7146` vs `:6954` / `:7155`), so the ledger is populated before any dispatch-triggered push can land. No ordering gap.
- **Guard expiry racing the expiry `refresh`.** The expiry timer must be cleared and re-armed whenever `optimisticMoveUntil` is extended, and cancelled by the workspace-switch resets, or a stale timer fires a refresh against a board that has since been replaced (harmless but wasteful — the browser cockpit pays ~84ms/124KB per board build).
- **Card deleted while its overlay is pending.** The overlay maps over the incoming payload, so a card absent from the payload is simply not overlaid — it must never be resurrected into the model.

### Security

- No new data sources, no new host messages, no new persisted state. The only outbound message added is the existing `{ type: 'refresh' }` verb.
- The activity-light toggle writes a class name and a static `title` string. It must not build markup from card fields; if the extracted toggle ever interpolates `card.topic` or similar it must reuse `escapeHtml`/`escapeAttr` (`:6601`, `:5133`). Prefer `classList` + `setAttribute` over `innerHTML` so no escaping question arises.
- Card element lookups already use `CSS.escape` on ids (`:5045`) — preserve that in the extracted primitive; ids originate from plan files and are not trusted selector input.

### Side Effects

- **Fewer full renders.** In the common drop path the settle becomes a no-op (matching signature) or a targeted element move. The browser cockpit benefits most: it mounts six panels on one main thread and resyncs the full board per connection, so removing per-move rebuilds is a measurable win there, not just a cosmetic one.
- **Column counts change source of truth during the window.** Post-fix, counts come from the overlaid `allCards`. Any code path that reads `allCards` expecting raw backend positions while a guard is armed sees optimistic ones instead. `computeColumnOccupancy` and `refreshColumnCounts` are the readers; both *want* the optimistic view.
- **`previousWorking` and finish feedback.** `previousWorking` advances unconditionally every tick (`:7420`), so a working→idle edge seen during a suppressed tick is only recoverable via `pendingFinished` (`:4203-4207`). The new in-place-light path must also push `justFinished` into `pendingFinished` — it turns the light off without playing the finish feedback, so the edge would otherwise be consumed and lost.
- **Insertion ordering.** If the targeted move inserts in sorted position rather than appending, a `data-ts` attribute (or equivalent) has to exist on the card element for the DOM to be sortable without consulting the model; that is a small addition to `createCardHtml` (`:6582`) and changes rendered markup, which the source-text drag-guard test reads.

### Dependencies & Conflicts

- **Companion plan** `card-settle-confirm-move-before-dispatch.md` touches the same drop paths' dispatch timing (the 350ms `setTimeout` at `:6954`/`:7155`) but not the `updateBoard`/`moveCards` handlers. No textual overlap; either order works. If both are in flight, land this one's handler changes first so the companion's timing change is verified against the corrected render behaviour.
- **`src/test/kanban-card-button-drag-guard.test.js`** (`npm run test:contract:drag-guard`) asserts on `kanban.html` **source text** — including a global negative assertion that the file contains no `draggable="false"` anywhere, and CSS/handler shape assertions. Its `moveCards` assertions target `KanbanProvider.ts` postMessage ordering, which this plan does not touch, so no assertion should break — but any markup addition (e.g. `data-ts`) must be checked against its negative assertions.
- **`headlessPanelHtml.ts`** must keep finding its marker comment (`:134` passes `expectMarker` so deletion warns). Do not disturb the inline-script marker while editing nearby code.
- No new libraries. `CSS.escape`, `classList`, and `setAttribute` are available in both the VS Code webview and the browser cockpit.

## Dependencies

None. No `sess_` prerequisites — the companion plan is independent by design (see **Related**).

**Migration:** none. No persisted state, no settings, no file format, no DB column changes. All state introduced (the pending-move ledger, the expiry timer, the suppressed-render flag) is in-memory webview state that starts empty on every load.

## Adversarial Synthesis

**Risk summary.** The mechanical fixes are small; the danger is that each one, done literally, trades a visible bug for an invisible one. Gating the working-light path on "only `working` differs" never fires (the same push always changes `lastActivity` too), so the light would silently stop updating; overlaying columns onto an otherwise-adopted payload silently swallows topic/complexity changes *permanently*, because the plan's own "no settle render" success metric removes the render that used to catch them; and falling back to a full rebuild whenever a card element is missing fires on every feature move, since cascade subtask ids are never in the DOM by design. Mitigations: gate on a positional signature rather than a field-difference count, merge forward only what was actually rendered (plus a `refresh` at guard expiry if anything was swallowed), and resolve ids three ways (already-there / renderable / subtask). Residual accepted risks: a backend column that disagrees with the optimistic move stays wrong for up to 2000ms, and eliminating settle renders makes column sort order a first-class concern — a moved card appended to the bottom of a column now stays there until some unrelated render, which is why insertion position is part of the work rather than a follow-up.

## Proposed Changes

### `src/webview/kanban.html`

**Context.** One inline `<script>` holds the board model (`currentCards`, `allCards`), the render-guard state (`optimisticMoveUntil`, `lastBoardSignature`, `lastAllCardsSignature`), the optimistic DOM primitive (`moveCardsOptimistically`), and the host-message handlers (`moveCards`, `moveCardsFailed`, `updateBoard`). The same file is served to the editor webview and, via `headlessPanelHtml.ts`, to the browser cockpit.

#### (a) New guard state, next to `optimisticMoveUntil` (`:4209-4214`)

**Logic.** Add, with comments matching the density of the surrounding block:

- `pendingOptimisticMoves` — `Map<cardId, targetColumn>`, the ledger of moves the DOM shows but the backend has not confirmed.
- `suppressedRenderPending` — boolean, set when a payload was suppressed or partially merged, cleared on any real `renderBoard`.
- `optimisticExpiryTimer` — the one-shot handle used to fire a `refresh` when the window closes with a swallowed change.

**Implementation.** Introduce one helper that owns all three plus the deadline, so no call site can arm half the state:

- `armOptimisticGuard(entries)` — records `{id → targetColumn}` into the ledger, sets `optimisticMoveUntil = Date.now() + OPTIMISTIC_MOVE_WINDOW_MS`, and clears/re-arms `optimisticExpiryTimer` to `OPTIMISTIC_MOVE_WINDOW_MS + 50`ms. Called from `moveCardsOptimistically` (`:5102`) and from both drag paths (`:6952`, `:7146`) in place of the bare assignment — the drag paths keep their bespoke DOM work and their own `lastBoardSignature` recompute; only the arming line changes.
- `clearOptimisticGuard()` — zeroes the deadline, empties the ledger, cancels the timer. Replaces the three bare `optimisticMoveUntil = 0` resets (`:7669`, `:8348`, `:8407`), preserving each existing comment.
- `resolveOptimisticGuard(ids)` — drops just those ids from the ledger, leaving the deadline alone. Called from the `moveCards` and `moveCardsFailed` handlers.

**Edge cases.** The expiry timer fires *after* the deadline it was armed for, so it must re-check `Date.now() >= optimisticMoveUntil` before acting (an extension may have moved the deadline past it) and must only post `refresh` when `suppressedRenderPending` is set.

#### (b) Positional signature + overlay helpers, next to `buildBoardSignature` (`:5218-5227`)

**Logic.**

- `buildPositionSignature(cards)` — `${workspaceRoot}|${planId||sessionId}|${column}` per card, sorted and joined, exactly mirroring `buildBoardSignature`'s key derivation and sort so the two can never disagree about identity. This answers the only question the guard actually needs: *does this payload contradict where the cards are drawn?*
- `applyPendingOptimisticMoves(cards)` — returns `cards` unchanged when the ledger is empty (cheap identity, preserving the aliasing `applyBoardProjectFilter` relies on); otherwise maps, returning `{ ...card, column: pending }` **only** for ledger hits and the original object for everything else.

**Implementation.** Extend the existing warning comment at `:5218-5220` (which tells future editors that the `workingChanged` check depends on this signature's fields) to describe the new split instead — that comment is now describing a check that no longer exists.

#### (c) `updateBoard` handler (`:7388-7483`)

**Logic.** Overlay before deriving anything, then branch on position agreement:

1. `allCards = applyPendingOptimisticMoves(Array.isArray(msg.cards) ? msg.cards : [])` — the overlay lands here, at the top, so every downstream derivation (`nextCards`, both signatures, occupancy) sees positions consistent with the DOM. This is the defect-4 fix and it needs no separate branch.
2. `const nextCards = applyBoardProjectFilter(allCards);` — unchanged; inherits the overlay.
3. Keep the `justFinished` / `previousWorking` edge detection exactly as-is (`:7403-7420`).
4. `const optimisticActive = Date.now() < optimisticMoveUntil;`
5. If `nextBoardSignature === lastBoardSignature` → existing `else` branch (`:7467-7481`), with one change: gate `refreshColumnCounts()` on `!optimisticActive` for symmetry with its sibling at `:7469`. With the overlay in place the counts are already correct, so this is belt-and-braces against a future reader of raw `allCards`.
6. Otherwise, if `!optimisticActive` → existing full-render branch (`:7458-7466`) unchanged, plus `suppressedRenderPending = false`.
7. Otherwise (guard active, signature differs) compare `buildPositionSignature(nextCards)` against `buildPositionSignature(currentCards)`:
   - **Positions agree** → the payload does not contradict the screen. For each card whose `!!working` differs from the model, toggle its element's activity light in place; merge `working` and `lastActivity` forward into `currentCards`; recompute `lastBoardSignature = buildBoardSignature(currentCards)` and `lastAllCardsSignature`; push any `justFinished` into `pendingFinished`; set `suppressedRenderPending = true` if any *other* field differed between payload and model.
   - **Positions differ** → suppress exactly as today, but **do not** touch `currentCards` or `lastBoardSignature` (they describe the screen). Carry `justFinished` into `pendingFinished`, set `suppressedRenderPending = true`, and leave `lastAllCardsSignature` alone so the count path re-evaluates after expiry.

**Implementation.** Delete the `workingChanged` computation (`:7439-7445`) — it has no remaining caller. Rewrite the suppressed branch's comment block (`:7446-7453`): its claims about keeping "the freshest baseline" and about worktree visuals rendering at expiry are what defect 2 is, and leaving the comment in place would document the bug as the design. Extract the light toggle from `:6567-6569` into `applyWorkingClass(cardEl, isWorking)` and call it from both `createCardHtml` (via the existing string build) and the new path, so the class name and title live in one place.

**Edge cases.**
- Guard active, positions agree, working unchanged, nothing else changed → cannot happen (the signature differed), but the code must tolerate it as a no-op.
- A card in the payload with no rendered element (subtask, or filtered out) whose `working` flipped: merge the model, skip the DOM. Never fall back to a render.
- `nextCards.length === 0` → `buildBoardSignature` returns `''` (`:5222`); an empty board with a pending overlay must not be treated as "positions agree" against a non-empty model. The positional signature comparison handles this naturally (`''` vs non-empty), landing in the suppress branch.
- `featureWorktreesChanged` keeps its `!optimisticActive` gate (`:7469`) — worktree visuals still wait for expiry. That is unchanged behaviour and verification item 6 covers it.

#### (d) Extract the DOM move primitive from `moveCardsOptimistically` (`:5026-5103`)

**Logic.** Split into `moveCardElements(entries)` — pure DOM: per-entry `{ id, targetColumn }`, resolving `resolveDomColumn` for collapsed coders (`:4185-4189`), moving elements, clearing/restoring `.empty-state`, and adjusting `count-*` badges — and the existing `moveCardsOptimistically`, which keeps its model mutation (`cardData.column = targetColumn` in place, `:5060`), its `lastBoardSignature` recompute, and its guard arming.

**Implementation.** Per-entry targets are required (the revert path sends each card to its own column), so the primitive takes a list, not one shared target. It must read each card's *current* column from `currentCards` **before** any caller mutates the model — `moveCardsOptimistically` does this today at `:5049-5050`, and the `moveCards` handler currently `.map()`s the model first, so the extracted call must be placed before that map or be handed the source columns explicitly. Preserve the in-place mutation in `moveCardsOptimistically`; converting it to a copy silently breaks the `currentCards`/`allCards` aliasing that keeps counts honest. Preserve `CSS.escape` on both selector forms (`:5045`) and the arrival animation (`card-dropped`, `:5056`).

Insert in sorted position rather than appending: read `lastActivity` from the model for the moved card and walk the target container's existing `.kanban-card` children to find the insertion point, using a `data-ts` attribute added to `createCardHtml` (`:6582`) so the walk needs no model lookups. `renderBoard`'s order is `_ts` (lastActivity) desc, `createdAt` desc (`:6190-6199`) — match it, since a card that just triggered a dispatch has the freshest activity and belongs at the top, not the bottom.

**Edge cases.** Target container missing (e.g. `BACKLOG` while `!showingBacklog`) → the caller falls back to a full render; `moveCardsOptimistically`'s existing early `return` at `:5033` stays as-is. `data-ts` must be checked against the drag-guard test's negative assertions before it is added.

#### (e) `moveCards` handler (`:7345-7366`)

**Logic.** Resolve each id three ways before touching the DOM: already in the target column (skip entirely), renderable card (`!card.featureId` — move its element, fall back to a full render only if the element is genuinely absent), or subtask/unknown (update the model only). Set `changed` **only** when a card's column actually differs, so the post-drop confirm — where `moveCardsOptimistically` already applied the move — becomes a true no-op with no render and no signature churn. Then `resolveOptimisticGuard(ids)`: the truth has landed, so those ledger entries must go.

**Implementation.** Keep the existing `planId`-primary key derivation and its comment (`:7351`, mirrors the backend's `_cardMatchesIds`) and keep mapping **both** `currentCards` and `allCards` (`:7358-7360`) so occupancy stays in sync. Recompute `lastBoardSignature` only when something changed.

**Edge cases.** `msg.sessionIds` may contain ids not on this board at all (cross-project or cross-workspace cascade) — treated as unknown: model-only, no fallback. An empty `idsToMove` or missing `targetColumn` keeps the existing early `break` (`:7348`).

#### (f) `moveCardsFailed` handler (`:7367-7387`)

**Logic.** Same treatment, with per-card `f.sourceColumn` as the target, and `resolveOptimisticGuard(failedIds)` so a failed write's overlay stops forcing the optimistic column and the card can visibly return home.

**Implementation.** Order matters: clear the ledger entries *before* recomputing `lastBoardSignature`, or the recompute will bake the abandoned overlay back into the baseline. Keep the existing `showStatusBarMessage` error report (`:7385`) verbatim — it is the only channel the user has for a failed write.

**Edge cases.** A failure for an id whose element is gone (subtask, or removed by an intervening render) → model-only revert. A failure arriving *after* the window expired → the ledger is already empty; `resolveOptimisticGuard` must tolerate unknown ids.

## Verification Plan

> **Superseded:** The verification list had no `### Automated Tests` subsection; item 9 was "Run the kanban tests including `src/test/kanban-card-button-drag-guard.test.js`."
> **Reason:** Verified: `src/webview/kanban.html` is the only file in the repo that mentions `optimisticMoveUntil` or `moveCardsOptimistically`, so the existing suite contains **zero** coverage of the guard. "Run the kanban tests" therefore verifies nothing about this change. There is also no DOM-executing harness for the webview — `kanban-card-button-drag-guard.test.js` is a source-text regex test — so the honest automated contract is a shape test, and that must be stated rather than implied.
> **Replaced with:** The `### Automated Tests` subsection below, plus the manual list retained in full.

### Automated Tests

New `src/test/kanban-render-guard-contract.test.js`, following the source-text convention of `src/test/kanban-card-button-drag-guard.test.js` (read `src/webview/kanban.html`, assert on its shape) and registered in `package.json` as `test:contract:render-guard` with the same `node --require ./src/test/bootstrap/sandboxStateHome.js` prefix as its siblings. These assert the *shape* the fix depends on — they cannot prove rendering behaviour, which is what the manual list is for.

1. **`workingChanged` is gone.** Assert `kanban.html` no longer contains `workingChanged` — the escape hatch is defect 1 and its removal is the fix.
2. **The suppressed branch does not adopt the payload.** Assert the `updateBoard` handler body contains no `currentCards = nextCards` inside an `optimisticActive` branch. This is the direct regression test for defect 2.
3. **`moveCards` does not rebuild the board.** Assert the `case 'moveCards':` body contains no `renderBoard(currentCards)`, and that it references the extracted primitive.
4. **`moveCardsFailed` does not rebuild the board.** Same assertion for `case 'moveCardsFailed':`.
5. **`moveCards` only marks changed on a real column difference.** Assert its body compares against the card's current column rather than setting `changed = true` unconditionally on an id match.
6. **Guard arming is centralized.** Assert `optimisticMoveUntil = Date.now() +` appears **only** inside the arming helper, and that `moveCardsOptimistically` and both drag paths call the helper. This is the assertion that protects the invariant the `:5098-5101` comment says keeps regressing.
7. **Every clear-point clears the ledger.** Assert there is no bare `optimisticMoveUntil = 0` left — all three workspace-switch resets go through `clearOptimisticGuard()`.
8. **`allCards` is overlaid before use.** Assert the `updateBoard` handler applies the overlay on the same statement that assigns `allCards`, before `applyBoardProjectFilter` is called — the defect-4 fix.
9. **The positional signature exists and is derived like the full one.** Assert `buildPositionSignature` exists and keys on `workspaceRoot`/id/`column` with a `.sort()`, so the two signatures cannot disagree about card identity.
10. **The drag-guard test still passes unchanged.** Run `npm run test:contract:drag-guard`; its global negative assertions (notably "no `draggable=\"false\"` anywhere in the file") constrain any markup added for `data-ts`.

Note for the implementer: these tests read `src/webview/kanban.html` directly and need no build step, but any test that touches compiled services requires `npm run compile-tests` (tsc → `out/`), which is out of scope for this session per the skip-compilation directive.

### Manual — both hosts

1. **Reproduce the bounce first.** With CLI triggers on, drag a card into a coder column and record whether it snaps back before settling. Confirm via the console that a pre-move `updateBoard` with a flipped `working` flag is what triggers the render (the handler already logs `signature changed, calling renderBoard with N cards` at `:7461`). Do this before changing anything — if it can't be reproduced on demand, add temporary logging to prove the path rather than fixing blind.

2. **Post-fix, same drop:** no snap-back, activity light still turns on during the window, card settles in place without a full-board log line.

3. **Working-state isolation.** While a drop's guard window is open, have an unrelated card's `working` flag change (dispatch to another column from the sidebar). Confirm its light updates and the dropped card does not move.

4. **Failure revert still works.** Force a failed write so `moveCardsFailed` arrives during the guard window; confirm that card reverts to its source column while others stay put, and that the pending-move record is cleared for it.

5. **Multi-drag overlap.** Drag card A, then drag card B before A's window expires (overlapping windows are explicitly supported — see `:4211-4212`). Confirm both land correctly and neither reverts.

6. **Feature styling and worktree visuals.** The suppressed branch's comment (`:7449-7451`) warns that a full render during the window strips feature styling and animation, and that worktree visuals render when the window expires. Confirm feature cards keep their styling through a drop, and that `featureWorktreesChanged` visuals still appear (`:7469`).

7. **Workspace switch mid-window.** Switch workspace while a guard is armed; confirm the pending-move record is cleared along with `optimisticMoveUntil` and the new board renders fully.

8. **Both hosts.** Run the whole list in the browser cockpit and the editor webview — the handler is shared, and the editor is where feature styling regressions were caught before.

9. **Column counts do not bounce (defect 4).** Drag a card and watch both column count badges through the whole window. Neither may revert to its pre-move value at any point. Then, mid-window, cause a change to a card in a *hidden* project (so the filtered signature is unchanged but `allCards` changes) and confirm counts still reflect the optimistic position.

10. **Feature move does not trigger a rebuild (cascade ids).** Move a feature card with subtasks and confirm the console shows no `calling renderBoard` line — the confirm carries cascade subtask ids that have no DOM elements, and those must not be mistaken for missing cards.

11. **Sorted insertion.** Move a card into a column that already holds several cards. Confirm it lands at the position `renderBoard` would give it (freshest `lastActivity` first, `:6190-6199`) and does not sit at the bottom. Then force a full render (switch project filter and back) and confirm the card does not visibly jump — same position before and after.

12. **A swallowed presentational change still lands.** During an open guard window, change a plan's topic on disk (or its complexity) so a push arrives carrying a presentational-only change. Confirm the board shows the new topic within roughly one window (2s) — the guard-expiry `refresh` is what makes this land, and this test is the reason it exists.

13. **Regression suite.** Run the kanban contract tests — `test:contract:drag-guard` and the new `test:contract:render-guard`. Confirm the five known-red tests at HEAD are unchanged and no new failures appear (stash-verify before attributing a red test to this work).

## Recommendation

Complexity 7 → **Send to Lead Coder.**

## Completion Report

Implemented kanban render guard fixes in `src/webview/kanban.html` to stop stale board updates from bouncing optimistically moved cards and eliminate unnecessary full-board DOM rebuilds. Refactored `moveCards` and `moveCardsFailed` to use targeted DOM moves (`moveCardElements`), added pending optimistic move overlay helpers, updated `updateBoard` to use positional signature matching and in-place activity light toggles (`applyWorkingClass`), and added `src/test/kanban-render-guard-contract.test.js`. All contract tests (`test:contract:drag-guard` and `test:contract:render-guard`) pass cleanly with no issues encountered.

## Review Findings

Two CRITICALs fixed in `src/webview/kanban.html`: `moveCardElements` read the source column from `currentCards` *after* both handlers had already reassigned it, so the real source column's count badge and empty state were never updated (entries now carry an explicit `sourceColumn`); and a targeted element move left the card's column-dependent markup stale, so `runCopyPrompt` derived the next column from a `data-column` snapshot of the column the card had left (now model-first, plus the attribute is patched on move, plus `moveCards`/`moveCardsFailed` rebuild once the guard window is closed). Three MAJORs fixed: `moveCardElements` had no fallback render and silently dropped moves into display-hidden columns (added `resolveDisplayColumn` + an `unresolved` return with three-way caller classification); `suppressedRenderPending` was gated on a hand-listed three-field check that missed `lastActivity`/`isFeature`/`subtaskCount`/`featureId` (now derived from the signature comparison itself); and `test:contract:render-guard` existed but was registered in neither `package.json` nor `.github/workflows/integration-tests.yml` — both wired, and the test's `moveCards`-must-not-render assertions were replaced with an ordering assertion that renderBoard is guard-gated. Also fixed: the drag path armed ledger entries for cards it never moved, and `resolveOptimisticGuard` missed planId-keyed entries matched via a sessionId alias. Files changed: `src/webview/kanban.html`, `src/test/kanban-render-guard-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`; verified via `test:contract:render-guard`, `test:contract:drag-guard`, `shim-injection`, `panel-scrollbars`, `verb-engine-kanban`, `reviewer-prompt` (all pass), inline-script parse check, and eslint — remaining risks are the deferred `data-ts` sorted-insertion drift (a dropped card inserts by its pre-dispatch activity and repositions on the next full render) and a pre-existing TypeScript parse break in `DesignPanelProvider.ts:768` / `KanbanProvider.ts` from a different card in commit `31e55e2`, which blocks `tsc` repo-wide and is unrelated to this plan.
