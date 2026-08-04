# Terminals Sidebar — Branding, Cleanup & Saved Groupings

**Complexity:** 6

## Goal

Rework the browser Terminals sidebar list: brand each row with the real CLI icon and name, drop the redundant locate button, replace flat terminal rows with named saved pane-assignment groups, and make the role picker read the real machine-global visible-agents store in both hosts. All four rewrite the same renderSidebarList / sidebar row surface, so they are sequenced together to avoid collisions.

## How the Subtasks Achieve This

- **Terminals role picker: read the real visible-agents store in both hosts**: Adds a `ptyVisibleRoles` verb on the shared `/terminals/verb/` rail that reads `~/.switchboard/integration-config.json` via `GlobalIntegrationConfigService.getAgentConfig`, merged over `sharedDefaults.DEFAULT_VISIBLE_AGENTS`, and deletes the two drifted hardcoded role lists in `terminals.js` (`DEFAULT_ROLES`, the `DEFAULT_VISIBLE_AGENTS` mirror). Contributes the "pickers and grids reflect the real Agents-tab config" half of the cleanup — without it the picker shows six hardcoded roles forever.
- **Remove redundant "locate" button from browser terminals.html sidebar**: Deletes the `locateBtn` block in `renderTerminalRow` (`terminals.js:779-787`) whose action is byte-identical to the row click. Contributes the visual-declutter third of the sidebar row cleanup and lands first among the row edits so the branding diff rebases onto the settled three-button action row.
- **Brand the terminals.html sidebar list with real CLI brand icons and names**: Extracts the five identical `basename().toUpperCase() + ' CLI'` derivation sites into one shared `deriveAgentDisplayName` helper (fixing `AGY CLI` → `Antigravity CLI` on both the sidebar and the kanban subline via the lock-step invariant), and renders a monochrome `currentColor` brand glyph beside each row's role subline, with assets in the already-served `icons/` root. Contributes the "rows identify the actual CLI brand" requirement.
- **Terminal Sidebar Groupings — Saved Pane-Assignment Sets, One-Click Switch**: Adds a persisted `terminalGroups` store (`terminals.groups` / `terminals.activeGroupId`), a SAVE AS GROUP control, a `switchToGroup` that routes through `setLayoutMode` (honouring the pane-size floor and the shipped pinning contract), a rename fixup, and a groups render mode in `renderSidebarList` that replaces individual rows once any group exists. Contributes the headline workflow change: named, switchable seating sets instead of one fragile live arrangement.

## Dependencies & sequencing

- **Cross-feature dependencies:** None blocking. The pinning feature (`pin-terminals-to-panes`) has already shipped — groupings' pin-coherence contract (switch touches only `paneAssignments` + `currentLayout`, never `pinnedPanes`) is with live code, defined in the groupings plan. The role-picker plan deliberately does NOT depend on `standalone-board-verb-rail-fallthrough`; the terminals rail is the correct home for a terminals-panel read.
- **Shipping order within this feature (all four touch `src/webview/terminals.js` — PRD one-stream-per-file forces sequential coding):**
  1. **Role picker** — disjoint region (picker/grid code at `terminals.js:1823-2018` + backend verb); lands first to clear the dead-code deletions other greps might trip on.
  2. **Locate-button removal** — `renderTerminalRow` actions block; tiny, lands before branding so branding rebases onto the settled row.
  3. **Branding** — `renderTerminalRow` info block + shared helper + icon assets + the four confirmed `kanban-auto-export.test.ts` `AGY CLI` assertion updates in the same change.
  4. **Groupings** — largest; `renderSidebarList` mode branch + group store + `renameTerminal` fixup; lands last so it rebases over the settled row render.
- **Prerequisites/guards:** groups mode bypasses `renderTerminalRow`, so the branding and locate changes are flat-mode-only once groups exist (accepted feature-wide; the "show all terminals" toggle keeps flat mode reachable). The four `AGY CLI` test assertions (lines 278/280/355/365) must be updated with the branding change or CI goes red. Solo mode (`?solo=`) suppresses all group UI by contract.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminals role picker: read the real visible-agents store in both hosts](../plans/standalone-role-picker-visible-agents.md) — **PLAN REVIEWED**
- [ ] [Terminal Sidebar Groupings — Saved Pane-Assignment Sets, One-Click Switch](../plans/feature_plan_20260804083403_terminal-sidebar-groupings.md) — **PLAN REVIEWED**
- [ ] [Remove redundant "locate" button from browser terminals.html sidebar](../plans/feature_plan_20260804115941_remove-redundant-locate-button-browser-terminals-sidebar.md) — **PLAN REVIEWED**
- [ ] [Brand the terminals.html sidebar list with real CLI brand icons and names](../plans/feature_plan_20260804120328_brand-cli-sidebar-list-with-icons.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

