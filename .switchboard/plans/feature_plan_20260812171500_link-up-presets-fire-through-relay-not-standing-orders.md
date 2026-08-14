# Link-Up Role Presets Fire Through The Relay Path, Inverting Who The Instruction Is Addressed To

## Goal

Make the Link-up modal's role presets land as **standing orders** instead of one-shot relays. Today the modal's own defaults — Mode `instant` + preset `researcher` — instruct the parent agent to forward, to the child, a message telling the child that the child is its own researcher. The instruction's audience is inverted and the parent never receives the standing order it was supposed to get.

### Problem analysis

Observed 2026-08-12. The operator used Link-up to make `researcher-1` the researcher for `planner-5`. What arrived in `planner-5` was:

```
You have been asked to relay something to another Switchboard terminal.

TARGET TERMINAL: researcher-1
YOUR TERMINAL:   planner-5

OPERATOR INSTRUCTION:
---
researcher-1 is your researcher. When you hit a question that needs external sources,
documentation or API details you do not already have, hand it to researcher-1 with enough
context to work standalone — it cannot see your conversation. ...
---

To deliver this to researcher-1, run:
curl ... -d '{"to":"researcher-1","from":"planner-5","message":"<the operator instruction above, verbatim>"}'
...
Carry out the operator instruction now.
```

The wrapper is an unambiguous forward-this-text directive: a named TARGET, a curl whose `message` field is templated `"<the operator instruction above, verbatim>"`, and a closing `Carry out the operator instruction now.` The payload, however, is written in the **second person to the parent** — *"{child} is **your** researcher"*, *"it cannot see **your** conversation"*.

Relayed verbatim as instructed, `researcher-1` receives *"researcher-1 is your researcher"* and *"it cannot see your conversation"* — where "your" now denotes `researcher-1` itself. Both sentences invert. The operator's actual intent (parent uses child for research) is never delivered to anyone.

The operator's read of the incident: *"why are you relaying? I thought I was telling you to use that terminal as the researcher... if not, the link up UI is super confusing."* The confusion is not the agent's — the prompt genuinely says relay, and the text genuinely addresses the parent. The UI produced a self-contradictory instruction.

### Root cause

**Every role preset is standing-order text, and the modal's default mode is the relay path.**

`src/webview/terminals.js:8027-8086` — all six non-custom presets are durable instructions in which the reader is addressed in the second person and the *other* terminal appears as `{child}` in the third. That is only coherent when the reader is the terminal the order is installed on.

The mode, meanwhile, defaults to the relay path in both the DOM and the JS:

- `src/webview/terminals.html:2028-2031` — `instant` is the **first** `<option>`.
- `src/webview/terminals.js:8098` — `let linkMode = 'instant';`
- `src/webview/terminals.js:1421-1422` — the persisted default is also `'instant'`.

And the preset defaults to the first entry, `researcher` (`:8089`, `:1418-1419`).

So a first-time operator who opens Link-up, picks parent and child, and presses SEND without touching the two remaining dropdowns gets **preset `researcher` + mode `instant`**: the exact broken combination. No misuse required.

`sendLinkMessage` (`:8396-8472`) then branches: `standing` → `POST /terminals/standing-orders {action:'add', parent, child, instruction}`, which is where all six role presets belong; `instant` → `ptySendPrompt` to the **parent** carrying `buildLinkPrompt(...)`, the relay wrapper above.

`buildLinkPrompt` (`:8370-8394`) is correct *for a genuine relay* and is not the defect. **The defect is that the modal asks the operator to choose the instruction's content and its delivery semantics as two independent dropdowns, when for six of the seven presets the semantics are already determined by the content.** Nothing validates the pair, so the default pair is the incoherent one.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Current State (verified at HEAD, 2026-08-14)

The teams relationship vocabulary this plan was written against **has landed** (commit `1bd39f4a`) — but it landed in a shape that **invalidates this plan's original derivation rule**, so the rule below is not the one previously written.

| Claim in the original plan | State at HEAD |
| :--- | :--- |
| `linkPresets.ts` is canonical, mirrored in `terminals.js`, guarded by a contract test | ✅ True. |
| Every preset carries `direction` | ✅ True — all **seven**. |
| *"`custom` has no `direction`, and that is the signal"* | ❌ **False.** `custom` is `{ id: 'custom', label: 'Custom…', direction: 'head-receives', template: '' }` (`linkPresets.ts:116`, `terminals.js:8085`). `LinkPresetDirection` is **non-optional** on the interface, so `custom` was given a filler value. |
| `reports-to-head` appears in the Link-up dropdown | ✅ True — `buildPresetOptions` (`:8112-8122`) renders **all seven** entries, `custom` included. |

**Consequence.** The original predicate — *"preset has a `direction` → standing orders"* — is `true` for `custom` and would flip Mode to Standing orders the moment the operator selects *Custom…*, yanking them out of the mode they just chose. That is precisely the failure the original Edge-Case 1 existed to prevent, reintroduced by the field it relied on. **The discriminator is a non-empty `template`, not the presence of `direction`.**

This is not a new invention: it is the test the codebase already uses for "is this a real relationship". `resolvePreset` (`linkPresets.ts:131`) and `resolvePresetMeta` (`:146`) both branch on `!preset.template || preset.id === 'custom'`. Reusing that predicate keeps one definition of "real relationship" rather than adding a second.

## User Review Required

- None. Deriving Mode from the preset's **template emptiness** (rather than warning about a mismatch, adding a parallel `mode` field, or rewriting preset text for both audiences) is settled below.

## Complexity Audit

### Routine

- Reading the selected preset in the existing preset `change` handler (`terminals.js:8520-8525`) and setting the Mode `<select>` from it.
- Deriving the first-run `linkMode` default from the default preset in `loadLayoutSettings` (`:1416-1422`).
- One clarifying line in `buildLinkPrompt`.

### Complex / Risky

- **Do not key the derivation on `direction` — `custom` has one.** This is the single most important correction to this plan. See Current State: `direction` is non-optional, so all seven presets carry it, and a `direction`-keyed rule captures the one preset that must be exempt. Key on `template` instead, matching `resolvePresetMeta`'s own test.

- **Do not add a new field for this.**

  > **Superseded:** Add a `mode: 'standing' | null` field to each `LINK_PRESETS` entry and set the Mode select from it.
  > **Reason:** It is a second encoding of a fact the data already carries, free to disagree with the first. It also lands on one side of a mirror: `linkPresets.ts` is canonical, `terminals.js` is a declared mirror, and `link-presets-mirror-contract.test.js` compares ids, labels, templates and directions across both files. A `mode` field added to the webview literal alone would silently stop being covered; added to both, it would need the test's regex parser extended — real cost for a fact already derivable.
  > **Replaced with:** Derive Mode from template emptiness. Preset has a non-empty `template` → Standing orders. Preset has an empty one (`custom`) → leave the operator's choice alone. No new field, nothing to keep in sync, no contract-test change.

- **Do not "fix" this by rewriting the preset text.** A template that reads correctly to both a parent and a child does not exist — "{child} is your researcher" is either addressed to the parent or it is nonsense. Authoring a second, child-addressed variant per preset creates two strings that can drift. The delivery semantics are wrong, not the words.
- **Do not add a confirm/warning gate.** `CLAUDE.md` forbids confirmation dialogs outright, and `window.confirm()` is a silent no-op in VS Code webviews. A mismatch warning would be either ignored or invisible. The pairing must be structural.
- **Operator override must survive.** Mode is still a real control — an operator may legitimately want a one-shot relay of custom text. Presets *set* the mode; they must not *lock* it.

## Edge-Case & Dependency Audit

1. **`custom` is identified by its empty `template`, not by a missing `direction`.** Its `template` is `''` (`terminals.js:8085`) and it is the only preset for which that is true. It is also the only preset whose delivery semantics are genuinely the operator's choice. Empty template → leave the Mode select untouched, or picking Custom would silently yank the operator out of the mode they just chose. Note that `resolvePreset` in the webview (`:8102-8108`) already returns `''` for it, so selecting Custom empties the message box — the two behaviours are consistent by construction.
2. **`reports-to-head` is in the Link-up dropdown and needs no special case.** `buildPresetOptions` (`:8112-8122`) renders every entry. `reports-to-head` carries `direction: 'member-receives'`, meaning the order is installed on the *member* about the head — but it is still a standing order, so the same rule applies. The rule is "has a real instruction → standing", not "is head-directed → standing". **What this plan does not change:** the modal's `standing` branch always writes `{parent, child}` as chosen in the two selects, so selecting `reports-to-head` in Link-up installs the order on the terminal picked as *parent*. `direction` is honoured by `wireSpawnedTeam` on the spawn path, **not** by the modal. That asymmetry is pre-existing, is out of scope here, and must not be silently "fixed" as part of a mode-derivation change — flag it and leave it.
3. **`presetDirty` (`:8090`).** The modal tracks whether the operator has hand-edited the message so a preset change does not clobber typed text. Setting the mode is part of *applying* a preset, so it happens on the same `change` event `applyPresetToMessage(true)` already uses — not on open.
4. **Re-opening the modal.** `openLinkModal` (`:8291`) restores `presetSel.value` and `modeSel.value` from persisted state. It must **not** re-derive the mode from the preset on open — that would override an operator who deliberately switched mode last session. Derivation belongs on the preset `change` event and on the *first-run* default only.
5. **Migration / shipped state.** A user with `terminals.linkMode = 'instant'` saved keeps `'instant'` on open (edge case 4), so nothing is destroyed. Only the *unset* default changes, and it changes by derivation from the default preset rather than by flipping a literal — keeping the two defaults consistent by construction instead of by coincidence. No `*.migrated.bak`, no import step: a default-resolution change, not a schema change.
6. **`syncSendEnabled` / button label.** `:8201-8213` sets the SEND button text to `SAVE` when `linkMode === 'standing'`. Setting the mode from a preset must call it, or the footer button lies about what pressing it does. Note it reads the module-level `linkMode`, not the select — so assign `linkMode` **before** calling it, not just `modeSel.value`.
7. **`standingOrdersAvailable` (`:8100`).** If the resolved preset implies `standing` but standing orders are unavailable on this host, the mode must stay `instant` rather than selecting an option the host cannot honour. The flag is set from a capability probe (`:8243`) and defaults to `false`, and `syncModeOptions` already disables the `standing` `<option>` when it is false (`:8257`). Check it before applying, exactly as the mode `change` handler does (`:8506-8509`).
8. **`buildLinkPrompt` stays as-is for genuine relays.** With role presets routed to standing orders, everything reaching `instant` is operator-authored custom text, for which "deliver verbatim" is the correct contract. Do not soften it to "adapt as needed" — that invites the agent to rewrite the operator's words.
9. **Audience line for the remaining relay path.** Custom text can still be written in the wrong person. One clarifying line in `buildLinkPrompt` naming the audience removes the residual ambiguity at zero cost. This is the only change to that function.
10. **Do not reorder `LINK_PRESETS`.** `LINK_PRESETS[0].id` is the persisted default preset (`:1418-1419`, `:8089`) and the array order is asserted by `link-presets-mirror-contract.test.js`. This plan adds no entries and must move none.
11. **The character counter is already fixed at the standing limit — leave it alone.** `syncSendEnabled` (`:8208-8212`) renders `${len} / ${MAX_INSTRUCTION_CHARS}` unconditionally: 2000 in **both** modes, with no mode branch. So the mode flip changes nothing here and there is nothing to verify beyond "every preset body is comfortably under 2000", which they are. (The counter arguably over-constrains the relay path, which has no server-side cap — pre-existing, out of scope, do not change it in this plan.) Host-side, `validateInstruction` enforces the 2000 cap on the standing path at `LocalApiServer.ts:2373`, so routing presets there introduces no silent truncation.
12. **Two live terminals precondition.** `syncLinkUpEnabled` gates the button on `liveCount >= 2`. Unaffected.
13. **Race conditions / security.** None. No new endpoint, no new input, no change to what either send path transmits — only which path a preset selects.

## Dependencies

- `sess_none — no external session dependency.`
- **Satisfied: the teams relationship vocabulary** — `linkPresets.ts`, the `terminals.js` mirror and the contract test are present at HEAD (`1bd39f4a`). This plan reads preset data that now exists. It reads `template`, not `direction`, so it is unaffected by `direction`'s exact semantics.
- **Shares `src/webview/terminals.js`** with `feature_plan_20260813060000_...` (researcher return path), but in a **different region**: that plan edits only the `LINK_PRESETS` literal (`:8027-8086`); this plan edits `loadLayoutSettings` (`:1416-1422`), the preset `change` handler (`:8520-8525`) and `buildLinkPrompt` (`:8370-8394`). They serialise under the project's one-stream-per-file rule but do not contend for the same lines.
- **Independent of the `/research/dispatch` retirement** — no shared file, no ordering constraint between them.

## Adversarial Synthesis

The largest risk in this plan was not in its design but in a premise that went stale under it: it keyed the whole mechanism on `direction` being absent for `custom`, and `direction` shipped as a required field with a filler value on `custom`. Implemented as originally written, the fix would flip Mode to Standing orders on the one preset that must be exempt — turning a bug about the default pairing into a bug about the escape hatch. Closed by keying on template emptiness, which is the discriminator `resolvePresetMeta` already uses, so there is still exactly one definition of "real relationship". The remaining risks are the ones originally identified and they stand: encoding "this is a standing order" a second time and letting the encodings drift — closed by deriving rather than adding a field; clobbering a deliberately-saved mode when the modal reopens — closed by deriving only on the preset `change` event and on the first-run default; and selecting `standing` on a host with no standing-orders endpoint — closed by gating on the existing `standingOrdersAvailable` flag. The alternatives remain worse: rewriting preset text for a child audience creates strings that cannot be correct for both readers, and a mismatch warning is forbidden by `CLAUDE.md` and invisible in a webview besides.

## Proposed Changes

### 1. `src/webview/terminals.js` — apply the preset's implied mode on preset change

**Context.** The preset `change` handler at `:8520-8525`, which currently sets `linkPreset`, refills the message via `applyPresetToMessage(true)` and persists the selection.

**Logic.** A preset carrying a real instruction body **is** a standing order — its text is written to the terminal it is installed on, in the second person, to apply durably. Applying such a preset therefore means applying its text and its delivery semantics together. Skip when the preset has no body (`custom` — the operator owns that choice), or when the host cannot offer standing orders.

**Implementation.** Inside the existing handler, after `linkPreset` is set and the message refilled:

```js
                // A preset with a real body IS a standing order: the text is written
                // in the second person TO the terminal it is installed on. Sending
                // such a body down the `instant` relay path tells the parent to
                // forward text written TO the parent, so every pronoun rebinds to the
                // child and the instruction inverts.
                //
                // Keyed on the TEMPLATE, not on `direction`: every preset carries a
                // direction (it is non-optional), `custom` included — so a
                // direction-keyed test would capture the one preset that must be
                // exempt. Empty template is the discriminator resolvePresetMeta()
                // already uses for "not a real relationship"; reuse it rather than
                // adding a second definition.
                const applied = LINK_PRESETS.find(p => p.id === presetSel.value);
                if (applied && applied.template && standingOrdersAvailable) {
                    // Assign linkMode BEFORE syncSendEnabled — it reads the module
                    // variable, not the select, to label the footer button SAVE.
                    linkMode = 'standing';
                    saveSetting('terminals.linkMode', linkMode);
                    const modeSel = document.getElementById('link-mode');
                    if (modeSel) { modeSel.value = linkMode; }
                    syncSendEnabled();
                }
```

**Edge cases.** The operator can still change Mode afterwards — this sets, it does not lock. `openLinkModal` (`:8291`) is **not** touched: it must keep restoring the persisted mode verbatim, or a deliberate override is undone on every reopen. When `standingOrdersAvailable` is false the mode is left at `instant` and the send still works down the relay path; do not surface an error here, because the operator has not done anything wrong — they merely selected a preset on a host that cannot store orders.

### 2. `src/webview/terminals.js` — derive the first-run default from the default preset

**Context.** `loadLayoutSettings`, `:1416-1422`.

**Logic.** The unset default for Mode should follow the default preset rather than an independent literal, so the two cannot disagree again.

**Implementation.**

```js
        const savedPreset = await loadSetting('terminals.linkPreset', LINK_PRESETS[0].id);
        linkPreset = LINK_PRESETS.some(p => p.id === savedPreset) ? savedPreset : LINK_PRESETS[0].id;

        // Default the mode FROM the default preset rather than from an independent
        // literal — an 'instant' literal beside a standing-order default preset is
        // exactly the pairing that shipped the audience-inversion bug. Keyed on the
        // template (see the preset change handler): every preset has a `direction`,
        // so only an empty template distinguishes `custom`. A value the operator
        // actually saved still wins.
        const presetDefault = LINK_PRESETS.find(p => p.id === linkPreset);
        const presetDefaultMode = (presetDefault && presetDefault.template) ? 'standing' : 'instant';
        const savedLinkMode = await loadSetting('terminals.linkMode', presetDefaultMode);
        linkMode = ['instant', 'standing'].includes(savedLinkMode) ? savedLinkMode : presetDefaultMode;
```

**Edge cases.** An operator with a saved `'instant'` keeps it — only the *absent* default moves. `standingOrdersAvailable` is **not** consulted here: it is populated by an async capability probe that has not necessarily resolved when `loadLayoutSettings` runs, and `syncModeOptions` (`:8257-8259`) already forces the select back to `instant` when the option is disabled. Gating the persisted default on a not-yet-known capability would make the default depend on probe timing.

### 3. `src/webview/terminals.js` — name the audience in the relay wrapper

**Context.** `buildLinkPrompt`, `:8370-8394`.

**Logic.** With role presets off this path, everything remaining is operator-authored. One line removes any doubt about who the text is for, without licensing the agent to reword it.

**Implementation.** Insert immediately after the `OPERATOR INSTRUCTION` block's closing `---` (`:8381`):

```js
            `---`,
            ``,
            `This message is addressed to ${childName}, not to you. Deliver it as written — do not act on it yourself.`,
            ``,
            `To deliver this to ${childName}, run:`,
```

**Edge cases.** `"<the operator instruction above, verbatim>"` in the `-d` template (`:8388`) stays exactly as it is; verbatim delivery remains the contract. The closing `Carry out the operator instruction now.` (`:8392`) also stays — with the new line above, "carry out" now unambiguously means "perform the delivery", not "obey the text".

## Verification Plan

Manual, in the Terminals panel. Per session directive, no compilation step and no automated test run is part of this plan.

1. **Reproduce first.** On the pre-fix build, clear the saved settings, open Link-up with two live terminals, choose parent and child, touch neither remaining dropdown, press SEND. Confirm the parent receives the `You have been asked to relay something…` wrapper around `{child} is your researcher` — the incoherent default pairing.
2. **The reported bug is gone.** Same steps post-fix: Mode reads *Standing orders* the moment the preset resolves, the footer button reads **SAVE**, and pressing it stores a standing order against the parent. Nothing is relayed.
3. **The parent actually gets the order.** Send any prompt to the parent and confirm the standing-orders block now carries the researcher instruction, addressed to the parent, in the second person, coherently.
4. **Every preset with a body.** Cycle `researcher`, `reviewer`, `tester`, `handoff`, `second-opinion` and `reports-to-head`; each flips Mode to Standing orders and each stores rather than relays.
5. **Custom leaves the mode alone — this is the regression the corrected predicate exists to prevent.** Set Mode to Instant, select `Custom…`; Mode stays Instant and the message box empties. Set Mode to Standing orders, select `Custom…`; Mode stays Standing orders. A build that keyed on `direction` instead of `template` fails this step by flipping to Standing orders in the first case.
6. **Override survives.** Select `researcher` (Mode → Standing orders), then manually set Mode back to Instant. It stays Instant, the send goes down the relay path, and the new audience line appears in the wrapper.
7. **Override survives a reopen.** With that override saved, close and reopen the modal. Mode is still Instant — `openLinkModal` must not re-derive it.
8. **First-run default.** Clear `terminals.linkMode` and `terminals.linkPreset` and reload. Preset resolves to `researcher` and Mode to Standing orders.
9. **Saved value still wins.** With `terminals.linkMode = 'instant'` saved, reload and confirm Mode opens on Instant.
10. **Standing orders unavailable.** With `standingOrdersAvailable` false, select `researcher` and confirm Mode stays Instant rather than selecting an option the host cannot honour, that no error is surfaced, and that SEND still works down the relay path.
11. **Footer button tracks the mode.** On each automatic flip confirm the footer reads **SAVE**, not **SEND** — this fails if `linkMode` is assigned after `syncSendEnabled` rather than before.
12. **Counter is unchanged.** Confirm `#link-counter` still reads `<len> / 2000` in both modes — this change does not touch it, and a counter that started varying by mode would mean something else was edited.
13. **No confirm gate anywhere.** SEND / SAVE still act immediately, per `CLAUDE.md`.

### Automated Tests

None added, and none run in this pass (session directive). This change deliberately adds no preset field, so `link-presets-mirror-contract.test.js` needs no extension and continues to cover the data this plan reads.

## Recommendation

Complexity 3 → **Send to Intern**, with one caveat that raises the bar above a mechanical edit: the corrected predicate (`template`, not `direction`) is the whole point of the change, and verification step 5 is the one that catches getting it wrong. Land second in this feature — after the researcher return path, which owns the `LINK_PRESETS` literal in the same file.
