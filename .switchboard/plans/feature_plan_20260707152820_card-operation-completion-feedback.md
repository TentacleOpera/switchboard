# Add completion feedback when a kanban card finishes an operation

## Goal

When a kanban card completes an operation — most visibly when its amber "agent working" status light goes out — the board currently gives the user **no feedback at all**. The light simply disappears on the next `renderBoard` call and the card silently re-renders. The user has to notice the absence of the pulsing dot to know an agent finished.

### Problem analysis & root cause

The activity light is rendered in `createCardHtml` (`src/webview/kanban.html:5816`):

```js
const workingLight = (!isCompleted && card.working)
    ? '<span class="card-status-light is-on" title="Agent working…">●</span>'
    : '';
```

The `working` flag is derived in the backend (`src/services/KanbanProvider.ts:130`) from `dispatchedAt` via `isWorkingState()`, which returns `true` only while `Date.now() - dispatchedAt < timeoutMs` (default **10 min** — `DEFAULT_WORKING_STATE_TIMEOUT_MS = 10 * 60 * 1000`, reduced from 20 min by the "10-minute timeout reduction" commit; the read-time check reads the live `switchboard.activityLight.timeoutMs` setting). When the timeout elapses (or the backend sweep nulls `dispatched_at`), the next `updateBoard` payload marks `working: false`, and `renderBoard` rebuilds the card DOM **without** the light. There is no transition detection — the webview never compares the previous `working` state to the new one, so nothing fires.

The board already has the infrastructure to show transient feedback:

- A status bar message area: `<div id="status-message" ...>` (`kanban.html:2644`) driven by the `showStatusMessage` message handler (`kanban.html:6485`) and reused inline in `moveCardsFailed` (`kanban.html:6582`; the inline status block is at `6597`–`6611`). It supports a `flashing` CSS animation (`@keyframes statusFlash`, `kanban.html:2483`) and auto-clears after 5s.
- A `flashIconBtn` helper (`kanban.html:4580`) that adds/removes a `flash` class with `animationend` cleanup — a reusable pattern for one-shot CSS animations.

Neither is wired to the working→idle transition. The fix is to **detect the transition in the webview** and (a) post a status bar message, and (b) play a short one-shot animation on the affected card.

## Metadata

- **Tags:** frontend, ui, ux
- **Complexity:** 4 (upper-Routine — single-file webview JS/CSS, but a non-trivial optimistic-render state interaction and a `renderBoard` signature change touching four call sites)
- *No `**Repo:**` line — this is a single-repo workspace.*

## User Review Required

No product-scope decision is required from the user before coding (the feature is purely additive UI feedback, no backend/DB/IPC contract change, no migration). The plan is ready to send to a Coder as-is. The user should spot-check the chosen visual treatment (green glow + status-bar wording) during manual verification and adjust copy/CSS if they prefer a different hue or message.

## Complexity Audit

### Routine
- Pure webview JS + CSS confined to `src/webview/kanban.html`. No backend messages required: the `working` state already arrives in every `updateBoard` payload via `card.working`.
- A transition-detection diff in the existing `updateBoard` / `renderBoard` path.
- A status bar message call reusing the existing `#status-message` element + `statusFlash` animation.
- One new CSS keyframe + a class toggle on the card element, with a `prefers-reduced-motion` guard mirroring the existing pulse guard (`kanban.html:982`).
- All APIs/behaviors used (`color-mix`, `CSS.escape`, `animationend`+`{once:true}`, `--vscode-testing-iconPassed`, `data-plan-id` queries) are already in use elsewhere in this file — no new dependencies.

### Complex / Risky
- **Optimistic-render interaction:** the `updateBoard` handler suppresses `renderBoard` while an optimistic drag window is active and no `working` flag changed (`kanban.html:6633`–`6651`). A finish detected during a suppressed tick must be **carried forward** to the next real render, not silently dropped — see the `pendingFinished` carry-forward in Proposed Changes §2. (The `working→idle` case is safe because it flips `workingChanged=true`, which busts the suppression; only a `COMPLETED`-column move with unchanged `working` can land in the suppressed branch.)
- **`renderBoard` signature change:** `renderBoard(cards)` (`kanban.html:5479`) becomes `renderBoard(cards, justFinishedIds = new Set())`. The default param keeps the four existing call sites (`moveCards` `6578`, `moveCardsFailed` `6595`, `updateBoard` `6655` + `6661`) working unchanged, but the change must be verified against all callers.

## Edge-Case & Dependency Audit

### Race Conditions
- **Batch updates:** A single `updateBoard` can flip several cards from working→idle at once (e.g. a timeout sweep). The status bar message must summarize ("2 plans finished") rather than fire once per card and overwrite itself. Throttle/coalesce within one `updateBoard` call.
- **Optimistic move window:** While `optimisticMoveUntil` is active, `renderBoard` is suppressed when no `working` flag changed (`kanban.html:6642`). Transition detection must run on the data update regardless, but the card animation should only attach when a real render happens — otherwise the animation targets a DOM node that won't be (re)created. Resolution: detect transitions in `updateBoard`, push any finish that occurs during a **suppressed** render onto a `pendingFinished` set, and drain that set on the next real `renderBoard` (see Proposed Changes §2). This makes the "fires on the next real render" guarantee actually true.
- **Shared `#status-message` timeout:** The new `showStatusBarMessage` helper and the host-driven `showStatusMessage` handler both stamp `statusEl._statusTimeoutId` on the same element. A finish message and a host error/close-timing message racing will clobber each other's 5s timeout. This is **acceptable** (last-write-wins is correct coalescing for a transient sub-bar) but is an intentional shared-channel decision, not an exclusive channel.

### Security
- **None.** Pure UI. The status-bar message is set via `statusEl.textContent = text` (no HTML injection surface), and card topics are already escaped by `escapeHtml`/`escapeAttr` in `createCardHtml`. No new untrusted-input handling, no eval, no innerHTML of dynamic content.

### Side Effects
- **DOM-only.** The change adds a transient class (`card-op-completed`) on card elements with `animationend` cleanup (`{ once: true }`), mirroring the existing column-highlight pattern at `kanban.html:5699`. No backend writes, no DB, no IPC messages emitted, no `postKanbanMessage` calls added.
- **Build artifact:** `dist/webview/kanban.html` is generated from `src/webview/kanban.html` by `copy-webpack-plugin` (`webpack.config.js:73`–`78`, pattern `src/webview/*.html` → `webview/[name][ext]`). Per project convention, `dist/` is **not** used during development/testing (testing is via an installed VSIX); `npm run compile` is only needed when producing a VSIX for release. Edit `src/` only; do not hand-edit `dist/`.

### Dependencies & Conflicts
- **`buildBoardSignature` includes `card.working`** (`kanban.html:4791`, with an explicit comment at `4785`–`4786` tying it to the `workingChanged` check). This is load-bearing for this plan: it guarantees a `working→idle` transition **changes the board signature**, so `updateBoard` takes the render path (`6655`) instead of the suppressed/unchanged paths. Do **not** remove `working` from the signature, or working finishes will stop rendering at all.
- **`renderBoard` call sites:** signature gains a defaulted second param. All four current callers pass one arg → safe. Audit for any other `renderBoard(...)` callers introduced later.
- **No new runtime dependencies:** `color-mix`, `CSS.escape`, `animationend`, `@media (prefers-reduced-motion: reduce)`, and `--vscode-testing-iconPassed` are all already used in this file.

## Dependencies

None — single-file webview change, no cross-plan (`sess_…`) dependencies.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) every line number in the original draft was stale against the live 10,601-line file — re-verified and corrected below; (2) the proposed unconditional `previousWorking` advance silently drops a `COMPLETED`-during-optimistic finish (the draft's verification step 7 "fires on next render" claim was false) — fixed via a `pendingFinished` carry-forward drained on the next real render; (3) the new `showStatusBarMessage` helper duplicated two existing status-flash blocks — refactor of the `showStatusMessage` handler and `moveCardsFailed` block through the helper made mandatory. Mitigations: line numbers verified against current source, carry-forward makes the optimistic-window guarantee real, and one helper serves all three status-flash call sites.

## Proposed Changes

> **Line-number verification (load-bearing):** the original draft's line numbers were measured against an older copy of the file. All numbers below are verified against the current `src/webview/kanban.html` (10,601 lines). Mapping of the draft's stale references → corrected:
>
> | Draft claimed | Actual (current file) | What lives there |
> |---|---|---|
> | `kanban.html:5722` (working light) | **5816** | `workingLight` in `createCardHtml` (fn starts 5755) |
> | `kanban.html:6520` (`case 'updateBoard'`) | **6614** | `case 'updateBoard':` |
> | `kanban.html:6391` (`showStatusMessage` handler) | **6485** | `case 'showStatusMessage':` |
> | `kanban.html:6503` (`moveCardsFailed`) | **6582** | `case 'moveCardsFailed':` (inline status block 6597–6611) |
> | `kanban.html:6469` (`moveCards` case) | **6563** | `case 'moveCards':` |
> | `kanban.html:2450` (`@keyframes statusFlash`) | **2483** | `@keyframes statusFlash` |
> | `kanban.html:4488` (`flashIconBtn`) | **4580** | `function flashIconBtn(btn)` |
> | `~kanban.html:5385` (board state vars) | **3957** (`currentCards`) / **3991** (`lastBoardSignature`) / **3996** (`optimisticMoveUntil`) | module-scope state |
> | `kanban.html:6554` / `6560` (renderBoard calls in updateBoard) | **6655** / **6661** | the two `renderBoard(...)` calls in `case 'updateBoard'` |
> | `kanban.html:6541` (optimistic suppression) | **6633`–`6651** | `optimisticActive` guard + suppressed-absorb branch |
> | `kanban.html:981` (reduced-motion pulse) | **982** | `.card-status-light.is-on { animation: none }` |
> | `kanban.html:965` (`.card-status-light` block) | **965** | ✓ correct |
> | `KanbanProvider.ts:130` (`isWorkingState`) | **130** | ✓ correct (but default timeout is **10 min**, not 20) |

### File: `src/webview/kanban.html`

#### 1. Track the previous working state + a carry-forward set (module-scope)

Near the other board state variables (`currentCards` at `kanban.html:3957`, `lastBoardSignature` at `3991`, `optimisticMoveUntil` at `3996`), add:

```js
// Map of cardId -> true while the card was last seen with its activity light on.
// Used to detect the working -> idle edge and fire completion feedback.
let previousWorking = new Map(); // id -> boolean

// Finishes detected during a suppressed render (optimistic window, no working
// change) are stashed here and drained by the next real renderBoard. Without
// this, a COMPLETED-column move during an optimistic tick would be silently
// dropped (previousWorking advances every tick, so the edge is never re-seen).
let pendingFinished = []; // [{ id, topic, completed }]
```

#### 2. Detect the finish edge in `updateBoard` and carry suppressed finishes forward

In the `case 'updateBoard':` block (`kanban.html:6614`), before the signature check decides whether to render, compute the set of cards that just transitioned `working: true → false` (or moved into `COMPLETED`):

```js
case 'updateBoard': {
    const nextCards = Array.isArray(msg.cards) ? msg.cards : [];
    // ...existing featureWorktrees / signature setup...

    // Detect working -> idle transitions (and completions) for finish feedback.
    const justFinished = []; // [{ id, topic, completed }]
    const nextWorking = new Map();
    for (const card of nextCards) {
        const id = card.planId || card.sessionId || '';
        if (!id) continue;
        const wasWorking = previousWorking.get(id) === true;
        const isCompleted = card.column === 'COMPLETED';
        const nowWorking = !isCompleted && !!card.working;
        nextWorking.set(id, nowWorking);
        // Fire only on a true edge: was working, now not — OR just entered COMPLETED.
        if (wasWorking && !nowWorking) {
            justFinished.push({ id, topic: card.topic || '', completed: isCompleted });
        } else if (isCompleted && wasWorking) {
            justFinished.push({ id, topic: card.topic || '', completed: true });
        }
    }
    previousWorking = nextWorking; // advance every tick so the edge stays accurate

    // ...existing signature/optimistic logic...
```

> **Clarification — carry-forward (makes verification step 7 true):** `previousWorking` advances unconditionally (keeps the `working→idle` edge accurate across ticks). But a finish detected in a tick where `renderBoard` is **suppressed** (optimistic window + no `working` change — only reachable for a `COMPLETED`-column move with unchanged `working`) must not be lost. Push those onto `pendingFinished` and drain them on the next real render. Concretely, where the suppressed-absorb branch sits (`kanban.html:6642`–`6651`):
>
> ```js
> if (optimisticActive && !workingChanged) {
>     // ...existing absorb-without-render comment...
>     currentCards = nextCards;
>     lastBoardSignature = buildBoardSignature(currentCards);
>     if (justFinished.length) pendingFinished.push(...justFinished); // carry forward
> } else {
>     lastBoardSignature = nextBoardSignature;
>     console.log('[Kanban WV] signature changed, calling renderBoard with', nextCards.length, 'cards');
>     const activeFinished = justFinished.length
>         ? justFinished.concat(pendingFinished.splice(0)) // drain carry + new
>         : (pendingFinished.length ? pendingFinished.splice(0) : []);
>     renderBoard(nextCards, new Set(activeFinished.map(f => f.id)));
> }
> ```

Then thread the active finish set into the `renderBoard(...)` call inside this case. **Only the signature-changed call (`kanban.html:6655`) ever carries a non-empty set** — because `working` and `column` are both in `buildBoardSignature`, any real finish changes the signature and takes this path; the featureWorktrees-changed call (`6661`, in the signature-unchanged branch) always receives an empty set in practice. Change the signature to `renderBoard(cards, justFinishedIds = new Set())`.

> Note: the `moveCards` case (`kanban.html:6563`) and `moveCardsFailed` (`6582`) also call `renderBoard` (`6578`, `6595`); they pass no finish set, which is correct (a manual move is not a "finished operation"). The default param keeps them working unchanged.

#### 3. One `showStatusBarMessage` helper — route all three status-flash sites through it (MANDATORY refactor)

Add a single helper near `flashIconBtn` (`kanban.html:4580`):

```js
/** Show a transient message in the kanban sub-bar status area (#status-message). */
function showStatusBarMessage(text, { isError = false } = {}) {
    const statusEl = document.getElementById('status-message');
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = isError
        ? 'var(--vscode-errorForeground, #ff6b6b)'
        : 'var(--accent-teal)';
    statusEl.style.display = 'inline-block';
    statusEl.classList.remove('flashing');
    void statusEl.offsetWidth; // restart animation
    statusEl.classList.add('flashing');
    if (statusEl._statusTimeoutId) clearTimeout(statusEl._statusTimeoutId);
    statusEl._statusTimeoutId = setTimeout(() => {
        statusEl.textContent = '';
        statusEl.classList.remove('flashing');
        statusEl._statusTimeoutId = null;
    }, 5000);
}
```

**Mandatory (not optional) refactor:** replace the inline body of the `showStatusMessage` message handler (`kanban.html:6485`–`6507`) with `showStatusBarMessage(msg.message || '', { isError: !!msg.isError });`, and replace the inline status block in `moveCardsFailed` (`kanban.html:6597`–`6611`) with `showStatusBarMessage(\`${failed.length} plan(s) not advanced: ${failed[0]?.reason || 'database update failed'}\`, { isError: true });`. Behavior is identical; one routine instead of three drifting copies (the codebase already has a comment at `1052` admitting `flashIconBtn` "was a no-op" — that's the rot pattern to avoid here).

In `renderBoard`, after the DOM is built, fire the message and the card animation:

```js
function renderBoard(cards, justFinishedIds = new Set()) {
    // ...existing body that builds the DOM...

    // After DOM is in place: completion feedback.
    if (justFinishedIds.size > 0) {
        // Coalesce the status bar message. Counts OPERATIONS completing (full
        // cards array), not just visible cards; animation is best-effort below.
        const finishedCards = cards.filter(c => justFinishedIds.has(c.planId || c.sessionId || ''));
        if (finishedCards.length === 1) {
            const c = finishedCards[0];
            const label = c.topic ? `"${c.topic.length > 40 ? c.topic.slice(0,37)+'…' : c.topic}"` : 'Plan';
            showStatusBarMessage(c.column === 'COMPLETED'
                ? `${label} completed`
                : `${label} finished`);
        } else if (finishedCards.length > 1) {
            const doneCount = finishedCards.filter(c => c.column === 'COMPLETED').length;
            showStatusBarMessage(doneCount
                ? `${finishedCards.length} plans finished (${doneCount} completed)`
                : `${finishedCards.length} plans finished`);
        }
        // Animate each still-present finished card (best-effort; cards filtered
        // out by project/backlog view are counted in the message but not animated).
        finishedCards.forEach(c => {
            const id = c.planId || c.sessionId || '';
            const el = document.querySelector(`.kanban-card[data-plan-id="${CSS.escape(id)}"]`);
            if (el) {
                el.classList.remove('card-op-completed');
                void el.offsetWidth;
                el.classList.add('card-op-completed');
                el.addEventListener('animationend', () => el.classList.remove('card-op-completed'), { once: true });
            }
        });
    }
}
```

#### 4. Add the completion animation CSS

Add near the existing `.card-status-light` block (`kanban.html:965`):

```css
/* One-shot feedback when a card's operation completes (status light goes out
   or card enters the COMPLETED column). Distinct from the static green
   .completed bar — this is a brief highlight that fades. */
@keyframes card-op-completed-flash {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 60%, transparent); }
    30%  { box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 45%, transparent); }
    100% { box-shadow: 0 0 0 0 transparent; }
}
.kanban-card.card-op-completed {
    animation: card-op-completed-flash 1.4s ease-out forwards;
}
@media (prefers-reduced-motion: reduce) {
    .kanban-card.card-op-completed { animation: none; }
}
```

> **Note on reduced-motion completeness:** the new card glow is guarded. The status-bar `statusFlash` keyframe (`kanban.html:2483`) has **no** reduced-motion guard today and is inherited unchanged by this plan. A fading opacity text bar is motion-tolerant in practice, so this plan does not touch `statusFlash`; adding a guard there is a separate follow-up if full reduced-motion coverage is desired.

### File: `dist/webview/kanban.html`

Do **not** edit by hand. `dist/` is regenerated by `copy-webpack-plugin` via `npm run compile` — but per project convention `dist/` is **not used during development or testing** (testing is via an installed VSIX). Regeneration is only needed when cutting a release VSIX.

## Verification Plan

> Per session directives: **skip compilation** (no `npm run compile` step) and **skip automated tests**. Verification is manual, via an installed VSIX, treating `src/` as the source of truth.

1. **Manual — single finish:** Open the Kanban board. Dispatch an agent to a plan so its amber status light is on. Wait for the working timeout to elapse (or temporarily lower `switchboard.activityLight.timeoutMs` to a few seconds for fast testing — note the production default is now **10 min**, not 20). Confirm:
   - The status bar (`#status-message`) shows `"<topic>" finished` and flashes for ~5s.
   - The card plays a brief green glow (`card-op-completed-flash`) that fades within 1.4s.
2. **Manual — completion:** Drag/click a working card into `COMPLETED`. Confirm the message reads `"<topic>" completed` and the same animation plays.
3. **Manual — batch:** With two working cards, let both time out in the same `updateBoard` tick. Confirm a single coalesced message (`2 plans finished`) rather than two overwriting messages, and both cards animate.
4. **Initial load:** Reload the webview while a card is already idle. Confirm **no** finish message fires (no false positive from seeding `previousWorking`).
5. **Reduced motion:** Enable OS "reduce motion". Repeat step 1. Confirm the card animation is suppressed but the status bar message still appears (text feedback remains).
6. **Optimistic window (carry-forward):** Drag a card during an optimistic move window so `renderBoard` is suppressed **and** a `COMPLETED`-column move lands in that suppressed tick. Confirm the finish message + animation fire on the **next real render** (the `pendingFinished` carry-forward), rather than being silently dropped. (Working→idle finishes need not be tested here — they bust the suppression via `workingChanged` and render immediately.)
7. **Filter / backlog view:** With a finished card that is filtered out of the visible set (project or backlog filter), confirm the message still counts it ("N plans finished") but no animation plays for the absent card (best-effort animation is correct).
8. **No regressions:** Confirm `moveCards`, `moveCardsFailed`, manual drags, and the existing `showStatusMessage` host handler still behave as before — the refactored handler routes through `showStatusBarMessage` with identical behavior, and the new `renderBoard` second param defaults to an empty set for all pre-existing callers.

## Recommendation

**Send to Coder.** Complexity 4 (upper-Routine: single-file mechanics, but a non-trivial optimistic-render state interaction requiring the `pendingFinished` carry-forward, plus a `renderBoard` signature change spanning four call sites). Not intern-safe; the carry-forward edge and the mandatory three-site refactor warrant a coder's attention.

**Stage Complete:** PLAN REVIEWED

**Stage Complete:** LEAD CODED


## Review Findings

Implemented in `e239e61` (single-file, `src/webview/kanban.html`) and matches the plan end-to-end: `previousWorking`/`pendingFinished` state (4009/4015), working→idle edge detection + carry-forward in the `updateBoard` handler (6664–6730, with `pendingFinished` drained in both the render and featureWorktrees branches), one `showStatusBarMessage` helper (4613) with the `showStatusMessage` handler (6562) and `moveCardsFailed` (6653) both refactored through it, `renderBoard(cards, justFinishedIds)` (5524) with coalesced status message + best-effort card animation (5784–5811), and the reduced-motion-guarded `card-op-completed-flash` CSS (988–998); `buildBoardSignature` retains `card.working` with a protective comment (4830). Regression trace clean — no double-trigger (only `updateBoard` passes a non-empty finish set), empty-seed `previousWorking` yields no initial-load false positive, and it composes with Plan 4's `workingChanged` force-render and Plan 2's mtime clear. Only NIT: the `else if (isCompleted && wasWorking)` branch (6677) is unreachable dead code (the first `if` already fires whenever `isCompleted`) — harmless, left as-is. No code fixes applied; verification static (compile/tests skipped per directive).

**Stage Complete:** CODE REVIEWED
