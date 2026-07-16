# Move Board State Export Section from Control Plane Tab to Remote Tab

## Goal

The **Board State Export** section currently lives inside the **Control Plane** tab of `setup.html`, where it is visually and conceptually buried beneath the Control Plane migration/scaffolding UI. It controls *where the kanban board state gets mirrored for remote/web-agent visibility* — a setting that is logically about **remote visibility**, not about the Control Plane parent-folder configuration. The goal is to relocate the **live** parts of this section (its heading, description, export-destination select, and reserved remote-URL input row) from the `control-plane-fields` tab content div into the `remote-fields` tab content div, so users configuring remote access find the board-state mirror setting where they expect it. The dead `board-state-export-init-git-row` (containing the unreachable `btn-init-control-plane-git` button and its status div) is **dropped rather than ported** — porting dead UI to a new tab is cargo, not a relocation.

### Problem Analysis & Root Cause

- **Symptom**: A user opening the **Remote** tab to configure remote board visibility (Linear/Notion/ClickUp mirroring) does not find the `read-only-snapshot` orphan-branch export setting there. They must instead open the **Control Plane** tab and scroll past the migration/scaffolding blurb to discover it. The setting is misfiled.
- **Root cause (placement)**: The Board State Export block (`setup.html` L711–735) was appended to the bottom of the `control-plane-fields` div (L699–736), separated from the Control Plane modal-trigger button only by a `border-top` divider. It was likely placed there because the `read-only-snapshot` mode publishes to a git orphan branch and the original implementation reused the Control Plane's git-init plumbing (`btn-init-control-plane-git`). Conceptually, though, the setting answers "where does the remote/web agent see my board?" — the same question the rest of the Remote tab answers.
- **Why it's safe to move**: All live element IDs (`board-state-export-select`, `board-state-export-remote-url`, `board-state-export-remote-url-row`) are looked up with `document.getElementById` in the JS handlers (L3556–3567) and the `boardStateExportSetting` hydration case (L4864–4876). `getElementById` is document-global and tab-agnostic — the handlers do not care which tab-content div owns the elements. No handler scopes its lookup to `#control-plane-fields` or relies on the section being a DOM sibling of the Control Plane modal trigger. Therefore the move is a pure HTML relocation with **zero JS changes required**.
- **Why the dead init-git row is dropped, not ported**: The `board-state-export-init-git-row` (L731–734, containing `btn-init-control-plane-git` + `control-plane-git-init-status`) is toggled hidden unless the select value is `control-plane` (L3562, L4872), but the select only offers `none` and `read-only-snapshot` — there is no `control-plane` option, so the row is **never rendered** through the UI. Porting unreachable UI to a new tab adds cargo without value. Dropping it is safe: every JS reference to the removed IDs is null-guarded (`if (initGitRow)` at L3562/L4872, `?.addEventListener` at L3568, `if (statusDiv)` at L4983), so their absence produces no errors — the handlers simply no-op. The now-dead JS handlers (L3568–3571 click binding, L4981–4989 `controlPlaneGitInitResult` case) and the backend `initControlPlaneGit` case (`SetupPanelProvider.ts` L418) are left in place as harmless no-ops; cleaning them is an optional follow-up, out of scope for this HTML-only plan.

## Metadata

- **Tags:** frontend, ui, refactor

> **Superseded:** Tags: frontend, ui, setup, refactor, remote, control-plane
> **Reason:** `setup`, `remote`, and `control-plane` are not in the improve-plan allowed tag list (frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library). The skill forbids inventing tags outside that list.
> **Replaced with:** Tags: frontend, ui, refactor — the only allowed-list tags that accurately describe a pure HTML relocation in the webview.

- **Complexity:** 2
- **Files touched:** `src/webview/setup.html`

## User Review Required

Yes — confirm two decisions: (1) the placement of the Board State Export block as the last item inside the `remote-fields` subsection, immediately before the trailing `remote-config-status` span; (2) dropping the dead `board-state-export-init-git-row` (unreachable `btn-init-control-plane-git` button + status div) rather than porting it. No code change proceeds until the user advances the card.

## Complexity Audit

### Routine

- Cutting the Board State Export block (the `<div style="margin-top: 20px; border-top: ...">` … `</div>` at L711–735) out of `control-plane-fields`. The **live** sub-parts (heading, description, select, remote-url row: L711–730) are pasted into `remote-fields`; the **dead** init-git row (L731–734) is dropped. Pure HTML edit, no logic change.
- Choosing an insertion point inside the Remote tab. The Remote tab's content is wrapped in a single `db-subsection` div (L1399–1526). The Board State Export block is a self-contained sub-section with its own `border-top` divider and monospace heading; placing it after the Notion setup block (L1515–1523) and before the trailing `remote-config-status` span (L1525) keeps it inside the subsection and visually last among the remote settings.
- The `border-top` divider on the moved block already provides visual separation from the preceding Notion setup block, so no new styling is needed.

### Complex / Risky

- **None introduced by this move.** No JS, no message contracts, no backend, no new IDs. The dropped init-git row's JS handlers (L3568–3571 click binding, L4981–4989 result case) and backend `initControlPlaneGit` case (`SetupPanelProvider.ts` L418) become dead no-ops but are null-guarded and produce no errors. Cleaning that dead JS/TS is an optional follow-up, out of scope for this HTML-only plan.

## Edge-Case & Dependency Audit

- **Race Conditions**: None. The `boardStateExportSetting` hydration case (L4864–4876) runs via `runSetupHydration`, which defers until the setup webview is ready. It does not depend on the Control Plane tab being the active tab — `getElementById` finds the elements regardless of which `shared-tab-content` div is currently `active`. After the move, hydration works identically when the Remote tab is active or hidden.
- **Security**: None. No new inputs, no new message types, no credential handling. The reserved `board-state-export-remote-url` input is unchanged and currently unused.
- **Side Effects**:
  - **`hidden` class toggling**: The `board-state-export-remote-url-row` div uses the `hidden` class, toggled by the select's `change` handler (L3557–3564) and the hydration case (L4871). Verified: `.hidden { display: none !important; }` is defined globally at L69 — it is not scoped to the Control Plane tab. Toggling continues to work in the Remote tab. (The `board-state-export-init-git-row` is dropped, so its toggle at L3562/L4872 now no-ops on a missing element — null-guarded, no error.)
  - **Control Plane tab now shorter**: After removing the block, the Control Plane tab ends after the "OPEN CONTROL PLANE SETUP" button (L709). This is cleaner — the tab now contains only Control Plane configuration, matching its title. No empty-state or layout fix is needed; the tab content div simply ends earlier.
  - **Remote tab scroll**: The Remote tab content is wrapped in a `padding:12px; overflow-y:auto; max-width:640px` container (L1398). Adding ~20 lines of content (the live block minus the dropped init-git row) stays well within the existing scroll behavior; no height adjustment needed.
  - **Dead JS/TS left behind**: The click handler at L3568–3571, the `controlPlaneGitInitResult` case at L4981–4989, and the backend `initControlPlaneGit` case (`SetupPanelProvider.ts` L418) become unreachable dead code after the row is dropped. All are null-guarded / no-op on missing elements, so they are harmless. Cleanup is an optional follow-up, out of scope here.
- **Dependencies & Conflicts**:
  - **No ID collisions**: All moved IDs are unique in the document (verified by grep — 18 matches across the file, all the same elements, none duplicated). Moving the live IDs does not create duplicates; dropping the dead IDs (`board-state-export-init-git-row`, `btn-init-control-plane-git`, `control-plane-git-init-status`) simply removes them from the document.
  - **No tab-scoped lookups**: Verified in `src/services/SetupPanelProvider.ts` — the `setBoardStateExport` (L400), `setBoardStateExportRemoteUrl` (L409), and `initControlPlaneGit` (L418) handlers resolve the workspace root via `_getCurrentWorkspaceRoot()` / `resolveEffectiveWorkspaceRootFromMappings`; none reference the rendering tab. The backend is tab-blind.
  - No other file references the Board State Export block's position within `control-plane-fields`. The extension's TypeScript provider posts `boardStateExportSetting` messages without knowing which tab renders the controls. No backend change.

## Dependencies

- None. No prerequisite sessions or plans.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) dropping the dead `board-state-export-init-git-row` leaves behind dead JS/TS (click handler L3568–3571, `controlPlaneGitInitResult` case L4981–4989, backend `initControlPlaneGit` case `SetupPanelProvider.ts` L418) — all null-guarded no-ops, harmless but untidy; (2) the live relocation itself is a pure, verified-safe HTML edit (global `getElementById`, global `.hidden` at L69, tab-blind backend) with zero JS changes on the kept elements. Mitigations: dead-code cleanup is flagged as an optional follow-up, out of scope for this HTML-only plan; the relocation's safety is confirmed against the live code.

## Proposed Changes

### `src/webview/setup.html`

**1. Remove the Board State Export block from the Control Plane tab.**

Delete L711–735 (the `<div style="margin-top: 20px; border-top: 1px solid var(--border-color); padding-top: 16px;">` … matching close `</div>` that wraps the BOARD STATE EXPORT heading, description, select, remote-url row, and the dead init-git row). The Control Plane tab's `control-plane-fields` div will then close immediately after the "OPEN CONTROL PLANE SETUP" button:

```html
                <button id="btn-open-control-plane-modal" class="secondary-btn w-full" style="margin-top: 12px;">OPEN CONTROL PLANE SETUP</button>
            </div>
```

**2. Insert the live parts of the block into the Remote tab, after the Notion setup block and before the trailing status span.**

Insert immediately before L1525 (`<span id="remote-config-status" ...>`). The inserted block is the original L711–730 **minus** the dead init-git row (original L731–734):

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
                    </div>
```

The live sub-parts (heading, description, select, remote-url row) are byte-for-byte identical to the removed block (plus a leading HTML comment) — no ID, class, or attribute changes on the kept elements. The dead `board-state-export-init-git-row` (with `btn-init-control-plane-git` and `control-plane-git-init-status`) is **not** re-inserted; those IDs no longer exist in the document.

**No changes to JS handlers (L3556–3567 select/remote-url handlers, L4864–4876 hydration) or the backend (`SetupPanelProvider.ts` L400/L409).** They use `document.getElementById` and are tab-agnostic. The click handler at L3568–3571 and the `controlPlaneGitInitResult` case at L4981–4989 reference the now-removed IDs but are null-guarded (`?.addEventListener`, `if (statusDiv)`) and silently no-op.

## Verification Plan

> **Session directive:** Compilation and automated tests are SKIPPED per the active session configuration. The verification below is manual only.

### Automated Tests

- None run per session directive (SKIP TESTS). No project compilation step is run per session directive (SKIP COMPILATION). This is an HTML-only edit; no type errors are expected from a relocation with no JS/TS changes.

### Manual Verification

1. **Open the Setup panel** and confirm:
   - The **Control Plane** tab now ends after the "OPEN CONTROL PLANE SETUP" button — no BOARD STATE EXPORT heading or select below it.
   - The **Remote** tab shows the BOARD STATE EXPORT section at the bottom (after the Notion setup block, before the trailing status line), with the export-destination select defaulting to `none` and the reserved remote-URL row hidden.
2. **Functional checks** (handlers still bind after the move):
   - Change the export-destination select to `read-only-snapshot` and confirm the reserved remote-URL row becomes visible (the `hidden` class is toggled off). Change back to `none` and confirm it hides.
   - Confirm the `boardStateExportSetting` hydration message still populates the select and remote-URL input on panel open (i.e. a previously-saved `read-only-snapshot` choice is restored and its row is shown).
3. **No duplicate IDs, no orphan dead IDs**: Search `setup.html` for `board-state-export-select` and confirm exactly one match. Search for `btn-init-control-plane-git`, `board-state-export-init-git-row`, and `control-plane-git-init-status` and confirm **zero matches** (the dead row was dropped, not ported).
4. **No console errors from dead handlers**: Open DevTools on the webview and confirm no errors fire on panel load or on switching the select — the orphaned click handler (L3568) and result case (L4981) must no-op silently on the missing elements.
5. **Tab switching**: Switch between Control Plane and Remote tabs several times and confirm no console errors and no layout regression in either tab.

## Recommendation

Complexity 2 → **Send to Intern**. Pure HTML relocation + dead-row drop, single file, zero JS changes on kept elements, verified-safe against the live code. The leftover dead JS/TS handlers are null-guarded no-ops and flagged as an optional follow-up, not work for this plan.

## Completion Summary

Relocated the live Board State Export block (heading, description, export-destination select, reserved remote-URL row) from the Control Plane tab's `control-plane-fields` div into the Remote tab's `remote-fields` div, placed after the Notion setup block and before the trailing `remote-config-status` span. Dropped the dead `board-state-export-init-git-row` (unreachable `btn-init-control-plane-git` button + `control-plane-git-init-status` div) rather than porting it. File changed: `src/webview/setup.html` (one removal at the old L711–735, one insertion at the new L1499–1520). Verified via grep: `board-state-export-select` has a single HTML id (no duplicates), and the three dropped dead IDs have zero HTML matches (only 4 null-guarded JS references remain, which no-op silently). No JS or backend changes were made. No issues encountered.
