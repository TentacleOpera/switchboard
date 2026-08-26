# Linear Gets Its Own Panel; Connections Keeps The Grab Bag

## Goal

Promote Linear to a first-class shell panel with its own rail icon in the primary group,
consolidating the Linear surfaces currently scattered across two other panels. Connections
stays as the multi-provider grab bag and moves to the top-right cluster.

### The problem, and the root cause

Linear is one of Switchboard's strongest integrations and is being significantly expanded,
but it has no home. It is currently spread across:

- **Tickets panel, LINEAR tab** (`src/webview/tickets.html:4004`) — sharing a tab strip
  with TICKETS and CLICKUP, so Linear is one third of a panel whose rail icon says
  "Tickets".
- **Connections panel, Providers tab** (`connections.html:309`) — provider config and
  auth, beside Hand-offs, Jobs, Web Agents and Docs Health.

So the two halves of one integration sit behind two different rail icons, neither of which
is named Linear, and the expansion work has nowhere to land except by growing a tab inside
a panel about something else.

The root cause is that Connections was built as a panel about *the connecting mechanism*
(providers, hand-offs, jobs) rather than about any particular destination. That is a
reasonable panel — it is just not where a headline integration should live. Its five tabs
are five unrelated concerns, which is why it reads as a grab bag.

## Metadata
- **Complexity:** 7
- **Tags:** frontend, backend, api, ui, feature

## No migration

Clean break. Tabs move, no redirect shims, no preserved deep links to the old tab
positions. CLAUDE.md's migration rule is waived for this release. Linear auth *tokens* are
not in scope and must not be touched — moving where auth is configured must not
invalidate an existing authorisation.

## Scope: both composition roots

A new panel is the highest-risk change in this set for host divergence. Required in the
same diff:
- `headlessPanelHtml.ts` — `getLinearHtml()`, a manifest entry, a `getPanelHtmlById` case,
  and a `linear` key on `PanelAvailability`.
- `TaskViewerProvider.ts:4102` — add `linear:` to the `sharedGetPanelsManifest({...})` call.
- `bootstrap.ts:876` — add `linear:` to *its* `sharedGetPanelsManifest({...})` call.

These two calls already disagree about which keys they pass (`bootstrap.ts` omits
`planning` and `tickets`). Adding the key to one and not the other yields a panel that
exists in one host and is invisible in the other, with every gate green. Diff the two
calls by hand.

## Implementation

1. **New panel document** `src/webview/linear.html` + `linear.js`, following the
   established panel contract exactly as `connections.html` does: `{{NONCE}}`
   substitution, the transport shim injected at `<!-- SHARED_DEFAULTS_SCRIPT -->`,
   `data-panel="linear"`, `data-initial-workspace-root`, `data-host-capabilities`, the
   theme class, and the `shared-tabs.css` tab strip. Copy the CSP string from
   `getConnectionsHtml` (`headlessPanelHtml.ts:489`) — same `connect-src` needs.
2. **Move the LINEAR tab out of Tickets.** Tickets keeps TICKETS and CLICKUP. Move the
   Linear tab's markup, styles and its slice of `tickets.js` wholesale — do not fork it.
   Where Linear and ClickUp share helpers (they are adjacent in several plans, e.g.
   `clickup-linear-detail-ui-compact.md`), extract the shared part rather than duplicating
   it; two divergent copies of ticket-detail rendering is the predictable failure here.
3. **Move Linear provider config out of Connections.** Connections keeps Providers for
   everything else, Hand-offs, Jobs, Web Agents, Docs Health. Linear's provider row,
   auth/connect UI and project picker move into the new panel. The auth *endpoints* and
   token storage are unchanged — this is a UI relocation only.
4. **Manifest.** Add `{ id: 'linear', label: 'Linear', icon: nav-linear.svg, route:
   '/linear', group: 'primary' }` positioned after `terminals`. New icon asset required:
   a single-colour SVG that works through `buildMaskedGlyph`'s CSS mask
   (`shell.js:221`) — multi-colour art will render as a solid block.
5. **Connections moves to the top-right cluster** — it keeps its panel, route and frame
   and loses its rail icon (`railHidden`, per the rail restructure plan).
6. **Deep link** `/#linear` must select the panel, matching the existing
   `/#board`, `/#project`, `/#design`, `/#setup` behaviour (`shell.js:9`).

## Edge cases

- **Availability fail-closed or fail-open?** Every other optional panel except Terminals
  uses `!== false` (fail-open); Terminals uses `=== true` (fail-closed) because node-pty
  may be absent. Linear has no native dependency, so fail-open matches its peers — but
  choose deliberately and comment it.
- **Panel disabled means omitted, not greyed.** `renderManifest` skips disabled panels
  entirely (`shell.js:1412`) on the stated grounds that a dead control reads as broken.
  A Linear panel with no authorisation configured must therefore render an *empty state
  with a connect action*, not be omitted — otherwise an unauthorised install has no path
  to authorising.
- **Two panels reading the same provider state.** Connections' remaining Providers tab and
  the new Linear panel may both display Linear connection status. Either the Providers tab
  drops Linear's row entirely, or both read one source. Do not let them hold separate
  copies of connection state.
- **Cross-panel navigation.** Tickets may need to hand off to Linear (a ticket that is a
  Linear issue). The shell already brokers `postMessage {type:'switchPanel', panel}`
  (`shell.js:9`) — reuse it, do not add a second bridge.
- **`getPanelHtmlById` default arm.** Missing the `case 'linear'` returns null and the
  route 404s while the rail icon still renders. Add the case and the manifest entry in one
  commit.
- **Linear MCP authorisation is separate.** The Linear MCP server requires its own OAuth
  and cannot be authorised from a non-interactive session. Panel work must not assume MCP
  availability.

## Verification plan

1. `npm run compile` clean.
2. Rail shows Linear in the primary group in both hosts. Then explicitly re-read
   `TaskViewerProvider.ts:4102` and `bootstrap.ts:876` side by side and confirm both pass
   the `linear` key.
3. `/linear` serves the panel directly; `/#linear` selects it from the shell.
4. Every function that worked in the Tickets LINEAR tab works in the new panel: project
   picker, import, issue detail, bidirectional description sync.
5. Tickets panel: TICKETS and CLICKUP intact, no dead Linear code paths, no console errors.
6. Connections panel: four remaining tabs intact, reachable from the top-right cluster,
   no Linear remnants and no duplicated connection state.
7. **An existing Linear authorisation still works after the move** — do not require
   re-auth.
8. Unauthorised install: Linear panel renders its connect empty state rather than being
   omitted from the rail.
9. Theme both panels under `theme-claudify` and `cyber-theme-enabled`.
