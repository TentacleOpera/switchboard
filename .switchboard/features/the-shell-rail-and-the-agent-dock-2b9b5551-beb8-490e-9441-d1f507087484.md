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
- [ ] [Move Agents icon above Terminals icon in shell rail](../plans/feature_plan_20260820082006_shell-agents-icon-above-terminals.md) — **PLAN REVIEWED** — ID: 6a0559f3-b64c-449f-bf2e-0d4a92e603a1
- [ ] [Replace Mission Control Rail Icon: UFO → Pixel Jet](../plans/replace-mission-control-ufo-with-pixel-jet.md) — **PLAN REVIEWED** — ID: 8a7fed15-0ab3-48aa-9694-1b628f17f2cd
- [ ] [Fix Agent Dock: Mission Controller Terminal Overhaul](../plans/fix-agent-dock-mission-controller-terminal.md) — **PLAN REVIEWED** — ID: 60a61736-6777-4595-83dd-f35da99166be
- [ ] [Placeholder Portraits Become One Radar-Console Interceptor, Painted in the Theme Accent](../plans/placeholder-portraits-become-one-radar-interceptor.md) — **PLAN REVIEWED** — ID: 9a64c093-9164-437c-a635-9ed1ec506fb7
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints, but two couplings matter.

The two art subtasks should land adjacently and **share one asset**. Both source the same interceptor from `switchboard-site/public/assets/agent-fleet-air-combat-detailed.svg`; drawing it twice gives two copies to keep in step. Note that `shell.js` and `kanban.html` are separate documents, so an SVG `<symbol>` reference does not cross between them — that is a duplicated definition, not a shared one, and it is the reason to define the geometry once and inline it deliberately in each.

`replace-mission-control-ufo-with-pixel-jet` must update `shell-terminal-strip.test.js`, which asserts the inlined SVG structure including UFO-specific elements (`sb-mc-beam`, `.light-a`/`.light-b`). Leaving those assertions turns this into a red gate.

`placeholder-portraits` carries a sequencing note added during the consistency audit: `extract-agent-control-into-its-own-panel-file.md` and `retire-the-agent-tabs-from-kanban-html.md` both move the `<defs>` block it edits, and neither has landed — `agent-control.html` does not exist yet. Doing the art swap in `kanban.html` now is correct; if the extraction lands first, the block exists twice and both copies need it.

The icon reorder and the dock overhaul are independent of everything above.
