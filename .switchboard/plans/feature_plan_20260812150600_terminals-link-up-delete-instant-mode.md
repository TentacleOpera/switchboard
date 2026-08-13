# Delete Link-Up's "Instant" Mode — Standing Orders Is the Only Mode

## Goal

Remove the Instant mode from the Terminals Link-up modal entirely. Link-up becomes a single-purpose dialog: save a standing order that is appended to every prompt sent to the parent agent. No mode selector, no one-shot delivery path.

### The problem

The Link-up modal presents two modes and defaults to the one that should not exist. `src/webview/terminals.html:2027-2032`:

```html
<label class="link-field-label" for="link-mode">Mode</label>
<select id="link-mode" class="link-select">
    <option value="instant">Instant — deliver this message once, now</option>
    <option value="standing">Standing orders — append to every prompt sent to the parent</option>
</select>
```

Instant is a one-shot prompt injected into the parent terminal. It leaves no record anywhere, so the operator cannot see what was said, cannot re-send it, and cannot revoke it — while standing orders are listed and individually deletable in the same modal (`#link-standing-list`, rendered by `renderStandingList` at `terminals.js:8263`). There is no reason to keep a mode whose entire behaviour is "type something into another terminal", which the operator can already do by clicking into that terminal.

### What Instant mode actually is, and everything it drags along

`sendLinkMessage` (`terminals.js:8396`) branches on `linkMode` at line 8414. The non-standing arm (lines 8426-8466) does:

```js
const res = await fetch('/terminals/verb/ptySendPrompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        name: parentName,
        data: buildLinkPrompt(parentName, childName, message),
        clearBeforePrompt: false,
        standingOrders: false
    })
});
...
document.getElementById('link-modal').hidden = true;
showPaneToast(`Instructed ${parentName} to message ${childName}`);
```

Removing it makes the following dead or wrong:

- `linkMode` state (line 8098), its load (`terminals.js:1421-1422`) and its persistence key `terminals.linkMode` (line 8512).
- `buildLinkPrompt` (line 8370) — the instant arm is its only caller (verified by grep: the declaration at 8370 and the single call at 8445).
- `syncModeAvailability` (line 8254) — exists only to disable the standing option and fall back to Instant.
- The `modeSel` change listener (lines 8504-8516), whose whole body is mode bookkeeping.
- `syncSendEnabled`'s label switch (line 8207): `sendBtn.textContent = linkMode === 'standing' ? 'SAVE' : 'SEND'`.
- The `#link-mode` `<select>` and its label in the HTML.

### The one real design consequence

`standingOrdersAvailable` (line 8100) is set from the `/terminals/standing-orders` GET (`available` flag). Today, when the store is unreachable — solo popout, headless, or no DB — the modal silently falls back to Instant (lines 8258-8260):

```js
if (!standingOrdersAvailable && sel.value === 'standing') { sel.value = 'instant'; }
```

With Instant gone there is no fallback. That path must become an honest disabled state: the modal opens, the instruction box is inert, and SAVE is disabled with the reason visible in the existing `#link-error` element. This is not an unreachable edge case invented for the sake of a message — it is the real solo-popout/headless behaviour, which today is masked by a silent mode switch.

### Verified at HEAD — the landmine that would make this change silently break the modal

`openLinkModal` (line 8291) looks up `#link-mode` at line 8298 and then hard-returns on it at line 8301:

```js
const modeSel = document.getElementById('link-mode');
...
if (!modal || !parentSel || !childSel || !modeSel || !messageEl || !presetSel) { return; }
```

Deleting the `<select>` from the HTML without removing `modeSel` from that guard makes `openLinkModal` return before setting `modal.hidden = false` — the Link-up button becomes a dead click with no error anywhere. The guard must be edited in the same change as the markup.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, refactor
- **Project:** Browser Switchboard

## User Review Required

None. The one design consequence — what the modal does when the standing-orders store is unreachable — is decided here: an honest disabled state with the reason in `#link-error`, no fallback mode.

## Complexity Audit

### Routine

- Deleting the `<select>`, its label, the state variable, and the change listener.
- Fixing the button label to a constant `SAVE`.
- Deleting `buildLinkPrompt` and `syncModeAvailability`.

### Complex / Risky

- **`openLinkModal`'s existence guard names `modeSel`** (line 8301). Missing it turns the whole modal into a dead click. See "Verified at HEAD" above. This is the single highest-risk line in the change.
- **`terminals.linkMode` is a persisted setting that has shipped.** It lives in the DB `config` table via `/kanban/verb/saveSetting`. Per the repo's migration rule, shipped state must not be assumed absent — but this is a *read* that simply stops happening. The correct handling is to stop reading and stop writing it, and leave the orphaned row in place. Do NOT add a migration that deletes the key, and do NOT leave a reader that could resurrect a mode that no longer exists.
- **The `#link-error` element is shared** between validation errors ("`<name>` is no longer live"), save failures, and — after this change — the unavailable-store state. `setLinkError(null)` is called on open (line 8317) and at the top of `sendLinkMessage` (line 8404); the unavailable message must be asserted *after* the open-path clear, or it will blink out.
- **`ptySendPrompt`'s `standingOrders: false` flag.** The instant arm was the surface that exercised the "suppress the standing-orders block for this one send" option. That option is still needed by other callers (the block must not be quoted back to the agent inside its own relay message). Do not delete the flag from the verb — only its use here.

> **Superseded:** "`fetchStandingOrders` swallows failures and sets `standingOrders = []; standingOrdersAvailable = false`. Both 'the store is genuinely empty' and 'the fetch failed' land on the same state today… Confirm the `available` flag distinguishes them before wiring SAVE's disabled state to it; if it does not, that is a second, separate defect."
> **Reason:** Verified at HEAD against the server. `_handleStandingOrdersList` (`src/services/LocalApiServer.ts:2300-2322`) returns `{ success: true, available: false, orders: [] }` **only** when `_resolveDbForRoot()` yields no database or the config read throws, and `{ success: true, available: true, orders }` otherwise — an empty-but-reachable store returns `available: true` with `orders: []`. The webview's own `catch` (line 8247) collapses a transport failure to `available: false`, which is also correct: an unreachable server is an unreachable store. So the flag already distinguishes the two cases exactly as the design needs, and there is no second defect.
> **Replaced with:** Gate SAVE on `standingOrdersAvailable` with no further investigation. Never gate on `standingOrders.length` — an empty reachable store must be savable, and that is precisely the first-use case.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Store becomes unavailable between open and SAVE.** The POST returns `success: false` (the server answers `503` with `{ success: false, error: 'Kanban database not available' }`, `LocalApiServer.ts:2340`), and the existing `setLinkError('Save failed: ' + ...)` path already covers it. Unchanged.
2. **Parent or child died while the modal was open.** The re-validation at lines 8406-8409 runs before the standing-order POST too. Unchanged.

### Security

- None. The change removes a write path (`ptySendPrompt` into another terminal) and adds none.

### Side Effects

3. **A persisted `terminals.linkMode: 'instant'`.** After the change nothing reads it. Assert no code path branches on the string `'instant'` anywhere in `terminals.js`.
4. **Store unavailable on open.** Modal opens, `#link-error` shows why, instruction textarea disabled, SAVE disabled, `#link-standing-list` hidden. `renderStandingList` (line 8266) already hides the list when `!standingOrdersAvailable`, so no extra work is needed there. No mode fallback.
5. **Focus on open.** `openLinkModal` ends with `presetSel.focus()` (line 8320). The preset select is never disabled, so the focus target survives the unavailable state — do not move focus to the disabled textarea.
6. **`applyPresetToMessage(true)`** still fills the instruction box on open even when the store is unavailable. Harmless: the box is disabled and SAVE is gated independently. Do not add a branch to skip it.
7. **Fewer than two live terminals.** `openLinkModal` already refuses with a toast (line 8293), and `syncLinkUpEnabled` (line 8328) disables the button. Unchanged.
8. **The instruction preset dropdown** (`#link-preset`, `LINK_PRESETS`, `terminals.linkPreset`) is mode-independent and stays. Do not remove it along with the mode selector, and do not remove the shared `.link-select` CSS rule (`terminals.html:1792`) — `#link-preset` uses it.
9. **Duplicate standing order** for the same parent/child pair — existing server behaviour, out of scope; do not add a client-side dedupe as a side effect.
10. **The `SEND` label.** The footer button is `<button id="link-send" ... >SEND</button>` (`terminals.html:2048`). Its static text must change to `SAVE` so the pre-`syncSendEnabled` first paint is not momentarily wrong.
11. **`MAX_INSTRUCTION_CHARS` counter** and the `is-over` class are mode-independent. Unchanged.
12. **`applyStandingOrdersClient`** (line 8220) is the client-side mirror of `src/services/standingOrders.ts` and is consumed by the drag-drop prompt path at line 4169. It is not part of the modal and must not be touched.
13. **No confirm dialog** on save or on deleting a standing order (repo rule — the existing `×` delete on each standing-order row already deletes immediately; keep it that way).

### Dependencies & Conflicts

- **Fully independent of the other three subtasks.** It touches `terminals.js` only in the 8090-8540 band and `terminals.html` only inside `#link-modal`; no sibling plan reaches either. Same file, so serialise the edit stream, but it can land first or last without consequence.
- No contract test references `linkMode`, `buildLinkPrompt`, `syncModeAvailability` or `#link-mode` (verified by grep across `src/test/`), so no test authoring is required by this change.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: deleting `#link-mode` from the markup while `openLinkModal`'s existence guard still names `modeSel`, which turns Link-up into a silent dead click; re-asserting the store-unavailable message before the open path's `setLinkError(null)` runs, which makes it blink out; and gating SAVE on `standingOrders.length` instead of `standingOrdersAvailable`, which would make the very first standing order unsavable. Mitigations: the guard edit is called out as the highest-risk line and carries its own static check; the unavailable branch is placed after the existing clear; and the server's `available` semantics were verified so SAVE gates on that flag alone.

## Proposed Changes

### `src/webview/terminals.html`

Delete the mode label and select (lines 2027-2032) and fix the footer button's static label (line 2048):

```html
<!-- removed: <label class="link-field-label" for="link-mode">Mode</label>
     removed: <select id="link-mode" ...>Instant / Standing orders</select>

     Link-up has ONE mode: a standing order appended to every prompt sent to the
     parent. The old one-shot mode fired a prompt into the parent terminal with no
     record, nothing to review and nothing to revoke — which is just typing into
     that terminal, and it was the DEFAULT. -->

<label class="link-field-label" for="link-preset">Instruction preset</label>
...
<button type="button" id="link-send" class="secondary-btn is-teal" disabled>SAVE</button>
```

Leave `.link-select` (line 1792) in place — `#link-preset` uses it.

### `src/webview/terminals.js`

**a) Delete state and its persistence** — remove `let linkMode = 'instant';` (line 8098) and the load block (lines 1421-1422):

```js
// removed: const savedLinkMode = await loadSetting('terminals.linkMode', 'instant');
// removed: linkMode = ['instant','standing'].includes(savedLinkMode) ? savedLinkMode : 'instant';
// `terminals.linkMode` is no longer read or written. Any persisted row is left in
// place, unread — this codebase does not delete shipped settings to tidy up.
```

**b) `syncSendEnabled`** (line 8201) — constant label, and gate on store availability:

```js
function syncSendEnabled() {
    const msg = document.getElementById('link-message');
    const sendBtn = document.getElementById('link-send');
    const counterEl = document.getElementById('link-counter');
    if (!msg || !sendBtn) { return; }
    // NOT standingOrders.length: an empty but reachable store is the first-use case
    // and must be savable. `available` is false only when no DB is reachable
    // (LocalApiServer._handleStandingOrdersList) or the fetch itself failed.
    sendBtn.disabled = !msg.value.trim() || !standingOrdersAvailable;
    // No label switch: SAVE is the only thing this button does now.
    if (counterEl) { /* unchanged */ }
}
```

**c) `sendLinkMessage`** (line 8396) — collapse to the standing-order arm only, deleting the `else` block (lines 8426-8466) wholesale:

```js
if (!standingOrdersAvailable) {
    setLinkError('Standing orders are unavailable here — no store is reachable (solo popout, headless, or no database).');
    return;
}
const res = await fetch('/terminals/standing-orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', parent: parentName, child: childName, instruction: message })
});
const data = await res.json();
if (!data.success) { setLinkError('Save failed: ' + (data.error || 'unknown')); return; }
await fetchStandingOrders();
renderStandingList();
document.getElementById('link-message').value = '';
showPaneToast(`Standing order saved for ${parentName}`);
```

The `try`/`catch`/`finally` wrapper and the liveness re-validation above it are unchanged.

**d) `openLinkModal`** (line 8291) — drop the `modeSel` lookup **and its clause in the existence guard**, and replace the mode wiring with the disabled state:

```js
const modal = document.getElementById('link-modal');
const parentSel = document.getElementById('link-parent');
const childSel = document.getElementById('link-child');
const messageEl = document.getElementById('link-message');
const presetSel = document.getElementById('link-preset');
// `!modeSel` MUST come out of this guard with the <select>. Left in, it returns
// before `modal.hidden = false` and the Link-up button becomes a dead click.
if (!modal || !parentSel || !childSel || !messageEl || !presetSel) { return; }

fillTerminalSelect(parentSel, live, defaultLinkParent());
syncChildOptions();

await fetchStandingOrders();
renderStandingList();

presetDirty = false;
presetSel.value = linkPreset;
applyPresetToMessage(true);
syncSendEnabled();

// AFTER the clear that used to sit here: this is a standing condition, not a
// per-attempt error, and the two share #link-error.
if (!standingOrdersAvailable) {
    messageEl.disabled = true;
    setLinkError('Standing orders are unavailable here — no store is reachable (solo popout, headless, or no database).');
} else {
    messageEl.disabled = false;
    setLinkError(null);
}

modal.hidden = false;
presetSel.focus();
```

**e) `wireLinkModal`** (line 8481) — delete the `modeSel` lookup (line 8487), the `modeSel` change listener (lines 8504-8516), and drop `modeSel` from the keydown `stopPropagation` loop (line 8498):

```js
for (const el of [messageEl, childSel]) {
    if (el) { el.addEventListener('keydown', (e) => { e.stopPropagation(); }); }
}
```

**f) Delete the now-dead functions** — `buildLinkPrompt` (lines 8338-8394, including its long doc comment) and `syncModeAvailability` (lines 8254-8261). Grep-confirmed at HEAD that neither has another caller.

## Verification Plan

### Automated Tests

Execution is **deferred by session directive (SKIP TESTS)**. No contract test in `src/test/` references `linkMode`, `buildLinkPrompt`, `syncModeAvailability` or `#link-mode`, so no test file needs authoring or updating for this change.

### Static checks

1. `grep -n "linkMode\|buildLinkPrompt\|syncModeAvailability\|link-mode" src/webview/terminals.js src/webview/terminals.html` returns nothing outside the explanatory HTML comment.
2. `grep -n "'instant'" src/webview/terminals.js` returns nothing — no code path branches on the string.
3. `grep -rn "terminals.linkMode" src/` returns nothing — the setting is neither read nor written.
4. `grep -n "modeSel" src/webview/terminals.js` returns nothing — in particular, `openLinkModal`'s existence guard no longer names it.
5. `grep -n "standingOrders:" src/webview/terminals.js src/services/` still shows `ptySendPrompt`'s flag accepted by the verb and passed by its other callers; only the Link-up use is gone.
6. `grep -n "applyStandingOrdersClient" src/webview/terminals.js` shows the mirror and its drag-drop caller untouched.

### Manual UAT

*(The browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall the VSIX before concluding the selector is still there.)*

7. With the extension running and two or more live terminals, click Link-up. **The modal opens** (the guard edit landed), there is no Mode row, and the button reads SAVE before any typing.
8. Type an instruction and save it. It appears in the list below with a working `×` that deletes immediately, no confirm.
9. Save a second order for a different parent/child pair and confirm both list correctly.
10. Kill the child terminal with the modal open, then press SAVE: `#link-error` reads `<name> is no longer live` and nothing is posted.
11. Change the preset dropdown: the instruction box refills, the choice persists across a panel reload, and the character counter still turns red past the cap.
12. Open the panel in solo popout: the modal opens, `#link-error` explains the store is unreachable, the instruction box is inert, SAVE is disabled, and the standing-order list is hidden — no silent one-shot send.
13. With a standing order saved, send a prompt to the parent terminal by drag-drop and confirm the order is still appended (the client-side mirror is untouched).

---

**Recommendation:** Complexity 3 — **Send to Intern.**
