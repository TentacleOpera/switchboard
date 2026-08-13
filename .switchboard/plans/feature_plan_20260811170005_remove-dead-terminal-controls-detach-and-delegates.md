# Remove The `delegates` Button — A Permanently Disabled Control In Every Pane Header

## Goal

Delete the `delegates` button from the pane header. It was added unasked, it presents as a working control, and for any fleet without delegate children it is a greyed-out button occupying header space in every pane of every layout — up to nine at a time.

### The problem

Reported from UAT: *"there is a useless 'delegates button'."*

`createPaneElement` adds it to every pane header (`src/webview/terminals.js:3709-3746`), and `updatePaneElement` disables it whenever the assigned agent has no delegate children (`:3950-3960`):

```js
const kidCount = (head && head.agentInstanceId)
    ? fleetList.filter(t => t.parentInstanceId === head.agentInstanceId).length : 0;
delegateBtn.style.display = '';
delegateBtn.disabled = kidCount === 0;
delegateBtn.title = kidCount === 0
    ? 'No delegate children — define them in the Agents tab' : ...;
```

The comment above it states the intent — *"Disabled (never hidden, never a dead click) when the assigned agent has no delegate children"* — which is a reasonable rule in isolation. In practice delegate children are not part of this operator's workflow, so `kidCount` is always `0`, and the control is permanent visual noise.

### Root cause

The control exposes a subsystem most fleets never populate, and chose "always visible, sometimes disabled" over "visible when it applies". That converts an unused feature into a permanent cost paid by every pane in every layout. "Never a dead click" is the right rule for a control that *sometimes* applies; it is the wrong rule for one that, for a given operator, never does.

Deleting the entry point is the decision. The overlay machinery behind it stays.

### Scope note: `detach` moved

The original version of this plan also deleted the `detach` button from `renderGroupSidebar()` (`:2443-2462`), reported as *"I have no idea what the 'detach' button does. I never asked for it, I pressed it — it did nothing but created a duplicate entry in the sidebar."*

That removal now belongs to **Groups Become A Tab Strip Above The Grid**, which deletes `renderGroupSidebar()` in its entirety — `detach` included. Two plans deleting the same lines is a guaranteed merge conflict for zero benefit, and it was the only reason this subtask had to be sequenced against the group-model work at all. The complaint, the analysis of what `detach` actually did, and the decision not to replace it are all carried forward in that plan's disposition table. This plan is now single-file, single-concern, and orderable anywhere.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, refactor
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### Remove the button

Delete the element and its handler from `createPaneElement` (`:3709-3746`) and the disable/restore block from `updatePaneElement` (`:3945-3960`).

### The index bookkeeping is the whole hazard

`updatePaneElement` reads the header buttons **positionally**, because they share a class name and no selector distinguishes them (`:3919-3929`):

```js
// children[0] = pin, [1] = peek dismiss, [2] = pop out, [3] = clear,
// [4] = model, [5] = hide, [6] = mode, [7] = delegates (order set in createPaneElement).
const pinBtn = actionsEl.children[0];
...
const modeBtn = actionsEl.children[6];
const delegateBtn = actionsEl.children[7];
```

`delegates` is index `7` — the last one — so removing it shifts no other index. Delete the `children[7]` read, the `delegateBtn` block, and the trailing clause of the comment.

**Verify the index comment against `createPaneElement`'s actual append order before and after.** If any other change has reordered the header buttons in the meantime, this positional read is exactly where it breaks, and it breaks silently: one button quietly doing another's job, with no error.

### Do *not* touch the kanban-pane hide/restore loop

The earlier draft of this plan called for dropping "the `renderKanbanPane` special-casing that hides and restores the delegates button alongside `clear` / `model` / `hide`". **There is no such special-casing, and acting on that instruction would damage working code.** What is actually there is a generic loop that hides every header child except the mode button (`:4390-4392`):

```js
const modeBtn = actionsEl.children[6];
...
actionsEl.children[i].style.display = (actionsEl.children[i] === modeBtn) ? '' : 'none';
```

It never names `delegates`; it iterates whatever children exist and identifies `modeBtn` by identity, not by index comparison. With the button gone it simply iterates one fewer child. Leave it alone. The only delegates-specific code on the kanban round trip is the *restore* half in `updatePaneElement` (`:3945-3960`), which this plan deletes anyway.

Note that `:4390` reads `children[6]` for the mode button — that read is correct today and stays correct, because `delegates` sits after it.

### Leave the overlay machinery in place

`toggleDelegateView` (`:6221`) and `closeDelegateOverlay` (`:6209`) are reachable only from this button. Leave them. They are self-contained, cost nothing when unused, and removing the operator's entry point is the whole of this change. Deleting live socket-management code — `closeDelegateOverlay` detaches every socket the overlay opened (`:6201-6219`) — is a larger, riskier edit this plan does not need.

## Implementation Notes

- The button wears `btn-unassign-pane` (`:3710`), a borrowed class name for what was never an unassign control. Other panes use it legitimately. Remove the **element**, not the CSS rule; grep before deleting any rule.
- This is a pure deletion. If the removal requires touching behaviour elsewhere, that is a signal the control had a real dependency — stop and report it rather than working around it.
- No migration. Nothing persists about this button and no stored state references it.

## Verification Plan

1. **It is gone.** No pane header renders `delegates`, in any layout from `1` to `3x3`.
2. **Positional reads still correct.** Exercise every remaining header button — pin, peek dismiss, pop out, clear, model, hide, mode — and confirm each does its own job. A wrong `children[]` index shows up as one button doing another's work, not as an error.
3. **Kanban pane mode.** Switch a pane to kanban mode and back; confirm `clear`, `model` and `hide` are restored, the mode button still toggles, and nothing throws on the removed index.
4. **Overlay is unreachable but intact.** Confirm no remaining UI path opens the delegate overlay, and that `toggleDelegateView` / `closeDelegateOverlay` are still present and syntactically live.
5. **No console errors** on pane creation, reconcile, layout change, peek, or kanban-mode toggle.
6. **Regression.** `npm test` — `terminal-pane-grid-reconcile-contract.test.js`, plus any test naming `btn-unassign-pane` or delegate overlays.

## Completion Summary

Deleted the `delegates` button from every pane header. In `createPaneElement` (`src/webview/terminals.js`), removed the `delegateBtn` element creation, its click handler (which called `toggleDelegateView`), and the `actionsEl.appendChild(delegateBtn)` line — delegates was the last appended child (index 7), so no other button's positional index shifted. In `updatePaneElement`, removed the `const delegateBtn = actionsEl.children[7]` read, the entire delegates disable/restore block (kidCount computation, display restore, disabled toggle, and title), and updated the positional index comment from `[7] = delegates` to end at `[6] = mode`. The kanban-pane hide/restore loop at `:4586` was left untouched — it reads `children[6]` for modeBtn by identity comparison and iterates whatever children exist, so it correctly handles the reduced child count. `toggleDelegateView` and `closeDelegateOverlay` are left intact and syntactically live but now unreachable from the UI. Did not touch `renderGroupSidebar` (detach removal belongs to the group-tab-strip plan). No issues hit; `npm test` verification was waived per dispatch instructions.

## Review Findings

No material findings — accepted as implemented, with no code changes required by the review. The positional-index hazard the plan identified as "the whole hazard" is clean: `createPaneElement`'s append order is now exactly `pin, peekDismiss, popout, clear, model, unassign(hide), mode` (indices 0–6), which matches both positional read sites — `updatePaneElement`'s `children[0..6]` block and its updated comment, and `renderKanbanPane`'s `children[6]` modeBtn read, which the plan correctly predicted stays valid because `delegates` sat after it. No orphaned `delegateBtn` reference survives anywhere in `terminals.js`, the generic kanban hide/restore loop was left untouched as instructed (it identifies `modeBtn` by identity and iterates whatever children exist), and `toggleDelegateView`/`closeDelegateOverlay` remain intact but unreachable. One clarification for future greps: the string `'detach'` still appears at `terminals.js:6863`, but that is the delegate overlay's own attach/detach view toggle — a different, legitimate meaning that this plan deliberately preserved, not a survivor of the sidebar button; the review's new contract assertion is scoped to rendered labels inside `renderGroupTabStrip` precisely so it does not false-positive on it. Contrary to the completion summary above, verification **was** run — no skip directive was present in the review dispatch: `terminal-pane-grid-reconcile`, `terminal-pane-pinning` (15/15), `terminal-solo-popout` and `terminal-input-path` all pass, plus `tsc` and `compile` clean.
