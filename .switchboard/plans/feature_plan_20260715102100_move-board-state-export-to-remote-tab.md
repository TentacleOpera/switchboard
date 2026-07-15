# Move Board State Export Section from Control Plane Tab to Remote Tab

## Goal

The **Board State Export** section currently lives inside the **Control Plane** tab of `setup.html`, where it is visually and conceptually buried beneath the Control Plane migration/scaffolding UI. It controls *where the kanban board state gets mirrored for remote/web-agent visibility* — a setting that is logically about **remote visibility**, not about the Control Plane parent-folder configuration. The goal is to relocate this section (its heading, description, export-destination select, reserved remote-URL input, and the "Initialize Control Plane Git Repo" button row) from the `control-plane-fields` tab content div into the `remote-fields` tab content div, so users configuring remote access find the board-state mirror setting where they expect it.

### Problem Analysis & Root Cause

- **Symptom**: A user opening the **Remote** tab to configure remote board visibility (Linear/Notion/ClickUp mirroring) does not find the `read-only-snapshot` orphan-branch export setting there. They must instead open the **Control Plane** tab and scroll past the migration/scaffolding blurb to discover it. The setting is misfiled.
- **Root cause (placement)**: The Board State Export block (`setup.html` L711–735) was appended to the bottom of the `control-plane-fields` div (L699–736), separated from the Control Plane modal-trigger button only by a `border-top` divider. It was likely placed there because the `read-only-snapshot` mode publishes to a git orphan branch and the original implementation reused the Control Plane's git-init plumbing (`btn-init-control-plane-git`). Conceptually, though, the setting answers "where does the remote/web agent see my board?" — the same question the rest of the Remote tab answers.
- **Why it's safe to move**: All element IDs (`board-state-export-select`, `board-state-export-remote-url`, `board-state-export-remote-url-row`, `board-state-export-init-git-row`, `btn-init-control-plane-git`, `control-plane-git-init-status`) are looked up with `document.getElementById` in the JS handlers (L3556–3571) and the `boardStateExportSetting` hydration case (L4864–4876). `getElementById` is document-global and tab-agnostic — the handlers do not care which tab-content div owns the elements. No handler scopes its lookup to `#control-plane-fields` or relies on the section being a DOM sibling of the Control Plane modal trigger. Therefore the move is a pure HTML relocation with **zero JS changes required**.

## Metadata

- **Tags:** frontend, ui, setup, refactor, remote, control-plane
- **Complexity:** 2

- **Files touched:** `src/webview/setup.html`

## Complexity Audit

### Routine

- Cutting the Board State Export block (the `<div style="margin-top: 20px; border-top: ...">` … `</div>` at L711–735) out of `control-plane-fields` and pasting it into `remote-fields`. Pure HTML edit, no logic change.
- Choosing an insertion point inside the Remote tab. The Remote tab's content is wrapped in a single `db-subsection` div (L1399–1526). The Board State Export block is a self-contained sub-section with its own `border-top` divider and monospace heading; placing it after the Notion setup block (L1515–1523) and before the trailing `remote-config-status` span (L1525) keeps it inside the subsection and visually last among the remote settings.
- The `border-top` divider on the moved block already provides visual separation from the preceding Notion setup block, so no new styling is needed.

### Complex / Risky

- **None.** No JS, no message contracts, no backend, no new IDs. The `btn-init-control-plane-git` button retains its existing handler (L3568–3571) which posts `initControlPlaneGit` — the handler is global and unaffected by the move. The button label still says "INITIALIZE CONTROL PLANE GIT REPO"; that label is accurate (it initializes the control-plane git repo for the orphan-branch snapshot) and is **not** being changed by this issue. Renaming the button is out of scope.

## Edge-Case & Dependency Audit

- **Tab hydration timing**: The `boardStateExportSetting` hydration case (L4864–4876) runs via `runSetupHydration`, which defers until the setup webview is ready. It does not depend on the Control Plane tab being the active tab — `getElementById` finds the elements regardless of which `shared-tab-content` div is currently `active`. After the move, hydration works identically when the Remote tab is active or hidden.
- **`hidden` class toggling**: The `board-state-export-remote-url-row` and `board-state-export-init-git-row` divs use the `hidden` class, toggled by the select's `change` handler (L3557–3564) and the hydration case (L4871–4872). The `hidden` class is a global CSS utility (`display: none`); it is not scoped to the Control Plane tab. Toggling continues to work in the Remote tab.
- **Control Plane tab now shorter**: After removing the block, the Control Plane tab ends after the "OPEN CONTROL PLANE SETUP" button (L709). This is cleaner — the tab now contains only Control Plane configuration, matching its title. No empty-state or layout fix is needed; the tab content div simply ends earlier.
- **Remote tab scroll**: The Remote tab content is wrapped in a `padding:12px; overflow-y:auto; max-width:640px` container (L1398). Adding ~25 lines of content stays well within the existing scroll behavior; no height adjustment needed.
- **No ID collisions**: All moved IDs are unique in the document (verified by grep — 14 matches, all the same elements). Moving them does not create duplicates.
- **Dependencies & conflicts**: No other file references the Board State Export block's position within `control-plane-fields`. The extension's TypeScript provider posts `boardStateExportSetting` messages without knowing which tab renders the controls. No backend change.

## Proposed Changes

### `src/webview/setup.html`

**1. Remove the Board State Export block from the Control Plane tab.**

Delete L711–735 (the `<div style="margin-top: 20px; border-top: 1px solid var(--border-color); padding-top: 16px;">` … matching close `</div>` that wraps the BOARD STATE EXPORT heading, description, select, remote-url row, and init-git row). The Control Plane tab's `control-plane-fields` div will then close immediately after the "OPEN CONTROL PLANE SETUP" button:

```html
                <button id="btn-open-control-plane-modal" class="secondary-btn w-full" style="margin-top: 12px;">OPEN CONTROL PLANE SETUP</button>
            </div>
```

**2. Insert the same block into the Remote tab, after the Notion setup block and before the trailing status span.**

Insert immediately before L1525 (`<span id="remote-config-status" ...>`):

```html
                    <!-- Board state export: where the kanban board state gets mirrored for remote/web-agent visibility. -->
                    <div style="margin-top: 20px; border-top: 1px solid var(--border-color); padding-top: 16px;">
                        <div style="font-size: 10px; color: var(--text-secondary); margin: 0 0 8px; font-family: var(--font-mono); letter-spacing: 1px;">
                            BOARD STATE EXPORT
                        </div>
                        <div style="font-size: 11px; color: var(--text-secondary); margin: 8px 0; line-height: 1.5;">
                            Choose where the kanban board state gets mirrored for remote/web-agent visibility. <strong>Default: none</strong> — no git footprint. <code>read-only-snapshot</code> publishes a one-directional, read-only snapshot (<code>board.json</code> + <code>board.md</code>) to the orphan branch <code>switchboard/board</code> — read-only, not a control channel. Notion/Linear are governed by their existing provider config.
                        </div>
                        <label class="startup-row" style="display:block; margin-top:8px;">
                            <span style="display:block; margin-bottom:4px;">Export destination</span>
                            <select id="board-state-export-select" style="width:100%; padding:4px 8px; background:var(--panel-bg); color:var(--text-primary); border:1px solid var(--border-color); border-radius:3px;">
                                <option value="none">none — no git footprint</option>
                                <option value="read-only-snapshot">read-only-snapshot — publish to orphan branch switchboard/board (read-only)</option>
                            </select>
                        </label>
                        <div id="board-state-export-remote-url-row" class="hidden" style="margin-top:8px;">
                            <label class="startup-row" style="display:block;">
                                <span style="display:block; margin-bottom:4px;">Git remote URL (reserved — currently unused)</span>
                                <input id="board-state-export-remote-url" type="text" placeholder="reserved" style="width:100%;">
                            </label>
                        </div>
                        <div id="board-state-export-init-git-row" class="hidden" style="margin-top:8px;">
                            <button id="btn-init-control-plane-git" class="secondary-btn w-full">INITIALIZE CONTROL PLANE GIT REPO</button>
                            <div id="control-plane-git-init-status" style="font-size:10px; color:var(--text-secondary); margin-top:4px;"></div>
                        </div>
                    </div>
```

The block is byte-for-byte identical to the removed block (plus a leading HTML comment) — no ID, class, or attribute changes. This guarantees the existing JS handlers and hydration case continue to bind to the same elements.

**No changes to JS handlers (L3556–3571) or the `boardStateExportSetting` hydration case (L4864–4876).** They use `document.getElementById` and are tab-agnostic.

## Verification Plan

1. **Build/compile**: Run the extension's standard build (e.g. `npm run compile` or the VS Code extension build task) and confirm no errors. This is an HTML-only edit, so no type errors are expected.
2. **Open the Setup panel** and confirm:
   - The **Control Plane** tab now ends after the "OPEN CONTROL PLANE SETUP" button — no BOARD STATE EXPORT heading or select below it.
   - The **Remote** tab shows the BOARD STATE EXPORT section at the bottom (after the Notion setup block, before the trailing status line), with the export-destination select defaulting to `none` and the remote-url / init-git rows hidden.
3. **Functional checks** (handlers still bind after the move):
   - Change the export-destination select to `read-only-snapshot` and confirm the reserved remote-URL row becomes visible (the `hidden` class is toggled off). Change back to `none` and confirm it hides.
   - Confirm the `boardStateExportSetting` hydration message still populates the select and remote-URL input on panel open (i.e. a previously-saved `read-only-snapshot` choice is restored and its row is shown).
   - Click "INITIALIZE CONTROL PLANE GIT REPO" (when visible) and confirm it still posts `initControlPlaneGit` — the button label is unchanged and out of scope to rename.
4. **No duplicate IDs**: Search `setup.html` for `board-state-export-select` and confirm exactly one match. Same for `btn-init-control-plane-git`.
5. **Tab switching**: Switch between Control Plane and Remote tabs several times and confirm no console errors and no layout regression in either tab.
