# Surface a Build Target in Agent Control

## Goal

Give the operator one place — Agent Control — to see and choose **where a build runs**: this box, a
desktop over SSH, or GitHub Actions. And whichever it is, the reviewer is told the result for **the
commit it was handed**.

### Correcting the previous framing

This plan replaces `the-pi-cannot-build-so-ci-should-and-the-reviewer-should-read-it.md`, whose title
claimed *"The Pi Cannot Build"* and whose goal was *"The board host never compiles anything."* Both
are false, and measurably so: this Pi 400 built the site repeatedly on 2026-09-09/10 in **14–34
seconds**. What is true is narrower — some builds are slow or memory-hungry here, and whether that is
acceptable is the operator's call, not the plan's.

So the deliverable is not offloading. It is **a visible, chosen target**, with the offload as one of
its options.

### Problem analysis

- **There is nowhere to express the choice.** Agent config today lives in `setup.html`
  (`startupCommands`) and the sidebar (`implementation.html`); neither says anything about where a
  build runs. The operator's only lever is which machine they happen to be sitting at.
- **The reviewer is the consumer that actually matters.** A reviewer handed a commit needs to know
  whether that commit builds and passes. Today nothing connects a build result to the commit a
  reviewer was dispatched, wherever the build happened.
- **The calculus is about to change.** `The Webpack Build Has No Cache, Type-Checks Everything Twice,
  and Always Rebuilds` is in the same feature. If it lands, local builds get materially faster and the
  case for offloading weakens — which is another reason to make the target a choice rather than bake
  one in.

## Metadata

**Complexity:** 4
**Tags:** ci, agents, ux, performance
**Project:** Browser Switchboard
**Dependencies:** `agent-control-becomes-its-own-panel` — that panel is the surface this control lives
on, so it lands first. Feature-mate: the webpack build-cache plan, which should be sequenced first
because it changes whether offloading is wanted at all.

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a build-target dropdown to the Agent Control panel markup — one control, three values.
- Persisting the operator's choice (existing settings/state infrastructure).
- Displaying the last build duration per target.

### Complex / Risky

- **Build-result-to-commit-SHA mapping.** The plan requires "a build result recorded against the commit SHA" and a reviewer "given the result for the commit it holds." The storage mechanism and the injection path into the reviewer prompt are not yet specified — a coder must design where results are stored (kanban DB? a sidecar file?) and how the reviewer dispatch reads them. This is the load-bearing implementation decision.
- **Standalone/extension parity.** Agent Control is served by both hosts (the standalone host serves the same webview HTML), but build execution on a remote target (SSH, GitHub Actions) requires backend wiring. Both composition roots (`extension.ts` and `standalone/bootstrap.ts`) must wire the build-target execution seam, or the control is a no-op in one host — the exact "never wired and working are the same value" trap from AGENTS.md.
- **Honest unavailability detection.** Probing whether the desktop is reachable or Actions is configured must happen at the point of choice, not silently fall back at the point of build. A target that falls back silently is worse than one that refuses (AGENTS.md fallback rule).

## Edge-Case & Dependency Audit

- **Race Conditions:** A build running on a remote target while the operator switches targets mid-build — the in-flight build should complete or be explicitly cancelled, not silently orphaned.
- **Security:** SSH and GitHub Actions credentials are required for the remote targets. These must go through the existing SecretStorage / encrypted-secrets store, not be stored in plaintext config. The standalone host already wires `encryptedSecretsStore` (`bootstrap.ts:5049`) — the extension host must wire the same.
- **Side Effects:** Triggering a GitHub Actions build has real-world side effects (consumes Actions minutes, triggers webhooks). The control must make this visible before the operator commits to it, not after.
- **Dependencies & Conflicts:** Depends on `agent-control-becomes-its-own-panel` landing first — the control lives on that panel. If the extraction has not landed, the control would need to go into `kanban.html`'s Agent Control tabs temporarily, which is wasted work. Feature-mate: the webpack build-cache plan should land first because it changes whether offloading is wanted at all.
- **Standalone parity:** Both hosts serve the Agent Control webview, but the build-execution backend (SSH dispatch, Actions trigger, result polling) must be wired in both `extension.ts` and `standalone/bootstrap.ts`. The control without the execution seam is a UI that does nothing — indistinguishable from a working control that has not been wired, per AGENTS.md.

## Dependencies

- `agent-control-becomes-its-own-panel` (feature) — the panel this control lives on. All three subtasks are in PLAN REVIEWED. Must land before this plan's UI work begins.
- Feature-mate: webpack build-cache plan — should land first; it changes whether offloading is wanted at all.

## Adversarial Synthesis

Key risks: the build-result-to-commit-SHA storage and reviewer-injection path are unspecified — a coder must design them, and a wrong design silently gives the reviewer "the last build" instead of "the build for their commit"; standalone/extension parity is not addressed — the control could be a no-op in one host; honest unavailability detection must not silently fall back. Mitigations: the plan's own verification covers the reviewer-receives-correct-commit check; the Edge-Case audit flags the parity gap; the AGENTS.md fallback rule governs the unavailability design.

## Proposed Changes

### 1. A build-target control in Agent Control

- **Logic:** one setting, three values — `this box`, `desktop over SSH`, `GitHub Actions` — shown with
  the current choice and, where known, the last build's duration on that target. Duration is what makes
  the choice informed rather than a guess.
- **Default `this box`.** It works; it is simply sometimes slower. This preserves the status quo — every build runs locally today — so the default does not change behaviour, it makes the existing behaviour explicit and visible.
- **Clarification (implied by requirement):** the setting persists via the existing agent-config state path (the same store `startupCommands` uses). The standalone host must read the same store.

### 2. The reviewer is told the result for their commit

- **Logic:** a build result is recorded against the commit SHA, and a reviewer dispatched that commit
  is given the result. Not "the last build" — the build for the commit it holds, or an explicit "not
  built yet".
- This is the half of the old plan worth keeping, and it holds regardless of which target is chosen.
- **Clarification (implied by requirement):** the build result is stored keyed by commit SHA — either in the kanban DB (a new table or a column on the plan/card) or a sidecar JSON. The reviewer dispatch path (`generateUnifiedPrompt` / `_cardsToPromptPlans` in `KanbanProvider.ts`) reads the result for the commit SHA and injects it into the reviewer prompt. A coder must choose the storage location and wire the read; both hosts must serve the same data.

### 3. Honest reporting when a target is unavailable

- **Logic:** if the desktop is unreachable or Actions is not configured, say so at the point of choice,
  not at the point of build. A target that silently falls back is worse than one that refuses.
- **Clarification (implied by requirement):** unavailability is probed when the control renders (or when the operator selects a target), not when a build is dispatched. The probe for SSH is a connection test; for Actions it is a credentials/config check. A failed probe shows an explicit "unavailable" state on the target option, not a silent revert to `this box`.

## Verification Plan

- The control appears in Agent Control, persists its choice, and shows the last duration per target.
- A reviewer dispatched commit X receives the build result for X, or an explicit not-built.
- Selecting an unreachable target reports that immediately.
- Default remains `this box`, and a build on it succeeds — the Pi is a valid target, not a fallback.
- The control and its build-execution backend work in **both** the extension host and the standalone host (parity check).

### Goal Invariants

- **Positive:** The Agent Control panel contains a build-target control with exactly three options: `this box`, `desktop over SSH`, `GitHub Actions`.
- **Positive:** The operator's choice persists across panel reopens and board restarts.
- **Positive:** A reviewer dispatched commit SHA `X` receives the build result for `X` (not the latest build result for a different SHA), or an explicit "not built yet."
- **Positive:** Selecting an unreachable target displays an "unavailable" indicator at the point of choice, before any build is dispatched.
- **Negative:** The build-target control does NOT silently fall back to `this box` when a remote target is selected but unavailable — it reports the unavailability.

## Outstanding Questions

- **[user]** Should the target be per-workspace or per-team? Per-team allows a heavy repo to offload while a light one stays local, but it is another dimension to configure. — proceeding on the assumption that the target is per-workspace, matching the granularity of `startupCommands` and the existing agent-config state.
- **[user]** Which type-gate mechanism covers `npm run package` and `npm run watch` after `transpileOnly` is enabled in the webpack feature-mate? — proceeding on the assumption that `fork-ts-checker-webpack-plugin` is attached to both configs (see webpack plan's Outstanding Questions).
