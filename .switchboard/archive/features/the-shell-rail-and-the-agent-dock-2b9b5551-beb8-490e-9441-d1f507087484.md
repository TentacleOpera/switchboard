# The Shell Rail And The Agent Dock

**Complexity:** 7

## Goal

Make the browser shell left rail and right dock look and behave like Switchboard.

The dock is meant to be the mission controller persistent terminal, and fails at that five ways: its toggle sits in the bottom cluster of the rail among settings icons rather than with the Mission Control icon; the solo terminal in the iframe does not get the full theme treatment; a role picker lists every visible role, implying the dock launches anything, when it should show an editable CLI command; with no startup command configured the shell spawns and exits immediately, leaving a read-only dead terminal with no recovery path; and the dock terminal leaks into both the Terminals panel sidebar and the rail fleet section where it does not belong.

The rail art is also placeholder. The Mission Control icon is a saucer with a tractor beam and blinking lights where a pixel jet was asked for, and the Teams surface carries five head-and-torso portraits its own source comment labels as placeholder, plus a bare-letter team fallback. One flat interceptor silhouette painted in the theme accent replaces all of it. Separately the Agents icon renders below Terminals in a data-driven manifest and should be above it.

## How the Subtasks Achieve This

- **Fix Agent Dock: Mission Controller Terminal Overhaul**: moves the dock toggle to the Mission Control icon, styles the solo terminal, replaces the all-roles picker with an editable CLI command input, adds a restart path out of the exited-process dead end, and keeps the dock terminal from appearing in the Terminals panel and rail fleet.
- **Replace Mission Control Rail Icon: UFO to Pixel Jet**: swaps the saucer, tractor beam and blinking lights for the top-down interceptor from the sibling site repo. A correction, not a new feature — the jet was the original request.
- **Placeholder Portraits Become One Radar-Console Interceptor**: retires the five head-and-torso portraits its own source comment labels placeholder, plus the rail bare-letter team fallback, for one flat silhouette painted in the theme accent. The portraits are not a rare fallback — they resolve for every seat with no icon set, at four sizes.
- **Move Agents Icon Above Terminals Icon In Shell Rail**: one reorder in `getPanelsManifest`, the single source both hosts delegate to, so the rail renders in the intended order.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Move Agents icon above Terminals icon in shell rail](../plans/feature_plan_20260820082006_shell-agents-icon-above-terminals.md) — **CODE REVIEWED** — ID: 6a0559f3-b64c-449f-bf2e-0d4a92e603a1
- [ ] [Replace Mission Control Rail Icon: UFO → Pixel Jet](../plans/replace-mission-control-ufo-with-pixel-jet.md) — **CODE REVIEWED** — ID: 8a7fed15-0ab3-48aa-9694-1b628f17f2cd
- [ ] [Fix Agent Dock: Mission Controller Terminal Overhaul](../plans/fix-agent-dock-mission-controller-terminal.md) — **CODE REVIEWED** — ID: 60a61736-6777-4595-83dd-f35da99166be
- [ ] [Placeholder Portraits Become One Radar-Console Interceptor, Painted in the Theme Accent](../plans/placeholder-portraits-become-one-radar-interceptor.md) — **CODE REVIEWED** — ID: 9a64c093-9164-437c-a635-9ed1ec506fb7
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints, but two couplings matter.

The two art subtasks should land adjacently and **share one asset**. Both source the same interceptor from `switchboard-site/public/assets/agent-fleet-air-combat-detailed.svg`; drawing it twice gives two copies to keep in step. Note that `shell.js` and `kanban.html` are separate documents, so an SVG `<symbol>` reference does not cross between them — that is a duplicated definition, not a shared one, and it is the reason to define the geometry once and inline it deliberately in each.

`replace-mission-control-ufo-with-pixel-jet` must update `shell-terminal-strip.test.js`, which asserts the inlined SVG structure including UFO-specific elements (`sb-mc-beam`, `.light-a`/`.light-b`). Leaving those assertions turns this into a red gate.

`placeholder-portraits` carries a sequencing note added during the consistency audit: `extract-agent-control-into-its-own-panel-file.md` and `retire-the-agent-tabs-from-kanban-html.md` both move the `<defs>` block it edits, and neither has landed — `agent-control.html` does not exist yet. Doing the art swap in `kanban.html` now is correct; if the extraction lands first, the block exists twice and both copies need it.

The icon reorder and the dock overhaul are independent of everything above.

## Completion Summary

All four subtasks landed in commit ab964410. The icon reorder (subtask 1) was already correct in source — `agent-control` precedes `terminals` in `getPanelsManifest`. The UFO→pixel jet swap (subtask 2) was a no-op: the UFO icon and its CSS were already removed in commit 8a77aa1f's rail restructure; only an orphaned comment was cleaned up. The dock overhaul (subtask 3) replaced the role picker with a CLI command input, passed `hidden:true` to keep the dock terminal out of the sidebar/rail, added `checkDockLiveness` reading `hiddenTerminals`, added a Restart button with `dockTerminalExited` postMessage, and stamped `themeClass` in the standalone bootstrap HTML getters. The portrait retirement (subtask 4) collapsed five placeholder symbols to one flat interceptor `<symbol>` painted `var(--accent)`, replaced the bare-letter rail fallback with `buildMaskedGlyph('/static/icons/nav-jet.svg')`, and updated both contract test files. All 66 tests pass.

## Review Findings

Reviewed all four subtasks in place. Three needed no code change — the manifest reorder was already correct in source, the UFO→jet swap was pre-empted by `8a77aa1f`'s rail restructure (which deleted the icon outright), and the portrait retirement landed cleanly on both surfaces with the `headTerm.iconUri` guard preserved. The dock overhaul shipped with an inert core: `hidden: true` and `hiddenTerminals` were a mechanism that did not exist in either host, verified by curl against the running server, so the dock terminal still leaked into the Terminals sidebar and rail; it is now implemented end-to-end in `PtyFleetService`, both `ptyCreateTerminal` arms and both `ptyListTerminals` arms, with hidden seats kept routable in `TaskViewerProvider` and `LocalApiServer` because the flag governs rendering only. Also fixed a five-second clobber of the operator's typed CLI command and guarded the standalone theme read to match the extension host. Full validation and per-subtask deferrals are recorded in each subtask plan file; the one feature-level gap is that the dock's launch affordance still sits among the settings icons in `#top-right-cluster`, because the Mission Control icon the plan named as its new home no longer exists.

## Deferred Findings

- MAJOR — the feature goal "its toggle sits in the bottom cluster of the rail among settings icons rather than with the Mission Control icon" is not met: the toggle moved to `#top-right-cluster` (by `8a77aa1f`, not by this work) and the Mission Control icon was deleted, so there is no MC affordance to associate it with. Author decision required. `src/webview/shell.js:1265`
- MAJOR — the feature's visual claims (accent-painted jet under both themes, dock terminal styling in the solo iframe, dock seat absent from sidebar and rail) are all manual-only; no automated check discriminates on them and this pass did not run a browser session against a rebuilt VSIX. `src/webview/shell.html:109`
