# Shell Rail Restructure: A Primary Group, A Cold Group, And No Process List

## Goal

Rebuild the shell rail as three declared groups instead of one long manifest run plus
an appended process list. Primary group (top): Kanban, Mission Control, Agent Control,
Terminals, Linear. Team slots below it. Cold group at the foot: Project, Artifacts,
Tickets, Design. Setup, Memo, Connections and the Agent Dock toggle leave the rail
entirely for the top-right cluster (companion plan). The theme toggle, the UFO Mission
Control button and the per-terminal buttons are deleted.

### The problem, and the root cause

The rail's composition is an accident of three mechanisms that never agreed on an axis.

`getPanelsManifest` (`src/services/headlessPanelHtml.ts:547`) returns eleven entries in
one flat array, and `renderManifest` (`src/webview/shell.js:1400`) appends every entry
with no `placement` marker to the top group in manifest order. `placement: 'bottom'` is
carried by exactly one entry — Setup — so "the bottom cluster" is not a group, it is a
single-member special case plus two buttons hardcoded around it: `buildDockToggle()`
(`shell.js:657`) and `buildThemeToggle()` (`shell.js:621`), both appended imperatively
in `renderManifest` after the manifest loop. `applyBottomAnchor` (`shell.js:1042`) then
reconciles a `margin-top: auto` across whichever of those members happen to exist,
because the cluster's membership changes at runtime.

Meanwhile `renderTerminalSection` (`shell.js:1059`) grows the rail by one button per
live process: one per team, then one per ungrouped terminal (`shell.js:1240`). So a
fleet of nine terminals in two teams is eleven buttons, and the rail's length is a
function of process count.

The result is roughly sixteen buttons in a 48px column with no hierarchy: a panel the
operator opens hourly and a panel opened twice a year are the same 36px square, and the
frequently-used ones are interleaved with the cold ones by manifest accident.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, ui, ux, refactor

## No migration

Clean break, no compat shim. Rail composition is UI chrome with no persisted state, and
this project is taking a clean break on shipped state generally for this release. Do NOT
add a migration, a legacy-key preserver, or a `*.migrated.bak` archive for anything in
this plan — CLAUDE.md's migration rule is explicitly waived here. The one piece of
persisted state in scope is `sb.agentDock` (`shell.js:DOCK_STATE_KEY`), which is
unchanged by this plan and must keep working.

## Scope: both composition roots

The manifest is shared but its availability flags are wired per host:
- `src/services/TaskViewerProvider.ts:4102` — extension host
- `src/standalone/bootstrap.ts:876` — standalone/npx host

Any new availability key added here (`linear`) must be wired in **both**, or the panel
silently vanishes in one host. Diff the two calls by hand; no gate catches this.

## Implementation

1. **Replace the single `placement` marker with a required group key.** In
   `PanelManifestEntry` (`headlessPanelHtml.ts:502`), swap `placement?: 'bottom'` for
   `group: 'primary' | 'cold'`. Making it required means a new panel cannot be added
   without choosing a group — the current optional marker is why nine entries landed in
   the top group by default.
2. **Reorder the manifest** to: `board`, `mission-control`, `agent-control`,
   `terminals`, `linear` (all `group: 'primary'`); `project`, `planning`, `tickets`,
   `design` (all `group: 'cold'`). Remove `memo`, `setup` and `connections` from the
   rail groups — they keep their manifest entries, routes and frames (the top-right
   cluster plan mounts them), but render no rail icon. Add a `railHidden: true` marker
   rather than deleting the entries: `getPanelHtmlById` (`headlessPanelHtml.ts:571`) and
   the deep-link handler both key on id, and dropping the entries breaks `/#setup`.
3. **`defaultPanelId` must stop being "first enabled entry."** Manifest order currently
   doubles as the default-panel rule (noted in the `placement` comment at
   `headlessPanelHtml.ts:506`). Declare it explicitly as `board` so reordering is free.
4. **Render groups, not markers.** In `renderManifest`, build `primary` and `cold`
   arrays from the group key, append `primary`, then `#strip-terminals`, then `cold`.
   Delete the `buildDockToggle()` and `buildThemeToggle()` calls and both functions.
5. **Delete the theme toggle.** The setting is fully reachable at Setup → Theme
   (`setup.html:683`, radios at `:966`), which posts the same `setThemeSetting` verb the
   rail button did. `applyThemeToAll` (`shell.js:692`) and the
   `switchboardThemeChanged` fan-out stay — they are the receiver, not the trigger.
6. **Delete per-terminal rail buttons.** Remove the ungrouped-terminal loop
   (`shell.js:1240`) and `buildTerminalButton`. Terminals outside a team are reachable
   only through the Terminals panel from now on — that is intended. This reverses the
   explicit decision in `shell-strip-team-icons-instead-of-per-terminal-cli-icons.md`
   ("Terminals belonging to no team keep an individual button"); that line in that plan
   is now superseded.
7. **Delete the UFO Mission Control button.** Remove `createMissionControlIcon`
   (`shell.js:339`), `ensureMissionControlIcon` and its three idempotent call sites
   (`renderManifest`, and both branches of `renderTerminalSection`), the
   `missionControlActive` / `missionControlSeat` / `missionControlStartInFlight` state,
   the `missionControlState` postMessage handler, and the `#strip-mission-control` CSS
   (`shell.html:245-280`). The `mission-control` **panel** icon in the primary group is
   unaffected — that is the surviving Mission Control entry point.
   - Delete the `missionControlState` relay at its source too
     (`terminals.js:1764`), or the panel keeps computing and posting state nothing reads.
   - `showStripToast` (`shell.js:318`) exists only for this button's start feedback.
     Keep it if the team slots' start-failure path uses it (they do, in the team-slots
     plan); otherwise delete it with the button.

8. **Nothing replaces the UFO in the rail.** Its start function moves to the agent dock,
   which already shares the controller's seat identity — see
   `opening-the-dock-starts-mission-control.md`. Two notes so the deletion is not
   misread as orphaning:
   - `POST /mission-control/start` keeps a live non-UI caller: the `/switchboard-manage`
     skill (`LocalApiServer.ts:550`). Do **not** delete the endpoint or its
     `missionControlStart` option along with the button.
   - The lit-click behaviour (navigate to Terminals, post `switchToController`) is not
     replaced. The Mission Control panel and the Terminals panel both already reach the
     controller; a rail shortcut to it is what is being given up, deliberately.

9. **Simplify `applyBottomAnchor`.** With a declared cold group, the anchor is one rule:
   `margin-top: auto` on the first cold-group icon, nothing else. Delete the runtime
   reconciliation over a variable member list.

## Edge cases

- **Pulse ledger keys.** `pulsedDoneStamps` (`shell.js:672`) holds both `term:<name>`
  and `team:<id>` keys. With per-terminal buttons gone, the `term:` branch is dead —
  remove it rather than leaving an unreachable arm, and keep the prune loop.
- **Empty cold group.** If every cold panel is disabled by host availability, the cold
  group is empty and the anchor has no owner. `#strip-terminals` must then reclaim
  `margin-top: auto` or the team slots float mid-rail.
- **Tooltip stranding.** `hideStripTooltip()` at the top of every rebuild
  (`shell.js:1060`) must survive the refactor; a removed hovered button never fires
  mouseout and the overlay strands beside empty space.
- **`icons` map membership.** Panels with `railHidden` must not be added to the `icons`
  map, or `selectPanel` will try to paint `.is-active` on a button that does not exist.
- **Deep links.** `/#setup`, `/#project`, `/#design` must still select their panel with
  no rail icon present. Test each explicitly.
- **The UFO's dimmed CSS is reused before it is deleted.** `#strip-mission-control.mission-control-dimmed`
  (`shell.html:267`) is the shell's only "inactive, click to start" treatment, and the
  team-slots plan adopts it for dormant slots. Promote it to a panel-agnostic class
  (e.g. `.strip-icon.is-dormant`) **before** deleting the UFO rules, or the team slots
  lose their dim state along with it.
- **`CRITICAL 1` regression guards become obsolete.** Three comments
  (`shell.js:1080`, `:1246`, `renderManifest`) exist solely to keep the UFO alive across
  rebuilds. Delete them with the button rather than leaving guards pointing at nothing.

## Verification plan

1. `npm run compile` clean; existing rail tests updated, not deleted.
2. `src/test/shell-terminal-strip.test.js` — assertions pinning per-terminal buttons and
   the theme toggle will fail. Rewrite them to assert absence. The assertion that
   `headTerm.iconUri` never becomes a team fallback is load-bearing and unrelated —
   preserve it verbatim.
3. Standalone host: `npx` the board, confirm rail reads Kanban / Mission Control / Agent
   Control / Terminals / Linear, then team slots, then Project / Artifacts / Tickets /
   Design at the foot. No theme button. No dock button.
4. Extension host: install the VSIX and confirm the identical rail. `dist/` staleness is
   not in scope (CLAUDE.md).
5. Spawn three ungrouped terminals; confirm zero new rail buttons and that all three are
   present and usable in the Terminals panel.
6. Deep-link each of `/#setup`, `/#memo`, `/#connections` and confirm the panel opens.
7. Confirm `POST /mission-control/start` still answers and the `/switchboard-manage` skill
   path still works after the button is gone — the endpoint outlives its caller here.
8. Grep for `missionControlState`, `ensureMissionControlIcon` and `strip-mission-control`
   and confirm zero live references remain in either host.
