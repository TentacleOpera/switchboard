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
**Tags:** ci, agents, ux, reviewer
**Dependencies:** `agent-control-becomes-its-own-panel` — that panel is the surface this control lives
on, so it lands first. Feature-mate: the webpack build-cache plan, which should be sequenced first
because it changes whether offloading is wanted at all.

## User Review Required

None.

## Proposed Changes

### 1. A build-target control in Agent Control

- **Logic:** one setting, three values — `this box`, `desktop over SSH`, `GitHub Actions` — shown with
  the current choice and, where known, the last build's duration on that target. Duration is what makes
  the choice informed rather than a guess.
- **Default `this box`.** It works; it is simply sometimes slower.

### 2. The reviewer is told the result for its commit

- **Logic:** a build result is recorded against the commit SHA, and a reviewer dispatched that commit
  is given the result. Not "the last build" — the build for the commit it holds, or an explicit "not
  built yet".
- This is the half of the old plan worth keeping, and it holds regardless of which target is chosen.

### 3. Honest reporting when a target is unavailable

- **Logic:** if the desktop is unreachable or Actions is not configured, say so at the point of choice,
  not at the point of build. A target that silently falls back is worse than one that refuses.

## Verification Plan

- The control appears in Agent Control, persists its choice, and shows the last duration per target.
- A reviewer dispatched commit X receives the build result for X, or an explicit not-built.
- Selecting an unreachable target reports that immediately.
- Default remains `this box`, and a build on it succeeds — the Pi is a valid target, not a fallback.

## Outstanding Questions

- Should the target be per-workspace or per-team? Per-team allows a heavy repo to offload while a light
  one stays local, but it is another dimension to configure.
