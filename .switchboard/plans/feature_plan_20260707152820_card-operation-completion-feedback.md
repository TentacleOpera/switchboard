# Add completion feedback when a kanban card finishes an operation

## Goal

When a kanban card completes an operation — most visibly when its amber "agent working" status light goes out — the board currently gives the user **no feedback at all**. The light simply disappears on the next `renderBoard` call and the card silently re-renders. The user has to notice the absence of the pulsing dot to know an agent finished.

### Problem analysis & root cause

The activity light is rendered in `createCardHtml` (`src/webview/kanban.html:5722`):

```js
const workingLight = (!isCompleted && card.working)
    ? '<span class="card-status-light is-on" title="Agent working…">●</span>'
    : '';
```

The `working` flag is derived in the backend (`src/services/KanbanProvider.ts:130`) from `dispatchedAt` via `isWorkingState()`, which returns `true` only while `Date.now() - dispatchedAt < timeoutMs` (default 20 min). When the timeout elapses (or the backend sweeps/clears `dispatched_at`), the next `updateBoard` payload marks `working: false`, and `renderBoard` rebuilds the card DOM **without** the light. There is no transition detection — the webview never compares the previous `working` state to the new one, so nothing fires.

The board already has the infrastructure to show transient feedback:

- A status bar message area: `<div id="status-message" ...>` (`kanban.html:2611`) driven by the `showStatusMessage` message handler (`kanban.html:6391`) and reused inline in `moveCardsFailed` (`kanban.html:6503`). It supports a `flashing` CSS animation (`@keyframes statusFlash`, `kanban.html:2450`) and auto-clears after 5s.
- A `flashIconBtn` helper (`kanban.html:4488`) that adds/removes a `flash` class with `animationend` cleanup — a reusable pattern for one-shot CSS animations.

Neither is wired to the working→idle transition. The fix is to **detect the transition in the webview** and (a) post a status bar message, and (b) play a short one-shot animation on the affected card.

## Metadata

- **Tags:** kanban, webview, ux, animation, status-light, feedback
- **Complexity:** 3 (Routine — pure webview JS/CSS, no backend contract change, no DB writes)

## Complexity Audit

**Routine.** The change is confined to `src/webview/kanban.html` (webview JS + CSS). No new backend messages are required: the working state already arrives in every `updateBoard` payload via `card.working`. The work is:

1. A transition-detection diff in the existing `updateBoard` / `renderBoard` path.
2. A status bar message call (reusing the existing `#status-message` element + `statusFlash` animation).
3. One new CSS keyframe + a class toggle on the card element.

No schema changes, no new IPC messages, no DB migrations. Risk is limited to visual jitter if the diff fires too aggressively (mitigated by only triggering on a true `true→false` edge).

## Edge-Case & Dependency Audit

- **Batch updates:** A single `updateBoard` can flip several cards from working→idle at once (e.g. a timeout sweep). The status bar message must summarize ("2 plans finished") rather than fire once per card and overwrite itself. Throttle/coalesce within one `updateBoard` call.
- **Optimistic move window:** While `optimisticMoveUntil` is active, `renderBoard` is suppressed (`kanban.html:6541`). Transition detection must run on the data update regardless, but the card animation should only attach when a real render happens — otherwise the animation targets a DOM node that won't be (re)created. Simplest: detect transitions in `updateBoard`, but defer the animation/message to `renderBoard` (pass a "just-finished" set).
- **Completed column:** `working` is already suppressed for `COMPLETED` cards (`kanban.html:5722`). A card that moves into `COMPLETED` while still "working" should still count as finished for the message (the column move is itself the completion signal). Treat column-into-`COMPLETED` as a finish event too.
- **Initial load:** On the very first `updateBoard` there is no previous state. Do not fire finish events for cards that arrive already idle — only fire on a `true→false` edge, so seed `previousWorking` from the first payload without emitting.
- **Workspace/project filter switches:** When the board re-renders due to a filter change (not a state change), cards may appear/disappear. Do not treat a card vanishing from the visible set as a "finish". Track finish events by card id and only animate cards still present after render.
- **`prefers-reduced-motion`:** The existing `card-status-light-pulse` is disabled under reduced motion (`kanban.html:981`). The new completion animation must likewise be suppressed / shortened under `@media (prefers-reduced-motion: reduce)`.
- **Build artifact:** `dist/webview/kanban.html` is generated from `src/webview/kanban.html` by `copy-webpack-plugin` (`webpack.config.js:73-78`). Edit `src/` only; run `npm run compile` to regenerate `dist/`. Do not hand-edit `dist/`.

## Proposed Changes

### File: `src/webview/kanban.html`

#### 1. Track the previous working state (module-scope)

Near the other board state variables (around `currentCards` / `lastBoardSignature`, ~`kanban.html:5385` region), add:

```js
// Map of cardId -> true while the card was last seen with its activity light on.
// Used to detect the working -> idle edge and fire completion feedback.
let previousWorking = new Map(); // id -> boolean
```

#### 2. Detect the finish edge in `updateBoard` and pass it to `renderBoard`

In the `case 'updateBoard':` block (`kanban.html:6520`), before the signature check decides whether to render, compute the set of cards that just transitioned `working: true → false` (or moved into `COMPLETED`):

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
    previousWorking = nextWorking;

    // ...existing signature/optimistic logic, but when renderBoard is actually
    // called, hand it justFinished so the animation can attach to real DOM nodes.
```

Then thread `justFinished` into every `renderBoard(...)` call inside this case (there are two: the signature-changed branch at `kanban.html:6554` and the featureWorktrees-changed branch at `kanban.html:6560`). Change the signature to `renderBoard(cards, justFinishedIds = new Set())`.

> Note: the `moveCards` case (`kanban.html:6469`) and `moveCardsFailed` also call `renderBoard`; they pass no finish set, which is correct (a manual move is not a "finished operation"). Default param keeps them working unchanged.

#### 3. Show a status bar message for finish events

Add a small helper near `flashIconBtn` (`kanban.html:4488`):

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

(Optionally refactor the existing `showStatusMessage` handler and `moveCardsFailed` block to call this helper to remove duplication — keep behavior identical.)

In `renderBoard`, after the DOM is built, fire the message and the card animation:

```js
function renderBoard(cards, justFinishedIds = new Set()) {
    // ...existing body that builds the DOM...

    // After DOM is in place: completion feedback.
    if (justFinishedIds.size > 0) {
        // Coalesce the status bar message.
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
        // Animate each still-present finished card.
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

### File: `dist/webview/kanban.html`

Do **not** edit by hand. After editing `src/webview/kanban.html`, run `npm run compile` (webpack) so `copy-webpack-plugin` regenerates `dist/webview/kanban.html` from `src/`.

## Verification Plan

1. **Build:** `cd /Users/patrickvuleta/Documents/GitHub/switchboard && npm run compile` — confirm webpack succeeds and `dist/webview/kanban.html` now contains the new `card-op-completed-flash` keyframe and `showStatusBarMessage` helper.
2. **Manual — single finish:** Open the Kanban board. Dispatch an agent to a plan so its amber status light is on. Wait for the working timeout to elapse (or temporarily lower `switchboard.activityLight.timeoutMs` to a few seconds for fast testing). Confirm:
   - The status bar (`#status-message`) shows `"<topic>" finished` and flashes for ~3s.
   - The card plays a brief green glow (`card-op-completed-flash`) that fades within 1.4s.
3. **Manual — completion:** Drag/click a working card into `COMPLETED`. Confirm the message reads `"<topic>" completed` and the same animation plays.
4. **Manual — batch:** With two working cards, let both time out in the same `updateBoard` tick. Confirm a single coalesced message (`2 plans finished`) rather than two overwriting messages, and both cards animate.
5. **Initial load:** Reload the webview while a card is already idle. Confirm **no** finish message fires (no false positive from seeding `previousWorking`).
6. **Reduced motion:** Enable OS "reduce motion". Repeat step 2. Confirm the card animation is suppressed but the status bar message still appears (text feedback remains).
7. **Optimistic window:** Drag a card during an optimistic move window so `renderBoard` is suppressed. Confirm no finish animation/message fires for that tick (it will fire on the next real render if the transition is still pending — acceptable).
8. **No regressions:** Confirm `moveCards`, `moveCardsFailed`, manual drags, and the existing `showStatusMessage` handler still behave as before (the new `renderBoard` second param defaults to an empty set).
