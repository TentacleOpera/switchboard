# Finish the prompt-copy return-body retrofit so standalone copy buttons actually copy

## Goal

Make every prompt-copy verb reachable from a browser panel return its prompt text in the HTTP response
body, so `transport.js` writes it to the **browser's** clipboard. Today ~50 copy arms outside the Kanban
provider write only to the host clipboard — which is a no-op in the standalone host — while the UI
reports success.

### Problem

The standalone host has no clipboard. The **live** no-op is the shim: standalone injects
`createVscodeHostSeams` (`src/standalone/bootstrap.ts:603`), so the seam is `VscodeHostClipboard` →
`vscode.env.clipboard`, and `webpack.config.js:149-150` aliases `vscode` to `vscodeShim.ts`:

```ts
// src/standalone/vscodeShim.ts:287-295  ← THE LIVE STANDALONE PATH
// Headless has no real clipboard. Provider arms that call
// `vscode.env.clipboard.writeText` (via VscodeHostClipboard) would crash with a
// TypeError on the missing member. No-op here; the prompt-copy verbs return the
// prompt in the HTTP body and transport.js copies it client-side (see the memo
// prompt pattern and the new improvePlan/improveFeature arms).
export const clipboard = {
    async writeText(_text: string): Promise<void> { /* no-op headless */ },
    async readText(): Promise<string> { return ''; },
};
```

`hostServices.ts:440-443` carries a second, near-identical clipboard no-op, but it belongs to
`createHeadlessHostSeams` — which has **zero callers** (`grep -rn "createHeadlessHostSeams" src/` hits
only the definition plus comments at `bootstrap.ts:752` and `vscodeShim.ts:235` saying it is not
injected). Do not edit it expecting a runtime effect.

The comment states the contract, and `transport.js` implements the client half:

```js
// src/webview/transport.js:372-376
if (result && result.prompt && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(result.prompt).catch(function (err) {
        console.warn('[transport] Clipboard write failed:', err);
    });
}
```

**The provider half was only finished for Kanban.** Measured across the `clipboard.writeText` call sites:

| Provider | `clipboard.writeText` sites | Arms returning `prompt` |
| :--- | ---: | ---: |
| `KanbanProvider.ts` | 20 | ~13 (retrofitted) |
| `PlanningPanelProvider.ts` | 21 | 3 |
| `DesignPanelProvider.ts` | 16 | 4 (one of them under the **wrong key**) |
| `TaskViewerProvider.ts` | 9 | 0 |
| `sharedUtilityVerbs.ts` | 3 | 0 |
| `SetupPanelProvider.ts` | 1 | 1 |

So in standalone, the copy buttons across Project/Planning, Design, Tickets and the dispatch fallbacks
put nothing on the clipboard — and say they did.

### Root cause

Three distinct defects, all downstream of the same unfinished retrofit:

**1. The arm writes only to the host clipboard and returns nothing to copy.** The canonical case:

```ts
// src/services/PlanningPanelProvider.ts:4287-4295
case 'copyPrdBuildPrompt': {
    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!wsRoot || typeof msg.projectName !== 'string') { break; }
    const projectName = msg.projectName;
    const promptText = buildPrdBuilderPrompt(projectName, wsRoot);
    await this._seams().clipboard.writeText(promptText);   // ← no-op in standalone
    this.postMessageToProjectWebview({ type: 'prdPromptCopied' });
    break;                                                 // ← no prompt in the body
}
```

**2. The UI then lies.** The push is handled unconditionally:

```js
// src/webview/project.js:863-867
case 'prdPromptCopied': {
    if (btnCopyPrdPrompt) {
        const oldText = btnCopyPrdPrompt.textContent;
        btnCopyPrdPrompt.textContent = 'Copied!';
```

The button flips to **Copied!** with an empty clipboard. Same shape at `constitutionPromptCopied`
(`:837`) and `systemPromptCopied` (`:851`). The Tickets **Diagram** button
(`handleCopyDiagramPrompt`, `src/services/sharedUtilityVerbs.ts:76`) is the silent variant — it returns
`{ success: true }` with no prompt and no push, so nothing happens at all.

**3. One arm uses a key `transport.js` does not read.**

```ts
// src/services/DesignPanelProvider.ts:2863-2866
await this._seams().clipboard.writeText(promptText);
this._seams().ui.showTemporaryNotification('Copied Design System Prompt to clipboard.');
this.postMessage({ type: 'copyDesignSystemPromptResult', success: true, promptText, docId: message.docId });
return { success: true, promptText };
```

`transport.js` reads `result.prompt`, so `promptText` is invisible to it. This arm looks retrofitted and
is not — the exact drift a CI gate exists to catch, and there is no gate for this convention yet.

**Scope note — this is standalone-only.** With the extension running, the browser talks to the
extension's `LocalApiServer` and `VscodeHostClipboard` writes the real system clipboard on the same
machine, so those copies work. `src/test/memo-browser-clear-and-copy-contract.test.js` records that
position explicitly and declines to return `prompt` for the memo arm on the grounds that a second
browser-side write is redundant *there*. That reasoning holds for the memo arm's specific flow; it does
not cover the standalone host, where the host write is a no-op and the body is the only channel.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, bugfix, reliability, ui
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding `prompt` to an arm's return object. Mechanical, one line per arm, no behaviour change in the
  editor (the host write still happens; the extra body field is inert there — `transport.js` is not
  loaded in the VS Code webview, and the webview's own handlers switch on `result.type`).
- Fixing `DesignPanelProvider.ts:2866` to return `prompt` alongside the existing `promptText` (the push
  consumer `copyDesignSystemPromptResult` keeps reading `promptText`, so nothing downstream moves).

**Complex / risky**
- **Breadth without a gate is how this regressed the first time.** ~50 arms across four large providers,
  many of which `break;` rather than `return` — converting those interacts with
  `scripts/check-verb-return-contract.js`, whose per-provider `break` ceilings may only ever go **down**.
  Converting `break` → `return { success: true, prompt }` *lowers* the count, which the ratchet allows,
  but the baseline file must be regenerated with `--write` rather than hand-edited.
- **Not every `clipboard.writeText` is a copy button.** `TaskViewerProvider.ts:5134` is the dispatch
  fallback — when no terminal is live, the prompt goes to the clipboard so the user can paste it into an
  agent. It is user-facing and equally broken in standalone, but its return type is `boolean`, not a verb
  body, so it needs routing through its caller rather than a one-line edit. Each of the 9 TaskViewer
  sites needs classifying before touching.
- **Browser clipboard writes can be refused.** `navigator.clipboard.writeText` after a `fetch()`
  boundary is rejected by WebKit (recorded in the memo contract test) and needs a focused document in
  Chrome. Today the rejection is a bare `console.warn`, so a refused write is indistinguishable from
  success — a second silent lie that this plan must not leave in place.

**Not in scope**
- Implementing a real native clipboard in the standalone host (`pbcopy` / `clip.exe` / `xclip`). It would
  write the *server's* clipboard, which is the wrong machine whenever the browser is not local, and it
  would not remove the need for the body channel. The declared convention is the body.
- Host-notification toasts in the browser. Separate defect, separate plan. **Sequencing:** if that plan
  lands first, standalone gains a toast saying "copied to clipboard" over an empty clipboard — a louder
  version of today's `Copied!` lie. Landing this plan first, or together, avoids that window.

**No confirmation dialogs are added. No migration is needed** — no persisted state is read or written.

## Edge-Case & Dependency Audit

1. **`break` → `return` conversions must preserve early-exit guards.** Arms like `copyPrdBuildPrompt`
   `break` on a validation failure *and* on success. Converting only the success path keeps the guard's
   `break` intact; converting both changes the response body for invalid input from `{}` to
   `{ success: false }`. Prefer returning `{ success: false, error }` on the guard — it is strictly more
   informative and `transport.js` already renders it — but audit each guard rather than assuming.
2. **Editor path must not change.** In the VS Code webview, `_handleMessage`'s return value is discarded
   for `break`-shaped arms and the host clipboard write is the real copy. Adding a return field is inert
   there. The `postMessage` pushes (`prdPromptCopied` etc.) stay exactly as they are so the button's
   `Copied!` affordance keeps working in the editor.
3. **Double write in the extension-served browser.** With the extension running, the host writes the
   system clipboard *and* the browser writes `navigator.clipboard` — same text, same machine, so the
   result is identical either way. Harmless, and the alternative (host-detection branching in provider
   arms) would put host knowledge into host-agnostic code.
4. **Empty or huge prompts.** Return `prompt` only when the string is non-empty, so
   `transport.js`'s `result.prompt &&` truthiness check is meaningful. Some prompts are large (unified
   dispatch prompts concatenate plan bodies); they already travel over this rail from Kanban, so no new
   size ceiling is introduced — but confirm no arm returns megabytes where the host write was previously
   the only copy.
5. **A refused browser clipboard write must be visible.** Add a fallback (hidden `<textarea>` +
   `document.execCommand('copy')`) and, if that also fails, a visible error toast. Silence here recreates
   the exact defect this plan fixes.
6. **`prompt` as a reserved body key.** `transport.js` treats *any* body field named `prompt` as
   clipboard content. An arm that returns a prompt for a different purpose would copy it as a side
   effect. Grep for existing non-copy uses of `prompt` in verb return bodies before adding more.
7. **`sharedUtilityVerbs.ts` is shared by Tickets and Planning.** `handleCopyDiagramPrompt` (`:66`) is
   registered in both `TICKETS_VERBS` and `PLANNING_VERBS` (`src/generated/verbAllowlist.ts`). One fix
   covers both panels; both need verifying.
8. **`protocol-catalog.json` and the generated allowlists.** No verbs are added or renamed, so
   `scripts/generate-verb-allowlist.js` / `generate-protocol-catalog.js` output should be unchanged —
   confirm with `node scripts/check-protocol-parity.js` rather than assuming.
9. **Kanban's already-retrofitted arms must not be double-edited.** ~13 already return `prompt`; the new
   gate must report them as compliant, not rewrite them.

## Proposed Changes

### 1. `scripts/check-clipboard-return-parity.js` — new ratcheted CI gate (write this first)

Following the `check-push-routing.js` / `check-standalone-push-parity.js` convention (TypeScript AST
walk, baseline that may only be **lowered**). Without it, the retrofit drifts again — the
`promptText` arm is proof.

- Walk each provider's `_handleMessage` switch plus `sharedUtilityVerbs.ts`.
- For every `case` arm containing a `clipboard.writeText(...)` call, assert the arm returns an object
  literal with a non-empty `prompt` property.
- Report violations as `provider:verb`, count them, and compare against
  `scripts/clipboard-return-parity-baseline.json`.
- Allowlist entries carry a required `reason` string, for the genuinely-not-a-copy-button sites (e.g. a
  non-verb helper whose caller returns the prompt instead).
- Run it before any edits to capture the true starting number; the retrofit then walks it to the
  allowlist floor.

### 2. `src/services/PlanningPanelProvider.ts` — 18 arms

Pattern, applied per arm (`copyPrdBuildPrompt` shown):

```ts
case 'copyPrdBuildPrompt': {
    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!wsRoot || typeof msg.projectName !== 'string') {
        return { success: false, error: 'copyPrdBuildPrompt requires a resolvable workspaceRoot and projectName' };
    }
    const promptText = buildPrdBuilderPrompt(msg.projectName, wsRoot);
    await this._seams().clipboard.writeText(promptText);
    this.postMessageToProjectWebview({ type: 'prdPromptCopied' });
    // Standalone has no host clipboard (vscodeShim.ts:287-295): the body IS the
    // copy channel there, and transport.js:372 writes it browser-side.
    return { success: true, prompt: promptText };
}
```

Sites: `:3056, :3156, :3207, :3366, :3369, :3391, :3395, :4292, :4338, :4384, :4475, :4512, :5157,
:5166, :5203, :5229, :5293, :5428`. `:3349`, `:3376` and `:4867` already return `prompt` — verify only.

### 3. `src/services/DesignPanelProvider.ts` — 12 arms + the key fix

The key fix at `:2866`:

```ts
// `promptText` stays for the copyDesignSystemPromptResult push consumer;
// `prompt` is what transport.js:372 reads to write the browser clipboard.
return { success: true, prompt: promptText, promptText };
```

Then the same retrofit at `:2834, :2983, :2987, :3013, :3017, :3042, :3046, :3074, :3079, :3095, :4880`.
Note this provider also has 19 **direct** `showTemporaryNotification` imports that already claim the
copy succeeded — those messages become truthful only once the body carries the prompt.

### 4. `src/services/sharedUtilityVerbs.ts` — 3 sites

```ts
// handleCopyDiagramPrompt (:66-84)
await deps.seams().clipboard.writeText(prompt);
deps.seams().ui.showTemporaryNotification('Diagram prompt copied to clipboard');
return { success: true, prompt };
```

Fixes the Tickets **Diagram** button in standalone. Same treatment at `:167` and `:176`
(`handleCopyToClipboard` and its sibling), where the verb's entire purpose is the copy.

### 5. `src/services/TaskViewerProvider.ts` — classify the 9 sites, then fix

Sites: `:5134, :5505, :5679, :5685, :12515, :12978, :12982, :17369, :25038`.

- **Verb arms** → same one-line retrofit as above.
- **Dispatch fallbacks** (e.g. `:5134`, inside a `Promise<boolean>` helper) → return the prompt to the
  caller so the *verb* body carries it:

```ts
// helper signature widens from Promise<boolean> to a result object
return { dispatched: false, clipboardPrompt: messagePayload };
```

  and the calling verb arm folds `clipboardPrompt` into its `prompt` field. Where a caller cannot carry
  it, allowlist the site in the gate with a `reason` rather than leaving the gate red.

### 6. `src/services/KanbanProvider.ts` — audit only

7 of the 20 sites did not match the retrofit in a first pass (`:1317, :5641, :8500, :8522, :8594,
:10659`, plus one indirect). Classify each: retrofit the copy buttons, allowlist the non-copy writes.

### 7. `src/webview/transport.js` — make a refused clipboard write visible

```js
function writeBrowserClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function (err) {
            console.warn('[transport] Clipboard write failed, trying execCommand:', err);
            if (!legacyCopy(text)) {
                // A refused write that says nothing is the same defect as a host
                // clipboard that silently no-ops. Say so.
                showTransportError('Copy failed — the browser refused clipboard access. Check site permissions and try again.');
            }
        });
        return;
    }
    if (!legacyCopy(text)) {
        showTransportError('Copy failed — this browser blocked clipboard access.');
    }
}

// WebKit rejects navigator.clipboard writes after a fetch() boundary (see
// memo-browser-clear-and-copy-contract.test.js); execCommand still works there.
function legacyCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
        (document.body || document.documentElement).appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (err) {
        console.warn('[transport] legacy copy failed:', err);
        return false;
    }
}
```

and the call site at `:372-376` becomes:

```js
if (result && typeof result.prompt === 'string' && result.prompt) {
    writeBrowserClipboard(result.prompt);
}
```

### 8. `src/test/browser-copy-prompt-parity.test.js` — new contract test

Structured like `src/test/memo-browser-clear-and-copy-contract.test.js` (headless providers +
`createHeadlessTestSeams`, `_startLocalApiServer` neutralised):

- For a representative arm per provider (`copyPrdBuildPrompt`, `copyDiagramPrompt`, the Design system
  prompt, one TaskViewer dispatch fallback): call `handleServiceVerb` with headless seams and assert the
  returned body carries a non-empty `prompt` **equal to** the text handed to the clipboard seam recorder.
  Equality is the assertion that matters — a body field that disagrees with the host write is worse than
  no field.
- Assert `DesignPanelProvider`'s design-system arm returns **both** `prompt` and `promptText`, so the
  push consumer is not broken by the fix.
- JSDOM: load `transport.js`, resolve a fetch with `{ success: true, prompt: 'abc' }` against a stubbed
  `navigator.clipboard` and assert `writeText('abc')`; then make `writeText` reject and assert
  `execCommand` was attempted and, when that also fails, that a `#sb-transport-error` node appeared.

Register as `test:contract:browser-copy-parity` in `package.json` and add it plus
`check-clipboard-return-parity` to `.github/workflows/integration-tests.yml`.

## Verification Plan

**Baseline first**
1. `node scripts/check-clipboard-return-parity.js` on the untouched tree — record the starting violation
   count. This is the number the retrofit drives down; without it there is no evidence of completeness.
2. `node scripts/check-verb-return-contract.js` before edits — capture the current `break` ceilings so
   the post-retrofit regeneration can be shown to be a lowering, not a raise.

**Build & static gates**
3. `npm run compile-tests`, `npm run compile`, `npm run lint`.
4. `node scripts/check-clipboard-return-parity.js` — must reach the allowlist floor, with every allowlist
   entry carrying a `reason`.
5. `node scripts/check-verb-return-contract.js --write` then inspect the diff: every changed ceiling must
   be **lower**. If the tool refuses, a real regression was introduced.
6. `node scripts/check-protocol-parity.js`, `node scripts/check-push-routing.js`,
   `node scripts/check-standalone-push-parity.js` — no verbs added or pushes changed, so no baseline may
   move.

**Automated**
7. `npm run test:contract:browser-copy-parity` (new).
8. `npm run test:contract:memo-browser-clear` — the memo arm deliberately does **not** return `prompt`;
   this test must stay green, proving the retrofit did not blanket-apply where the existing contract says
   otherwise.
9. `npm run test:contract:verb-engine`, `:verb-engine-planning`, `:verb-engine-tickets`,
   `:verb-engine-kanban` — the clipboard seam recorder lives in these suites.
10. Run steps 7–9 against a clean stash first; five regression tests are already red at HEAD and must not
    be mistaken for damage from this change.

**Manual (standalone — the broken host)**
11. Stop the extension. `npx switchboard`. In the browser Project panel click **Copy PRD build prompt**,
    then paste into an editor. Expect the real prompt (today: nothing, with the button still saying
    `Copied!`).
12. Tickets panel → select a ticket → overflow → **Diagram**, then paste. Expect the full diagram prompt.
13. Design panel → **Copy Design System Prompt**, then paste. Expect the prompt (this is the wrong-key
    arm).
14. A dispatch path with no live terminal — confirm the fallback prompt reaches the browser clipboard.
15. Deny clipboard permission for the site in browser settings, click any copy button, and confirm a red
    "Copy failed" toast appears instead of a bare console warning.

**Manual (extension-served browser and editor — must be unchanged)**
16. With the extension running, `npx switchboard`, repeat steps 11–13. Expect the same prompts on the
    clipboard (host write and browser write agree; the double write is invisible).
17. In VS Code, click the same buttons in the panel webviews. Expect identical behaviour to today,
    including the `Copied!` button affordance and the native notifications.
