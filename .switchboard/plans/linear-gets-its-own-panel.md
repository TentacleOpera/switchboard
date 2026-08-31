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
- **Feature:** 4c1323fb-a025-467f-b289-88f50b1f8347

## Explicitly out of scope

- **The Tickets panel does not change.** Its `TICKETS` / `CLICKUP` / `LINEAR` tabs
  (`tickets.html:4002-4004`) stay as they are. Linear *issues* are ticket-browsing and
  belong there. Do not move, fork or re-render them.
- **ClickUp connectivity stays in Connections.** Nothing about ClickUp moves, is
  deprecated, or is re-homed by this plan.
- **Connections keeps Hand-offs, Jobs, Web Agents and Docs Health**, and keeps its
  Providers tab for every other provider.

## User Review Required

No user review required — plan is in PLAN REVIEWED status and ready for dispatch. The open item about "instructions to do all the stuff in the most recent plans" (section 3 scope) is flagged in the plan body and does not block dispatch — section 3 covers the remote-control loop and nothing more until confirmed.

## Complexity Audit

### Routine
- Creating `src/webview/linear.html` + `linear.js` following the panel contract (CSP, nonce, transport shim, theme class, tab strip).
- Adding a manifest entry `{ id: 'linear', label: 'Linear', icon: nav-linear.svg, route: '/linear', group: 'primary' }`.
- Adding a `getPanelHtmlById` case for `'linear'`.
- Deep link `/#linear` selects the panel.
- Cross-panel navigation via existing `postMessage {type:'switchPanel', panel}` bridge.

### Complex / Risky
- Composition-root wiring — the highest-divergence-risk change in the set. Must add `linear:` to both `TaskViewerProvider.ts:4102` and `bootstrap.ts:876` in the same diff. These two calls already disagree (bootstrap omits `planning` and `tickets`); add `linear` to both regardless and flag the pre-existing divergence for a separate fix.
- Moving Linear rows out of Connections → Providers — if Providers is a generic list rendered from a provider registry, exclude Linear from that list rather than special-casing its markup. Must not break ClickUp connectivity or Hand-offs/Jobs/Web Agents/Docs Health.
- Generated instruction text from live mappings — never cache across a mapping change, never persist a copy. Status names are user data: `textContent`, never `innerHTML`.
- Unauthorised install must not omit the panel — fail-open (`!== false`), like every optional panel except Terminals. An unauthorised Linear panel is exactly where authorising happens.
- Two surfaces showing remote-control state (this panel + `btn-remote-control` in kanban toolbar) — must read one source and both reflect a change made in the other. Use the WS broadcast rail, not local copies.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Two surfaces toggling remote control: if both are clicked simultaneously, the WS broadcast rail serialises the state change. Verify convergence rather than special-casing.

**Security:**
- Linear MCP authorisation is separate from Switchboard's Linear auth. The panel must not conflate the two or imply one grants the other.
- Status names arrive from Linear and are rendered into instructions: `textContent`, never `innerHTML` — XSS guard.

**Side Effects:**
- Connections panel loses its Linear rows but keeps every other provider. ClickUp connectivity, Hand-offs, Jobs, Web Agents, Docs Health all intact.
- Tickets panel is byte-for-byte unaffected: TICKETS, CLICKUP, LINEAR tabs all present and functional.
- `btn-remote-control` in the kanban toolbar stays — one state, two controls, not a second mechanism.

**Dependencies & Conflicts:**
- **Rail restructure** — provides the `group: 'primary'` key and the primary rail slot for Linear. The Linear panel takes the primary slot the restructure reserves for it.
- **Pre-existing divergence** — `bootstrap.ts:876` omits `planning` and `tickets`. This is out of scope; add `linear` to both calls and flag the divergence separately.

## Dependencies

- **Rail restructure** — must have declared the `group: 'primary'` key. The Linear manifest entry uses `group: 'primary'`; without the restructure, the manifest type does not have the `group` field.
- Independent of all other subtasks — the Linear panel shares only its manifest entry with the rail restructure. It can proceed in parallel once the group key exists.

## Adversarial Synthesis

Key risks: (1) composition-root divergence — `bootstrap.ts` already omits `planning` and `tickets`; adding `linear` to a known-incomplete call is adding to a broken call. Flag the pre-existing divergence as out of scope; add `linear` to both regardless. (2) Unauthorised install must not omit the panel — fail-open, not fail-closed, or the panel where authorising happens is invisible. (3) Generated instruction text drift — generated from live mappings, so it changes when mappings change; never cache or persist. (4) Two surfaces showing remote-control state — must converge via WS broadcast, not local copies. Mitigations: (1) flag divergence, (2) plan specifies fail-open, (3) plan says "never cache across mapping change," (4) plan says "use WS broadcast rail."

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

### Goal Invariants

- Assert `src/webview/linear.html` exists and follows the panel contract (nonce, CSP, transport shim, theme class, tab strip).
- Assert `src/webview/linear.js` exists.
- Assert `getPanelsManifest` in `src/services/headlessPanelHtml.ts` includes an entry with `id: 'linear'` and `group: 'primary'`.
- Assert `getPanelHtmlById` in `src/services/headlessPanelHtml.ts` has a `case 'linear'`.
- Assert `linear` availability key is passed in both `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts`.
- Assert `/linear` route serves the panel document.
- Assert `/#linear` deep link selects the panel.
- Assert the Tickets panel's LINEAR tab is present and functional (byte-for-byte unaffected).
- Assert Connections panel's ClickUp connectivity, Hand-offs, Jobs, Web Agents, and Docs Health are intact.
- Assert an unauthorised install renders the Linear panel (fail-open, not omitted).
- Assert `btn-remote-control` in the kanban toolbar and the Linear panel both reflect remote-control state changes (one source, two controls).
- Assert generated instruction text uses `textContent` for status names (never `innerHTML`).

## Implementation Summary

Created dedicated Linear panel webview assets (`src/webview/linear.html`, `src/webview/linear.js`, `icons/nav-linear.svg`) with Connect, Wire Agent, and How It Works tabs. Wired `getLinearHtml` in `src/services/headlessPanelHtml.ts`, mounted `/linear` and `/linear/verb/*` endpoints in `src/services/LocalApiServer.ts`, and updated verb routing and scrollbar contract tests. Cleaned up vestigial Linear controls and skill-copy button rows from `src/webview/connections.html` and `src/webview/connections.js` while keeping Notion and ClickUp fully functional. Verified full test suites pass with standalone push-parity confirmed.


## Review Findings

Reviewed against commit 8a77aa1f. The panel document, manifest entry (`group: 'primary'`), `getPanelHtmlById` case, `/linear` route and `/linear/verb/*` dispatch all land in one diff; `linear: true` is passed in BOTH composition roots (`TaskViewerProvider.ts:4191`, `bootstrap.ts:1014` — which also picked up the pre-existing `planning`/`tickets` omission); availability is fail-open; every verb `linear.js` posts resolves in `SETUP_VERBS` or `TICKETS_VERBS`; status names render via `textContent`. One CRITICAL and two MAJOR defects fixed. CRITICAL: `case 'remoteConfig'` passed `msg.payload` to `renderRemoteConfig`, but `remoteGetConfigPayload` returns a FLAT message (`{type, config, boardKeys, workspaces, active, capabilities}`) with no such wrapper — the workspace dropdown and board list rendered empty and the remote-control button was pinned to "Start", defeating this plan's own one-source-two-controls invariant. MAJOR: Connections coerced any stored `provider` to `notion`/`clickup` on both read and write while autosaving on every field change, so an unrelated Connections edit silently retargeted a Linear remote-control config at Notion; the stored `linear` provider is now preserved and named in the section title. MAJOR: `connections-routing-contract.test.js` pinned `btn-copy-linear-agent-skill` and the `linearAgentSkillText` handler in Connections and was left red by the move; it now tracks the control at its new home instead. Files changed: `src/webview/linear.js`, `src/webview/connections.js`, `src/test/connections-routing-contract.test.js`. Validation: `test:contract:connections-routing` 15/15, `test:contract:panel-scrollbars` 55/55, `test:contract:browser-panel-verb-routing` 16/16.

## Deferred Findings

- MAJOR `src/webview/linear.js:188` and `src/webview/connections.js:262` — one `remoteConfig` key has two editors and the provider field is exclusive, so the panels remain capable of overwriting each other's provider through paths other than the one fixed here (e.g. an operator switching Connections to ClickUp silently disables Linear remote control with no warning on the Linear panel). The exclusivity is still not enforced in code.
- NIT `src/webview/linear.js:283` — `requestLinearAgentSkill()` is fired on every `remoteConfig` push as well as on load, so a rapid sequence of config saves issues repeated skill-text builds.
- NIT `src/webview/linear.js:355` — the "browse the issues" button posts BOTH the shell `switchPanel` bridge and the `openTicketsPanel` verb; in the extension host both fire.
