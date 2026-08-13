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

`src/webview/terminals.js:7922-7967` — all five non-custom presets are durable, second-person-to-**parent** instructions (`{child}` in the third person, the reader addressed in the second). That is only coherent when the reader is the parent.

The mode, meanwhile, defaults to the relay path in both the DOM and the JS:

- `src/webview/terminals.html:1926-1929` — `instant` is the **first** `<option>`.
- `src/webview/terminals.js:7979` — `let linkMode = 'instant';`
- `src/webview/terminals.js:1390-1391` — the persisted default is also `'instant'`.

And the preset defaults to the first entry, `researcher` (`:7970`, `:1387-1388`).

So a first-time operator who opens Link-up, picks parent and child, and presses SEND without touching the two remaining dropdowns gets **preset `researcher` + mode `instant`**: the exact broken combination. No misuse required.

`sendLinkMessage` (`:8295-8341`) then branches: `standing` → `POST /terminals/standing-orders {action:'add', parent, child, instruction}`, which is where all five role presets belong; `instant` → `ptySendPrompt` to the **parent** carrying `buildLinkPrompt(...)`, the relay wrapper above.

`buildLinkPrompt` (`:8253-8276`) is correct *for a genuine relay* and is not the defect. **The defect is that the modal asks the operator to choose the instruction's content and its delivery semantics as two independent dropdowns, when for five of the six presets the semantics are already determined by the content.** Nothing validates the pair, so the default pair is the incoherent one.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

- None. Deriving Mode from the preset's existing `direction` (rather than warning about a mismatch, adding a parallel field, or rewriting preset text for both audiences) is settled below.

## Complexity Audit

### Routine

- Reading the selected preset's `direction` in the existing preset `change` handler (`terminals.js:8401-8406`) and setting the Mode `<select>` from it.
- Deriving the first-run `linkMode` default from the default preset in `loadLayoutSettings` (`:1385-1391`).
- One clarifying line in `buildLinkPrompt`.

### Complex / Risky

- **Do not add a new field for this — `direction` already is it.**

  > **Superseded:** Add a `mode: 'standing' | null` field to each `LINK_PRESETS` entry and set the Mode select from it.
  > **Reason:** It duplicates a field the teams feature is already adding for the same underlying fact. Teams subtask 4 (`feature_plan_20260812190005_team-member-scope-and-relationship.md:139`) puts `direction` on every preset precisely because *"`reports-to-head` is installed on the member about the head, while `researcher`, `reviewer`, `tester`, `handoff` and `second-opinion` are all installed on the head about the member. Store the direction on the preset rather than inferring it — inferring it is how the orientation gets flipped, and a flipped order is silent."* A preset that carries a `direction` **is** a standing order — that is what direction means. A parallel `mode` field would be a second encoding of one fact, free to disagree with the first. Worse, subtask 4 makes `src/services/linkPresets.ts` canonical with a `terminals.js` mirror and a contract test asserting *"ids, labels, templates and directions identical"* (`:120-122`, `:191`); a `mode` field added to the webview literal alone would either fail that test or silently stop being covered by it.
  > **Replaced with:** Derive Mode from `direction`. Preset has a `direction` → Standing orders. Preset has none (`custom`) → leave the operator's choice alone. No new field, nothing to keep in sync, and the fix inherits subtask 4's mirror test for free.

- **Do not "fix" this by rewriting the preset text.** A template that reads correctly to both a parent and a child does not exist — "{child} is your researcher" is either addressed to the parent or it is nonsense. Authoring a second, child-addressed variant per preset creates two strings that can drift. The delivery semantics are wrong, not the words.
- **Do not add a confirm/warning gate.** `CLAUDE.md` forbids confirmation dialogs outright, and `window.confirm()` is a silent no-op in VS Code webviews. A mismatch warning would be either ignored or invisible. The pairing must be structural.
- **Operator override must survive.** Mode is still a real control — an operator may legitimately want a one-shot relay of custom text. Presets *set* the mode; they must not *lock* it.

## Edge-Case & Dependency Audit

1. **`custom` has no `direction`, and that is the signal.** Its template is `''` and it is the only preset whose delivery semantics are genuinely the operator's choice. Absent `direction` → leave the Mode select untouched, or picking Custom would silently yank the operator out of the mode they just chose.
2. **`reports-to-head` in the Link-up dropdown.** Subtask 4 adds it with `direction: 'member-receives'`. It is a standing order like the others, so the same derivation applies — Mode goes to Standing orders, and the order is installed on the child about the parent. No special case needed; the rule is "has a direction → standing", not "is head-directed → standing".
3. **`presetDirty` (`:7971`).** The modal tracks whether the operator has hand-edited the message so a preset change does not clobber typed text. Setting the mode is part of *applying* a preset, so it happens on the same `change` event the message-fill already uses — not on open.
4. **Re-opening the modal.** `openLinkModal` (`:8181-8201`) restores `presetSel.value = linkPreset` and `modeSel.value = linkMode` from persisted state. It must **not** re-derive the mode from the preset on open — that would override an operator who deliberately switched mode last session. Derivation belongs on the preset `change` event and on the *first-run* default only.
5. **Migration / shipped state.** A user with `terminals.linkMode = 'instant'` saved keeps `'instant'` on open (edge case 4), so nothing is destroyed. Only the *unset* default changes, and it changes by derivation from the default preset rather than by flipping a literal — keeping the two defaults consistent by construction instead of by coincidence. No `*.migrated.bak`, no import step: a default-resolution change, not a schema change.
6. **`syncSendEnabled` / button label.** `:8088` sets the SEND button text to `SAVE` in standing mode. Setting the mode from a preset must go through the same sync path or the footer button lies about what pressing it does.
7. **`standingOrdersAvailable` (`:7981`).** If the resolved preset implies `standing` but standing orders are unavailable on this host, the mode must stay `instant` rather than selecting an option the host cannot honour. Check the existing flag before applying.
8. **`buildLinkPrompt` stays as-is for genuine relays.** With role presets routed to standing orders, everything reaching `instant` is operator-authored custom text, for which "deliver verbatim" is the correct contract. Do not soften it to "adapt as needed" — that invites the agent to rewrite the operator's words.
9. **Audience line for the remaining relay path.** Custom text can still be written in the wrong person. One clarifying line in `buildLinkPrompt` naming the audience removes the residual ambiguity at zero cost. This is the only change to that function.
10. **Do not reorder `LINK_PRESETS`.** `LINK_PRESETS[0].id` is the persisted default preset (`:1387-1388`, `:7970`); subtask 4 carries the same warning (`:148`). This plan adds no entries and must move none.
11. **`MAX_INSTRUCTION_CHARS` (2000) vs `MAX_BLOCK_CHARS` (4000).** Standing orders are length-capped where relays are not, and truncation is silent (`standingOrders.ts:70-72`). Every role preset is well under 2000, so routing them to the standing path introduces no truncation risk — but confirm `#link-counter` updates to the standing limit when the mode changes.
12. **Two live terminals precondition.** `syncLinkUpEnabled` (`:8208-8216`) gates the button on `liveCount >= 2`. Unaffected.
13. **Race conditions / security.** None. No new endpoint, no new input, no change to what either send path transmits — only which path a preset selects.

## Dependencies

- `sess_none — no external session dependency.`
- **Hard: teams subtask 4** — `feature_plan_20260812190005_team-member-scope-and-relationship.md`. It introduces `direction`, `src/services/linkPresets.ts` as the canonical list, the `terminals.js` mirror and the contract test. This plan reads `direction` and therefore cannot land before it. Landing first would mean inventing the field, which is exactly what the Superseded callout rejects.
- **Shares `terminals.js`** with teams subtasks 2, 4 and the agent-CLI label-cache plan. Different regions; they serialise under the project's one-stream-per-file rule.
- Independent of the `/research/dispatch` retirement chain — no shared file, no ordering constraint between them.

## Adversarial Synthesis

Key risks: encoding "this is a standing order" a second time and letting the two encodings drift — closed by deriving from `direction` rather than adding a field; clobbering a deliberately-saved mode when the modal reopens — closed by deriving only on the preset `change` event and on the first-run default; and selecting `standing` on a host with no standing-orders endpoint — closed by gating on the existing `standingOrdersAvailable` flag. The alternatives are both worse: rewriting preset text for a child audience creates strings that cannot be correct for both readers, and a mismatch warning is forbidden by `CLAUDE.md` and invisible in a webview besides.

## Proposed Changes

### 1. `src/webview/terminals.js` — apply the preset's implied mode on preset change

**Context.** The preset `change` handler at `:8399-8406`, which currently sets `linkPreset`, persists it, refills the message and focuses the box for `custom`. After teams subtask 4, each preset carries `direction`.

**Logic.** A preset that declares a `direction` is a standing order by definition — direction says *which terminal receives the order*, which presupposes there is one. Applying a preset therefore means applying its text and its delivery semantics together. Skip when the preset declares no direction, or when the host cannot offer standing orders.

**Implementation.** Inside the existing handler, after `linkPreset` is set and the message refilled:

```js
            // A preset carrying `direction` IS a standing order — direction names
            // which terminal receives it, which presupposes one exists. Sending such
            // a body down the `instant` relay path tells the parent to forward text
            // written TO the parent, so every pronoun rebinds to the child and the
            // instruction inverts. Derived, never a second field: `direction` is the
            // single encoding (linkPresets.ts is the source of truth; this literal is
            // its mirror). `custom` has no direction — the operator owns that choice.
            const applied = LINK_PRESETS.find(p => p.id === presetSel.value);
            if (applied && applied.direction && standingOrdersAvailable) {
                linkMode = 'standing';
                saveSetting('terminals.linkMode', linkMode);
                const modeSel = document.getElementById('link-mode');
                if (modeSel) { modeSel.value = linkMode; }
                syncSendEnabled();   // footer button must read SAVE, not SEND
            }
```

**Edge cases.** The operator can still change Mode afterwards — this sets, it does not lock. `openLinkModal` (`:8181-8201`) is **not** touched: it must keep restoring the persisted mode verbatim, or a deliberate override is undone on every reopen.

### 2. `src/webview/terminals.js` — derive the first-run default from the default preset

**Context.** `loadLayoutSettings`, `:1385-1391`.

**Logic.** The unset default for Mode should follow the default preset rather than an independent literal, so the two cannot disagree again.

**Implementation.**

```js
        const savedPreset = await loadSetting('terminals.linkPreset', LINK_PRESETS[0].id);
        linkPreset = LINK_PRESETS.some(p => p.id === savedPreset) ? savedPreset : LINK_PRESETS[0].id;
        // Default the mode FROM the default preset rather than from an independent
        // literal — an 'instant' literal beside a standing-order default preset is
        // exactly the pairing that shipped the audience-inversion bug. A value the
        // operator actually saved still wins.
        const presetDefault = LINK_PRESETS.find(p => p.id === linkPreset);
        const presetDefaultMode = (presetDefault && presetDefault.direction) ? 'standing' : 'instant';
        const savedLinkMode = await loadSetting('terminals.linkMode', presetDefaultMode);
        linkMode = ['instant', 'standing'].includes(savedLinkMode) ? savedLinkMode : presetDefaultMode;
```

**Edge cases.** An operator with a saved `'instant'` keeps it — only the *absent* default moves.

### 3. `src/webview/terminals.js` — name the audience in the relay wrapper

**Context.** `buildLinkPrompt`, `:8253-8276`.

**Logic.** With role presets off this path, everything remaining is operator-authored. One line removes any doubt about who the text is for, without licensing the agent to reword it.

**Implementation.** Insert immediately after the `OPERATOR INSTRUCTION` block's closing `---`:

```js
            `---`,
            ``,
            `This message is addressed to ${childName}, not to you. Deliver it as written — do not act on it yourself.`,
            ``,
            `To deliver this to ${childName}, run:`,
```

**Edge cases.** `"<the operator instruction above, verbatim>"` in the `-d` template stays exactly as it is; verbatim delivery remains the contract.

## Verification Plan

Manual, in the Terminals panel. Per session directive, no compilation step and no automated test run is part of this plan.

1. **Reproduce first.** On the pre-fix build, clear the saved settings, open Link-up with two live terminals, choose parent and child, touch neither remaining dropdown, press SEND. Confirm the parent receives the `You have been asked to relay something…` wrapper around `{child} is your researcher` — the incoherent default pairing.
2. **The reported bug is gone.** Same steps post-fix: Mode reads *Standing orders* the moment the preset resolves, the footer button reads **SAVE**, and pressing it stores a standing order against the parent. Nothing is relayed.
3. **The parent actually gets the order.** Send any prompt to the parent and confirm the standing-orders block now carries the researcher instruction, addressed to the parent, in the second person, coherently.
4. **Every directional preset.** Cycle `researcher`, `reviewer`, `tester`, `handoff`, `second-opinion` and `reports-to-head`; each flips Mode to Standing orders and each stores rather than relays.
5. **Custom leaves the mode alone.** Set Mode to Instant, select `Custom…`; Mode stays Instant. Set Mode to Standing orders, select `Custom…`; Mode stays Standing orders.
6. **Override survives.** Select `researcher` (Mode → Standing orders), then manually set Mode back to Instant. It stays Instant, the send goes down the relay path, and the new audience line appears in the wrapper.
7. **Override survives a reopen.** With that override saved, close and reopen the modal. Mode is still Instant — `openLinkModal` must not re-derive it.
8. **First-run default.** Clear `terminals.linkMode` and `terminals.linkPreset` and reload. Preset resolves to `researcher` and Mode to Standing orders.
9. **Saved value still wins.** With `terminals.linkMode = 'instant'` saved, reload and confirm Mode opens on Instant.
10. **Standing orders unavailable.** With `standingOrdersAvailable` false, select `researcher` and confirm Mode stays Instant rather than selecting an option the host cannot honour, and that SEND still works down the relay path.
11. **Character counter.** On the mode flip, confirm `#link-counter` reflects the standing-order limit (2000) rather than the relay limit, and that no preset is near it.
12. **No confirm gate anywhere.** SEND / SAVE still act immediately, per `CLAUDE.md`.

### Automated Tests

None added, and none run in this pass (session directive). This change deliberately adds no field, so it inherits teams subtask 4's `linkPresets.ts` ↔ `terminals.js` mirror contract test without extending it.

## Recommendation

Complexity 3 → **Send to Intern.** Land after teams subtask 4.
