# Kanban Pane's Workspace › Project Picker Is Too Narrow To Read

## Goal

In a kanban-mode pane in `terminals.html`, the combined workspace/project dropdown must show its full selection. Today it is capped at 170px and every multi-workspace option — which reads `workspace > project` — is cut off mid-word, so the operator cannot tell which board the pane is showing.

### The problem

`src/webview/terminals.js:5303-5337` builds the picker. In a multi-workspace setup the option labels are:

```js
allOpt.textContent = `${wsLabel} — All projects`;                       // :5317-5319
opt.textContent   = (workspaces.length > 1 ? `${wsLabel} > ` : '') + proj;  // :5325
otherOpt.textContent = `${ws.label} — All projects`;                    // :5334
```

`wsLabel` is the workspace folder name and `proj` is the board's project name. A realistic pair — `switchboard > Browser Switchboard` — is 32 characters. At the panel's 11px font that is roughly 200px of text.

### Root cause

`src/webview/terminals.html:1640`:

```css
.kanban-pane-ws-project-picker { max-width: 170px; }
```

170px is a hard ceiling that predates the combined picker: it was sized for a workspace-only dropdown, and the `workspace > project` composition landed on top of it without re-measuring. There is no fallback either — `combinedPicker.title` is set to the static string `'Workspace and project filter'` (`terminals.js:5310`), not to the selected option's text, so hovering tells the operator nothing about what got truncated.

Two structural facts constrain the fix:

1. The picker is a flex child of `.pane-title` (`terminals.html:1272-1281`), which is `overflow: hidden; text-overflow: ellipsis` and sits in a 22px `.pane-header` alongside `.pane-actions`. Simply raising `max-width` to a large fixed value would push the column picker and the header buttons off-screen in the 2x3 / 3x3 layouts.
2. `.pane-title-name` is documented as "the ONLY shrinkable child of the `.pane-title` flex row" (`terminals.html:1282-1290`) — but in a kanban pane there is no `.pane-title-name` at all. `renderKanbanPane` clears `titleEl` and appends only the `P<n>` chip and the two `<select>`s (`terminals.js:5297-5379`). So in kanban mode the header's shrink budget is entirely unclaimed, and the two pickers can take it.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** Two CSS rules and two lines of JS. No state, no persistence, no message passing, no host code.

The only thing to be careful about is not regressing the dense layouts: `1x3`, `2x3` and `3x3` panes are narrow, and the header already abbreviates its action buttons there (`terminals.html:946-948`). The fix must be width-responsive rather than a bigger fixed number.

## Edge-Case & Dependency Audit

- **Single-workspace installs** already omit the `wsLabel > ` prefix (`terminals.js:5325`) and show the bare project name, and their "all" option is the literal `'All projects'`. They are not broken today and must not get a wider control for nothing — a percentage-based cap handles both cases without branching.
- **Very long project names** exist independently of the workspace prefix. A cap is still required; the `title` fallback is what makes a capped label recoverable.
- **The header rebuild guard.** The picker is only recreated when `combinedSig` changes (`terminals.js:5295-5296`) — the 5s kanban poll re-renders the pane constantly and rebuilding the `<select>` each tick would slam an open dropdown shut. So the `title` must be refreshed in the **always-runs** tail (`terminals.js:5382-5384`), not inside the rebuild branch, or it goes stale the moment the operator changes selection without changing the option set.
- **Dense layouts.** At `3x3` the pane is roughly 1/3 of the panel width. A `max-width: 55%` cap leaves the column picker and the `P<n>` chip room; a fixed 340px would not.
- **No `min-width: 0`, no shrink.** `<select>` elements have an intrinsic minimum content width. Without `min-width: 0` a flex child refuses to shrink below it and overflows the header instead of ellipsising. Both pickers need it.
- **Native `<select>` truncation — the `title` is the guarantee, not the CSS.** A capped `<select>` clips its selected-option text rather than ellipsising it. `text-overflow: ellipsis` on a `<select>` button face is inconsistently honoured across engines and is treated here as **cosmetic and non-load-bearing**: if it applies, the clip reads a little better; if it does not, nothing about the fix changes. The `title` attribute is what makes a capped label recoverable, and it is the only part of this plan the acceptance criteria depend on. Do not spend implementation time chasing engine-specific `<select>` ellipsis behaviour.
- **Two rendering hosts.** `terminals.html` is served both as a VS Code webview and over HTTP at `/terminals` by `LocalApiServer` (`src/services/LocalApiServer.ts:3946`, resolved via `src/services/headlessPanelHtml.ts:388-389`), so the browser cockpit renders the same markup in whatever engine the operator's browser uses. Both CSS features used here (`min()`, percentage `max-width`) are universally supported, and the file already relies on `color-mix()` (`terminals.html:1356`), so the baseline is unchanged. This is why the `title` fallback — engine-independent — carries the recoverability guarantee.
- **Not a Setup/board control.** `.kanban-pane-ws-project-picker` appears only in `terminals.html`; grep confirms no other file styles or queries it. No cross-panel impact.
- **Shared function with a sibling subtask.** The always-runs tail edited here (`terminals.js:5382-5384`) lives in `renderKanbanPane`, the same function the *per-group kanban state* subtask hooks with `captureKanbanPanesFor` calls inside the two picker `change` handlers (`:5340-5352`, `:5370-5378`). Different lines, no shared statement — but expect both subtasks in the same function and do not treat the other's edit as a merge conflict to resolve away.

## Proposed Changes

### 1. `src/webview/terminals.html` — width the picker against the pane, not a magic number

Replace the shared rule at `:1628-1640`:

```css
        .kanban-pane-column-picker,
        .kanban-pane-ws-project-picker {
            background: var(--panel-bg);
            color: var(--text-primary);
            border: 1px solid var(--border-bright);
            border-radius: 3px;
            font-size: 11px;
            font-family: inherit;
            padding: 1px 4px;
            max-width: 120px;
            cursor: pointer;
            /* A <select> has an intrinsic min content width; without this it
               refuses to shrink and overflows the 22px .pane-header instead of
               truncating. Both pickers are flex children of .pane-title. */
            min-width: 0;
            /* Cosmetic only. A <select> button face clips rather than ellipsises in
               most engines; this is a free improvement where it is honoured and a
               no-op where it is not. The `title` set in terminals.js is what
               actually makes a capped label recoverable — do not chase this. */
            text-overflow: ellipsis;
        }
        /* The combined picker's options read "<workspace> > <project>" in a
           multi-workspace install (terminals.js renderKanbanPane), which is
           routinely 30+ characters. The old flat 170px cap was sized for a
           workspace-only dropdown and cut every such label mid-word.
           Percentage-of-pane, not a bigger fixed number: at 3x3 the pane is a
           third of the panel and a fixed 340px would push the column picker and
           the header buttons off-screen. flex-shrink lets it give way to the
           column picker first when the pane is genuinely tiny. */
        .kanban-pane-ws-project-picker {
            max-width: min(340px, 55%);
            flex: 0 1 auto;
        }
```

`.pane-title` itself needs no change: in kanban mode it holds only the chip and the two selects, so the 55% + 120px pair fits with the `P<n>` chip in every layout down to `3x3`.

### 2. `src/webview/terminals.js` — make the truncated label recoverable on hover

Replace the static tooltip at `:5310`:

```js
                combinedPicker.className = 'kanban-pane-ws-project-picker';
                // Title is set from the SELECTED option in the always-runs tail
                // below, not here: this branch only executes when combinedSig
                // changes (the option set), while the selection changes far more
                // often. Setting it here alone would leave a stale tooltip.
                combinedPicker.dataset.sig = combinedSig;
```

and set the real value in the tail that already syncs `.value` (`:5382-5384`):

```js
        if (combinedPicker) {
            const want = `${chosenWs || ''}|${chosenProj}`;
            if (combinedPicker.value !== want) { combinedPicker.value = want; }
            // The label is capped by CSS and a <select> clips rather than
            // ellipsises, so the full "workspace > project" text has to be
            // reachable somewhere. selectedOptions is empty for one render if
            // `want` matches no option (a project deleted underneath the pane) —
            // fall back to the generic label rather than emitting "undefined".
            const selectedLabel = combinedPicker.selectedOptions[0]?.textContent;
            combinedPicker.title = selectedLabel
                ? `Workspace and project filter — ${selectedLabel}`
                : 'Workspace and project filter';
        }
```

## Verification Plan

1. `node --test src/test/` — full suite green (five tests are red at HEAD independently; stash-verify before attributing).
2. **Multi-workspace, wide pane.** Open `terminals.html` with ≥2 workspace roots registered and a project named `Browser Switchboard` on the primary. Put a pane in kanban mode, layout `2h`. Assert the picker reads `switchboard > Browser Switchboard` in full, with no clipping.
3. **Dense layouts.** Switch to `2x3`, then `3x3`. Assert: the picker narrows rather than overflowing; the column picker beside it is still fully visible; the `P<n>` chip is not pushed out; the `.pane-header` does not grow past 22px and does not scroll horizontally.
4. **Tooltip.** Hover the picker in `3x3` where the label *is* clipped. Assert the tooltip reads `Workspace and project filter — switchboard > Browser Switchboard`. Change the selection to another project and hover again without touching anything else — assert the tooltip updated (this is the stale-title regression the tail placement exists to prevent).
5. **Single workspace.** With one root, assert the options still read `All projects` / bare project names and the control has not visibly grown.
6. **Open-dropdown stability.** Open the picker and leave it open for ≥10s (two kanban poll ticks). Assert it does not close and keyboard focus is retained — proof the rebuild guard was not disturbed.
7. **Theme.** Confirm in both light and dark that the picker's border and text tokens are unchanged.
8. **Browser cockpit.** Repeat steps 2–4 with the panel opened over HTTP at `/terminals`, not only in the VS Code webview. The `title` fallback must behave identically; a difference in whether the `<select>` face ellipsises is expected and is not a defect.
9. **Deleted project.** With a kanban pane pinned to a project, delete that project on the board and let the pane repoll. Assert the tooltip degrades to the bare `Workspace and project filter` rather than rendering `undefined` — the `selectedOptions[0]` empty case the tail guards.
