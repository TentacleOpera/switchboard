# Relocate Init Plugin Button in Setup Tab

## Goal
Move the "INIT PLUGIN" button from the top of the Setup tab to the bottom and relabel it "REINITIALISE PLUGIN" with a warning, reducing accidental clicks on a dangerous action that should rarely be used.

## Problem
The "INIT PLUGIN" button at the top of the Setup tab is dangerous because the plugin auto-initializes on startup. This button should almost never be pressed by users, but its prominent position at the top makes it easily accessible and likely to be clicked accidentally.

## Solution
Move the "INIT PLUGIN" button to the bottom of the Setup tab and rebrand it to make its purpose clearer and less accessible.

## Metadata
- **Tags:** [UI, UX]
- **Complexity:** 2

## User Review Required
- Confirm the warning text wording is acceptable ("Press this button if your .switchboard directory, agents.md or agent folder gets deleted. Do not touch otherwise.")
- Confirm "REINITIALISE PLUGIN" is the preferred label (British spelling matches existing codebase convention)

## Complexity Audit

### Routine
- Single-file HTML edit (`src/webview/setup.html`)
- Moving an existing DOM element within the same parent container
- Relabeling a button and adding a warning div
- No JS handler changes needed (ID-based `getElementById` at line 2712 works regardless of DOM position)
- No CSS changes needed (existing `secondary-btn`, `--accent-orange`, `--border-dim` variables already defined)

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None — this is a static HTML layout change with no async logic
- **Security:** No security implications; the button fires the same `switchboard.setup` command it always has
- **Side Effects:** Removing the button from line 470 makes "GIT IGNORE STRATEGY" the first visible element in the Setup tab. The existing `margin: 12px 0 4px` on that header provides adequate top spacing — no layout gap will appear
- **Dependencies & Conflicts:** The JS event listener at line 2712 (`document.getElementById('btn-initialize')?.addEventListener(...)`) uses optional chaining and ID-based lookup; it will find the relocated element without modification. No other code references the button's DOM position

## Dependencies
- None

## Adversarial Synthesis
Key risks: The "REINITIALISE" label implies a distinct recovery operation, but the underlying command (`switchboard.setup`) is identical to the original — this is a labeling change, not a functional one. No confirmation dialog guards the button, though moving it is a net safety improvement over the current prominent placement. Mitigations: The warning text clearly discourages casual use, and the relocated position at the tab bottom with visual separation makes accidental clicks far less likely.

## Changes Required

### File: `src/webview/setup.html`

1. **Remove the button from its current position** (line 470):
   - Delete: `<button id="btn-initialize" class="secondary-btn w-full">INIT PLUGIN</button>`

2. **Add the button at the bottom of the Setup tab** (after line 517, before the closing `</div>` of the setup tab at line 518):
   ```html
   <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-dim);">
       <div style="font-size: 10px; color: var(--accent-orange); margin-bottom: 8px; line-height: 1.4; font-family: var(--font-mono);">
           ⚠ Press this button if your .switchboard directory, agents.md or agent folder gets deleted. Do not touch otherwise.
       </div>
       <button id="btn-initialize" class="secondary-btn w-full">REINITIALISE PLUGIN</button>
   </div>
   ```

3. **No JS changes required** — the event listener at line 2712 (`document.getElementById('btn-initialize')?.addEventListener('click', () => vscode.postMessage({ type: 'runSetup' }))`) uses ID-based lookup and will find the relocated element automatically.

**Clarification:** The button fires the same `switchboard.setup` command regardless of the new "REINITIALISE" label. The label reflects the expected use case (recovery from deleted files), not a different implementation path.

## Rationale
- **Safety**: Moving the button to the bottom reduces accidental clicks
- **Clarity**: The warning text with orange accent color draws attention to the danger
- **Accuracy**: "REINITIALISE" better reflects the actual use case (recovering from deleted files)
- **Visual separation**: The border-top and margin create clear separation from normal settings

## Testing
1. Open the Setup panel
2. Verify the "INIT PLUGIN" button is no longer at the top
3. Scroll to the bottom of the Setup tab
4. Verify the "REINITIALISE PLUGIN" button appears with the warning text above it
5. Verify the button still functions correctly (test by clicking it)
6. Verify the "GIT IGNORE STRATEGY" header is now the first visible element and has no awkward spacing at the top

## Verification Plan

### Automated Tests
- No automated tests required — this is a static HTML layout change with no logic modifications

### Recommendation
**Send to Intern** — Complexity 2: single-file, localized HTML edit with no logic changes.
