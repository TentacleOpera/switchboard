# A Card Advances on a Copy That Never Reached the Clipboard

## Goal

Copy Prompt must not advance a card unless the prompt actually reached the clipboard. Today the
advance is unconditional and every layer that could have detected the failure reports success, so
the operator loses the prompt and the card moves anyway — with nothing on screen or in the log
saying so.

### Problem analysis

**Reproduced on this board, 2026-09-14.** Two cards were selected in `CREATED` and Copy Prompt was
pressed. Both advanced to `PLAN REVIEWED` (`73a271e9` and `4aa33a28`, `column_entered_at`
`2026-09-14T21:41:21Z`). The clipboard was never written. No error appeared, no toast, no console
warning.

The call chain has **three independent defects**, each of which alone would be enough to lose the
prompt silently.

**Defect A — the standalone clipboard seam is a no-op that reports success.**

`KanbanProvider.ts:12509`, inside the `promptSelected` handler:

```ts
const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);
await this._seams().clipboard.writeText(prompt);
```

On the standalone host — the one that actually runs on the Pi — that seam is
`src/standalone/hostServices.ts:415`:

```ts
writeText: async (text: string) => { console.log('[headless clipboard] writeText'); },
```

and `src/standalone/vscodeShim.ts:609`:

```ts
async writeText(_text: string): Promise<void> { /* no-op headless */ },
```

Both resolve successfully having done nothing. This is the failure mode CLAUDE.md names directly —
*"a fallback must never be indistinguishable from a real value"* — in its purest form: the seam's
success value is identical whether the clipboard was written or the host has no clipboard at all.
The `await` cannot fail, so control always reaches the advance below it. A headless host having no
clipboard is correct and expected; **reporting that as a completed write is not**.

**Defect B — the browser fallback signals failure by return value, and every caller uses `.catch`.**

`src/webview/clipboardFallback.js:25-33`:

```js
window.sbCopyToClipboard = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
            .then(function () { return true; })
            .catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
};
```

`fallbackCopy` returns `false` when `document.execCommand('copy')` fails (`:49-51`). The function
therefore **resolves with `false` on failure and never rejects**. Every caller in the tree treats it
as a rejecting promise. `src/webview/transport.js:491`:

```js
if (result && result.prompt && window.sbCopyToClipboard) {
    window.sbCopyToClipboard(result.prompt).catch(function (err) {
        console.warn('[transport] Clipboard write failed:', err);
    });
}
```

A resolved-`false` promise runs `.then`, not `.catch`. That `.catch` is unreachable for the one
failure it was written to catch. `kanban.html:12301` has the same shape with a `.then` that flashes
`COPIED!` — so a failed copy renders a success message.

**Why the fallback fails here specifically.** The board is reached over `http://<pi-ip>:7777`, which
is not a [secure context], so `navigator.clipboard` is `undefined` and the first branch is skipped
entirely. `fallbackCopy` then calls `document.execCommand('copy')` from inside a `fetch().then()`
callback — after the round-trip, long outside the click's user-gesture window, which browsers
require for a programmatic copy. It returns `false`. Both paths to the clipboard are closed, and the
closure is reported as success.

This is adjacent to `browser-surface-verb-failures.md` (COMPLETED), which fixed the
`result.success === false` toast on the *very next lines* of the same handler (`:496`). It did not
touch the clipboard branch above it, so the gap is genuinely open rather than a regression.

**Defect C — the advance is not conditioned on the copy, in either layer.**

- **Webview** (`kanban.html:9033-9050`): for any source column other than `PLAN REVIEWED`,
  `moveCardsOptimistically(ids, column, nextCol)` runs *before* `postKanbanMessage` is called. The
  card moves on screen before the request is even sent, and nothing reverts it.
- **Backend** (`KanbanProvider.ts:12509` then `:12595`): `clipboard.writeText` is awaited and its
  result discarded, then `moveCardToColumn` runs unconditionally.

So even if Defects A and B were fixed and the failure were known, the advance would still happen.
There is no branch to put the knowledge into.

### Root cause

Copy-and-advance is modelled as one action with one outcome, when it is two operations of which only
one can fail. The clipboard write was given a `Promise<void>` signature — `void` being the shape
that cannot express failure — and both of its implementations honour that signature by succeeding
unconditionally. Every layer downstream was then written against a contract that says a copy cannot
fail, so none of them has a branch for it.

## Metadata

**Tags:** bugfix, reliability, ux, frontend
**Complexity:** 5
**Repo:** switchboard

## User Review Required

No. The behaviour asked for is explicit: a card must not change column unless the prompt reached the
clipboard.

## Settled Design

- **Copy first, advance second, and only on confirmation.** The advance becomes a consequence of a
  confirmed copy rather than a sibling of an attempted one.
- **The clipboard seam stops returning `void`.** It returns `{ copied: boolean; via: 'host' | 'headless-noop' | 'async-api' | 'exec-command' | 'none' }` — the tagged-source form CLAUDE.md
  prescribes for exactly this class of read. `'headless-noop'` is what the standalone seam returns,
  and it carries `copied: false`, because that is the truth.
- **A headless host is not a failure, it is a different path.** The standalone host legitimately has
  no clipboard; the browser is the only place a copy can happen. So the backend must stop pretending
  to copy and instead hand the prompt to the client, which is already the transport's design
  (`transport.js:491`). The fix is to make the backend *honest* about not copying, not to give it a
  clipboard.
- **`sbCopyToClipboard` must reject on failure.** Changing it to return a tagged object would fix
  the signal but leave the six existing `.catch`-shaped callers silently wrong. Rejecting makes
  every existing caller correct as written, and is the smaller, safer change. The resolved value
  stays `true` so any caller reading it keeps working.
- **When the copy cannot be automated, ask for one click rather than failing.** A non-secure origin
  plus an async call site means no automatic copy is possible. Showing the prompt in a selectable
  modal with a Copy button — whose handler runs *inside* a user gesture, where `execCommand` works —
  converts an unrecoverable failure into one deliberate click, and the advance follows the copy.
- **Not fixed here: the insecure origin.** Serving the board over a secure context would restore
  `navigator.clipboard` and make the fallback unnecessary. That is
  `the-board-teaches-its-own-address-as-a-bare-ip.md` (currently PLAN REVIEWED), and this plan must
  not wait on it — the ordering and honesty defects are real on a secure origin too, where a copy
  can still be denied by permissions policy.

## Complexity Audit

### Routine
- Making `sbCopyToClipboard` reject.
- Returning a tagged result from the two host seams.

### Complex / Risky
- **Six existing `sbCopyToClipboard` call sites** (`transport.js:491`, `kanban.html:12301`,
  `connections.js:517`, `inspect.js:488`, `linear.js:408`, `mission-control.js:370`). Making the
  helper reject turns a silent no-op into a visible rejection at all of them — which is the intent,
  but each needs its handler checked so a rejection surfaces as a message rather than an unhandled
  promise rejection in the console. `linear.js:408` is the sharp one: it falls back to
  `navigator.clipboard.writeText` directly when the helper is absent, so it bypasses the fix and
  must be routed through the helper.
- **The optimistic move must become conditional or revertible.** `moveCardsOptimistically`
  (`kanban.html:4942`) exists to hide latency and has a render guard against stale re-renders.
  Making the advance wait for a confirmed copy either removes that optimism for this one path or
  requires a revert, and a half-applied revert leaves the DOM disagreeing with the board.
- **Both composition roots wire the clipboard seam.** Changing the seam's return type is a shared
  interface change; the extension host's real clipboard must return `copied: true` and the headless
  one `copied: false`, or the honest-reporting fix inverts on one host.

## Edge-Case & Dependency Audit

- **Race conditions.** Two rapid Copy Prompt clicks could interleave copy-confirm and advance. The
  advance must carry the card ids it was confirmed for, not re-read the current selection.
- **Security.** None new. No new endpoint; the prompt already crosses this boundary.
- **Side effects.** Failing to advance is now a *visible* outcome where it used to be an invisible
  success. Expect reports of "the card didn't move" that are this fix working.
- **Dependencies & conflicts.**
  - `browser-surface-verb-failures.md` (COMPLETED) — owns the `success === false` branch immediately
    below the clipboard branch in the same handler. Do not disturb it; this plan adds the sibling
    branch it deliberately left.
  - `bug_copy_prompt_advance_column_project_panel.md` (COMPLETED) — added copy-prompt advance to the
    project panel by mirroring the board. **It therefore inherited this defect.** The same
    conditional-advance fix must land on both project-panel paths, or the panels diverge again in
    the opposite direction.
  - `the-board-teaches-its-own-address-as-a-bare-ip.md` (PLAN REVIEWED) — would remove the
    triggering condition. Independent; neither blocks the other.

## Adversarial Synthesis

**Risk summary.** The change is small in lines and broad in reach: one helper's contract, one seam's
return type, and an ordering change in two panels. The main risk is turning silent failures into
unhandled rejections at six call sites — visible noise instead of visible errors — so each caller
must be audited, not just the helper. The second risk is the optimistic-move revert leaving the DOM
out of step with the board on a failed copy; the safer route is to not move optimistically on this
path at all and accept one round-trip of latency, since the copy must be confirmed before the move
is legitimate anyway. The third is scope creep into the secure-context work, which is a different
plan and must stay there.

## Proposed Changes

### Change A — the clipboard seam stops lying

#### `src/standalone/hostServices.ts:415` and `src/standalone/vscodeShim.ts:609`
- **Logic:** return `{ copied: false, via: 'headless-noop' }` instead of resolving `void`. Keep the
  `console.log`, and make it say the prompt was **not** copied and that the browser is expected to
  do it.
- **Edge case:** this is not an error path and must not throw. A headless host with no clipboard is
  the normal, expected configuration for this product.

#### The extension host's clipboard seam
- Return `{ copied: true, via: 'host' }` on success. Find it by the same seam name; do not assume
  one file.

#### `src/services/KanbanProvider.ts:12509` (and the sibling at `:12624`)
- **Logic:** capture the result. If `copied` is false, do **not** advance — return
  `{ success: true, prompt, advanced: 0, copiedByHost: false }` so the client knows it owns the copy
  *and* owns the advance that follows it.
- **Edge case:** `:12624` is a second copy-then-advance site in the same file. Both must change, or
  the defect survives on whichever path is missed. Grep for every `clipboard.writeText` in the
  provider before declaring this done.

### Change B — `sbCopyToClipboard` rejects on failure

#### `src/webview/clipboardFallback.js:25-33`
- **Logic:** resolve `true` only on a confirmed write; reject with an `Error` naming which path was
  attempted and why it failed (`no-secure-context`, `exec-command-refused`, `api-denied`). Keep the
  async-API branch first and the `execCommand` fallback second.
- **Edge case:** the rejection must name the cause. "Copy failed" sends the operator nowhere;
  "clipboard API unavailable — the board is not on a secure origin" points straight at the fix.

#### The six call sites
- `transport.js:491`, `kanban.html:12301`, `connections.js:517`, `inspect.js:488`, `linear.js:408`,
  `mission-control.js:370` — confirm each has a `.catch` that surfaces the failure to the user
  rather than only `console.warn`. `linear.js:408` additionally drops its direct
  `navigator.clipboard.writeText` fallback and uses the helper unconditionally.

### Change C — advance only after a confirmed copy

#### `src/webview/kanban.html:9033-9050` (`promptSelected`) and `:9052-9074` (`promptAll`)
- **Logic:** remove the pre-send `moveCardsOptimistically` call from this path. On the response,
  copy the prompt; **only** if the copy resolves, post an explicit advance for the confirmed ids and
  move the cards in the DOM.
- **Edge case:** the `column !== 'PLAN REVIEWED'` guard on the optimistic move stays meaningful for
  the post-confirmation move — `PLAN REVIEWED` batches are complexity-routed per card by the
  backend, so the client still must not pick a single target for them.

#### Failure UI
- **Logic:** on rejection, show the prompt in a selectable modal with a Copy button, and leave the
  cards where they are. The modal's Copy handler runs inside a user gesture, so `execCommand`
  succeeds where the async path could not. On a successful click, advance.
- **Edge case:** per CLAUDE.md this modal is **not** a confirmation dialog — it is a recovery
  surface presented only after a failure, and it must not appear on the success path.

#### The project panel
- Apply the same ordering to both copy-prompt paths named in
  `bug_copy_prompt_advance_column_project_panel.md`, so the two surfaces stay identical.

## Verification Plan

### Automated Tests
1. **Headless seam is honest.** `hostServices`' clipboard returns `copied: false`. A test asserting
   the standalone seam never reports a completed write — this fails against today's code.
2. **Helper rejects.** With `navigator.clipboard` undefined and `execCommand` stubbed to return
   `false`, `sbCopyToClipboard` **rejects**. Today it resolves `false`; this is the regression test
   for Defect B.
3. **No advance without a copy.** Drive `promptSelected` with a failing clipboard and assert the
   card's `kanban_column` is unchanged. The headline test — it reproduces the reported bug.
4. **Advance after a confirmed copy.** The success path still advances, so the fix does not simply
   disable the feature.
5. **No unhandled rejections.** Each of the six call sites handles a rejection; a test that fails on
   an unhandled promise rejection during a simulated copy failure.

### Goal Invariants
1. `src/standalone/hostServices.ts` contains no clipboard `writeText` that resolves without
   reporting `copied: false`. *(Paired positive: the extension host's seam reports `copied: true`,
   so the two hosts are distinguishable rather than both silent.)*
2. `clipboardFallback.js` contains a `reject(` call on the failure path, and no `return
   Promise.resolve(false)`.
3. In `kanban.html`, no `moveCardsOptimistically` call appears before the `postKanbanMessage` that
   sends `promptSelected` or `promptAll`.
4. Every `sbCopyToClipboard` call site in `src/webview/` is followed by a rejection handler — count
   of call sites equals count of handlers.
5. `src/webview/linear.js` contains no direct `navigator.clipboard.writeText` fallback.
6. A card whose copy failed has the same `kanban_column` before and after the attempt.
