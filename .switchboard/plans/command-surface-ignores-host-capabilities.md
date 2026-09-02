# The command surface is the only browser panel that ignores host capabilities, so it offers controls the host has declared it does not have

## Goal

Make `/command` honour the `data-host-capabilities` contract every other served panel participates in, so a control the host cannot service is not offered on the phone.

### Problem Analysis

`getCommandHtml` (`headlessPanelHtml.ts:529-549`) stamps the full capability object onto the body of every served `/command` page, exactly as it does for the other panels. Fetched from the running standalone host, this workspace's page carries:

```json
{ "terminalDispatch": true,  "automation": false,        "mission-control": false,
  "terminalFleet": true,     "mcpTerminals": false,      "secretsEntry": true,
  "featureManagement": true, "worktrees": true,          "uat": true,
  "boardStructure": false,   "featureAdvanced": false }
```

Four are **false** on this host. The surface honours none of them.

`transport.js` — injected into `/command` via `injectTransportShim` at `:544`, and verified present in the served page — reads that attribute at `:452` and applies gating classes with matching CSS: `caps.automation === false` adds `host-automation-false` and hides `#btn-cli-triggers`, `#btn-remote-control`, `#btn-build-via-planner` and siblings; `mission-control === false` adds `host-mission-control-false` and hides `#btn-mission-control` and `.mission-control-only`; `mcpTerminals`, `worktrees` and `terminalDispatch` gate their own selectors the same way.

Every one of those selectors names an element in `kanban.html` or `terminals.html`. **`command.html` contains zero `host-` occurrences** and none of its elements carry `.mission-control-only` or any other gated class, so the machinery runs on the page and matches nothing. `command.js` never reads `document.body.dataset.hostCapabilities` either — `mission-control.js:6-9` parses it into a `HOST_CAPS` constant, `command.js` has no equivalent.

The visible consequence on this host: the MISSION view is a first-class nav destination with its own rail entry, its own pane and a LAUNCH MISSION button, on a host that has declared `mission-control: false`.

### Root Cause

**Capability gating is expressed as CSS keyed on element ids and classes, and it was never extended to a panel added later.** The mechanism is opt-in by construction — a panel participates by naming its own elements in `transport.js`'s injected stylesheet, or by reading the dataset itself. Nothing asserts that a panel opted in, so a new surface joins the roster fully un-gated and every gate stays green: `transport.js` runs, parses the JSON, adds the body class, and the selector list simply does not mention this document.

This is the same shape as the composition-root divergence `CLAUDE.md` warns about — the trap is not a missing verb, it is a seam nobody wired, where "never wired" and "working" look identical from the outside.

### Why this is not the mission plan

`command-mission-view-composer-is-inert-and-off-spec.md` fixes what the Mission view *does* — a composer the design struck out, whose controls silently early-return because nothing calls `POST /kanban/mission/create`. This plan decides whether that view should be *offered at all* on a given host. They are independent: a host with `mission-control: true` still needs the composer fix, and a host with it false should not show the view even once the composer is fixed.

### Non-goals

- **Do not change any capability's computed value.** The values are the host's to declare; this plan consumes them.
- **Do not hide the nav item for a capability that is true.** Four are false on this host; on the extension host the set differs, and the surface must be correct on both.
- No new capability names.

## Metadata

**Topic:** Command surface honours the host capability contract
**Complexity:** 3
**Tags:** webview, ui, mobile, command-surface, hosts

## User Review Required

None. The capability names and their semantics are already defined by `DEFAULT_HOST_CAPABILITIES` and consumed by two existing panels.

## Complexity Audit

### Routine
- Adding gated classes to the mission nav entries and pane.
- Parsing `data-host-capabilities` in `command.js`, following `mission-control.js:6-9`.

### Complex / Risky
- **Hiding a nav destination changes navigation, not just paint.** `switchView` (`command.js:167-200`) toggles `.active` on `viewPanes[viewName]`; `activeView` defaults to `'dispatch'`. If a gated view is hidden by CSS but still reachable — by a stale `activeView`, or by the tablet rail's separate button set — the operator lands on an invisible pane and the surface looks broken. Gating must remove the destination from the nav sets, not merely hide the pane.
- **Which capability actually governs the Mission view.** `mission-control` gates the Mission Control *panel*; `automation` gates the orchestration buttons. `/command`'s MISSION view drives `/kanban/queue/next` — the queue pop — which is closer to automation than to the Mission Control panel. `transport.js:499-508` has an explicit comment noting that `mission-control` "predates the Mission Control panel" and that "the panel is gated by `automation`" — strong evidence that `automation` is the correct governor. Verify by reading what sets each capability on both hosts (`DEFAULT_HOST_CAPABILITIES` and `TaskViewerProvider baseHostCapabilities`), and gate on that one. Guessing here produces a view that is hidden on the wrong host.
- **Two nav sets.** `phoneNavBtns` and `tabletNavBtns` are separate NodeLists (`:55-56`). Both must be gated, or the tablet rail keeps a destination the phone bar has dropped.

## Edge-Case & Dependency Audit

**Race conditions:** None — capabilities are stamped into the served HTML and are static for the life of the page.

**Security:** None. Capability gating is a UI affordance, not an authorisation boundary; the endpoints enforce their own gates and continue to.

**Side effects:** If every non-Dispatch view were ever gated off on some host, the nav would collapse to one entry. Verify the surface degrades to a usable single-view layout rather than an empty rail.

**Dependencies & conflicts:** Touches the mission nav wiring, which the mission-composer plan also edits. Land after it, so the composer is gone before the view is gated and the two changes do not collide in `renderMissionView`.

## Dependencies

- **`command-mission-view-composer-is-inert-and-off-spec.md`** — restructures the Mission view. Land first; this plan then gates the finished view rather than the composer.

## Adversarial Synthesis

Key risks: (1) gating on `mission-control` when the view is really governed by `automation`, hiding it on the wrong host — mitigation: read both setters on both hosts before choosing, and record the reasoning in a comment; (2) hiding the pane with CSS while leaving the destination reachable, stranding the operator on a blank view — mitigation: gate the nav entries in both NodeLists and assert `switchView` cannot select a gated view; (3) assuming this is cosmetic — a LAUNCH MISSION button on a host with no mission control is a control that cannot work, which is the same defect class as the rest of this feature; (4) adding a `host-command-*` class to `transport.js`'s stylesheet and forgetting `command.html` must carry the matching class — mitigation: verification asserts against the *rendered* page, not the stylesheet.

## Proposed Changes

**1. Read the contract (`command.js`).**

Parse `document.body.dataset.hostCapabilities` into a `HOST_CAPS` constant at init, following `mission-control.js:6-9` verbatim including its `try`/`catch` default of `{}` — an unparseable attribute must degrade to "everything available", never to a blank surface. A MISSING attribute (not just unparseable) must also degrade to all-available: if `dataset.hostCapabilities` is absent, `HOST_CAPS` is `{}` and every view passes the filter. This matches `transport.js:452`'s early-return on `!raw`.

**2. Gate the nav destinations.**

Build `viewPanes` and both nav NodeLists from a declared list of views, each carrying the capability that governs it (Dispatch and Move: none; Mission: the capability determined in the Complexity Audit; Teams: `terminalFleet`). Filter that list by `HOST_CAPS` before wiring. A filtered-out view is removed from `viewPanes` and its buttons from both nav sets, so `switchView` cannot reach it — `if (!viewPanes[viewName]) return;` (`:169`) then already refuses it with no further change.

**3. Default to a view that exists.**

`activeView` is initialised to `'dispatch'` (`:17`). Dispatch is ungated, so this holds — but assert it rather than assume it: on init, if `activeView` is not in the filtered set, fall back to the first available view.

## Verification Plan

1. On the standalone host (`mission-control: false`), open `/command`. The MISSION entry is absent from both the phone nav bar and the tablet rail, and no mission pane is reachable.
2. On the same host, DISPATCH, MOVE and TEAMS are present and fully functional — the gating is surgical, not a blanket hide.
3. On a host where the governing capability is true, MISSION is present and behaves as the mission-composer plan specifies. Confirm by serving the page from the extension host and diffing the rendered `<body>` capability attribute against the standalone one.
4. Corrupt `data-host-capabilities` to invalid JSON in the served page. Every view renders — the surface fails open, not blank.
5. With MISSION gated off, confirm no console error and no empty pane: `switchView('mission')` from the console is refused by the existing `viewPanes` guard.
6. Confirm `TEAMS` disappears on a host with `terminalFleet: false`, and that the surface still lays out correctly with two nav entries.
7. Both hosts: run 1-3 against the VS Code extension and the standalone host — the capability sets genuinely differ between them, which is the entire point of the contract.

### Goal Invariants

- Assert `command.js` reads `document.body.dataset.hostCapabilities` into a `HOST_CAPS` constant (the surface now participates in the capability contract).
- Assert a view whose governing capability is `false` is absent from both `viewPanes` and both nav NodeLists (`phoneNavBtns`, `tabletNavBtns`) — not merely CSS-hidden.
- Assert `switchView('<gated-view>')` returns early (the `viewPanes` guard at `:169` refuses it) — the gated view is unreachable, not just invisible.
- Assert a missing or unparseable `data-host-capabilities` attribute results in all views being available (fail-open, not fail-blank).
- Assert `command.html` or `command.js` contains at least one reference to `hostCapabilities` or `HOST_CAPS` (the surface no longer ignores the contract).

## Completion Summary

Implemented in `src/webview/command.js` only. Added a `HOST_CAPS` constant parsed from `document.body.dataset.hostCapabilities` at IIFE init (following `mission-control.js:6-9`, fail-open to `{}` on missing/unparseable). Declared a `VIEWS` list mapping each view to its governing capability (Dispatch/Move: none; Mission: `automation`; Teams: `terminalFleet`) and filter it by `HOST_CAPS` before wiring — gated views are dropped from `viewPanes` and their nav buttons removed from both `#phone-nav-bar` and `#tablet-rail` before the survivor snapshot, so `switchView`'s existing `viewPanes` guard refuses them. Mission gates on `automation` (not `mission-control`) per `transport.js:499-508` and the queue-pop nature of `/kanban/queue/next`; reasoning recorded in a comment. Added an `activeView` survival assertion in `init()` and dropped the tablet rail's orphaned teams section when Teams is gated, so the rail lays out correctly with two entries.
