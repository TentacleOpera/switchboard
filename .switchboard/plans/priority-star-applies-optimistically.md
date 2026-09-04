# The Priority Star Applies Optimistically, Like Every Other Board Action

<!-- board-collapse-03 -->
> **RESCOPED 2026-09-04 (Board Collapse 03, decision 16).** **Delete** the proposed same-column repositioning routine that mirrors `renderBoard`'s comparator. That would be the third copy of "where does this card go": `moveCardElements` already has two rules of its own, and the sibling plan *Kanban card jumps to middle on copy-prompt advance* extracts one shared comparator for render and every optimistic move. Use it.
> > 
> > **Keep** the `pendingStars` ledger, its clearing on a matching `updateBoard` push rather than the 2 s optimistic guard, and failure option (a): a generic toast, no per-card revert, no backend change.


## Goal

Make the kanban board's priority star update the moment it is clicked, instead of waiting for a host round trip and a board re-render. Moves on the same board are already optimistic; the star is the outlier, and on a remote Switchboard the delay is long enough to read as a dead button.

### Problem Analysis & Root Cause

**The handler posts and does nothing else.** The real click handler lives at `kanban.html:9702` (the plan's original `:9380` reference was stale — the file has drifted; the handler is inside `handleCardClick`'s `.star-btn` branch):

```js
if (btn.classList.contains('star-btn')) {
    e.stopPropagation();
    e.preventDefault();
    const planId = btn.dataset.planId || btn.dataset.session || '';
    const workspaceRoot = btn.dataset.workspaceRoot || '';
    const currentlyStarred = btn.dataset.starred === '1';
    postKanbanMessage({
        type: 'setPriorityStarred',
        planId,
        sessionId: btn.dataset.session || '',
        starred: !currentlyStarred,
        workspaceRoot
    });
    return;
}
```

No class toggle, no `data-starred` flip, no local model update. The star's appearance changes only when the host writes the DB, pushes `updateBoard`, and the board re-renders every card from scratch. Starred cards also sort first, so the click's *other* visible effect — the card jumping to the top of its column — waits on the same round trip.

**Moves on the same board are already optimistic.** `moveCardsOptimistically` (`kanban.html:7892`) is called from three sites (`8416`, `8435`, `8459`) and applies the change locally first. The star is the one card action that does not. This is a gap in an established pattern, not a missing pattern.

**Why it is worse remotely.** Locally the round trip is a webview `postMessage` and back. Over the tailnet it is a network hop, a DB write, a board rebuild, and a push — against a board of 2,446 cards. The user's report is that it takes forever, and that is consistent: the star is waiting on a full board regeneration, not on the write.

**The phone already does this correctly, which makes the board the outlier twice over.** The mobile dispatch surface's `toggleCardStar` (`command.js:1163`; the plan's original `:1106` reference was stale):

```js
async function toggleCardStar(cardId, currentStarred) {
    const nextStarred = !currentStarred;
    pendingStars.set(cardId, nextStarred);     // optimistic
    renderActiveView();
    ...
    if (!res.ok) { pendingStars.delete(cardId); renderActiveView(); }
}
```

A pending-ledger keyed by card id, applied over the server state by `getEffectiveCard` (`command.js:498`), cleared on response. The mobile surface has the pattern the desktop board lacks. **Important transport difference (surfaces a gap in the original plan's reasoning):** the mobile surface detects failure per-card because it issues a *direct REST fetch* to `/kanban/plans/priority` and reads `res.ok`. The kanban board does NOT — `postKanbanMessage` is fire-and-forget (`vscode.postMessage` in the webview, fetch-to-`/kanban/verb/setPriorityStarred` in the browser cockpit via `transport.js:345`), and the only failure signal either host emits is a generic `showStatusMessage` toast that carries no `planId`. So the phone's per-card failure revert cannot be copied verbatim onto the board without a new card-keyed ack — see the Superseded callout in Proposed Changes §5 and the Outstanding Question.

**Not already covered.** The existing feature `priority-is-a-card-field-everywhere-a-card-is-shown` (`4115b513`) and its two subtasks are about *reach* — making priority a native field, and putting the star into the sidebar's separate rendering functions. Neither touches latency or optimism. The star's slowness on the board is unreported until now.

## Metadata
**Topic:** Priority star updates optimistically on the kanban board
**Tags:** frontend, ui, ux, bugfix, performance

> **Superseded:** Tags: [kanban, webview, ux, latency, bugfix]
> **Reason:** `kanban`, `webview`, and `latency` are not in the improve-plan allowed tag set (frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library). Tag schema is enforced; out-of-set tags are dropped on import.
> **Replaced with:** Tags: frontend, ui, ux, bugfix, performance

**Complexity:** 5

> **Superseded:** Complexity: 3
> **Reason:** A score of 3 assumes a single-file, localized class-toggle. The code read surfaces three moderate, well-scoped risks that extend existing patterns rather than reusing them verbatim: (1) there is no existing same-column reposition-by-star helper — `moveCardElements` inserts by ts-descending and ignores the starred-first precedence, so the sort half needs a new sort-aware DOM move, not a reuse; (2) the existing `armOptimisticGuard` is a 2-second time window tuned for local postMessage, which is the wrong mechanism for the remote-latency case this plan exists to fix; (3) per-card failure revert (plan §5) requires a new card-keyed ack message that does not exist in either host. None of these are architectural novelties, but together they lift this out of "routine single-file" into mixed territory.
> **Replaced with:** Complexity: 5 (Mixed — majority routine optimistic-toggle, with moderate reposition-mechanism and failure-contract risks extending existing patterns)

## User Review Required

None — with one caveat carried into Outstanding Questions: the failure-revert scope (per-card revert + tell vs. match-the-move-pattern's generic-toast-only) is a product decision the implementer should not make unilaterally. See Outstanding Questions.

## Complexity Audit

### Routine
- Toggling the `.starred` class, flipping `data-starred`, and updating the matching `currentCards` entry on click — a local DOM/model mutation in the existing `handleCardClick` `.star-btn` branch (`kanban.html:9702`).
- Reconciling on the authoritative `updateBoard` push: the existing optimistic-guard merge path already copies `priorityStarred` forward when position signatures match (`kanban.html:10869`), so server-wins reconciliation is largely already wired.
- Posting `setPriorityStarred` to the host — the verb and its backend handler (`KanbanProvider.ts:12789` → `setPriorityStarred` at `:8827`) already exist and are idempotent.

### Complex / Risky
- **Same-column reposition by starred-first precedence.** No existing helper does this. `moveCardElements` (`kanban.html:7767`) inserts by ts-descending (or `queue_position` for STAGING) and does NOT consult `priorityStarred`; the starred-first comparator lives only inside `renderBoard` (`kanban.html:9176-9219`). The optimistic sort must mirror that comparator or the card will not jump to the top on click (verification step 3 fails).
- **Optimistic-guard mechanism vs. remote latency.** `armOptimisticGuard` (`kanban.html:6298`) suppresses `renderBoard` for `OPTIMISTIC_MOVE_WINDOW_MS = 2000`, tuned for the local postMessage round trip. The plan's motivating case is remote tailnet against 2,446 cards, where the board push can exceed 2s — the guard would expire and a `renderBoard` would revert the optimistic star before the server confirms. The mobile `pendingStars` ledger (cleared on a *matching* board update at `command.js:137-138`, not on a timer) is the latency-robust pattern.
- **Per-card failure revert.** Neither host emits a card-keyed ack; the only failure signal is a generic `showStatusMessage` toast (`kanban.html:10567`, dispatched from `KanbanProvider.ts:12799` and `transport.js:390`) with no `planId`. Per-card revert + "tell the user" (plan §5, verification step 6) requires a new ack message across `KanbanProvider.ts`, `transport.js`, and `kanban.html` — a cross-host contract change. See Outstanding Questions for the scope decision.

## Edge-Case & Dependency Audit

**Race Conditions**
- **Double click.** Two rapid clicks on the same star post two `setPriorityStarred` verbs with opposite `starred` values. The pending ledger must be keyed by `planId` so the last click's intended state wins; both server writes land (idempotent), and the final board push agrees with the last click. A naive "clear pending on first response" would leave the DOM and server disagreeing mid-sequence.
- **Guard expiry vs. in-flight write (remote).** If the 2s window expires before the server push arrives, a `renderBoard` fires from stale server state and reverts the star. The ledger must survive guard expiry (hold the optimistic value until a matching push clears it), or the window must be extended/replaced for the star path.
- **Concurrent optimistic move + star.** A card dragged to a new column while a star toggle is pending: the move arms the guard with the card's new column; the star push arrives and merges `priorityStarred` forward only if position signatures match (`kanban.html:10855`). A star pending on a card mid-move must not block the move's reconciliation.

**Security**
- None. The verb is already authenticated/validated server-side (`KanbanProvider.setPriorityStarred` resolves `planId` via `getPlanByPlanId` then `getPlanBySessionId` and rejects unresolved ids). Optimism is a pure client-side visual; it grants no new authority.

**Side Effects**
- Optimistic `currentCards` mutation changes `buildBoardSignature` (`kanban.html:8074` includes `priorityStarred`), which affects the signature-comparison reconciliation in `updateBoard` (`kanban.html:10851`). The optimistic signature must be advanced so the next push is recognized as "matching" rather than triggering a full re-render that flickers.
- Column count badges are unaffected (no card changes column).

**Dependencies & Conflicts**
- **Depends on:** the existing `setPriorityStarred` verb and backend handler (present). The existing optimistic-guard merge path that copies `priorityStarred` forward (present, `kanban.html:10869`).
- **Conflicts with / coordinated with:** the `priority-is-a-card-field-everywhere-a-card-is-shown` feature (`4115b513`) and the sidebar star plan (`b677a96e`). Those add the star to *other* render surfaces; this plan changes the *board's* click behavior. If the sidebar star lands first and copies the board's old non-optimistic handler, it will inherit the same bug — coordinate so both surfaces share the new optimistic helper rather than duplicating it.
- **No dependency on** native priority (`602832e6`); this plan must not wait for it.

## Dependencies
- None — no other plan must land first. The `setPriorityStarred` verb and backend handler already ship.

## Adversarial Synthesis

Key risks: (1) the "reuse the existing sort/reposition path" instruction is fictional for the starred-first sort — `moveCardElements` ignores `priorityStarred`, so the sort half needs a new sort-aware DOM move that mirrors `renderBoard`'s comparator; (2) the 2s `armOptimisticGuard` time window is tuned for local latency and will expire mid-flight on the remote case this plan exists to fix, reverting the star before the server confirms — the mobile `pendingStars` ledger (cleared on matching push, not a timer) is the robust mechanism; (3) per-card failure revert requires a card-keyed ack that neither host emits today. Mitigations: write a targeted same-column reposition that reuses `renderBoard`'s exact comparator; hold the optimistic star in a `pendingStars`-style ledger cleared by a matching `updateBoard` rather than by the 2s timer; decide the failure-revert scope explicitly (see Outstanding Questions) before implementing.

## Proposed Changes

**1. Apply the star locally on click, before posting.** In the `.star-btn` branch of `handleCardClick` (`kanban.html:9702`), flip `data-starred`, toggle the `.starred` class on the button (and update the SVG `fill` so the icon matches the rendered state at `kanban.html:9456-9457`), and update the matching entry in `currentCards` so the model and the DOM agree. Advance `lastBoardSignature` via `buildBoardSignature(currentCards)` so the next push reconciles against the optimistic state rather than treating it as a stale signature.

**2. Re-sort the affected column optimistically — ~~using a NEW sort-aware reposition~~ using the SHARED comparator.** (Corrected 2026-09-04, Board Collapse audit: a new private routine would be the third copy of "where does this card go". `Kanban card jumps to middle on copy-prompt advance` extracts one comparator for `renderBoard` and every optimistic move; consume it.) Starred cards sort first, so the card must move to the top of its column immediately — otherwise half the click's effect is optimistic and half is not, which reads as a bug in its own right.

> **Superseded:** "Reuse the existing sort/reposition path rather than re-rendering the column."
> **Reason:** The existing `moveCardElements` (`kanban.html:7767`) inserts by ts-descending (or `queue_position` for STAGING) and does NOT consult `priorityStarred`. The starred-first precedence exists only inside `renderBoard`'s comparator (`kanban.html:9176-9219`). Reusing `moveCardElements` for a same-column star reposition would place the card by timestamp, not at the top, so the card would NOT jump on click and verification step 3 would fail. There is no existing same-column reposition-by-star helper to reuse.
> **Replaced with (SUPERSEDED AGAIN 2026-09-04, Board Collapse audit):** ~~Write a targeted same-column reposition that mirrors `renderBoard`'s comparator~~ — mirroring a comparator is what produces drift. Call the shared comparator extracted by `Kanban card jumps to middle on copy-prompt advance`, which `moveCardElements` also calls, so star ordering, the shipped priority order-by and the creation-date rule are all honoured from one place. Original text for the record: write a targeted same-column reposition that mirrors `renderBoard`'s comparator exactly (starred-first, then `columnOrder` ASC with NULL-first, then `column_entered_at` DESC, then `createdAt` DESC) and relocates the single card element within its `col-` container. Alternatively, re-render only the affected column through the existing comparator — heavier but guaranteed-consistent. Prefer the targeted move; fall back to a single-column re-render if the comparator is too entangled to extract.

**3. Hold the optimistic star in a `pendingStars` ledger keyed by `planId`, cleared by a matching `updateBoard` — NOT by the 2s `armOptimisticGuard` timer.**

> **Superseded:** "Follow `moveCardsOptimistically`'s structure, including whatever guard it carries."
> **Reason:** `moveCardsOptimistically` arms `armOptimisticGuard`, a 2-second time window (`OPTIMISTIC_MOVE_WINDOW_MS = 2000`, `kanban.html:6290`) tuned for the local postMessage round trip. This plan's motivating case is remote tailnet against 2,446 cards, where the board push can exceed 2s. A time-window guard would expire mid-flight and a `renderBoard` would revert the optimistic star before the server confirms — the exact "dead button" symptom this plan exists to fix. The mobile `pendingStars` ledger (`command.js:38`, cleared on a *matching* board update at `command.js:137-138`) is the latency-robust pattern.
> **Replaced with:** Introduce a `pendingStars: Map<planId, boolean>` on the board (mirroring `command.js`). On click, set the ledger entry and apply it optimistically. In the `updateBoard` path, after merging server cards, clear any ledger entry whose pending value equals the server's `priorityStarred` for that card (exactly `command.js:137-138`). The optimistic value persists across guard expiries and full re-renders until the server confirms it, so a slow remote push cannot revert a fast local click. Coordinate with the existing optimistic-guard merge (`kanban.html:10869`) so a star pending on a card does not block the move-reconciliation path.

**4. Reconcile on the authoritative push.** When `updateBoard` arrives, the server value wins: clear the matching `pendingStars` entry (per §3) and let the render/merge path apply the server state. If the server value differs from the pending value (e.g. another client starred/unstarred the same card), the server wins and the ledger clears — last-authoritative-write, consistent with how moves reconcile.

**5. Failure handling — scope decision required (see Outstanding Questions).** The original plan's "revert visibly on failure AND say so" cannot be implemented on the board as-is: neither host emits a card-keyed ack, so the board cannot know WHICH card failed from the generic `showStatusMessage` toast. Two options:
- **(a) Match the board's existing move pattern:** optimistic + ledger + reconcile-on-push, with the existing generic `showStatusMessage` toast as the only failure signal and NO per-card revert (the ledger holds the optimistic value until a push confirms or denies it; a failed write simply never confirms, and the next push reverts). This is consistent with how moves already behave (moves have no per-card failure revert either) and requires no backend change.
- **(b) Exceed the move pattern:** add a new card-keyed ack (e.g. `priorityStarResult { planId, starred, success }`) emitted from `KanbanProvider.setPriorityStarred` (`:8827`) and the `setPriorityStarred` verb handler (`:12789`), re-dispatched by `transport.js` in the browser, and handled in `kanban.html` to revert the specific card's ledger entry + show a card-scoped message. This is a cross-host contract change (`KanbanProvider.ts` + `transport.js` + `kanban.html`) and is the only way to satisfy verification step 6 as written.

> **Superseded:** "Revert visibly on failure. If the host reports the write failed, restore the previous state *and* say so. The phone's version reverts silently on both branches, which leaves the user believing a star was set. Do not copy that half."
> **Reason:** The phone detects failure per-card via a direct REST fetch (`res.ok`). The board's `postKanbanMessage` is fire-and-forget in both hosts and emits only a generic, non-card-keyed `showStatusMessage` toast on failure. "Restore the previous state AND say so" for a specific card is impossible without a new card-keyed ack message that does not exist. Also: the phone's failure branch DOES revert (it deletes the pending entry and re-renders at `command.js:1177-1180`); it merely does not TELL the user — the original "reverts silently on both branches" characterization was imprecise (the success branch relies on the board push, the failure branch reverts but quietly).
> **Replaced with:** The two options above. Recommended default: (a), for consistency with the board's own move pattern and zero backend risk; the generic toast already fires on failure. If per-card revert + a card-scoped message is a hard requirement, take (b) and treat it as a separate, larger change touching the host↔webview message contract in both composition roots.

**6. Tolerate a double click.** Two rapid clicks must not leave the DOM and the server disagreeing. Key the `pendingStars` ledger by `planId` so the last click's intended state overwrites the first; both server writes are idempotent and the final push agrees with the last click. Do NOT clear the ledger on the first response — clear only on a matching `updateBoard` (per §3/§4).

**Out of scope:** the sidebar star (`b677a96e`) and native priority (`602832e6`). If those land first the same optimism should extend to them, but this plan does not depend on either and must not wait for them. Coordinate so any new star surface shares the board's optimistic helper rather than duplicating the old non-optimistic handler.

## Verification Plan

Latency is the symptom, so verification is timing plus correctness — a star that applies instantly and then reverts is worse than a slow one.

> **Note:** Per the dispatching session, compilation and automated tests are NOT executed in this run. The checks below remain the verification contract for the implementer; they are simply not run now.

### Automated Tests
- A webview-shim contract test asserting the `.star-btn` click handler toggles `data-starred` and the `.starred` class synchronously, before any `postKanbanMessage` is awaited (mirrors `src/test/webview-shim-injection-contract.test.js`).
- A reconciliation test asserting a `pendingStars` entry is cleared when an `updateBoard` payload carries a matching `priorityStarred` for that `planId` (mirrors the `command.js:137-138` contract).
- A double-click test asserting two rapid toggles settle to the last-clicked value in both the ledger and the DOM, with no leaked ledger entry.

### Goal Invariants
- Assert `kanban.html`'s `.star-btn` click branch (in `handleCardClick`) calls a local toggle that flips `data-starred` and the `.starred` class BEFORE (or independently of) the `postKanbanMessage({ type: 'setPriorityStarred', ... })` call — i.e. the visual change does not await the post.
- Assert a `pendingStars` Map keyed by `planId` exists in `kanban.html` and is consulted by the `updateBoard`/reconciliation path (absent today — its presence is the positive invariant; paired negative: assert the handler no longer posts-and-does-nothing-else).
- Assert the optimistic same-column reposition places a newly-starred card above every unstarred sibling in its `col-` container within one frame of the click (count of unstarred cards above the starred card in that column === 0 immediately after click, before any push).
- Assert `armOptimisticGuard`'s 2s timer is NOT the sole clear mechanism for a pending star — i.e. a `pendingStars` entry survives past `OPTIMISTIC_MOVE_WINDOW_MS` until a matching `updateBoard` clears it (negative: assert no code path clears `pendingStars` purely on `optimisticMoveUntil` expiry).

1. **Local click latency.** The star fills within one frame of the click, before any host response. Verify with the host paused in the debugger — the visual change must already have happened.
2. **Remote click latency.** From the phone over the tailnet against the home lab board, the star responds immediately. This is the reported symptom and the pass condition.
3. **Sort applies at the same instant.** The card jumps to the top of its column on click, not on the later push. (Requires the new sort-aware reposition from §2 — `moveCardElements` alone will not satisfy this.)
4. **Reconciliation.** After `updateBoard` arrives, the card's state matches the DB. Star, wait for the push, confirm no flicker and no second reposition.
5. **Unstar** is optimistic in the same way, including the card falling back to its unstarred position.
6. **Failure path.** Force the write to fail (stop the server mid-click, or make the host return an error). Behavior depends on the scope decision in Outstanding Questions: under (a) the generic toast fires and the next push reverts the star (no per-card revert); under (b) the specific card reverts AND a card-scoped message shows. The chosen option's behavior is the pass condition.
7. **Double click.** Two rapid clicks settle to the same value in DOM and DB, with no stuck pending state.
8. **Multi-card.** Star several cards quickly; each resolves independently and no ledger entry leaks.
9. **No move regression.** Drag a card and use the advance buttons; `moveCardsOptimistically` behaves exactly as before — this change shares its neighbourhood and must not alter the move guard or signature path.
10. **Both hosts.** VS Code webview (`postMessage`) and browser cockpit (WebSocket/verb-rail via `transport.js`), since the round trip differs and only the browser path shows the remote latency. If option (b) is taken, the new card-keyed ack must fire in BOTH `KanbanProvider.ts` (webview) and `transport.js` (browser) — a single-host ack is a divergence.

## Outstanding Questions
- **[user]** Failure-revert scope: should the board match the existing move pattern (option (a): optimistic + ledger + generic toast, no per-card revert, zero backend change) or exceed it (option (b): new card-keyed ack across `KanbanProvider.ts` + `transport.js` + `kanban.html` for per-card revert + card-scoped message)? — proceeding on the assumption that **(a)** is the default (consistency with moves, lower risk), with (b) as a follow-up if per-card revert is a hard requirement. The implementer must confirm before building (b).
