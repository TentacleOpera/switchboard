# Remote-Control Provider Exclusivity Is Unenforced and Undisclosed

## Goal

Disclose that selecting one remote-control provider disables the other, so a silent switch stops looking like a broken integration.

### Problem analysis

`connections.js:266-268` preserves a stored `linear` but writes `clickup` when the select says so. `linear.js:188` writes `provider: 'linear'` unconditionally. Neither panel reads the other's provider, and neither warns.

So picking ClickUp in Connections silently disables Linear remote control, with nothing on the Linear panel saying so. The user's next observation is that Linear remote control is broken.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 3
**Tags:** bugfix, ux

## User Review Required

**Yes, lightly — a disclosure decision more than a bug fix.** Whether the product should *prevent* the switch or merely disclose it is the author's call; this plan assumes disclose.

## Proposed Changes

### `connections.js:266-268` and `linear.js:188`
- **Logic:** each panel reads the effective provider and discloses when the other is disabled.
- **Edge case:** per CLAUDE.md this is disclosure, not a confirm gate — no dialog, no two-click pattern.

## Verification Plan

### Goal Invariants

1. Selecting ClickUp in Connections surfaces that Linear remote control is disabled, and the Linear panel discloses the same. *(Paired: with only one provider configured, no disclosure appears.)*
