# Link-Up Preset Instructions — Pick The Relationship From A Dropdown Instead Of Hand-Writing It Every Time

## Goal

Add a preset picker to the Link-up modal so the common relationships — *researcher for*, *reviewer for*, *tester for*, *hand over context to* — are one selection instead of a paragraph typed from scratch. Selecting a preset fills the instruction box with resolved text (real terminal names substituted), and the text stays editable. `Custom…` clears it and behaves exactly as the modal does today.

The modal should open **send-ready**: a preset is selected by default, so the happy path is *open → SEND*.

> **Superseded:** the line references throughout this plan (`openLinkModal` at `:7397`, `syncSendEnabled` at `:7390`, `buildLinkPrompt` at `:7451`, `wireLinkModal` at `:7551`, `terminals.html:1683-1691`, CSS `:1476-1490`, etc.).
> **Reason:** `src/webview/terminals.js` grew by ~28 lines above the link-up block after this plan was written; every cited line pointed ~28 lines short of its target. A plan whose citations miss is a plan a coder stops trusting on the first lookup.
> **Replaced with:** all references below re-verified against HEAD. Canonical anchors: `defaultLinkParent` `:7368`, `fillTerminalSelect` `:7382`, `syncChildOptions` `:7401`, `setLinkError` `:7411`, `syncSendEnabled` `:7418`, `openLinkModal` `:7425`, `syncLinkUpEnabled` `:7449`, `buildLinkPrompt` `:7479`, `sendLinkMessage` `:7518`, `wireLinkModal` IIFE `:7579`, textarea `input` listener `:7594`, textarea `keydown`/`stopPropagation` `:7598`, LINK UP click wiring `:918-919`, `loadSetting` `:1292`, `saveSetting` `:1309`, `loadLayoutSettings` `:1320`, `saveLayoutSettings` `:1388`. In `src/webview/terminals.html`: `.link-field-label` `:1497-1503`, `.link-select` / `.link-message` `:1504-1512`, modal markup `:1697-1721`, parent field `:1704-1705`, child field `:1707-1708`, instruction label + textarea `:1710-1712`.

### Problem

The instruction field is a bare, always-empty textarea, and the modal actively refuses to work until the operator writes prose.

- `openLinkModal` (`src/webview/terminals.js:7425`) blanks it on every single open: `messageEl.value = ''` (`:7436`). There is no history, no last-used value, no default.
- `syncSendEnabled` (`:7418`) is `sendBtn.disabled = !msg.value.trim()` — SEND is dead until something is typed.
- The markup has exactly three controls (`src/webview/terminals.html:1704-1712`): parent select, child select, and the textarea, whose placeholder (`"e.g. hand over the context of this task to terminal 2"`) is the *only* hint anywhere that canned relationships are even the intended use.

So every link-up — including repeating the identical arrangement on a fresh pair of terminals five minutes later — costs a paragraph of hand-authored prose. Worse, the quality of the relationship depends entirely on how carefully the operator phrases it in the moment; a terse "you're the researcher" produces a very different agent than a well-specified one, and there is nothing to make the good phrasing the default.

### Root cause

**There is no source of instruction text in the codebase to populate a dropdown from.** The concepts the operator wants to pick — researcher, reviewer, tester — exist only as *roles*: `BuiltInAgentRole` in `src/services/agentConfig.ts:1`, the `GRID_BUILTIN_ROLES` array in `terminals.js:5508`, the kanban column definitions at `agentConfig.ts:145`. Those are identifiers and column mappings, not relationship prose, and none of them says anything about how one terminal should work *with another*.

`buildLinkPrompt` (`:7479`) then treats the operator's text as an opaque verbatim slot — it interpolates `message` between `---` delimiters and adds transport mechanics around it. It has no notion of a relationship *type*, so there was never a hook where a preset could have been resolved.

The result is that the one part of link-up the operator must supply is the one part the feature gives no help with at all.

## Metadata

**Tags:** frontend, ui, ux, feature
**Complexity:** 4
**Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3
> **Reason:** 3 reads as "routine single-file change" and routes the card to an Intern. This touches two files, introduces a new persisted setting, and adds a small state machine (`presetDirty` × preset-change × parent/child-change) whose one wrong branch produces an instruction naming the wrong terminal. It also has to serialise against an in-flight plan editing the same file. That is the low end of Medium, not the top of Low.
> **Replaced with:** **Complexity:** 4 → *Send to Coder*.

## User Review Required

None. Every open question this plan started with is decided in-line: the dirty-flag precedence rule, the `Custom…` behaviour, the default selection, where the persisted preset is read, and the label wording. Nothing is left for the operator to adjudicate before coding.

## Complexity Audit

### Routine
- The new control is a fourth field in a modal body that already holds three, styled by the existing `.link-select` rule (`terminals.html:1504`). No new CSS class is strictly required.
- `wireLinkModal` (`:7579`) is the established place to bind it, right beside the existing `parentSel.addEventListener('change', syncChildOptions)` (`:7592`).
- Nothing downstream changes. The resolved preset text lands in the same `message` slot `buildLinkPrompt` already consumes verbatim, so the prompt builder, the send path, the validation and the error surface are all untouched.
- Persisting the last-used preset reuses `saveSetting` / `loadSetting` (`:1309`, `:1292`) exactly as `terminals.groupPrefs` and friends do.
- No migration: the preset list is new state that has never shipped, and an absent saved preset falls back to the first entry.
- No new host surface. `loadSetting` / `saveSetting` POST to `/kanban/verb/getSetting` and `/kanban/verb/saveSetting`, which `loadLayoutSettings` (`:1320`) already depends on in both hosts. There is no new verb, no `verbSchemas.ts` entry, no `/panels` manifest row and no return-contract ratchet movement — so the project's two-layer completion contract is satisfied by construction rather than by a follow-up wiring plan.

### Complex / Risky
- **Placeholder staleness.** Preset text bakes in the parent and child *names*. Change the child select after picking a preset and the instruction now names the wrong terminal. Resolved by re-resolving on select change, guarded by a dirty flag (below). See "Residual: stale names in operator-edited prose" for the one case the flag deliberately does not cover, and why it is a wording inconsistency rather than a mis-delivery.
- **Clobbering the operator's edits.** Re-resolving must never overwrite text the operator has hand-modified.
- **Preset wording is the actual deliverable.** A dropdown of vague one-liners is worse than the current empty box, because it makes bad phrasing the default and invisible. The templates below are the substance of this plan, not filler.
- **Same-file serialisation.** `feature_plan_20260811170004_link-up-relay-endpoint-and-safe-clear-default.md` edits `buildLinkPrompt` in this same file. Logically independent; physically colliding. Do not run both in parallel (see Dependencies).

## Edge-Case & Dependency Audit

### Race Conditions

**Modal-open must not await the network.** The persisted preset is read once at init inside `loadLayoutSettings` (`:1320`), *not* per open.

> **Superseded:** `openLinkModal` awaits `loadSetting('terminals.linkPreset', …)` on every open and becomes `async`; its only caller ignores the return value, so nothing else changes.
> **Reason:** `loadSetting` (`:1292`) is an HTTP round-trip to `/kanban/verb/getSetting`. Awaiting it inside the open path means the modal no longer appears on the frame the operator clicks LINK UP, and a slow or failed call leaves the button looking dead — a second click then queues a second open. It also breaks the file's own settings idiom: every other `terminals.*` key is batch-read once in `loadLayoutSettings` and written fire-and-forget. The `async`-ness bought nothing that the init read does not.
> **Replaced with:** a module-level `let linkPreset = null;` populated in `loadLayoutSettings`, validated against `LINK_PRESETS` at load. `openLinkModal` stays **synchronous** and reads the already-resolved variable.

Everything else in this change is single-threaded DOM work inside one modal. The fleet can change while the modal sits open, but that is pre-existing and already handled: `sendLinkMessage` (`:7518`) re-validates both ends against `fleetList` before posting, and `syncLinkUpEnabled` (`:7449`) recomputes the two-live-terminals precondition on every poll. Neither is affected by what fills the textarea.

### Security

Nothing new. The preset text is authored in-tree, interpolated only with terminal `friendlyName`s already rendered in the two adjacent selects, and delivered on the existing `ptySendPrompt` path with the existing explicit `clearBeforePrompt: false` (`:7554`). The templates are ordinary single-quoted string concatenation — **not** template literals — so `${…}` and backticks in preset prose cannot be evaluated. No secret is touched: the API token continues to reach the agent as `$SWITCHBOARD_API_TOKEN` and is never interpolated into text.

### Side Effects

- **One new persisted key:** `terminals.linkPreset` (a preset `id` string). Written from the preset `change` handler only — deliberately **not** added to `saveLayoutSettings` (`:1388`), which fires on every layout mutation and would rewrite an unchanged key repeatedly. `saveSetting` already no-ops under solo mode (`:1310`), and solo hides `.terminals-sidebar` — which is where LINK UP lives (`terminals.html:1646`) — so the modal is unreachable there anyway.
- **The modal's initial SEND state flips from disabled to enabled.** Intended, and the headline of this change. `syncSendEnabled`'s predicate is unchanged, so `Custom…` (empty box) still disables it correctly.
- **Programmatic `messageEl.value = …` does not fire `input`.** Load-bearing: it is why `applyPresetToMessage` can set the text without tripping its own dirty flag, and why it must call `syncSendEnabled()` itself rather than relying on the listener at `:7594`.

### Dependencies & Conflicts

**The relay-endpoint plan — serialise, do not parallelise.** `feature_plan_20260811170004_link-up-relay-endpoint-and-safe-clear-default.md` rewrites `buildLinkPrompt`'s transport section and keeps the operator instruction first and verbatim; this plan only changes what fills the `message` argument. They compose in either order *semantically*. But both edit `src/webview/terminals.js`, and the project's orchestration discipline is one agent stream per file. Run them sequentially. That plan's own line references (`:7479`, `:7518`, `:7449`) are already correct against HEAD; if this plan lands first, re-derive them before starting it.

### Decided behaviours

**Dirty tracking.** A `presetDirty` flag is set on the first `input` event on the textarea after a preset resolve. While clean, changing the preset, parent or child re-resolves the text. Once dirty, only an explicit preset re-selection overwrites it — selecting a preset is an unambiguous "give me that text", so it always wins; a parent/child change while dirty does not touch the box. `openLinkModal` resets the flag.

**Custom.** `Custom…` sets the textarea empty, clears the dirty flag, and focuses it — identical to today's behaviour, so nothing is taken away from an operator who wants to write freely.

**Default selection.** The first preset (`researcher`), or the last-used preset when one is saved. A saved id that is not in `LINK_PRESETS` (a renamed or removed preset) normalises back to `LINK_PRESETS[0].id` **at load time** — see the callout under Proposed Changes §2 for why validating only at `sel.value` assignment is not enough.

**`Custom…` persists too, and that is correct.** If the operator's last choice was `Custom…`, the modal reopens with an empty box and SEND disabled. That contradicts the "opens send-ready" headline for exactly the operator who explicitly asked not to be given text — last-used means last-used, and one preset selection restores the send-ready path.

**Focus.** `openLinkModal` currently focuses the textarea because "the instruction is the only thing left to supply" (`:7441`). With a preset pre-filling it, focus moves to the preset select — it is now the primary control, and putting focus there is what makes it discoverable. Tab order is preset → textarea (the field is inserted directly above the instruction label), so an edit is one keystroke away.

**xterm keystroke stealing.** The textarea calls `stopPropagation()` on keydown (`:7598`) because xterm eats keys. The existing `#link-parent` / `#link-child` selects do **not**, and work fine — the modal is a full-viewport overlay and the terminal is not focused behind it. Follow the existing select idiom; do not add a handler.

**Single-terminal fleets.** Unchanged. `syncLinkUpEnabled` (`:7449`) still disables the button below two live terminals, and the preset select is never reached.

**Non-goal, stated:** operator-authored *saved* presets (a managed library with add/rename/delete) are out of scope. `Custom…` covers the one-off case; a persisted user library is a separate, larger surface with its own storage and management UI.

### Residual: stale names in operator-edited prose

The dirty flag deliberately does not re-resolve a hand-edited box on a child change, so an operator who types and *then* switches the child is left with their own prose naming the previous child. This is bounded, not dangerous: `buildLinkPrompt` (`:7479`) emits `TARGET TERMINAL: ${childName}` from the live select at send time, and `sendLinkMessage` posts to the live parent — so delivery is always correct and the stale name is a wording inconsistency inside the operator's own text, visible in the box they just typed in.

Rejected mitigations, recorded so they are not re-proposed: (a) find-and-replace the old child name inside the operator's prose — silently editing typed text is worse than the inconsistency; (b) a warning banner under the box — CLAUDE.md forbids nothing here, but the operator can already read the box, and the codebase's standing preference is not to narrate states the user is looking at. Optional cheap hardening if a coder wants it: keep the last resolved string in `lastResolvedText` and treat `messageEl.value === lastResolvedText` as clean regardless of the flag, which recovers the type-then-undo case for free.

## Dependencies

None — no prior agent session is a prerequisite for this work, so there is no `sess_…` chain to record. The one real dependency is a file-level ordering constraint on a sibling plan, captured under **Edge-Case & Dependency Audit → Dependencies & Conflicts**: `feature_plan_20260811170004_link-up-relay-endpoint-and-safe-clear-default.md` edits the same file and must not run concurrently.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) preset text that names a terminal the operator has since changed — contained because `buildLinkPrompt` derives the authoritative `TARGET TERMINAL` from the live select, so the worst case is prose disagreeing with the header, not a mis-delivery; (2) a persisted preset id that no longer exists silently producing an empty box under a dropdown reading "Researcher" — closed by normalising the saved id at load; (3) five paragraphs of canned prose becoming the invisible default for every future link-up, which makes wording the deliverable rather than the plumbing. Mitigations: validate the saved id in `loadLayoutSettings`, keep the persisted read out of the modal-open path so the modal opens on the click frame, gate all re-resolution behind an explicit `presetDirty` precedence rule, and verify the `researcher` preset against a live pair rather than only reading it.

## Proposed Changes

### 1. `src/webview/terminals.js` — the preset table

Placed near the other link-up helpers, above `defaultLinkParent` (`:7368`), inside the same `// ─── Link-up modal ───` block that starts at `:7353`. `{child}` and `{parent}` are substituted at resolve time.

```js
/**
 * Link-up instruction presets. The point of each one is to be a BETTER
 * instruction than what an operator types in a hurry: it states the
 * relationship, what triggers a hand-off, and that the parent keeps working —
 * the three things a terse "you're the researcher" leaves out and the agent
 * therefore gets wrong.
 *
 * Ordered by expected use. The first entry is the default, so the modal opens
 * send-ready.
 *
 * `label` is STATIC — see the Superseded callout in this plan. The child's real
 * name appears in the resolved text, which is where it is load-bearing; the
 * adjacent #link-child select already names it before the operator picks.
 *
 * Single-quoted concatenation, NOT template literals: preset prose must never be
 * evaluated, and `{child}` / `{parent}` are substituted by resolvePreset().
 */
const LINK_PRESETS = [
    {
        id: 'researcher',
        label: 'Researcher — it researches for me',
        template:
            '{child} is your researcher. When you hit a question that needs external sources, ' +
            'documentation or API details you do not already have, hand it to {child} with enough ' +
            'context to work standalone — it cannot see your conversation. Keep working on what you ' +
            'can while it runs, and fold its answer in when it comes back. Do not block on it.'
    },
    {
        id: 'reviewer',
        label: 'Reviewer — it reviews my work',
        template:
            '{child} is your reviewer. When you finish a self-contained unit of work, hand {child} ' +
            'a summary of what changed and which files — it cannot see your conversation, so make ' +
            'the summary stand on its own — and ask it to review before you move on to the next ' +
            'unit. Address what it raises rather than deferring it.'
    },
    {
        id: 'tester',
        label: 'Tester — it verifies my work',
        template:
            '{child} is your tester. When a change is ready to verify, hand {child} what you changed ' +
            'and what the expected behaviour is — it cannot see your conversation, so state both ' +
            'explicitly — and let it run the checks. Treat a failure it reports as your work to fix, ' +
            'not its.'
    },
    {
        id: 'handoff',
        label: 'Hand off — give it my context',
        template:
            'Hand over the full context of what you are working on to {child}: the goal, what you have ' +
            'done so far, what is left, and any decisions or dead ends that matter. {child} has no ' +
            'visibility into your conversation, so write it to be picked up cold.'
    },
    {
        id: 'second-opinion',
        label: 'Second opinion — ask it before I decide',
        template:
            'Before you commit to an approach on anything non-trivial, put it to {child} as a second ' +
            'opinion: state the approach, the alternatives you rejected and why. Weigh what comes back ' +
            'on the merits — {child} is not the decision-maker, you are.'
    },
    { id: 'custom', label: 'Custom…', template: '' }
];

/** The persisted last-used preset id, resolved once in loadLayoutSettings(). */
let linkPreset = LINK_PRESETS[0].id;
let presetDirty = false;

function resolvePreset(id, parentName, childName) {
    const preset = LINK_PRESETS.find(p => p.id === id);
    if (!preset || !preset.template) { return ''; }
    return preset.template
        .replace(/\{child\}/g, childName || 'the other terminal')
        .replace(/\{parent\}/g, parentName || 'this terminal');
}
```

> **Superseded:** `label` strings carry `{child}`, substituted when the options are built, so the dropdown itself reads *"Researcher — reviewer-1 researches for me"*; `fillPresetSelect(selectedId)` rebuilds the whole `<select>` and is re-called from `syncChildOptions` on every parent/child change.
> **Reason:** the interpolation buys nothing and costs a mechanism. The child's name is already on screen in the `#link-child` select immediately above, so the option text repeats it — and to keep the repetition current, the entire `<select>` has to be torn down and rebuilt on every parent and child change, purely for cosmetics. That rebuild is what forces a re-select afterwards, and the plan's own snippet called `fillPresetSelect(currentId)` with `currentId` never defined anywhere — the exact selection-loss bug the rebuild introduces. Option text also cannot wrap, so long friendly names push the label past the 480px modal with no graceful failure.
> **Replaced with:** static labels that keep the *direction* of the relationship ("it reviews my work") without naming anyone. The options are built **once**, and `{child}` / `{parent}` resolve only into the textarea, where the name is genuinely load-bearing. `syncChildOptions` no longer touches the select's options at all — it only re-resolves the text.

> **Superseded:** the `reviewer` and `tester` templates as originally written (no mention that the child cannot see the parent's conversation).
> **Reason:** "it cannot see your conversation" is the single most load-bearing fact in every one of these relationships — it is what makes an agent write a self-contained hand-off instead of a pronoun-laden fragment — and it appeared in only three of five templates. The two that omitted it are exactly the two where a lazy hand-off ("review what I just did") fails silently.
> **Replaced with:** the clause added to `reviewer` and `tester` above. `handoff` and `researcher` already carried it; `second-opinion` states the approach and alternatives explicitly, which serves the same purpose.

### 2. `src/webview/terminals.js` — wiring

```js
/** Build the preset options once. The option text is static, so there is no
 *  reason to rebuild this on a parent/child change. */
function buildPresetOptions() {
    const sel = document.getElementById('link-preset');
    if (!sel) { return; }
    sel.innerHTML = '';
    for (const p of LINK_PRESETS) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        sel.appendChild(opt);
    }
}

/** Re-resolve the instruction text. `force` = an explicit preset selection, which
 *  always wins over the operator's edits; otherwise a dirty box is left alone. */
function applyPresetToMessage(force) {
    const presetSel = document.getElementById('link-preset');
    const messageEl = document.getElementById('link-message');
    const parentSel = document.getElementById('link-parent');
    const childSel = document.getElementById('link-child');
    if (!presetSel || !messageEl || !parentSel || !childSel) { return; }
    if (presetDirty && !force) { return; }
    messageEl.value = resolvePreset(presetSel.value, parentSel.value, childSel.value);
    // A programmatic .value assignment does NOT fire `input`, so this neither
    // trips presetDirty nor reaches the listener at :7594 — hence the explicit
    // reset and the explicit syncSendEnabled().
    presetDirty = false;
    syncSendEnabled();
}
```

The four-element guard is deliberate: the original snippet guarded `presetSel` and `messageEl` and then dereferenced `document.getElementById('link-parent').value` unguarded, which throws on the very DOM shape the guard exists to tolerate.

Bound in `wireLinkModal` (`:7579`), beside the existing `parentSel` change handler (`:7592`):

```js
buildPresetOptions();            // static options; the DOM is parsed by now
const presetSel = document.getElementById('link-preset');
if (presetSel) {
    presetSel.addEventListener('change', () => {
        linkPreset = presetSel.value;
        applyPresetToMessage(true);
        saveSetting('terminals.linkPreset', linkPreset);
        if (presetSel.value === 'custom') { document.getElementById('link-message').focus(); }
    });
}
```

`syncChildOptions` (`:7401`) gains a tail call to `applyPresetToMessage(false)` so the resolved names follow the child selection. The textarea's existing `input` listener (`:7594`) becomes `() => { presetDirty = true; syncSendEnabled(); }`.

**Load the persisted preset in `loadLayoutSettings` (`:1320`)**, alongside the other `terminals.*` reads:

```js
const savedPreset = await loadSetting('terminals.linkPreset', LINK_PRESETS[0].id);
linkPreset = LINK_PRESETS.some(p => p.id === savedPreset) ? savedPreset : LINK_PRESETS[0].id;
```

Two things this normalisation buys, and one apparent hazard that is not one:

- **Validate at load, not at assignment.** Guarding only the `sel.value = savedPreset` write leaves an unknown id in `linkPreset` while the browser leaves the select showing its first option. `resolvePreset` then finds no match and returns `''`, so the operator gets an empty box and a disabled SEND under a dropdown reading "Researcher" — a state with no explanation on screen. Normalising the variable makes the two agree by construction.
- **`LINK_PRESETS` is declared ~6000 lines *below* `loadLayoutSettings`, and that is fine.** It is a module-scope `const` inside the file's IIFE, and `loadLayoutSettings` is only ever called from `init()`, which runs at `:7607-7611` — after the IIFE body has executed top to bottom. The temporal dead zone only bites a read during that synchronous pass. Worth the comment, because it looks wrong.

### 3. `src/webview/terminals.js` — `openLinkModal` (`:7425`)

Replace the unconditional blanking at `:7436`:

```js
- messageEl.value = '';
+ presetDirty = false;
+ presetSel.value = linkPreset;   // options already exist — built once in wireLinkModal
+ applyPresetToMessage(true);     // fills the box; SEND is live on open
```

Ordering is load-bearing. `openLinkModal` calls `syncChildOptions()` at `:7435`, which now tail-calls `applyPresetToMessage(false)` — so the preset must be selected **before** that call, or the first resolve runs against whatever the select happened to hold. Set `presetSel.value` immediately after `fillTerminalSelect(parentSel, …)` (`:7434`) and before `syncChildOptions()`; the explicit `applyPresetToMessage(true)` afterwards then makes the final state independent of how the intermediate call landed.

Then move focus from the textarea to the preset select at `:7441`:

```js
- messageEl.focus();           // the instruction is the only thing left to supply
+ presetSel.focus();           // the preset is now the primary control; Tab reaches the box
```

`openLinkModal` stays **synchronous** — no `await`, no signature change, and the caller at `:918-919` (`btnLinkUp.addEventListener('click', openLinkModal)`) is untouched.

### 4. `src/webview/terminals.html`

Above the existing instruction label (`:1710`), between the child select and the textarea:

```html
<label class="link-field-label" for="link-preset">Instruction preset</label>
<select id="link-preset" class="link-select"></select>
```

The `.link-field-label` (`:1497-1503`) and `.link-select` (`:1504-1511`) rules already cover it; no CSS change. Inserting **between** the existing fields rather than at the top also leaves `.link-field-label:first-child { margin-top: 0; }` (`:1503`) matching the Parent label as it does today.

Leave the textarea's placeholder in place. It is dead in the pre-filled path but is still the right hint the moment `Custom…` empties the box.

## Verification Plan

Manual UAT against a running host, in order. Steps 1–8 need two live terminals; step 11 needs one.

1. **Opens send-ready.** Open Link-up. A preset is selected, the instruction box is pre-filled with the resolved text, and SEND is enabled without typing. The modal appears on the click, with no perceptible delay for a settings fetch.
2. **Names are real.** The filled text names the actual selected child terminal — no `{child}` or `{parent}` placeholder is ever visible. The dropdown labels are static and name no terminal.
3. **Preset switch.** Select each preset in turn. The box is replaced each time with correctly resolved text.
4. **Child change re-resolves.** With an untouched box, change the child select. The instruction now names the new child. Confirm the same for the parent select, and confirm the preset select keeps its selection across both (it is never rebuilt).
5. **Edits survive.** Type into the box, then change the child select. The edit is preserved and is not overwritten.
6. **Explicit selection wins.** After editing, select a different preset. The box is replaced — a preset pick is an explicit request.
7. **Custom.** Select `Custom…`. The box empties, focus lands in it, and SEND is disabled until text is typed — today's behaviour exactly.
8. **Last-used persists.** Pick a non-default preset, send, reopen the modal. That preset is selected. Reload the panel and confirm it survives. Repeat with `Custom…` and confirm it too is restored (empty box, SEND disabled) — that is the decided behaviour, not a regression.
9. **Delivery is unchanged.** Send with a preset. The parent receives the resolved preset text verbatim inside the operator-instruction section of the prompt, with no template syntax and no truncation.
10. **Preset text does its job.** Run the `researcher` preset against a live pair and confirm the parent actually delegates a question to the child and keeps working rather than blocking — the wording is the deliverable, so it gets tested, not just read. Spot-check `reviewer` for the same: the summary it hands over must stand alone, with no pronouns pointing back at its own conversation.
11. **Precondition intact.** With one live terminal, LINK UP stays disabled with its existing tooltip.
12. **Escape / cancel.** Both still close the modal, and reopening re-resolves cleanly with no leftover dirty state (type, Escape, reopen → the box holds resolved preset text, not the abandoned edit).
13. **Stale-name residual is bounded.** Type into the box naming child A, switch the child to B, send. Confirm the prompt's `TARGET TERMINAL:` header reads **B** and delivery goes to the correct parent — the only artefact is the operator's own prose still saying A.
14. **Corrupt saved preset.** Write a junk value to `terminals.linkPreset` (e.g. via `POST /kanban/verb/saveSetting`), reload, and open the modal. The dropdown shows `Researcher` **and** the box holds the researcher text — the two must not disagree.

### Automated Tests

**None run in this pass** — this improve pass ran under explicit `SKIP TESTS` / `SKIP COMPILATION` directives, so no suite was executed and no result is asserted here.

For the coder who picks this up: this change adds no new module, export, verb or route, so there is no natural new unit to test — the behaviour lives entirely in DOM wiring inside `terminals.js`. Treat the existing panel contract suites as the regression surface (the terminal contract tests, and the browser-panel scrollbar contract test that `terminals.html` is already subject to per the comment at `:1488-1490`); this change touches neither scrollbar CSS nor the verb surface, so they should be green unmodified. If a coder wants one automated assertion for the money path, the highest-value one is a pure-function test over `resolvePreset` — every id resolves non-empty except `custom`, no `{`/`}` survives substitution, and an unknown id returns `''` — because that is the function whose silent `''` return is behind finding 14.

---

**Recommendation: Send to Coder** (Complexity 4).

## Completion Report

Implemented the preset instruction dropdown for the Link-up modal. Added `LINK_PRESETS`, `resolvePreset`, `buildPresetOptions`, and `applyPresetToMessage` to `src/webview/terminals.js`; wired the new `#link-preset` select in `wireLinkModal`; updated `openLinkModal` to open send-ready with the last-used preset; made `syncChildOptions` re-resolve names while respecting `presetDirty`; loaded `terminals.linkPreset` in `loadLayoutSettings` with validation; and inserted the `<select>` into `src/webview/terminals.html`. A `node --check` syntax pass of `terminals.js` passed. No automated test suite or compilation was run per the plan's `SKIP TESTS` / `SKIP COMPILATION` directives.

## Review Findings

Reviewed at HEAD `1bd39f4a` + working tree; the plan's own surface (preset table, `resolvePreset`, `buildPresetOptions`, `applyPresetToMessage`, the `#link-preset` markup, the persisted `terminals.linkPreset`) matches the plan and its Superseded callouts. Two defects were fixed in `src/webview/terminals.js`: `openLinkModal` had been made `async` by the sibling standing-orders work and awaited `fetchStandingOrders()` *before* `modal.hidden = false`, violating this plan's explicit "modal-open must not await the network" decision — the send-ready path is now fully synchronous and the standing-orders list renders into an already-visible modal; and `presetSel.value` is now assigned *before* `syncChildOptions()` per §3's ordering requirement. Also coerced `linkMode` alongside the select in `syncModeAvailability`, which previously left the variable on `standing` while the dropdown read `Instant`, so SEND took the standing branch against a store the gate had just declared unreachable. Verification (run independently — no `SKIP` directive was present in the dispatch): `node --check` and `eslint` clean; `test:contract:link-presets-mirror` 7/7, `standing-orders-marker` 16/16, `panel-scrollbars` 45/45, `terminal-*` and `shell-modal-panel` suites green; `parity:check`, `push-routing:check`, `verb-returns:check`, `standalone-parity:check` all pass (one pre-existing failure in `shell-terminal-strip`, identical at HEAD, unrelated). Remaining risk: `reports-to-head` (`direction: 'member-receives'`) is still offered in a modal that always writes `{parent, child}` from the two selects, so picking it installs the order on the wrong end — left in place deliberately because `feature_plan_20260812171500_link-up-presets-fire-through-relay-not-standing-orders.md` owns that asymmetry and instructs that it not be silently fixed; manual UAT steps 1–14 remain unrun.
