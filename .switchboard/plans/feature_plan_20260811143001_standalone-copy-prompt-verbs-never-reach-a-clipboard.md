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
| `PlanningPanelProvider.ts` | 21 | 3 |
| `KanbanProvider.ts` | 20 | ~13 (retrofitted) |
| `DesignPanelProvider.ts` | 16 | 4 (one of them under the **wrong key**) |
| `TaskViewerProvider.ts` | 9 | 0 |
| `sharedUtilityVerbs.ts` | 3 | 0 |
| `SetupPanelProvider.ts` | 1 | 1 |

*(Counts re-measured at HEAD, 2026-08-14 — unchanged from the original survey.)*

**`terminalUtils.ts` has 3 more `clipboard.writeText` calls that are deliberately excluded.** They are
`pasteTextViaClipboard`'s save/restore pair around `workbench.action.terminal.paste` — the clipboard is
scratch space for a terminal paste, not a copy button, and two of the three *restore* the user's previous
clipboard. They are the clearest proof that the new gate must walk **verb arms**, not raw call sites
(see Proposed Change 1). They also reach `vscode.env.clipboard` **directly**, not through the seam, so
they are outside this plan's seam-level retrofit entirely.

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
machine, so those copies work.

**The memo arm is not a counter-example — read why, or this retrofit will be applied wrongly.**
`src/test/memo-browser-clear-and-copy-contract.test.js:183` asserts the memo *provider* arm returns
`result.prompt === undefined`, justified as "a second, browser-side write would be redundant and is
rejected by WebKit after a fetch() boundary". Taken at face value that reads as a general licence to
decline `prompt`. It is not, and the reason is 300 lines further down the same file:

```js
// memo-browser-clear-and-copy-contract.test.js:492-493
// This host has NO VS Code clipboard, so it MUST keep returning prompt.
assert.match(armBody, /\bprompt,/, 'standalone dropped `prompt` — it is the only clipboard writer there');
```

That assertion targets a **completely separate implementation**: `src/standalone/bootstrap.ts:1659`
(`if (verb === 'memoGeneratePrompt')`) forks the memo verbs outright — its own entry parser, its own
`buildMemoPlannerPrompt`, its own returns — and it *does* return `prompt`. Standalone therefore **never
reaches the memo provider arm at all**; bootstrap intercepts first (`memoLoad`, `memoSave`, `memoClear`,
`memoGeneratePrompt` — 4 forked arms, the only `if (verb === ...)` arms in the file).

So the operative rule is **not** "redundant browser writes may be declined". It is:

> An arm may decline to return `prompt` **only if standalone never reaches it.** Every arm standalone
> *does* reach must carry the prompt in the body, because there the body is the only clipboard writer.

Every arm in this plan's scope is reached by standalone through the shared provider (`handleServiceVerb`
→ `_handleMessage`), so every one of them returns `prompt`. The memo test stays green untouched.

*(The memo fork itself contradicts PRD contract #1 "anti-divergence — reuse verbatim" and is a standing
maintenance hazard: a fix to the provider arm silently misses standalone. It is **out of scope here** —
noted so a coder recognises it as known and pre-existing rather than damage from this change.)*

## Metadata

- **Complexity:** 7
- **Tags:** frontend, backend, bugfix, reliability, ui, accessibility
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding `prompt` to an arm's return object. Mechanical, one line per arm, no behaviour change in the
  editor (the host write still happens; the extra body field is inert there — `transport.js` is not
  loaded in the VS Code webview, and the webview's own handlers switch on `result.type`).
- Fixing `DesignPanelProvider.ts:2866` to return `prompt` alongside the existing `promptText` (the push
  consumer `copyDesignSystemPromptResult` keeps reading `promptText`, so nothing downstream moves).

**Complex / risky**
- **Two handlers declare return types too narrow to hold `prompt`.** Every provider's `_handleMessage`
  is `Promise<any>` (`PlanningPanelProvider.ts:2510`, `DesignPanelProvider.ts:2489`,
  `KanbanProvider.ts:7837`, `TicketsPanelProvider.ts:1314`, `SetupPanelProvider.ts:310`,
  `TaskViewerProvider.ts:370`), so provider arms accept an extra field with no signature change — the
  retrofit really is one line per arm **there**. But `sharedUtilityVerbs.ts` declares concrete shapes:

  ```ts
  handleCopyDiagramPrompt(...): Promise<{ success: boolean; error?: string }>            // :66-69
  handleCopyToClipboard(...):   Promise<{ success: boolean; count?: number; error?: string }>  // :130-133
  ```

  `return { success: true, prompt }` against those is an **excess-property error**, not a warning — the
  build fails. Both signatures must be widened in the same edit. This is the plan's only type-level
  change and it is confined to that one file; the risk is discovering it at compile time and "fixing" it
  by dropping the field instead of widening the type. **Widen the type.**
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
- **The browser half is harder than the server half, and this is where the plan's risk now lives.**
  Web research (2026-08-14) confirmed that `navigator.clipboard.writeText()` after a `fetch()` boundary
  is rejected by WebKit — transient user activation does not survive the network turn in its
  call-stack-based gesture model — **and** that `document.execCommand('copy')` is refused on the same
  terms, so the obvious fallback is not one. The client must therefore claim the clipboard
  *synchronously in the click frame* via `navigator.clipboard.write()` with a `Promise<Blob>` payload,
  which means `transport.js` needs to know a verb is a copy verb **before** the response exists. That is
  a generated-artifact dependency (Proposed Change 1 emits the verb list) and a real change in shape from
  "one line in a `.then()`". See Proposed Change 7.
- **A host/browser combination exists with no programmatic copy path at all.** WebKit treats
  `http://localhost` as a secure context but not LAN addresses, so standalone served to another machine
  over `http://192.168.x.x` has `navigator.clipboard === undefined` in Safari. The accessible manual-copy
  surface is therefore a **required deliverable**, not a defensive nicety — without it those users have
  no copy path, and a button that cannot work must be honest about it (PRD contract #6).
- **A refused write must never look like success.** Today the rejection is a bare `console.warn`, so a
  refused write is indistinguishable from success — a second silent lie this plan must not leave in
  place, and the reason the fallback is a visible surface rather than a log line.

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
6. **`prompt` as a reserved body key — and the one arm that is not a prompt.** `transport.js` treats
   *any* body field named `prompt` as clipboard content, so an arm returning a prompt for a different
   purpose would copy it as a side effect. Grep for existing non-copy uses before adding more.

   This plan contains its own violation of that rule. `handleCopyToClipboard`
   (`sharedUtilityVerbs.ts:129`, the Tickets **Link all** / **Link to ticket** button) copies a
   newline-joined list of **local ticket file paths**, not a prompt:

   ```ts
   await deps.seams().clipboard.writeText(paths.join('\n'));
   return { success: true, count: paths.length };
   ```

   Returning those paths as `prompt` would work mechanically and be a lie semantically — exactly the
   drift that produced the `promptText` bug this plan exists to fix.

   **Reconciled decision: add a second reserved key, `__clipboard`.** `transport.js` copies
   `result.prompt` **or** `result.__clipboard`, preferring `prompt` when both are present.
   Prompt-bearing arms keep `prompt` (no churn on Kanban's ~13 already-retrofitted arms, and the memo
   standalone assertion at `:493` still matches). Non-prompt copies use `__clipboard`. The `__` prefix
   marks it transport-private and matches the `__notices` convention introduced by the sibling subtask
   (see Cross-Subtask Reconciliation), so the browser cockpit ends with **one** naming rule for
   transport-private body keys rather than two invented independently.

   The gate (Proposed Change 1) accepts **either** key, so a genuine non-prompt copy is compliant
   without an allowlist entry.
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

- **Walk verb arms, never raw call sites.** Scope the walk to each provider's `_handleMessage` switch
  plus the exported handlers in `sharedUtilityVerbs.ts`. A call-site-based walk would flag
  `terminalUtils.ts`'s 3 `clipboard.writeText` calls — which are `pasteTextViaClipboard`'s
  save/restore scratch writes around a terminal paste, reach `vscode.env.clipboard` directly rather
  than the seam, and are not copy buttons at all. Arm-scoping excludes them structurally, so they never
  need an allowlist entry that a later reader would have to re-litigate.
- For every `case` arm containing a `clipboard.writeText(...)` call, assert the arm returns an object
  literal with a non-empty `prompt` **or** `__clipboard` property (Edge Case 6 — `__clipboard` is the
  key for copies whose payload is not a prompt).
- Report violations as `provider:verb`, count them, and compare against
  `scripts/clipboard-return-parity-baseline.json`.
- Allowlist entries carry a required `reason` string, for genuinely-not-a-copy-button arms (e.g. a
  non-verb helper whose caller returns the prompt instead).
- Run it before any edits to capture the true starting number; the retrofit then walks it to the
  allowlist floor.
- Follow `check-standalone-push-parity.js`'s ratchet shape: a committed baseline number that may only be
  **lowered**, with the reason for each remaining unit recorded in the file rather than in a commit
  message.
- **Emit the copy-verb list as a generated artifact.** The same AST pass that identifies clipboard-writing
  arms writes the set of their verb names to a generated file (a JS constant the webview can load, plus
  a `.ts` for any host-side consumer). `transport.js` needs this list because it must decide whether to
  claim the clipboard *before* the response exists — see Proposed Change 7. Generating it here is what
  keeps the client's notion of "this is a copy verb" from drifting from the server's; a hand-maintained
  list would be the same defect this gate exists to prevent, one layer up. Add a `--check` mode that
  fails when the committed generated file differs from a fresh walk, and wire it into CI alongside the
  parity count (the `check-protocol-parity.js` convention).

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

### 4. `src/services/sharedUtilityVerbs.ts` — 2 functions, 3 sites, 2 signature widenings

**`handleCopyDiagramPrompt` (:66-84)** — 1 site. Widen the signature, then return the prompt:

```ts
export async function handleCopyDiagramPrompt(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<{ success: boolean; error?: string; prompt?: string }> {   // ← widened
    ...
    await deps.seams().clipboard.writeText(prompt);
    deps.seams().ui.showTemporaryNotification('Diagram prompt copied to clipboard');
    return { success: true, prompt };
}
```

Fixes the Tickets **Diagram** button in standalone.

**`handleCopyToClipboard` (:129-186)** — the remaining 2 sites. Correcting the original survey: these are
**not** two sibling functions, they are the two clipboard branches of this **one** function — the
`msg.ticketIds` branch and the whole-directory fallback. Both need the key, and per Edge Case 6 the key
is `__clipboard`, because the payload is ticket file paths:

```ts
export async function handleCopyToClipboard(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<{ success: boolean; count?: number; error?: string; __clipboard?: string }> {   // ← widened
    ...
    // ticketIds branch
    const joined = paths.join('\n');
    await deps.seams().clipboard.writeText(joined);
    deps.push({ type: 'ticketLinkCopied', count: paths.length, requestedCount: msg.ticketIds.length, missingCount: missingIds.length });
    return { success: true, count: paths.length, __clipboard: joined };
    ...
    // whole-directory fallback
    const joinedDirs = paths.join('\n');
    await deps.seams().clipboard.writeText(joinedDirs);
    return { success: true, count: paths.length, __clipboard: joinedDirs };
}
```

Return the key only when the joined string is non-empty, per Edge Case 4. The `ticketLinkCopied` /
`ticketLinkFailed` pushes are consumed by `src/webview/tickets.js:8135` and `:8141` and stay exactly as
they are — the button's existing affordance is untouched in both hosts.

`handleCopyToClipboard` is registered for both Tickets and Planning, so this one edit covers both panels
(Edge Case 7); verify both.

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

> **Shared surface.** The sibling subtask (host-notification toasts) rewrites the *same*
> `.then(function (result) {...})` handler in this file. This plan lands **first** and owns the clipboard
> half; the toast plan builds on what this leaves behind and must not re-paste the pre-retrofit clipboard
> line. See Cross-Subtask Reconciliation at the end of this plan for the single reconciled end-state.

> **⚠️ This section was redesigned after web research (2026-08-14). The original design does not work
> in the browser it was written for.** The original chain was
> `navigator.clipboard.writeText(...).catch(() => document.execCommand('copy'))`, run inside the
> `.then()` of the `fetch()`. Research confirmed the premise (WebKit *does* reject `writeText()` after an
> `await fetch()` — transient user activation does not survive the network turn in WebKit's
> call-stack-based gesture model) **but killed the fallback**: `document.execCommand('copy')` requires an
> active gesture frame *on the same terms*. Post-`await`, in WebKit, **both halves fail**. The original
> design would have produced a "Copy failed" toast 100% of the time in Safari — replacing a silent lie
> with a loud, permanent failure.
>
> `execCommand` is not removed from any engine (it remains functional in Chromium, WebKit and Gecko
> despite being formally obsolete), so it is not deprecation that rules it out here — it is the gesture
> frame. It survives below **only** for the synchronous-payload case, where it is actually legal.

**The sanctioned pattern: claim the clipboard synchronously, resolve the payload later.**
`navigator.clipboard.write()` accepts a `ClipboardItem` whose value is a `Promise<Blob>`. Called
**synchronously inside the click frame**, it captures user activation immediately and resolves the text
afterwards — which is exactly the shape of a verb round trip. Supported in Safari 13.1+, Chrome 97+ and
Firefox 127+.

**This is reachable here, and that is not an accident of luck — it was verified.** `transport.js`'s
`vscodeShim.postMessage` is called *synchronously from click listeners* in the panels:

```js
// src/webview/project.js:3311-3315
btnCopyPrdPrompt.addEventListener('click', () => {
    if (!_selectedProjectName) return;
    vscode.postMessage({ type: 'copyPrdBuildPrompt', ... });   // ← still inside the gesture frame
});
```

Same shape for `btn-diagram-prompt` in `tickets.js`. So at `postMessage` time the gesture is live and the
`ClipboardItem` can be constructed before the `fetch()` is awaited.

**The one design cost: `transport.js` must know a verb is a copy verb *before* it sees the response.**
It cannot inspect `result.prompt` — that arrives too late. It has the verb name synchronously, so it
needs a client-side set of copy verbs. **Generate it from the gate** (Proposed Change 1), which already
walks every arm to find clipboard writers — emit `src/generated/copyVerbs.ts` (and a small JS constant
for the webview) from the same AST pass. The gate that enforces the contract also produces the list the
client needs, so the two cannot drift.

```js
// Generated by scripts/check-clipboard-return-parity.js — do not hand-edit.
const COPY_VERBS = new Set(['copyPrdBuildPrompt', 'copyDiagramPrompt', /* … */]);
```

Then, in the shim's `postMessage`, **before** the fetch:

```js
var clipboardClaim = null;
if (COPY_VERBS.has(verb) && navigator.clipboard && window.ClipboardItem) {
    // Claim the clipboard NOW, while the click's user activation is still live.
    // The payload resolves from the same fetch the verb is already making, so no
    // second round trip. WebKit loses the gesture across the await; this does not.
    var payload = fetchPromise
        .then(function (result) {
            var text = pickCopyText(result);          // result.prompt || result.__clipboard
            if (!text) { throw new Error('no copy payload'); }
            return new Blob([text], { type: 'text/plain' });
        });
    try {
        clipboardClaim = navigator.clipboard.write([
            new ClipboardItem({ 'text/plain': payload })
        ]);
    } catch (err) {
        clipboardClaim = Promise.reject(err);
    }
}
```

`fetchPromise` is the existing `fetch(...)` promise — the response handler chains off the same one, so
the request is made once. A verb that turns out to carry no payload rejects the blob promise, which
rejects the write; that is handled below and is not an error worth showing.

**Failure handling — and why the manual fallback is required, not optional.** If the claim rejects for a
real reason (permission denied, no secure context, unsupported engine), fall back to the manual copy
surface. `execCommand` is attempted only where it is legal — inside a *fresh* user gesture on the
fallback UI's own button:

```js
function offerManualCopy(text, reason) {
    // Programmatic copy is unavailable. Do NOT claim success, and do NOT retry
    // execCommand from here — this is post-await, so it is refused on the same
    // terms as writeText. Surface the text and let the user press Cmd/Ctrl+C.
    showManualCopyPanel(text, reason);
}
```

`showManualCopyPanel` renders a dismissible surface containing a **focused, pre-selected
`<textarea readonly>`** holding the text, plus a `<div role="status" aria-live="polite">` announcing
*"Automatic copy unavailable. Press Command+C or Control+C to copy."* (WCAG 2.2 SC 4.1.3). Its own
"Copy" button *may* call `execCommand('copy')` against that selection, because that click is a genuine
gesture frame — this is the single place the legacy API is still valid on this path.

**A concrete case that makes the manual surface mandatory rather than defensive.** WebKit treats
`http://localhost` and `http://127.0.0.1` as secure contexts, but **not** LAN addresses
(`http://192.168.x.x`) or custom local aliases. There, `navigator.clipboard` is `undefined` outright. That
is precisely the standalone scenario this plan's "Not in scope" section describes — the browser on a
different machine from the server — where a native server-side clipboard would be the wrong machine
*and* the browser API is unavailable. Without the manual surface, remote-LAN + Safari has **no copy path
at all**, and a button that cannot work must not pretend otherwise (PRD contract #6, capability-gating
honesty). Detect via `window.isSecureContext === false || !navigator.clipboard` and route straight to the
manual surface — skip the claim entirely rather than failing into it.

**Already satisfied — do not add it as work.** Research flagged that same-origin iframes need an explicit
`allow="clipboard-write"` in WebKit. Checked at HEAD: `src/webview/shell.js:383` already sets
`frame.setAttribute('allow', 'clipboard-read; clipboard-write')` on every panel frame. No change needed;
recorded so a coder does not "fix" it twice, and so a future refactor of `buildFrame` knows that
attribute is load-bearing.

<details>
<summary>Retained for the fallback UI's own button only — the legacy synchronous copy</summary>

```js
// LEGAL ONLY inside a real gesture frame (the manual panel's Copy button).
// Never call this from the fetch .then() — WebKit refuses it there exactly as it
// refuses writeText(), which is why the original fallback chain was unusable.
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

</details>

**The shared payload picker**, used by both the synchronous claim and the fallback:

```js
// `prompt` is the established key (Kanban's retrofitted arms, the standalone memo
// arm); `__clipboard` carries copies whose payload is not a prompt — today the
// Tickets "Link all" file-path list. Prefer `prompt` if an arm somehow has both.
function pickCopyText(result) {
    if (!result || typeof result !== 'object') { return ''; }
    if (typeof result.prompt === 'string' && result.prompt) { return result.prompt; }
    if (typeof result.__clipboard === 'string' && result.__clipboard) { return result.__clipboard; }
    return '';
}
```

**And the call site at `:372-376` — note what it no longer does.** The clipboard write has moved
*earlier*, into the synchronous claim before the fetch. What remains in the `.then()` is only the
transport-private cleanup and the fallback trigger:

```js
// The clipboard was already claimed synchronously (see above) — do NOT write it
// here. A write at this point is post-await and is refused by WebKit, which is
// the entire defect this plan exists to fix.
if (clipboardClaim) {
    clipboardClaim.catch(function (err) {
        console.warn('[transport] clipboard claim failed:', err);
        var text = pickCopyText(result);
        if (text) { offerManualCopy(text, err); }
    });
}
if (result && typeof result === 'object' && '__clipboard' in result) { delete result.__clipboard; }
```

The `__clipboard` delete mirrors the `__notices` delete the sibling subtask adds: the body is
re-dispatched as a `MessageEvent` at `:410-412`, and leaving a transport-private field in it invites a
panel handler to start reading it later.

**Ordering note for the sibling.** The clipboard claim now sits *above* the `fetch()` call, not inside
the `.then()`. That makes the two subtasks' edits less entangled than originally planned — the sibling's
notice loop owns the `.then()` almost exclusively — but the DO-NOT-TOUCH marking still applies to the
`clipboardClaim.catch(...)` block above.

**Do not touch the `EXPECTED_QUIET` block at `:377-405`.** The current handler suppresses the generic
failure toast for quiet-listed reasons (`not-imported`, e.g. `readLocalTicketFile` for a subtask whose
file has not been downloaded) while still falling through to `dispatchMessage` so the typed body reaches
its panel handler. It is easy to lose while editing this function; the sibling subtask's first draft
lost it. It is unrelated to clipboard work and must survive both changes byte-for-byte.

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
- Assert `handleCopyToClipboard` returns `__clipboard` equal to the joined path list handed to the
  clipboard recorder, and does **not** return `prompt` (the payload is file paths, not a prompt).
- **JSDOM, the gesture-order assertion — the one that locks in the redesign.** Stub
  `navigator.clipboard.write` and `window.ClipboardItem`. Post a copy verb and assert
  `navigator.clipboard.write` was called **before** the fetch promise resolved. Ordering *is* the
  contract: a write issued after resolution is the WebKit-refused shape this plan exists to eliminate,
  and it is invisible to any assertion that only checks the final clipboard contents. Also assert
  `writeText` was **never** called on the verb path.
- JSDOM: resolve the fetch with `{ success: true, prompt: 'abc' }` and assert the `ClipboardItem`'s
  `text/plain` promise resolves to a Blob containing `abc`; repeat with
  `{ success: true, __clipboard: 'x\ny' }` and assert `x\ny`.
- JSDOM: post a **non**-copy verb and assert `navigator.clipboard.write` was **not** called — the
  speculative claim must be gated on the generated `COPY_VERBS` set, or every button in the cockpit
  consumes user activation and races for the clipboard.
- JSDOM: make the claim reject and assert the manual-copy surface appears carrying the exact text, with
  a focused `<textarea>` and an `aria-live` status node. Assert `execCommand` was **not** called from the
  `.then()` path (it is refused there; attempting it teaches a false lesson to the next reader).
- JSDOM: set `window.isSecureContext = false` / delete `navigator.clipboard`, post a copy verb, and
  assert the manual surface is offered **without** a failed claim attempt first.
- **Assert the failure toast through a behavioural hook, not `#sb-transport-error`.** The sibling subtask
  replaces that singleton with a `#sb-transport-notices` stack, so an assertion on the old element id
  turns this test red the moment the sibling lands — a false regression on a working feature. Assert
  instead that `showTransportError` was reached (spy on it, or assert a visible node containing the
  copy-failure text appears anywhere under `document.body`). The message text and the fact that *some*
  error surface rendered are the contract; the element id is not.
- Assert the quiet-list is intact: resolve a fetch with `{ success: false, reason: 'not-imported', type: 'x' }`
  and assert **no** error surface rendered and `dispatchMessage` still ran.

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
   be **lower**. The tool's write path *refuses* to raise a ceiling by design, so a refusal means a real
   regression was introduced — fix the code, never hand-edit the baseline.

   Committed baseline at HEAD (2026-08-14) for reference:
   `{ Kanban: 1, Planning: 152, Tickets: 55, Design: 9, TaskViewer: 1, Setup: 0 }`.

   **The PRD's ratchet example is stale — do not treat it as the target.** The PRD names "Design = 14"
   as that provider's floor; the committed ceiling is already **9**. Drive to the measured residual the
   tool reports, not to any number quoted in prose.
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
15. Deny clipboard permission for the site in browser settings, click any copy button, and confirm the
    manual-copy surface appears with the full text pre-selected — not a bare console warning, and not a
    "Copy failed" toast with no recovery.

**Manual (the browser matrix that the redesign exists for) — do not skip Safari**

16. **Safari on `http://localhost`.** Repeat steps 11–13 in Safari. This is the configuration the
    original design failed in: expect the text on the clipboard on the first click, with no manual
    surface. If the manual surface appears, the synchronous claim is not actually synchronous — check
    that nothing `await`s between the click listener and `vscode.postMessage`.
17. **Safari over a LAN address.** Serve standalone and open it from another machine as
    `http://<lan-ip>:<port>`. Expect `navigator.clipboard` to be `undefined`, the copy button to route
    straight to the manual-copy surface, and **no** failed-claim warning in the console. This is the
    configuration with no programmatic copy path at all; the acceptance criterion is that it degrades
    honestly rather than dead-clicking.
18. **Chrome and Firefox on localhost.** Repeat step 11 in both. Firefox needs 127+ for
    `ClipboardItem`-with-promise; if the installed build is older, confirm it degrades to the manual
    surface rather than throwing.
19. **Accessibility check on the manual surface.** With VoiceOver or NVDA running, trigger it and confirm
    the status message is announced and focus lands in the textarea with the text selected, so
    `Cmd/Ctrl+C` works without further navigation.

**Manual (extension-served browser and editor — must be unchanged)**
16. With the extension running, `npx switchboard`, repeat steps 11–13. Expect the same prompts on the
    clipboard (host write and browser write agree; the double write is invisible).
17. In VS Code, click the same buttons in the panel webviews. Expect identical behaviour to today,
    including the `Copied!` button affordance and the native notifications.

## Execution Order (batching)

PRD "Orchestration discipline" caps a batch at ~20–30 arms and serialises same-file edits. This plan is
~42 arms across four provider files, so run it as four gated batches — one provider file per batch, gate
between:

0. **The client half first, on its own.** `transport.js` (Change 7): the synchronous clipboard claim,
   the generated `COPY_VERBS` consumption, and the manual-copy surface. This is now the hardest and
   least mechanical part of the plan, it is the piece the browser matrix (Verification 16–19) actually
   tests, and every retrofitted arm downstream is unverifiable end-to-end until it exists. Doing it last
   — as the original batching had it, riding along with batch 1 — would mean discovering a WebKit
   gesture problem after 42 arms had already been edited.
1. **Gate + `sharedUtilityVerbs.ts`** — `check-clipboard-return-parity.js` (including the `COPY_VERBS`
   emitter that step 0 consumes) plus that file's 3 sites and both signature widenings. Smallest server
   surface, and it proves the gate's arm-walk on the file with the trickiest shapes before 40 more arms
   depend on it.
2. **`PlanningPanelProvider.ts`** — 18 arms (largest single batch).
3. **`DesignPanelProvider.ts`** — 12 arms + the `promptText` key fix.
4. **`TaskViewerProvider.ts`** (9 sites, classify first) + **`KanbanProvider.ts`** audit-only.

Steps 0 and 1 have a mutual dependency — the client needs the generated verb list, the generator is part
of the gate. Land the gate's emitter first as a stub over a hand-written seed list if that unblocks
step 0, but the seed must be replaced by generated output before batch 2. Re-run the gate after each
batch; the violation count only ever falls.

## Cross-Subtask Reconciliation

This plan and its sibling — **"Bridge host notifications to the browser panels"** — both edit
`src/webview/transport.js`, and both touch `src/standalone/vscodeShim.ts` and
`src/services/sharedUtilityVerbs.ts`. The reconciled contract:

| Surface | This plan (lands **first**) | Sibling (lands **second**) |
| :--- | :--- | :--- |
| `transport.js` — **above** the `fetch()` call | Adds the synchronous `ClipboardItem` claim, gated on generated `COPY_VERBS` | Does not touch it |
| `transport.js` `.then(result)` — clipboard block `:372-376` | **Removes the write from here entirely**; leaves only `clipboardClaim.catch(...)` + `__clipboard` cleanup | **Does not touch it.** Must not re-paste the pre-retrofit `navigator.clipboard` lines — a post-`await` write is the exact WebKit-refused shape this plan removed |
| `transport.js` `EXPECTED_QUIET` block `:377-405` | Untouched | Untouched — preserve byte-for-byte |
| `transport.js` error surface | Uses `showTransportError` as it exists today | Generalises it into a `#sb-transport-notices` stack, keeping `showTransportError` as a thin wrapper |
| Reserved body keys | Adds `__clipboard` | Adds `__notices` — same `__` transport-private convention |
| `vscodeShim.ts` | Clipboard no-op `:292-295` stays a no-op (see Not in scope) | Edits `show*Message` `:133-135` — a different hunk, no conflict |
| `sharedUtilityVerbs.ts` `handleCopyDiagramPrompt` | Adds `prompt` to the return, widens the signature | Reads it in a contract test; does not edit it |
| `hostServices.ts` `createHeadlessHostSeams` | Not edited | Not edited — feature-level decision recorded in the feature file |

**Why this plan ships first.** If the toast subtask lands alone, standalone gains a green
"…copied to clipboard" toast over an **empty** clipboard — a louder, more convincing version of today's
`Copied!` lie. Shipping the body channel first means every toast the sibling adds is telling the truth on
arrival. Landing both together is equally acceptable; landing the sibling first is not.

**The one assertion that must not be written naively.** This plan's JSDOM test asserts a copy failure is
visible. Asserting on `#sb-transport-error` — the element id that exists today — makes this test go red
when the sibling replaces that singleton with a stack. Assert on behaviour (`showTransportError` reached,
or a visible node carrying the message), never on that id. See Proposed Change 8.

## Resolved Assumptions

**Both external uncertainties were researched on 2026-08-14 and are now settled. Do not re-open them.**
Proposed Change 7 was redesigned around the answers; the record below exists so the next reader knows the
design is deliberate rather than incidental.

1. **WebKit rejects `navigator.clipboard.writeText()` after an `await fetch()` — CONFIRMED.** WebKit
   verifies user activation against the JavaScript call stack, so resolving a network request moves
   execution to a microtask turn that no longer traces back to the click. Chromium and Gecko keep
   activation across the boundary (subject to a ~5s timeout), which is why this bug is invisible in
   Chrome. The comment in `memo-browser-clear-and-copy-contract.test.js` was correct.
2. **`document.execCommand('copy')` is NOT a viable fallback here — REFUTED, and this killed the
   original design.** It is not removed from any engine (still functional in Chromium, WebKit and Gecko
   despite being formally obsolete in the HTML spec), but it requires an active gesture frame on the
   *same terms* as `writeText()`, plus a live DOM selection in WebKit. Called from the fetch `.then()`,
   it fails exactly where `writeText()` fails. The original chain would have shown a permanent
   "Copy failed" toast in Safari — a louder failure than the silent lie it replaced.
3. **The sanctioned pattern is `navigator.clipboard.write()` with a `Promise<Blob>` inside
   `ClipboardItem`, called synchronously in the click frame** — Safari 13.1+, Chrome 97+, Firefox 127+.
   Verified reachable here: the panels call `vscode.postMessage` synchronously from their click
   listeners (`project.js:3311`, `tickets.js` `btn-diagram-prompt`).
4. **Iframe permission — already satisfied.** WebKit requires `allow="clipboard-write"` on same-origin
   iframes; `src/webview/shell.js:383` already sets it. No work; recorded so it is not re-done or
   accidentally dropped in a `buildFrame` refactor.
5. **Secure context — a real gap, now designed for.** `http://localhost` and `http://127.0.0.1` are
   secure contexts in all three engines, but WebKit does **not** extend that to LAN IPs or custom local
   aliases, where `navigator.clipboard` is `undefined`. Standalone served to another machine over HTTP
   therefore has no programmatic copy path in Safari — which is why the manual-copy surface is a required
   deliverable rather than a defensive extra.

No further web research is needed for this plan. The remaining unknowns are all code-answerable and are
tracked as classification work in Proposed Change 5 (the 9 `TaskViewerProvider` sites) and Change 6
(the Kanban audit).
