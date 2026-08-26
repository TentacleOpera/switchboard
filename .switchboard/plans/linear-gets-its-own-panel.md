# A Linear Panel: Setup, Agent Wiring, And The Instructions To Drive Switchboard From Linear

## Goal

Give Linear its own shell panel in the primary rail group, dedicated to the **link between
Linear and Switchboard**: quick setup and authorisation, the controls that wire the
Switchboard agent to Linear, and the operator instructions for driving the board from a
Linear client. This is not a ticket browser. Linear tickets stay exactly where they are.

### The problem, and the root cause

Linear remote control is one of Switchboard's strongest capabilities and is being
significantly expanded, and every part of *setting it up* is somewhere else, next to
something unrelated:

- **Authorisation and provider config** — Connections → Providers
  (`src/webview/connections.html:309`), beside Hand-offs, Jobs, Web Agents and Docs
  Health.
- **The on/off switch** — `btn-remote-control` in the kanban toolbar
  (`kanban.html:3006`), a 20px icon between "start automation" and "create worktree".
- **The operator instructions** — nowhere. `linear-remote-agent-skill-copy-button.md`
  states it directly: *"There is currently no way for Switchboard to surface this
  information in a usable form. Users must manually piece together their own instructions
  from documentation."* Its target, a "Kanban REMOTE tab", no longer exists — Remote
  Control became Connections (`setup.html:1086`: *"Remote Control is now Connections"*),
  so the plan has no home to land in.

The root cause is that Connections is a panel about *the connecting mechanism* — providers,
hand-offs, jobs, as a class — not about any one destination. That is a legitimate panel.
It is just the wrong shape for a headline integration whose setup has a specific,
sequenced, explainable flow, which is why the expansion work has nowhere to go except as
another tab inside a panel about something else.

## Metadata
- **Complexity:** 6
- **Tags:** frontend, backend, api, ui, ux, feature

## Explicitly out of scope

- **The Tickets panel does not change.** Its `TICKETS` / `CLICKUP` / `LINEAR` tabs
  (`tickets.html:4002-4004`) stay as they are. Linear *issues* are ticket-browsing and
  belong there. Do not move, fork or re-render them.
- **ClickUp connectivity stays in Connections.** Nothing about ClickUp moves, is
  deprecated, or is re-homed by this plan.
- **Connections keeps Hand-offs, Jobs, Web Agents and Docs Health**, and keeps its
  Providers tab for every other provider.

## No migration

Clean break. Linear setup UI relocates; no redirect shims and no preserved deep links to
old tab positions. CLAUDE.md's migration rule is waived for this release. **Existing Linear
authorisation must survive untouched** — this moves where auth is *configured*, not how it
is stored. Do not touch token storage or the OAuth actor path
(`linear-oauth-actor-app-for-per-lead-attribution.md`).

## Scope: both composition roots

A new panel is the highest-divergence-risk change in this set. Required in one diff:
- `headlessPanelHtml.ts` — `getLinearHtml()`, a manifest entry, a `getPanelHtmlById` case,
  a `linear` key on `PanelAvailability`.
- `TaskViewerProvider.ts:4102` — add `linear:` to its `sharedGetPanelsManifest({...})` call.
- `bootstrap.ts:876` — add `linear:` to *its* call.

These two calls already disagree about which keys they pass (`bootstrap.ts` omits
`planning` and `tickets`). Adding the key to one host only yields a panel that is invisible
in the other with every gate green. Diff the two by hand.

## Panel contents

Three sections, in the order an operator meets them:

1. **Connect** — authorisation state and a connect/disconnect action; workspace and team
   selection; the project mapping that decides which Linear project the board syncs with.
   This is the Linear slice of Connections → Providers, presented as a first step rather
   than as a row in a list.
2. **Wire the agent** — the controls that put Switchboard and Linear in contact: the remote
   control on/off state (surfaced here, and left working where it already is in the kanban
   toolbar — one state, two controls, not a second mechanism), and the **generated agent
   instruction text** with a copy action, per
   `linear-remote-agent-skill-copy-button.md`. That plan's key insight is that the text can
   be fully tailored with zero user effort, because sync already guarantees Linear status
   names match Switchboard column names — so the mapping data needed to generate it is
   already on hand. Generate from live mappings; never ship a static blob.
3. **How it works** — the operator instructions, written from the mechanics in
   `.claude/skills/switchboard-remote/SKILL.md`: plans live as Linear issues, status
   changes drive column transitions, the execution-trigger status dispatches the local
   column agent, comments route to that agent and responses are written back, and the
   startup reconciler picks up transitions made while the IDE was closed. Show the user's
   *actual* status names, resolved live — a generic description of a mapping the operator
   cannot see is the documentation gap this section exists to close.

**Open item for the author:** you mentioned "instructions to do all the stuff in the most
recent plans." Name them and I will pin section 3 to their specifics. Candidates I found:
`linear-remote-agent-skill-copy-button.md`,
`missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md`,
`linear-bidirectional-description-sync.md`, `linear-import-epic-linking.md`,
`linear-free-tier-auto-archive-on-completion.md`,
`tracker-labels-select-from-switchboard-registries.md`. Until confirmed, section 3 covers
the remote-control loop above and nothing more.

## Implementation

1. **New panel document** `src/webview/linear.html` + `linear.js`, following the panel
   contract as `connections.html` does: `{{NONCE}}` substitution, transport shim injected
   at `<!-- SHARED_DEFAULTS_SCRIPT -->`, `data-panel="linear"`,
   `data-initial-workspace-root`, `data-host-capabilities`, theme class, `shared-tabs.css`
   tab strip. Copy the CSP from `getConnectionsHtml` (`headlessPanelHtml.ts:489`) — same
   `connect-src` needs.
2. **Manifest entry** `{ id: 'linear', label: 'Linear', icon: nav-linear.svg, route:
   '/linear', group: 'primary' }`, after `terminals`. New icon asset: single-colour SVG,
   because `buildMaskedGlyph` (`shell.js:221`) paints through a CSS mask and multi-colour
   art renders as a solid block.
3. **Move the Linear rows out of Connections → Providers**, leaving every other provider —
   ClickUp included — untouched. If Providers is a generic list rendered from a provider
   registry, exclude Linear from that list rather than special-casing its markup.
4. **Reuse the existing endpoints.** Auth, sync, status-mapping and remote-control
   toggling all have working routes. This panel is a new front end over them; it must not
   introduce a second path to any of them.
5. **Deep link** `/#linear` selects the panel, matching `/#board`, `/#project`, `/#design`,
   `/#setup` (`shell.js:9`).
6. **Cross-panel navigation.** From Linear to the Tickets LINEAR tab ("browse the issues
   themselves") via the shell's existing `postMessage {type:'switchPanel', panel}` bridge
   (`shell.js:9`). Do not add a second bridge.

## Edge cases

- **Unauthorised install must not omit the panel.** `renderManifest` skips disabled panels
  entirely (`shell.js:1412`) on the stated grounds that a dead control reads as broken. But
  an unauthorised Linear panel is exactly where authorising happens — so availability must
  not be derived from auth state. Fail-open (`!== false`), like every optional panel except
  Terminals, and render a connect empty state.
- **Two surfaces showing remote-control state.** This panel and `btn-remote-control` in the
  kanban toolbar must read one source and both reflect a change made in the other. The WS
  broadcast rail already carries this class of state; use it rather than local copies.
- **Generated instruction text drifts.** It is generated from live mappings, so it changes
  when mappings change. Never cache it across a mapping change, and never persist a copy
  the operator might paste after it has gone stale.
- **Status names are user data.** They arrive from Linear and are rendered into
  instructions. `textContent`, never `innerHTML`.
- **`getPanelHtmlById` default arm.** A missing `case 'linear'` 404s the route while the
  rail icon still renders. Manifest entry and case land in the same commit.
- **Linear MCP authorisation is separate** from Switchboard's Linear auth, and cannot be
  performed from a non-interactive session. The panel must not conflate the two or imply
  one grants the other.

## Verification plan

1. `npm run compile` clean.
2. Rail shows Linear in the primary group in **both** hosts — then re-read
   `TaskViewerProvider.ts:4102` and `bootstrap.ts:876` side by side and confirm both pass
   the key.
3. `/linear` serves directly; `/#linear` selects from the shell.
4. **Tickets panel is byte-for-byte unaffected:** TICKETS, CLICKUP and LINEAR tabs all
   present and fully functional.
5. **Connections is unaffected except for Linear's rows:** ClickUp connectivity works,
   Hand-offs / Jobs / Web Agents / Docs Health all intact.
6. An existing Linear authorisation still works after the move — no re-auth required.
7. Unauthorised install: panel renders its connect empty state, is not omitted, and
   authorising from it succeeds end to end.
8. Toggle remote control in the kanban toolbar; confirm the Linear panel reflects it, and
   the reverse.
9. Copy the generated agent instruction text; confirm it contains the operator's actual
   status names, and that changing a mapping changes the text.
10. Theme under both `theme-claudify` and `cyber-theme-enabled`.
