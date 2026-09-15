# Nothing Checks or Surfaces Tailscale ACL Posture

## Goal

Surface whether tailnet ACLs actually narrow who can reach a terminal surface, so the operator can tell an open tailnet from a scoped one.

### Problem analysis

The tailnet listener trusts every peer by design, so ACLs are the only thing narrowing who reaches a terminal surface — and nothing in the product reads, checks or reports them.

Verified 2026-09-15: a word-boundary search for `\bacl\b` across `src/` returns **nothing**. (A naive `grep -i acl` returns 19 hits, all substring noise — `aCl` from camelCase and `acl` inside longer words. The naive form is what makes this look handled.)

This feature's existing subtasks cover MagicDNS, the Host header, secure origin, the spent token and CSRF. None covers ACL posture.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Feature:** 1543a9dc-158a-43c1-a7ac-e9aac94d9ca7
**Complexity:** 4
**Tags:** security, infrastructure

## User Review Required

No — that the posture should be *visible* is not in question. Whether the board should refuse to serve on an open tailnet is a separate decision and is deliberately not proposed here.

## Proposed Changes

### Tailnet posture check
- **Logic:** read the node's ACL-relevant posture (via the Tailscale CLI or local API) and surface it where the operator chooses tailnet serving.
- **Edge case:** unreadable posture must display as *unknown*, never as *fine*. A security control that fails open to a reassuring label is worse than no label — the CLAUDE.md fallback rule applies directly.

## Verification Plan

### Goal Invariants

1. A word-boundary search for `\bacl\b` in `src/` returns at least one real handler. *(Paired: the surfaced value distinguishes open / scoped / unknown, so 'unknown' cannot render as safe.)*
