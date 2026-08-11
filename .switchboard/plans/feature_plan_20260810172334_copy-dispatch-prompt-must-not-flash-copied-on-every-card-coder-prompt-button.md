# Copy Dispatch Prompt must not flash "Copied!" on every card's coder-prompt button

## Goal

Make the Planned column's **Copy Dispatch Prompt** button report what it actually did — one dispatch-analysis prompt on the clipboard — instead of hijacking every card's per-card **Copy coder prompt** button and flashing it green with the text `Copied!`.

### Problem

Clicking the Copy Dispatch Prompt button (the `column-icon-btn` on the Planned / `PLAN REVIEWED` column) makes **every card in the column** flash a green `Copied!` label on its own copy button. That button is labelled `Copy coder prompt` on the Planned column. No coder prompt was copied. The clipboard holds a single *planner* dispatch-analysis prompt covering the whole batch. The feedback is lying about both **which prompt** was copied and **how many** copies happened.

This is worse than cosmetic: the per-card copy button is the user's only affordance for "give me the coder prompt for this one card." Flashing it `Copied!` teaches the user that the card's coder prompt is on the clipboard when it is not — a paste after that flash produces the wrong prompt entirely.

### Root cause

Two independent pieces, wired together by a copy-paste of the wrong success loop.

**1. The backend arm emits per-card copy confirmations it has no right to emit.**

`src/services/KanbanProvider.ts:10482` handles `copyDispatchPromptSelected`. The arm is correct right up to the clipboard write — it deliberately builds the *planner* `dispatch-analysis` prompt via `generateUnifiedPrompt('planner', …)` rather than `_generatePromptForColumn` (the in-file comment at 10483–10492 explains exactly why). Then, at lines 10536–10539, it runs the success loop lifted verbatim from `promptSelected`:

```ts
await this._seams().clipboard.writeText(prompt);
for (const card of sourceCards) {
    const sid = this._cardId(card);
    this.postMessage({ type: 'copyPlanLinkResult', planId: sid, sessionId: sid, success: true });
}
this.postMessage({ type: 'showStatusMessage', message: `Copied dispatch-analysis prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
```

`copyPlanLinkResult` is a **per-card, per-prompt** signal. In `promptSelected` / `promptAll` (`KanbanProvider.ts:9677`, `9710`, `9741`, `9748`, `9763`) that loop is honest — those arms call `_generatePromptForColumn`, which builds precisely the advance prompt the per-card button copies, and then advance the cards. In `copyDispatchPromptSelected` neither is true: a *different* prompt was built, and nothing advanced. The loop was inherited, not designed.

**2. The webview arm is hard-wired to the per-card advance button.**

`src/webview/kanban.html:8326` handles `copyPlanLinkResult` and resolves the target by DOM query:

```js
btn = document.querySelector(`.card-btn.copy[data-plan-id="${CSS.escape(msg.planId)}"]`);
…
btn.textContent = 'Copied!';
btn.classList.add('copied');
```

`.card-btn.copy` is the per-card advance-prompt button rendered at `kanban.html:7000`. Its label comes from the `copyLabel` switch at `kanban.html:6975–6990`: for a card in `PLAN REVIEWED`, `getNextColumn` resolves to a coded lane whose `role` is `lead` / `coder` / `intern`, so `copyLabel === 'Copy coder prompt'`. The `.copied` class runs the `copyFlash` keyframes at `kanban.html:1166` — a 1.5s green (`--vscode-testing-iconPassed`) background. That is the exact green `Copied!` the user is seeing, on the exact button the user named.

Because the button label is replaced by literal `Copied!` and only restored from `btn.dataset.copyLabel` after the animation, the user watches `Copy coder prompt` turn into `Copied!` on N cards at once.

**Amplifier — no selection means the whole column.** `kanban.html:5936` sends the whole column's ids when nothing is selected (by design — the button is a batch, not a selection gate). So the default click path is the one that flashes *every* card.

**Amplifier — the message is a broadcast.** `postMessage` fans out to every connected board client (VS Code webview and standalone browser board both consume `kanban.html`), so a second open board flashes its cards too, for a clipboard write that happened on someone else's machine session.

### The fix

Delete the per-card loop. The arm already posts the correct, batch-shaped feedback on the next line — `showStatusMessage`, rendered by `showStatusBarMessage` (`kanban.html:5184`) into the `#status-message` sub-bar element (`kanban.html:2832`) in accent teal for 5 seconds. And the clicked column button already gets its own local flash: the global click listener at `kanban.html:12458` calls `flashIconBtn(btn)` on any clicked `button`, applying the `.flash` scale animation (`kanban.html:1180`). Both surfaces are already wired; the card-level flash is pure noise on top of them.

No new UI, no new message type, no CSS. One loop removed, plus a regression test so the loop cannot be re-pasted back in.

## Metadata

- **Complexity:** 2
- **Tags:** bugfix, ui, frontend
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.**

- The change is a four-line deletion in one `switch` arm plus one new source-reading regression test. No control flow, no state, no persistence, no migration.
- Nothing shipped depends on the removed message: `copyPlanLinkResult` is fire-and-forget UI feedback with no acknowledgement, no DB write, and no effect on the arm's return value (`{ success: true, prompt }`), which is what the HTTP/verb caller receives.
- No migration concern (per the repo's shipped-state rule): nothing is persisted by this path. The removed message is transient UI chatter.

**The one thing worth care:** the *other* five `copyPlanLinkResult` emit sites in `KanbanProvider.ts` (`9677`, `9710`, `9741`, `9748`, `9763`, all inside `promptSelected` / `promptAll`) and the single-card `copyPlanLink` arm at `10221` are all legitimate and must be left alone. A careless "remove the duplicated loop" sweep would strip the honest feedback from the prompt buttons too. The edit must be scoped to the `copyDispatchPromptSelected` arm only.

## Edge-Case & Dependency Audit

- **Dispatch view.** The same DOM column renders `DISPATCH` cards when `showingDispatch` is on, and the Copy Dispatch Prompt button is shown in both views (`kanban.html:5671`, comment at 5668). Removing the card flash fixes both views identically — there is no view-specific branch to add.
- **Empty column / no matching plans.** The arm returns early with `showInformationMessage` before reaching the loop (`KanbanProvider.ts:10505–10520`). Unaffected.
- **API / verb callers.** `copyDispatchPromptSelected` is in `KANBAN_VERBS` (`src/generated/verbAllowlist.ts`) and schema'd at `src/services/verbSchemas.ts:396`, so an HTTP caller can invoke it with no webview attached. The return shape `{ success: true, prompt }` is unchanged; only a UI-side broadcast disappears. No contract break.
- **Multi-client broadcast.** Removing the loop also removes the cross-client card flash on other connected boards. That is the desired outcome, not a regression — no other client's clipboard received anything.
- **`promptSelected` / `promptAll` must keep flashing.** Those arms copy exactly the prompt the per-card button copies and then advance the cards; their per-card `copyPlanLinkResult` is the correct signal and is explicitly out of scope.
- **`copyPlanLink` (single card, `KanbanProvider.ts:10217`) must keep flashing.** It targets one card and copies that card's link — the message's original, correct use.
- **`prompt-ready` state is untouched.** The separate `.card-btn.copy.prompt-ready` amber-glow path (`kanban.html:1175`, handled at `kanban.html:8364`) uses a different message and is unrelated.
- **Status bar visibility.** `showStatusBarMessage` no-ops if `#status-message` is missing (`kanban.html:5185`). The element is present in `kanban.html:2832`, which is the single shared board document for both the VS Code webview and the standalone browser board — so the replacement feedback exists on both surfaces. Verify visually on both rather than assuming.
- **No confirmation dialog.** Per repo rule, the button keeps firing immediately; this change only alters post-hoc feedback.
- **Test-only dependency:** the new regression test reads `KanbanProvider.ts` as text (the established pattern in `src/test/kanban-card-button-drag-guard.test.js`), so it needs no VS Code host and no compile step.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — drop the per-card copy confirmations from `copyDispatchPromptSelected`

At lines 10535–10540, replace:

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

Nothing else in the arm changes. `sourceCards` is still used by the status message and by the earlier guards, so no unused-variable fallout.

### 2. `src/test/copy-dispatch-prompt-no-card-flash.test.js` — new regression test

Source-reading test in the style of `src/test/kanban-card-button-drag-guard.test.js`, so it runs standalone under node with no VS Code host.

```js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

/**
 * Regression: the Planned column's Copy Dispatch Prompt button copies ONE planner
 * dispatch-analysis prompt for the whole batch. It must not emit per-card
 * copyPlanLinkResult messages — those flash each card's `.card-btn.copy` (labelled
 * "Copy coder prompt" on this column) green with "Copied!", claiming a prompt that
 * was never copied.
 */
function testCopyDispatchPromptEmitsNoCardFlash() {
    const providerPath = path.join(__dirname, '../services/KanbanProvider.ts');
    const src = fs.readFileSync(providerPath, 'utf8');

    // Slice the copyDispatchPromptSelected arm: from its case label to the next case label.
    const armStart = src.indexOf("case 'copyDispatchPromptSelected': {");
    assert.notStrictEqual(armStart, -1, "copyDispatchPromptSelected arm must exist in KanbanProvider.ts");
    const armEnd = src.indexOf("case '", armStart + 40);
    assert.notStrictEqual(armEnd, -1, 'Could not find the end of the copyDispatchPromptSelected arm');
    const arm = src.slice(armStart, armEnd);

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
 * Guard the other side: promptSelected/promptAll DO copy the per-card advance prompt
 * and advance the cards, so their per-card flash is correct and must survive.
 */
function testPromptArmsKeepCardFlash() {
    const providerPath = path.join(__dirname, '../services/KanbanProvider.ts');
    const src = fs.readFileSync(providerPath, 'utf8');

    const start = src.indexOf("case 'promptSelected': {");
    assert.notStrictEqual(start, -1, 'promptSelected arm must exist');
    const end = src.indexOf("case 'promptAll': {", start);
    assert.notStrictEqual(end, -1, 'promptAll arm must exist');
    const promptSelectedArm = src.slice(start, end);

    assert.ok(
        promptSelectedArm.includes('copyPlanLinkResult'),
        'promptSelected must keep its per-card copyPlanLinkResult — it copies exactly the ' +
        'per-card advance prompt, so the card flash is honest there.'
    );
}

testCopyDispatchPromptEmitsNoCardFlash();
testPromptArmsKeepCardFlash();
console.log('✓ copy-dispatch-prompt-no-card-flash: dispatch copy does not flash card buttons; prompt arms still do');
```

### 3. `package.json` — register the regression test script

Alongside the existing `test:regression:*` / `test:contract:*` entries (around lines 803–808):

```json
"test:regression:copy-dispatch-flash": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/copy-dispatch-prompt-no-card-flash.test.js",
```

### Explicitly not changed

- `src/webview/kanban.html` — the `copyPlanLinkResult` handler at 8326 stays exactly as-is. It is correct for its real callers (`copyPlanLink`, `promptSelected`, `promptAll`); the defect was an arm sending it that shouldn't. Narrowing the handler would break the honest callers.
- The five `copyPlanLinkResult` emits in `promptSelected` / `promptAll` (`9677`, `9710`, `9741`, `9748`, `9763`).
- The single-card `copyPlanLink` arm (`10217`).
- All CSS (`copyFlash`, `iconFlash`, `promptReadyGlow`) and the `#status-message` sub-bar.

## Verification Plan

**Automated**

1. `node src/test/copy-dispatch-prompt-no-card-flash.test.js` — passes. Then re-introduce the deleted loop locally and confirm the first assertion **fails** (proves the test actually guards the defect), and revert.
2. `npx tsc --noEmit -p .` (or the repo's typecheck entry) — no new errors; confirms `sourceCards` and `_cardId` have no dangling references after the deletion.
3. Run the existing kanban webview/provider tests (`src/test/kanban-card-button-drag-guard.test.js`, `src/test/browser-panel-verb-routing.test.js`, `src/test/verb-engine-kanban-headless.test.js`) — no new failures. Note: per the repo's known-red baseline, stash-verify any failure against HEAD before attributing it to this change.

**Manual — VS Code extension (build and install the VSIX; do not test from `dist/`)**

4. Board → Planned column, **nothing selected**. Click Copy Dispatch Prompt.
   - Expect: **no** card turns green; **no** card's `Copy coder prompt` label changes.
   - Expect: the column button itself gives its brief scale `.flash`.
   - Expect: `#status-message` shows `Copied dispatch-analysis prompt for N plan(s) to clipboard.` in teal, clearing after ~5s.
   - Paste into a scratch buffer: it is the **planner dispatch-analysis** prompt covering all N plans — not a coder advance prompt.
5. Same, with **2 of 5 cards selected**. Same expectations; status message reads `2 plan(s)`; the pasted prompt covers only those 2.
6. Toggle **Dispatch view** on the Planned column and repeat step 4 — identical behaviour (no card flash, status message present).
7. **Control (must still flash):** click a single card's `Copy coder prompt` button → that one button turns green `Copied!` and restores its label. Then click the column's `Prompt Selected` button with a selection → those cards flash `Copied!` **and** advance. Both paths are unchanged.
8. **Empty column:** clear/filter Planned to zero cards and click the button → the existing information message appears, no flash, no status message.

**Manual — standalone browser board** (`kanban.html` is the shared document for both surfaces)

9. Open the standalone browser board, repeat step 4. Verify no card flash and that `#status-message` renders the confirmation there too (the sub-bar is present in the shared document; confirm visually rather than assuming).
10. With **two boards open simultaneously** (VS Code webview + browser), click Copy Dispatch Prompt in one. Verify the *other* board shows no card flash — the cross-client phantom confirmation is gone.
