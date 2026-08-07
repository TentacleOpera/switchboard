# Delete the Vestigial Default Prompt Overrides UI Left Behind in the Setup Panel

## Metadata

**Complexity:** 3
**Tags:** frontend, bugfix, cleanup, setup, regression

## Goal

Remove the dead Default Prompt Overrides UI from the Setup panel — the feature now lives
in the kanban Prompts tab — so the panel stops throwing an uncaught `TypeError` on every
load, and add a contract test that fails on any element id the JavaScript reads but the
markup does not define.

## Goal — Problem Analysis

The Setup panel throws this on every load, in both hosts:

```
setup:2055 Uncaught TypeError: Cannot set properties of null (setting 'textContent')
    at updatePromptOverrideSummary (setup:2055:47)
    at setup:3411:21
    at s (transport.js:1:405)
    at o.onmessage (transport.js:1:2158)
```

### Root Cause

Commit **`be89aa2a` ("new planning features", 2026-04-26)** moved prompt customisation to
the **kanban Prompts tab** (`#prompts-tab-content` / `.prompts-tab`, `kanban.html:3033`)
and deleted Setup's entry point — the `Default Prompt Overrides` subsection, including
both of its elements:

```html
-  <div id="default-prompt-override-summary" …></div>
-  <button id="btn-customize-default-prompts" class="secondary-btn w-full">CUSTOMIZE DEFAULT PROMPTS</button>
```

**Everything else stayed.** Setup still carries the whole feature's implementation — its
modal markup, ~180 lines of JavaScript, its message arms, and three backend handlers —
all of it unreachable, because the only thing that opened it was the deleted button.

The two deleted ids fail differently, and that asymmetry is why only one was ever noticed:

| Site | Code | Behaviour |
| :--- | :--- | :--- |
| `setup.html:1269` | `const promptOverrideSummary = document.getElementById('default-prompt-override-summary');` | No optional chaining → permanently `null` |
| `setup.html:2434` | `document.getElementById('btn-customize-default-prompts')?.addEventListener('click', openCustomPromptsModal);` | `?.` → silently no-ops |

Optional chaining swallowed the button's removal; the bare read surfaced the summary's as a
crash. The crash path is `updatePromptOverrideSummary` (line 2052) dereferencing that null,
called from the `defaultPromptOverrides` message arm (line 3410) — a message
`SetupPanelProvider.ts:922` pushes on hydration, so it fires on every single load.

**This is dead code, not a lost feature.** The correct repair is deletion. Restoring the
markup would resurrect a duplicate of a feature that deliberately moved, giving the same
setting two editors backed by the same `switchboard.agents.promptOverrides` config key.

### Background Context

The relocation target is real and complete: `kanban.html` owns the Prompts tab, and the
backend still serves the feature there — `getDefaultPromptOverrides`,
`saveDefaultPromptOverrides` and `getDefaultPromptPreviews` all appear in `KANBAN_VERBS`
and `TASKVIEWER_VERBS`, handled by `TaskViewerProvider.ts:12628-12635`. Only Setup's copy
is surplus.

The same class of leftover has already been cleaned once, in the file that now owns the
feature — `kanban.html:4115`:

> The old `promptsTabCollectConfig()` was removed — it referenced non-existent element IDs

So this is the second occurrence of the same failure during the same relocation, and the
first one was found and fixed by hand. That is the argument for the contract test below
rather than a third hand-fix later.

**A sweep of the whole panel finds 20 orphaned ids out of 112 `getElementById` reads
(18%)**, of which these two are only the pair that got noticed. At least one more is an
unguarded deref of identical shape, so it is a second live crash rather than a silent
no-op:

```javascript
// setup.html:3802
document.getElementById('notion-backup-status').textContent = 'Configured';
```

The remaining 17 fail silently behind `?.` or a later null check. Each is either a feature
whose UI moved (delete the code, as here) or one whose markup was dropped in error
(restore the element) — a triage this plan does not attempt, but does make countable.

## Proposed Changes

### File 1: `src/webview/setup.html` — delete the vestigial feature

Remove, in full:

| What | Lines |
| :--- | :--- |
| `#custom-prompts-modal` markup block | 1218–1251 |
| Element refs `customPromptsModal`, `promptOverrideMode`, `promptOverrideText`, `promptOverrideSummary`, `promptPreviewText` | 1265, 1267–1270 |
| State `lastPromptOverrides`, `lastPromptPreviews`, `editingPromptRole` | 1291–1293 |
| `PROMPT_ROLES` | 1426 |
| `renderPromptRoleTabs`, `saveCurrentRoleDraft`, `loadCurrentRoleIntoForm`, `updatePromptOverrideSummary`, `loadPreviewForCurrentRole`, `openCustomPromptsModal`, `closeCustomPromptsModal` | 2016–2074 |
| Listeners: customize / clear / save | 2434, 2473–2477, 2478–2483 |
| Modal backdrop-click dismissal | 2581–2583 |
| Message arms `defaultPromptOverrides`, `defaultPromptPreviews` | 3409–3415 |

**Explicitly KEEP — Export/Import Prompt Settings.** This is a *different*, live Setup
feature with real markup (`btn-export-prompts` / `btn-import-prompts` /
`prompt-settings-status`, lines 770–773), working listeners (2353–2369) and its own result
arm (`exportPromptSettingsResult`, 3416). The names are close enough that a careless sweep
takes it out; it stays.

**The Escape handler is a repoint, not a delete.** Lines 2584–2588 are the panel's *only*
`Escape` handler and it closes the prompts modal exclusively:

```javascript
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeCustomPromptsModal();
            }
        });
```

`#control-plane-modal` (line 1104) is the remaining modal, and it has a CANCEL button and
backdrop dismissal (2436–2439) but **no Escape handling**. Deleting this listener outright
would leave the panel with no Escape-to-close at all. Repoint it instead:

```javascript
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { closeControlPlaneModal(); }
        });
```

### File 2: `src/services/SetupPanelProvider.ts` — drop the now-unreachable handlers

Delete `getDefaultPromptOverrides` (line 920), `saveDefaultPromptOverrides` (929) and
`getDefaultPromptPreviews` (956). Nothing sends them once File 1 lands, and the
`getDefaultPromptOverrides` arm is what pushes the message that triggers the crash.

**Do not touch the equivalents in `TaskViewerProvider.ts`** (12628–12635) — that is the
live path serving the kanban Prompts tab.

### File 3: `protocol-catalog.json` — retire the Setup verbs, then regenerate

Remove `getDefaultPromptOverrides`, `saveDefaultPromptOverrides` and
`getDefaultPromptPreviews` from the **Setup** provider's `verbs[]` only, leaving the Kanban
and TaskViewer providers untouched. Then:

```
npm run catalog:generate
```

`src/generated/verbAllowlist.ts` carries `// AUTO-GENERATED — do not edit` and
`scripts/check-protocol-parity.js` fails CI on drift, so hand-editing the `.ts` is a
guaranteed red build.

### File 4: `src/webview/setup.html` — guard the second live crash

```javascript
                        const badge = document.getElementById('notion-backup-status');
                        if (badge) { badge.textContent = 'Configured'; }
```

Same shape as the reported crash, still live, one line. Guarded rather than deleted:
unlike the prompts UI, there is no evidence the Notion backup status moved anywhere, so
this is the "markup dropped in error" case awaiting triage — and a silent no-op beats an
uncaught throw while it waits.

### File 5: `src/test/setup-panel-element-ids.test.js` — the durable guard

Parse `setup.html`, collect every id passed to `getElementById`, collect every `id="…"` the
markup defines, fail on any read with no definition — with an explicit allowlist for the
orphans this plan is not triaging:

```javascript
// Each entry is a KNOWN-DEAD element lookup awaiting triage: its markup is gone and its
// JavaScript was left behind. Every one is either a feature whose UI moved (delete the
// code — see the Default Prompt Overrides removal this test shipped with) or markup
// dropped in error (restore the element). Shrink this list; never grow it. A NEW orphan
// is a regression, and the allowlist exists so that adding to it is a deliberate,
// reviewed act rather than an accident nobody sees for three months.
const KNOWN_ORPHANED_IDS = new Set([ /* the 18 remaining */ ]);
```

The allowlist is what makes this landable now. Without it the test fails on 20 pre-existing
orphans and cannot merge; with it, the debt is counted in one place and the next orphan
fails on the commit that creates it.

## Edge Cases

**Dynamically created ids.** Ids injected via `innerHTML` templates rather than static
markup would look orphaned to a naive scan, so the test matches `id="…"` anywhere in the
file, template literals included. That is how the 20 were counted, and spot-checking
confirmed the sampled ids appear only inside `getElementById` calls and nowhere as markup.

**Both hosts.** `setup.html` serves the VS Code webview and the browser cockpit alike, and
the ids are missing from the file itself, so the crash is host-independent. The operator
saw it in the browser only because that is where the console was open.

**Settings already written through the dead UI.** None can exist — the modal has had no
opener since April, so no override was ever saved from Setup. Any stored value under
`switchboard.agents.promptOverrides` came from the kanban Prompts tab and is untouched by
this change: deleting a second editor does not delete the setting.

**The `defaultPromptOverrides` push after File 2.** `SetupPanelProvider` stops posting it,
so the arm being deleted in File 1 has nothing left to receive — the two changes are
order-independent, but landing File 1 alone still fixes the crash, and landing File 2 alone
also fixes it. Both are needed for the cleanup to be complete.

## Dependencies

None. No migration: this is UI-only dead code, and the underlying setting is owned and
served by the kanban Prompts tab throughout.

## Adversarial Synthesis

**"Restore the markup — the modal is intact, so the removal was collateral."** That was the
first read of this bug and it was wrong. An intact modal is equally consistent with a
relocation that removed the entry point and did not finish the cleanup, which is what the
kanban Prompts tab confirms. Restoring would ship two editors for one config key and
reintroduce a surface the product deliberately consolidated. The leftover implementation is
evidence of an unfinished deletion, not of intent to keep.

**"Deleting ~180 lines to fix a one-line crash is disproportionate."** The one-line guard
leaves a dead modal, dead state, dead message arms, three dead backend handlers and three
stale verbs in the Setup surface — and a `?.` that hides the fact that none of it is
reachable. That is precisely the state that produced this bug, and the same relocation has
already produced it once before (`kanban.html:4115`). Cleaning it is the smaller long-term
cost.

**"The Escape repoint is scope creep."** It is the opposite: deleting the listener without
repointing silently removes the panel's only Escape-to-close, turning a cleanup into a
behaviour regression. One line to keep the affordance where a modal still exists.

**Risk: some of the deleted JavaScript is shared with a surviving feature.** Checked —
every symbol in the deletion table appears only within the line ranges listed, and the
neighbouring Export/Import Prompt Settings feature uses none of them. The contract test
plus a `node --check` on the edited file will catch any missed reference immediately.

## Verification Plan

### Automated Tests

`src/test/setup-panel-element-ids.test.js` (new):

1. **No un-allowlisted orphans.** Every id read via `getElementById` is either defined as
   markup in the same file or listed in `KNOWN_ORPHANED_IDS`.
2. **The allowlist is honest.** Every entry is still actually orphaned, so a restored or
   deleted id must be removed from the list rather than lingering as a permanent exemption.
3. **The prompts-override symbols are gone.** Assert `setup.html` contains no
   `updatePromptOverrideSummary`, `openCustomPromptsModal`, `custom-prompts-modal`,
   `PROMPT_ROLES` or `default-prompt-override-summary` — the deletion cannot half-land.
4. **Export/Import Prompt Settings survives.** Assert `btn-export-prompts`,
   `btn-import-prompts` and `prompt-settings-status` still resolve to markup. This is the
   boundary most likely to be crossed by accident.
5. **Escape still closes a modal.** Assert the keydown handler references
   `closeControlPlaneModal`.

`scripts/check-protocol-parity.js` must pass — it fails on any drift between
`protocol-catalog.json` and the generated allowlist, which is what proves File 3 was
regenerated rather than hand-edited. Existing `setup-panel-migration.test.js`,
`setup-panel-refresh-regression.test.js` and `setup-panel-ws-hydration-contract.test.js`
must stay green.

### Manual Verification

1. Open the browser cockpit with DevTools on. **Verify:** no `Cannot set properties of
   null` at `updatePromptOverrideSummary` on load — the console dump that opened this
   report is clean.
2. Open the Setup panel and read it top to bottom. **Verify:** no "Default Prompt
   Overrides" section, and no gap or stray heading where it used to be.
3. **Verify:** "Export Settings to File" and "Import Settings from File" are still present
   and still work, with the status line rendering under them.
4. Click **OPEN CONTROL PLANE SETUP**, then press **Escape**. **Verify:** the modal closes.
   Confirm CANCEL and backdrop-click still close it too.
5. Open the kanban Prompts tab. **Verify:** prompt overrides are editable there and any
   previously saved override is intact — the setting is untouched by this removal.
6. Save an override in the Prompts tab, reopen Setup. **Verify:** clean load, no console
   error, no orphaned summary text anywhere.
7. Configure a Notion backup. **Verify:** no `Cannot set properties of null` from the
   `notion-backup-status` path at line 3802.
8. Repeat steps 1-4 in the VS Code webview host. **Verify:** identical behaviour.
