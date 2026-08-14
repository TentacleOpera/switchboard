# Copy Dispatch Prompt must not flash "Copied!" on every card's coder-prompt button

## Goal

Make the Planned column's **Copy Dispatch Prompt** button report what it actually did — one dispatch-analysis prompt on the clipboard — instead of hijacking every card's per-card **Copy coder prompt** button and flashing it green with the text `Copied!`.

### Problem

Clicking the Copy Dispatch Prompt button (the `column-icon-btn` on the Planned / `PLAN REVIEWED` column) makes **every card in the column** flash a green `Copied!` label on its own copy button. That button is labelled `Copy coder prompt` on the Planned column. No coder prompt was copied. The clipboard holds a single *planner* dispatch-analysis prompt covering the whole batch. The feedback is lying about both **which prompt** was copied and **how many** copies happened.

This is worse than cosmetic: the per-card copy button is the user's only affordance for "give me the coder prompt for this one card." Flashing it `Copied!` teaches the user that the card's coder prompt is on the clipboard when it is not — a paste after that flash produces the wrong prompt entirely.

### Root cause

Two independent pieces, wired together by a copy-paste of the wrong success loop.

**1. The backend arm emits per-card copy confirmations it has no right to emit.**

`src/services/KanbanProvider.ts:10772` handles `copyDispatchPromptSelected`. The arm is correct right up to the clipboard write — it deliberately builds the *planner* `dispatch-analysis` prompt via `generateUnifiedPrompt('planner', …)` (`:10821-10824`) rather than `_generatePromptForColumn`, and the in-file comment at `:10773-10782` explains exactly why. Then, at `:10825-10830`, it runs the success loop lifted verbatim from `promptSelected`:

```ts
await this._seams().clipboard.writeText(prompt);
for (const card of sourceCards) {
    const sid = this._cardId(card);
    this.postMessage({ type: 'copyPlanLinkResult', planId: sid, sessionId: sid, success: true });
}
this.postMessage({ type: 'showStatusMessage', message: `Copied dispatch-analysis prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
```

`copyPlanLinkResult` is a **per-card, per-prompt** signal. In `promptSelected` / `promptAll` (`KanbanProvider.ts:9901`, `9934`, `9965`, `9972`, `9987`) that loop is honest — those arms call `_generatePromptForColumn`, which builds precisely the advance prompt the per-card button copies, and then advance the cards. In `copyDispatchPromptSelected` neither is true: a *different* prompt was built, and nothing advanced. The loop was inherited, not designed.

**2. The webview arm is hard-wired to the per-card advance button.**

`src/webview/kanban.html:9070` handles `copyPlanLinkResult` and resolves the target by DOM query:

```js
btn = document.querySelector(`.card-btn.copy[data-plan-id="${CSS.escape(msg.planId)}"]`);
…
btn.textContent = 'Copied!';
btn.classList.add('copied');
```

`.card-btn.copy` is the per-card advance-prompt button rendered at `kanban.html:7722`. Its label comes from the `copyLabel` switch at `kanban.html:7673-7714`: for a card in `PLAN REVIEWED`, `getNextColumn` resolves to a coded lane whose `role` is `lead` / `coder` / `intern`, so `copyLabel === 'Copy coder prompt'` (`:7704`). The `.copied` class runs the `copyFlash` keyframes at `kanban.html:1161` — a 1.5s green (`--vscode-testing-iconPassed`) background. That is the exact green `Copied!` the user is seeing, on the exact button the user named.

Because the button label is replaced by literal `Copied!` and only restored from `btn.dataset.copyLabel` after the animation (`:9085`, `:9100`), the user watches `Copy coder prompt` turn into `Copied!` on N cards at once.

**Amplifier — no selection means the whole column.** The arm sends the whole column's ids when nothing is selected (`KanbanProvider.ts:10801-10810`), by design — the button is a batch, not a selection gate. So the default click path is the one that flashes *every* card.

**Amplifier — the message is a broadcast.** `postMessage` fans out to every connected board client (VS Code webview and standalone browser board both consume `kanban.html`), so a second open board flashes its cards too, for a clipboard write that happened on someone else's machine session.

### The fix

Delete the per-card loop. The arm already posts the correct, batch-shaped feedback on the next line — `showStatusMessage`, handled at `kanban.html:8401` and rendered by `showStatusBarMessage` (`kanban.html:5847`) into the `#status-message` sub-bar element (`kanban.html:2836`) in accent teal for ~5 seconds. And the clicked column button already gets its own local flash: the global click listener at `kanban.html:13219-13225` calls `flashIconBtn(btn)` on any clicked `button`, applying the `.flash` scale animation (`kanban.html:1180`). Both surfaces are already wired; the card-level flash is pure noise on top of them.

No new UI, no new message type, no CSS. One loop removed, plus a regression test so the loop cannot be re-pasted back in.

## Metadata

- **Complexity:** 2
- **Tags:** bugfix, ui, frontend
- **Project:** Browser Switchboard

## User Review Required

None. The scope is a single `switch` arm; the five sibling emit sites and the single-card arm are explicitly out of scope and are guarded by the new test.

## Complexity Audit

### Routine

- The change is a four-line deletion in one `switch` arm plus one new source-reading regression test. No control flow, no state, no persistence, no migration.
- Nothing shipped depends on the removed message: `copyPlanLinkResult` is fire-and-forget UI feedback with no acknowledgement, no DB write, and no effect on the arm's return value (`{ success: true, prompt }`), which is what the HTTP/verb caller receives.
- No migration concern (per the repo's shipped-state rule): nothing is persisted by this path. The removed message is transient UI chatter.
- PRD gates are untouched: the arm already `return`s in-body (contract #4), already has a `verbSchemas.ts` entry (`:396`), and no verb is added, so `verb-returns:check` / `parity:check` / `catalog:check` are unaffected.

### Complex / Risky

- **The one thing worth care:** the *other* five `copyPlanLinkResult` emit sites in `KanbanProvider.ts` (`9901`, `9934`, `9965`, `9972`, `9987`, all inside `promptSelected` / `promptAll`) and the single-card `copyPlanLink` arm at `:10441` (emitting at `:10445`) are all legitimate and must be left alone. A careless "remove the duplicated loop" sweep would strip the honest feedback from the prompt buttons too. The edit must be scoped to the `copyDispatchPromptSelected` arm only, and the regression test asserts both directions.
- **The regression test slices a `switch` arm by string search**, which is inherently positional. Harden it: assert the slice actually contains `generateUnifiedPrompt('planner'` before asserting the absence of `copyPlanLinkResult`, so a mis-slice fails loudly instead of passing vacuously.

## Edge-Case & Dependency Audit

### Side Effects

- **Dispatch view.** The same DOM column renders `DISPATCH` cards when `showingDispatch` is on, and the Copy Dispatch Prompt button is shown in both views (`kanban.html:6331-6340` — see the comment at `:6334-6335`). Removing the card flash fixes both views identically; there is no view-specific branch to add.
- **Multi-client broadcast.** Removing the loop also removes the cross-client card flash on other connected boards. That is the desired outcome, not a regression — no other client's clipboard received anything.
- **`prompt-ready` state is untouched.** The separate `.card-btn.copy.prompt-ready` amber-glow path (`kanban.html:1175`, handled at `kanban.html:9111`) uses a different message and is unrelated.
- **No confirmation dialog.** Per repo rule, the button keeps firing immediately; this change only alters post-hoc feedback.

### Dependencies & Conflicts

- **Empty column / no matching plans.** The arm returns early with `showInformationMessage` before reaching the loop (`KanbanProvider.ts:10796-10810`, `:10817-10820`). Unaffected.
- **API / verb callers.** `copyDispatchPromptSelected` is in `KANBAN_VERBS` (`src/generated/verbAllowlist.ts`) and schema'd at `src/services/verbSchemas.ts:396`, so an HTTP caller can invoke it with no webview attached. The return shape `{ success: true, prompt }` is unchanged; only a UI-side broadcast disappears. No contract break.
- **`promptSelected` / `promptAll` must keep flashing.** Those arms copy exactly the prompt the per-card button copies and then advance the cards; their per-card `copyPlanLinkResult` is the correct signal and is explicitly out of scope.
- **`copyPlanLink` (single card, `KanbanProvider.ts:10441`) must keep flashing.** It targets one card and copies that card's link — the message's original, correct use.
- **Sibling subtasks.** Independent. The other two subtasks in this feature edit `src/webview/kanban.html` only; this one edits `src/services/KanbanProvider.ts` and adds a test file. No shared surface, no ordering constraint.
- **Test-only dependency:** the new regression test reads `KanbanProvider.ts` as text (the established pattern in `src/test/kanban-card-button-drag-guard.test.js`), so it needs no VS Code host and no compile step.

### Race Conditions

- **None introduced.** The change removes messages; it adds no timing, no ordering, and no shared state. The remaining `showStatusMessage` and the local `.flash` are both fire-and-forget and already coexist today.

### Security

- **None.** No new input is accepted, no new surface is exposed; a broadcast of card ids to every connected client is *removed*, which is a marginal reduction in leaked state across multi-client boards.

## Dependencies

None (no session dependencies, no ordering constraint against the sibling subtasks).

## Adversarial Synthesis

**Key risks:** an over-broad "remove the duplicated loop" edit strips the five legitimate `copyPlanLinkResult` emits in `promptSelected`/`promptAll` and the single-card `copyPlanLink` arm, silently removing honest feedback from three working buttons; and the replacement feedback (`#status-message`) is assumed to render on the standalone browser board rather than verified. **Mitigations:** the regression test asserts both directions — absent in `copyDispatchPromptSelected`, present in `promptSelected` and `copyPlanLink` — and hardens its arm slice with a positive marker so a mis-slice fails loudly; and the manual plan verifies the status bar visually on both the VS Code webview and the browser cockpit rather than reasoning from the shared document.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — drop the per-card copy confirmations from `copyDispatchPromptSelected`

At `:10825-10830`, replace:

```ts
                await this._seams().clipboard.writeText(prompt);
                for (const card of sourceCards) {
                    const sid = this._cardId(card);
                    this.postMessage({ type: 'copyPlanLinkResult', planId: sid, sessionId: sid, success: true });
                }
                this.postMessage({ type: 'showStatusMessage', message: `Copied dispatch-analysis prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
```

with:

```ts
                await this._seams().clipboard.writeText(prompt);
                // Deliberately NO per-card copyPlanLinkResult loop. That message flashes the
                // card's own `.card-btn.copy` — the ADVANCE prompt button, labelled "Copy coder
                // prompt" on this column — green with the text "Copied!". What actually landed on
                // the clipboard is ONE planner dispatch-analysis prompt for the whole batch, so a
                // per-card confirmation is wrong on both counts: wrong prompt, wrong cardinality.
                // (The loop was inherited from promptSelected, where it IS honest — that arm
                // copies exactly the per-card advance prompt and then advances the cards.)
                // Correct feedback for a batch clipboard write: the status bar below, plus the
                // clicked column button's own .flash from the global click listener in kanban.html.
                this.postMessage({ type: 'showStatusMessage', message: `Copied dispatch-analysis prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
```

Nothing else in the arm changes. `sourceCards` is still used by the status message and by the earlier guards, so no unused-variable fallout. `this._cardId` remains used throughout the file.

### 2. `src/test/copy-dispatch-prompt-no-card-flash.test.js` — new regression test

Source-reading test in the style of `src/test/kanban-card-button-drag-guard.test.js`, so it runs standalone under node with no VS Code host.

```js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PROVIDER = path.join(__dirname, '../services/KanbanProvider.ts');

/** Slice a `switch (msg.type)` arm from its case label to the next case label. */
function sliceArm(src, label) {
    const start = src.indexOf(`case '${label}': {`);
    assert.notStrictEqual(start, -1, `${label} arm must exist in KanbanProvider.ts`);
    const end = src.indexOf("case '", start + `case '${label}': {`.length);
    assert.notStrictEqual(end, -1, `Could not find the end of the ${label} arm`);
    return src.slice(start, end);
}

/**
 * Regression: the Planned column's Copy Dispatch Prompt button copies ONE planner
 * dispatch-analysis prompt for the whole batch. It must not emit per-card
 * copyPlanLinkResult messages — those flash each card's `.card-btn.copy` (labelled
 * "Copy coder prompt" on this column) green with "Copied!", claiming a prompt that
 * was never copied.
 */
function testCopyDispatchPromptEmitsNoCardFlash() {
    const src = fs.readFileSync(PROVIDER, 'utf8');
    const arm = sliceArm(src, 'copyDispatchPromptSelected');

    // Positive marker first: proves we sliced the arm we think we did, so the
    // absence assertion below can never pass vacuously on a mis-slice.
    assert.ok(
        arm.includes("generateUnifiedPrompt('planner'"),
        'Slice does not look like the copyDispatchPromptSelected arm (no planner prompt build) — the arm boundaries moved.'
    );

    assert.ok(
        !arm.includes('copyPlanLinkResult'),
        'copyDispatchPromptSelected must NOT post copyPlanLinkResult — it flashes each card\'s ' +
        'coder-prompt button "Copied!" for a prompt that was never copied per-card.'
    );

    assert.ok(
        /showStatusMessage[\s\S]*?dispatch-analysis prompt/.test(arm),
        'copyDispatchPromptSelected must still report the batch copy via showStatusMessage.'
    );
}

/**
 * Guard the other side: promptSelected DOES copy the per-card advance prompt and
 * advance the cards, so its per-card flash is correct and must survive.
 */
function testPromptSelectedKeepsCardFlash() {
    const src = fs.readFileSync(PROVIDER, 'utf8');
    const start = src.indexOf("case 'promptSelected': {");
    assert.notStrictEqual(start, -1, 'promptSelected arm must exist');
    const end = src.indexOf("case 'promptAll': {", start);
    assert.notStrictEqual(end, -1, 'promptAll arm must exist');

    assert.ok(
        src.slice(start, end).includes('copyPlanLinkResult'),
        'promptSelected must keep its per-card copyPlanLinkResult — it copies exactly the ' +
        'per-card advance prompt, so the card flash is honest there.'
    );
}

/** The single-card arm is the message's original, correct use. */
function testCopyPlanLinkKeepsCardFlash() {
    const src = fs.readFileSync(PROVIDER, 'utf8');
    assert.ok(
        sliceArm(src, 'copyPlanLink').includes('copyPlanLinkResult'),
        'copyPlanLink must keep its copyPlanLinkResult — one card, one link, one flash.'
    );
}

testCopyDispatchPromptEmitsNoCardFlash();
testPromptSelectedKeepsCardFlash();
testCopyPlanLinkKeepsCardFlash();
console.log('✓ copy-dispatch-prompt-no-card-flash: dispatch copy does not flash card buttons; prompt/link arms still do');
```

### 3. `package.json` — register the regression test script

Alongside the existing `test:regression:*` entries (`:831-832`):

```json
"test:regression:copy-dispatch-flash": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/copy-dispatch-prompt-no-card-flash.test.js",
```

### Explicitly not changed

- `src/webview/kanban.html` — the `copyPlanLinkResult` handler at `:9070` stays exactly as-is. It is correct for its real callers (`copyPlanLink`, `promptSelected`, `promptAll`); the defect was an arm sending it that shouldn't. Narrowing the handler would break the honest callers.
- The five `copyPlanLinkResult` emits in `promptSelected` / `promptAll` (`9901`, `9934`, `9965`, `9972`, `9987`).
- The single-card `copyPlanLink` arm (`10441`, emitting at `10445`).
- All CSS (`copyFlash` `:1161`, the `.flash` keyframes `:1180`, `promptReadyGlow` `:1175`) and the `#status-message` sub-bar (`:2836`).

## Verification Plan

### Automated Tests

1. `node src/test/copy-dispatch-prompt-no-card-flash.test.js` — passes. Then re-introduce the deleted loop locally and confirm the first assertion **fails** (proves the test actually guards the defect), and revert.
2. `npx tsc --noEmit -p .` (or the repo's typecheck entry) — no new errors; confirms `sourceCards` and `_cardId` have no dangling references after the deletion.
3. Run the existing kanban webview/provider tests (`src/test/kanban-card-button-drag-guard.test.js`, `src/test/browser-panel-verb-routing.test.js`, `src/test/verb-engine-kanban-headless.test.js`) — no new failures. Per the repo's known-red baseline, stash-verify any failure against HEAD before attributing it to this change.
4. `npm run verb-returns:check` and `npm run parity:check` — unchanged (no verb added, no `break` introduced); run as a no-drift confirmation only.

### Manual — VS Code extension (build and install the VSIX; do not test from `dist/`)

5. Board → Planned column, **nothing selected**. Click Copy Dispatch Prompt.
   - Expect: **no** card turns green; **no** card's `Copy coder prompt` label changes.
   - Expect: the column button itself gives its brief scale `.flash`.
   - Expect: `#status-message` shows `Copied dispatch-analysis prompt for N plan(s) to clipboard.` in teal, clearing after ~5s.
   - Paste into a scratch buffer: it is the **planner dispatch-analysis** prompt covering all N plans — not a coder advance prompt.
6. Same, with **2 of 5 cards selected**. Same expectations; status message reads `2 plan(s)`; the pasted prompt covers only those 2.
7. Toggle **Dispatch view** on the Planned column and repeat step 5 — identical behaviour (no card flash, status message present).
8. **Control (must still flash):** click a single card's `Copy coder prompt` button → that one button turns green `Copied!` and restores its label. Then click the column's `Prompt Selected` button with a selection → those cards flash `Copied!` **and** advance. Both paths are unchanged.
9. **Empty column:** clear/filter Planned to zero cards and click the button → the existing information message appears, no flash, no status message.

### Manual — standalone browser board (`kanban.html` is the shared document for both surfaces)

10. Open the standalone browser board, repeat step 5. Verify no card flash and that `#status-message` renders the confirmation there too — the sub-bar is present in the shared document, but confirm visually rather than assuming, and remember the browser panel is served from the installed VSIX's `dist/` (rebuild and reinstall first).
11. With **two boards open simultaneously** (VS Code webview + browser), click Copy Dispatch Prompt in one. Verify the *other* board shows no card flash — the cross-client phantom confirmation is gone.

---

**Recommendation:** Complexity 2 → **Send to Intern.**
