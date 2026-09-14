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

The extension host's clipboard seam is `VscodeHostClipboard` at `src/services/hostSeams.ts:507`,
implementing the `HostClipboard` interface (`:502`). It delegates to `vscode.env.clipboard.writeText`
and resolves `void` on success — the real clipboard write. Both hosts implement the same
`HostClipboard` interface, so changing the return type is a single interface change that touches
both implementors.

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

**Defect C also exists on other copy-then-advance verbs.** The same `await
clipboard.writeText` → unconditional advance pattern appears at `KanbanProvider.ts:12037`
(drag-drop prompt), `:12064` (`batchPlannerPrompt`), `:12093` (`batchLowComplexity`), `:11241`
(lead dispatch IDE mode), and `:13766` (`copyPrompt`/`sendToLead`). These are different buttons with
the same defect. This plan scopes to `promptSelected` and `promptAll` (the Copy Prompt button on the
board and the project panel). The other verbs are acknowledged as out of scope; a follow-up plan
should cover them or they will keep advancing on a headless no-op.

### Root cause

Copy-and-advance is modelled as one action with one outcome, when it is two operations of which only
one can fail. The clipboard write was given a `Promise<void>` signature — `void` being the shape
that cannot express failure — and both of its implementations honour that signature by succeeding
unconditionally. Every layer downstream was then written against a contract that says a copy cannot
fail, so none of them has a branch for it.

## Metadata

**Tags:** bugfix, reliability, ux, frontend
**Complexity:** 6
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
  the signal but leave the existing `.catch`-shaped callers silently wrong. Rejecting makes every
  existing caller correct as written, and is the smaller, safer change. The resolved value stays
  `true` so any caller reading it keeps working.
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
- Returning a tagged result from the two host seams and the `HostClipboard` interface.
- Removing the pre-send `moveCardsOptimistically` call from the `promptSelected`/`promptAll` paths.

### Complex / Risky
- **The transport.js ↔ kanban.html control-flow handoff.** `transport.js:491` copies the prompt
  fire-and-forget in the generic response handler, then dispatches the result to the panel handler.
  The panel handler (kanban.html) decides whether to advance, but it does not know whether the
  transport-layer copy succeeded — the copy is not awaited, and its outcome is not attached to the
  dispatched message. The fix must either (a) gate `transport.js:491` on `copiedByHost !== false` so
  the panel handler owns the copy when the host did not do it, or (b) have `transport.js:491` await
  the copy and attach `clientCopied: boolean` to the result before dispatching. Option (a) is
  cleaner — it keeps the advance decision and the copy in the same handler. This is the single most
  important design decision the implementation must get right.
- **Seventeen+ `sbCopyToClipboard` call sites across `src/webview/`.** The original plan named six;
  the actual count is far higher. Each site that has a `.then` with success UI but no `.catch` will
  show a success message on a failed copy after the reject fix, and each fire-and-forget site with
  no handler at all will produce an unhandled promise rejection. The full audit is in the Proposed
  Changes (Change B). The sites on the copy-prompt-advance path are the ones that must advance
  conditionally; the copy-link and fire-and-forget sites only need a `.catch` to avoid console noise.
- **The optimistic move must become conditional or revertible.** `moveCardsOptimistically`
  (`kanban.html:8449`) exists to hide latency and has a render guard against stale re-renders.
  Making the advance wait for a confirmed copy either removes that optimism for this one path or
  requires a revert, and a half-applied revert leaves the DOM disagreeing with the board.
- **The project panel's optimistic badge update.** `project.js:1871-1878` and `:2574-2581` update
  the column badge optimistically before posting `copyKanbanPlanPrompt`. This is the project panel's
  analogue of `moveCardsOptimistically`. It must also become conditional or revertible, or the badge
  will show the next column while the card has not advanced.
- **Both composition roots wire the clipboard seam.** Changing the `HostClipboard` interface return
  type is a shared interface change; the extension host's `VscodeHostClipboard` must return
  `copied: true` and the headless one `copied: false`, or the honest-reporting fix inverts on one
  host.
- **Other copy-then-advance verbs share Defect C.** `batchPlannerPrompt` (`:12064`),
  `batchLowComplexity` (`:12093`), drag-drop prompt (`:12037`), lead IDE dispatch (`:11241`), and
  `copyPrompt`/`sendToLead` (`:13766`) all `await clipboard.writeText` then advance unconditionally.
  These are out of scope for this plan but must be tracked — a follow-up plan should extend the
  conditional-advance fix to them.

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
    project panel by mirroring the board. **It therefore inherited this defect.** The project panel
    delegates to `KanbanProvider.handleServiceVerb('promptSelected', ...)` via
    `PlanningPanelProvider.ts:4056`, so the backend fix covers it automatically. The project panel's
    frontend optimistic badge update (`project.js:1871-1878`, `:2574-2581`) still needs the
    conditional/revertible treatment.
  - `the-board-teaches-its-own-address-as-a-bare-ip.md` (PLAN REVIEWED) — would remove the
    triggering condition. Independent; neither blocks the other.

## Adversarial Synthesis

**Risk summary.** Key risks: (1) the transport.js ↔ kanban.html handoff — the generic copy at
`transport.js:491` is fire-and-forget and the panel handler cannot see its outcome, so the advance
decision and the copy must be co-located in the panel handler with `transport.js:491` gated off for
`copiedByHost === false` responses; (2) 17+ `sbCopyToClipboard` call sites, of which at least 10
lack a rejection handler and will become unhandled rejections or false success messages after the
reject fix; (3) the project panel's optimistic badge update is a second frontend surface that must
become conditional. Mitigations: gate transport.js on `copiedByHost`, audit every call site, and
apply the badge revert to both project.js sites.

## Proposed Changes

### Change A — the clipboard seam stops lying

#### `src/services/hostSeams.ts:502-514` (the `HostClipboard` interface and `VscodeHostClipboard`)
- **Context:** The `HostClipboard` interface (`:502`) declares `writeText(text: string): Promise<void>`.
  `VscodeHostClipboard` (`:507`) implements it by delegating to `vscode.env.clipboard.writeText`.
  This is the extension host's real clipboard — it succeeds and actually writes.
- **Logic:** Change the interface return type to
  `Promise<{ copied: boolean; via: string }>`. `VscodeHostClipboard.writeText` returns
  `{ copied: true, via: 'host' }` on success. On a `vscode.env.clipboard.writeText` rejection
  (rare — permissions denial), return `{ copied: false, via: 'host' }` and log the error rather
  than throwing, so the backend's copy-then-advance branch can still gate on `copied`.
- **Edge case:** The `readText` method is unchanged — no caller uses it for the advance decision.

#### `src/standalone/hostServices.ts:414-417` and `src/standalone/vscodeShim.ts:608-611`
- **Logic:** return `{ copied: false, via: 'headless-noop' }` instead of resolving `void`. Keep the
  `console.log`, and make it say the prompt was **not** copied and that the browser is expected to
  do it.
- **Edge case:** this is not an error path and must not throw. A headless host with no clipboard is
  the normal, expected configuration for this product.

#### `src/services/KanbanProvider.ts:12509` (and the sibling at `:12624`)
- **Logic:** capture the result. If `copied` is false, do **not** advance — return
  `{ success: true, prompt, advanced: 0, copiedByHost: false }` so the client knows it owns the copy
  *and* owns the advance that follows it. If `copied` is true (extension host), proceed with the
  existing advance logic and return `{ success: true, prompt, targetColumn: nextCol, copiedByHost: true }`.
- **Edge case:** `:12624` is the `promptAll` handler — a second copy-then-advance site in the same
  file. Both must change, or the defect survives on whichever path is missed. Grep for every
  `clipboard.writeText` in the provider before declaring this done.
- **Edge case:** the `!nextCol` early-return paths at `:12518` and `:12629` already return
  `{ success: true, prompt, advanced: 0 }` without advancing. Add `copiedByHost` to these returns
  too so the client can distinguish "no next column" from "host copied" from "host did not copy".

### Change B — `sbCopyToClipboard` rejects on failure

#### `src/webview/clipboardFallback.js:25-33`
- **Logic:** resolve `true` only on a confirmed write; reject with an `Error` naming which path was
  attempted and why it failed (`no-secure-context`, `exec-command-refused`, `api-denied`). Keep the
  async-API branch first and the `execCommand` fallback second.
- **Edge case:** the rejection must name the cause. "Copy failed" sends the operator nowhere;
  "clipboard API unavailable — the board is not on a secure origin" points straight at the fix.

#### The call sites — full audit

> **Superseded:** "Six existing `sbCopyToClipboard` call sites (`transport.js:491`,
> `kanban.html:12301`, `connections.js:517`, `inspect.js:488`, `linear.js:408`,
> `mission-control.js:370`)."
> **Reason:** The actual count is 17+ across `src/webview/`. The original six were a subset and
> missed several sites that have `.then` with success UI but no `.catch` — those will show a success
> message on a failed copy after the reject fix.
> **Replaced with:** The full audit below, grouped by handler shape.

**Sites with `.then` + success UI but NO `.catch` (will show false success after fix — must add
`.catch`):**
- `kanban.html:12231` — worktree prompt copy, flashes `COPIED!`
- `kanban.html:12262` — merge worktree prompt copy, flashes `COPIED!`
- `setup.html:2388` — tutorial prompt copy, flashes `COPIED!`
- `planning.js:5697` — copy plan link, flashes `Copied`
- `project.js:1481` — copy link, flashes `Copied`
- `project.js:1731` — link all, flashes `Copied!`
- `project.js:1860` — copy link, flashes `Copied`
- `project.js:2562` — feature copy link, flashes `Copied`
- `project.js:2816` — subtask copy link, flashes `Copied`
- `project.js:3941` — review copy prompt, flashes `Copied!`

**Fire-and-forget sites with NO handler at all (will produce unhandled rejection after fix — must
add `.catch` or wrap in `try/await`):**
- `kanban.html:12779` — external automation prompt, no `.then`/`.catch`
- `inspect.js:488` — copy hex color, no `.then`/`.catch`
- `terminalViewport.js:1486` — terminal selection copy, no `.then`/`.catch`

**Sites that already have a `.catch` (verify it surfaces the failure, not just `console.warn`):**
- `transport.js:491` — `.catch` logs `console.warn` only. **Special:** this site must be gated on
  `copiedByHost !== false` (see Change C) so it does not double-copy when the panel handler owns
  the copy.
- `kanban.html:12301` — `.then` flashes `COPIED!`, `.catch` exists. Verify the `.catch` shows a
  failure message, not just a console warn.
- `connections.js:517` — `.catch` falls back to `copyTextToClipboard` backend message but still
  shows "Cron prompt copied to clipboard ✓" in both branches. The catch-path message should say
  "Copy failed — pasted to extension clipboard" or similar, not "copied."
- `linear.js:408` — `.catch` surfaces failure to status element. Additionally drops its direct
  `navigator.clipboard.writeText` fallback (`|| ((txt) => navigator.clipboard.writeText(txt))`)
  and uses the helper unconditionally.
- `mission-control.js:370` — `.catch` posts `mcScheduleExternalCopy` in both branches. Acceptable
  for this site (the schedule copy is not on the advance path), but the catch should log the
  failure.
- `project.js:837` — `.then`/`.catch` pair, shows toast on success, toast on catch. ✓

**Sites that already use `await` in `try/catch` (correct as written):**
- `planning.js:1834` — `await` in `try/catch`. ✓
- `planning.js:1867` — `await` in `try/catch`. ✓
- `tickets.js:4792` — `await` in `try/catch`. ✓
- `terminals.js:8822` — `await` in `try/catch`. ✓

### Change C — advance only after a confirmed copy

#### `src/webview/transport.js:491-495` (the generic copy — gate it)
- **Logic:** the generic `if (result && result.prompt && window.sbCopyToClipboard)` copy at
  `:491` runs for every response carrying a `prompt` field. After the fix, when
  `result.copiedByHost === false`, the panel handler (kanban.html) must own the copy so it can chain
  copy → advance. Gate `transport.js:491` on `result.copiedByHost !== false` — i.e. only
  auto-copy when the host already copied (extension host path). When `copiedByHost === false`,
  skip the transport-layer copy and let the panel handler do it.
- **Edge case:** responses without a `copiedByHost` field (older verbs, non-prompt responses) must
  still auto-copy as before. The gate is `copiedByHost === false`, not `copiedByHost === undefined`.

#### `src/webview/kanban.html:9033-9050` (`promptSelected`) and `:9052-9074` (`promptAll`)
- **Logic:** remove the pre-send `moveCardsOptimistically` call from this path. On the response,
  check `result.copiedByHost`:
  - If `copiedByHost === true` (extension host): the backend already advanced. Apply the DOM move
    from the `moveCards` messages the backend sent (existing behaviour).
  - If `copiedByHost === false` (standalone host): call `sbCopyToClipboard(result.prompt)`. On
    resolve, post an explicit advance — `postKanbanMessage({ type: 'moveSelected', column: backendColumn, sessionIds: ids })` — and move the cards in the DOM via `moveCardsOptimistically(ids, column, nextCol)`. On reject, show the failure modal (see below) and leave the cards where they are.
- **Edge case:** the `column !== 'PLAN REVIEWED'` guard on the optimistic move stays meaningful for
  the post-confirmation move — `PLAN REVIEWED` batches are complexity-routed per card by the
  backend, so the client still must not pick a single target for them. For `PLAN REVIEWED` with
  `copiedByHost === false`, the client copies the prompt and posts `moveSelected`; the backend's
  `moveSelected` handler does the complexity routing.
- **Edge case:** `promptAll` at `:9052` has the same structure. Apply the same fix. Note that
  `promptAll` for `CODED_AUTO` already redirects to `promptSelected` at `:9069`.

#### Failure UI
- **Logic:** on rejection, show the prompt in a selectable modal with a Copy button, and leave the
  cards where they are. The modal's Copy handler runs inside a user gesture, so `execCommand`
  succeeds where the async path could not. On a successful click, advance.
- **Edge case:** per CLAUDE.md this modal is **not** a confirmation dialog — it is a recovery
  surface presented only after a failure, and it must not appear on the success path.

#### The project panel — `src/webview/project.js:1867-1886` and `:2569-2586`
- **Logic:** the project panel's `copyKanbanPlanPrompt` handler delegates to
  `PlanningPanelProvider.ts:4056` which calls `KanbanProvider.handleServiceVerb('promptSelected', ...)`.
  The backend fix (Change A) covers the advance. The project panel's frontend optimistic badge
  update at `project.js:1871-1878` (and `:2574-2581`) must become conditional: only update the badge
  after the `kanbanPlanPromptCopied` response confirms `success === true` AND the copy was confirmed.
  Since the project panel does not do a client-side copy (the backend returns the prompt and
  transport.js copies it), the badge update should wait for the `kanbanPlanPromptCopied` response
  and check `result.copiedByHost`. If `copiedByHost === false`, the badge should not update until
  the transport-layer copy succeeds — or the project panel should do its own copy in the
  `kanbanPlanPromptCopied` handler and update the badge only on success.
- **Edge case:** the `kanbanPlanPromptCopied` handler at `project.js:952` currently just updates
  button text. It needs to also handle the `copiedByHost === false` case — do a client-side copy
  and only update the badge on success.

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
5. **No unhandled rejections.** Each of the call sites listed in Change B handles a rejection; a
   test that fails on an unhandled promise rejection during a simulated copy failure.
6. **Transport gate.** When `result.copiedByHost === false`, `transport.js:491` does NOT call
   `sbCopyToClipboard` (the panel handler owns it). When `copiedByHost === true` or undefined, it
   does.
7. **Project panel badge does not advance on failed copy.** Drive `copyKanbanPlanPrompt` with
   `copiedByHost: false` and a failing client-side copy; assert the column badge is unchanged.

### Goal Invariants
1. `src/standalone/hostServices.ts` contains no clipboard `writeText` that resolves without
   reporting `copied: false`. *(Paired positive: `VscodeHostClipboard` in `src/services/hostSeams.ts`
   reports `copied: true`, so the two hosts are distinguishable rather than both silent.)*
2. `clipboardFallback.js` contains a `reject(` call on the failure path, and no `return
   Promise.resolve(false)`.
3. In `kanban.html`, no `moveCardsOptimistically` call appears before the `postKanbanMessage` that
   sends `promptSelected` or `promptAll`.
4. Every `sbCopyToClipboard` call site in `src/webview/` is followed by a rejection handler — count
   of call sites equals count of handlers.
5. `src/webview/linear.js` contains no direct `navigator.clipboard.writeText` fallback.
6. A card whose copy failed has the same `kanban_column` before and after the attempt.
7. `transport.js:491` does not call `sbCopyToClipboard` when `result.copiedByHost === false`.
8. `src/services/hostSeams.ts` `HostClipboard.writeText` return type is not `Promise<void>`.
