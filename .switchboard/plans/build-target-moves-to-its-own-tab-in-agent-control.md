# Build Target Moves to Its Own Tab in Agent Control

## Goal

Move the **Build Target** subsection out of the AGENTS tab and into a tab of its own in the Agent
Control panel, so the agents surface carries only the controls the operator reaches for often.

### Problem analysis

- **It sits on top of the important controls.** The Build Target block is the *first* subsection in
  `#agents-tab-content` (`agent-control.html:3004-3040`), above Agent Visibility & CLI Commands, the
  machine bar, and the agent list. It is a set-once-and-forget setting — the operator picks a target,
  maybe fills in an SSH host, and never returns — yet it occupies the most valuable position in the
  panel.
- **It adds nothing where it is.** The section does not interact with anything else on the AGENTS
  tab: it has its own verbs (`getBuildTarget`, `saveBuildTarget`, `saveBuildTargetConfig`), its own
  render function, and its own hydration post (`agent-control.js:2576`). Nothing else on the tab
  reads `buildTargetState`.
- **The tab machinery already exists.** The panel's tab bar (`agent-control.html:2992-2997`) is
  generic: a `data-tab` button plus a `#<name>-tab-content` div, switched by one click handler
  (`agent-control.js:2554-2613`), with per-tab hydration arms. STANDING ORDERS was added the same
  way. This plan is a move, not a mechanism.

## Metadata

**Feature:** 2b621be1-366c-4bf5-8aaf-183c3f852742 (Agent Control becomes its own panel — same
feature as `surface-a-build-target-in-agent-control`)
**Complexity:** 2
**Tags:** ux, agents
**Project:** Browser Switchboard
**Dependencies:** None — the panel and the section both already exist.

## User Review Required

None. (Operator directed this plan on 2026-09-19: "move it into its own tab in the agents-control
panel so it doesn't clutter the important controls.")

## Complexity Audit

### Routine

- Adding a fifth tab button and tab-content div — the pattern is established four times over.
- Moving the existing `db-subsection` markup verbatim — all element ids are unchanged, so
  `renderBuildTarget()` and its event listeners need no modification.
- Moving the `getBuildTarget` hydration post from the `agents` arm to a `build` arm.

### Complex / Risky

- **Persisted active-tab validation.** `AGENT_CONTROL_TABS` (`agent-control.js:2619`) is the
  allowlist for the persisted `activeTab` restore. If `build` is not added, a workspace that left
  the panel on the new tab silently restores to AGENTS — a quiet wrong answer, per the fallback
  rule. The new id must be added to the array, not just the markup.
- **Reconnect healing.** The `buildTarget` state arrives as a push answering `getBuildTarget`; if
  the socket was down at activation the tab would sit on stale state until a manual switch. The
  STANDING ORDERS tab already solved this with `sbTransportReconnected` (`agent-control.js:3199`);
  the build tab needs the same arm or it regresses below the panel's own standard.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new — tab switching is synchronous and `renderBuildTarget()` is
  idempotent against the last-received `buildTarget` message.
- **Security:** None — no new verbs, no new data, no markup that did not already exist.
- **Side Effects:** None — the same messages flow; only the tab that triggers `getBuildTarget`
  changes.
- **Dependencies & Conflicts:** Edits `agent-control.html` and `agent-control.js` only. Any plan
  touching the tab bar or the AGENTS tab markup in flight will conflict textually but not
  semantically.
- **Standalone parity:** Both composition roots serve the same `agent-control.html` file, so the
  markup change reaches both hosts with **no host-side diff**. Verification is still both-hosts:
  open the panel in the extension host and in standalone and confirm the tab exists and hydrates —
  the failure mode (tab present in one host) cannot occur by construction, but the standing rule is
  that parity is verified, not inferred.

## Dependencies

None.

## Adversarial Synthesis

The plan is a cut-and-paste of markup plus three small JS edits, and every risk listed is a place
where "looks done" and "is done" diverge: the tab renders even if `AGENT_CONTROL_TABS` was not
updated (restore just falls back), and the tab hydrates even if the reconnect arm was forgotten
(the first activation works; only a mid-session host restart exposes it). Mitigation is naming
both edits as required scope and giving each a verification step, below.

## Proposed Changes

### 1. A fifth tab, last in the bar

- **Markup:** add `<button class="shared-tab-btn" data-tab="build">BUILD</button>` to
  `.shared-tab-bar` after STANDING ORDERS, and a new
  `<div id="build-tab-content" class="shared-tab-content">` with the same inner padding wrapper the
  other tabs use.
- **Position is deliberate — last.** The tab bar orders by frequency of use; a set-once control
  goes last, which is the whole point of the move. Label `BUILD` (short, matches the one-word
  style); the section header inside already says "Build Target".
- **Move, don't copy:** lift the entire Build Target `db-subsection` (the comment block included,
  `agent-control.html:3004-3040`) into the new tab. AGENTS keeps Agent Visibility & CLI Commands,
  the machine bar, and the agent list — nothing else changes on it.

### 2. Wire the tab like the others

- Add `'build'` to `AGENT_CONTROL_TABS` so a session that ended on it restores to it.
- Move `postKanbanMessage({ type: 'getBuildTarget' })` out of the `agents` hydration arm into a new
  `if (tabName === 'build')` arm — the section's data should be fetched when its own tab activates,
  not the tab it left.
- Update the now-stale "simplified: 4 tabs" comment at `agent-control.js:2554`.
- Extend the `sbTransportReconnected` handler: when the active tab is `build`, re-post
  `getBuildTarget` (same shape as the standing-orders arm at `agent-control.js:3199`).

### 3. No host-side changes

- No new verbs, no provider changes, nothing in `extension.ts` or `standalone/bootstrap.ts`. The
  five existing build-target verbs already return everything the moved section renders.

### Out of scope

- The deferred NIT from the original plan's review — the select displaying "this box" when no
  target was ever chosen (`agent-control.js:3477`) — is a display/logic fix, not a move. A coder
  may note it but this plan does not require it.

## Verification Plan

- The tab bar shows five tabs; BUILD is last.
- AGENTS renders without the Build Target block; BUILD renders with it, and the select, status
  line, durations, and per-target config blocks all behave identically to before the move.
- `buildTargetState` hydrates on BUILD activation (select value, availability labels, durations
  populate without a reload).
- Persist `activeTab: 'build'`, reload the panel — it restores to BUILD, not AGENTS.
- Kill the transport while on BUILD, reconnect — the section re-hydrates without a manual switch.
- Open Agent Control in **both** the extension host and the standalone host; the tab exists and
  works in each.

### Goal Invariants

- **Positive:** `.shared-tab-bar` contains a `data-tab="build"` button, positioned after
  `data-tab="standing-orders"`.
- **Positive:** `#agents-tab-content` contains no element with id prefix `build-target-`.
- **Positive:** `#build-tab-content` contains `build-target-select`, `build-target-status`,
  `build-target-durations`, `build-target-config-ssh`, and `build-target-config-actions`.
- **Positive:** `AGENT_CONTROL_TABS` contains `'build'`, and `getBuildTarget` is posted from the
  `build` activation arm, not the `agents` arm.
- **Negative:** `extension.ts` and `standalone/bootstrap.ts` are untouched — there is nothing to
  wire.

## Outstanding Questions

- None. Label choice (`BUILD` vs `BUILD TARGET`) is left to the coder; either satisfies the
  invariants.
