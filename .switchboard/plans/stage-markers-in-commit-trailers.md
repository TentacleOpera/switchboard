# Stage Markers in Git — a Commit Says Which Stage Finished, for the Orchestrator and the Board

## Goal

When the planner, lead or reviewer commits, its commit carries a machine-readable trailer naming the stage and the plan. Anything that needs to know "is this done" — the orchestrator's tick, the board's UI — reads git instead of inferring.

### Why

**Every completion signal in this system today is an inference.** Plan-file mtime advance, pty-stream silence, a card's column — each is a proxy that has to be interpreted, and each has a documented failure: mtime is unreliable, a lead is idle by design so silence means nothing, and cards move on coding *start* so a column never means finished. The board has struggled for the same reason: it has no fact to display, only estimates.

**A commit is a fact.** It is durable (unlike mtime, which does not survive a fresh checkout), attributable (a role and a plan, not a guess), verifiable (the diff is right there), and it exists at exactly the moment a stage ends. The orchestrator persona already says *"verify via git — status of record"*; this gives that rule something to read.

**Three stages, three markers.** With the planner, lead and reviewer each committing (see `retire-auto-commit-agents-commit-their-own-work.md`), the pipeline emits one marker per stage: planned, coded, reviewed. "Reviewed" is the one nothing can currently express — the reviewer both approves and fixes, and neither the plan file nor the board distinguishes its output from the coder's.

## The marker

Git trailers on the commit the role already makes — no extra commit, no separate file:

```
reviewer: fix null guard in team lookup and verify against plan

Switchboard-Stage: reviewed
Switchboard-Plan: <planId>
```

- **`Switchboard-Stage`** — `planned` | `coded` | `reviewed`. One value per stage, emitted by that role's commit clause.
- **`Switchboard-Plan`** — the planId the dispatch carried.

Trailers rather than a message prefix: they are machine-readable (`git log --format='%(trailers)'`), they leave the subject line free to describe the actual change, and they survive rebases and merges. A subject-line convention would put parsing pressure on text a human writes.

The role's dispatch prompt already knows both values, so the commit clause emits them — the agent is not asked to remember or invent anything.

## Who reads them

**The orchestrator's tick.** "Is this stage finished" becomes a git query against the plan's marker, replacing an opinion about terminal activity.

**The board.** A plan's real stage becomes displayable — and the gap between "a card sits in CODER CODED" and "coding actually finished" closes, because the first is a dispatch and the second is a commit.

## Additive, not a replacement

**Existing detection stays.** Do not remove mtime-advance completion, the turn-end classification, or anything else that currently drives the board — markers are a second, better source that must prove itself first. A missing commit is a missing marker, and until markers are demonstrably reliable, losing the old signal would trade a noisy detector for a silent one.

Reconciling the two — or retiring the weaker — is a later decision made with evidence, not part of this plan.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, feature

## Verification Plan

1. A planner finishing a plan produces a commit trailing `Switchboard-Stage: planned` and the correct planId.
2. Same for a lead (`coded`) and a reviewer (`reviewed`).
3. `git log --format='%(trailers)'` returns the markers without any bespoke parsing.
4. Markers survive a rebase and a merge of the branch carrying them.
5. The board can show a plan as reviewed on the strength of the marker alone.
6. A role set to `dontCommit` emits no marker, and nothing downstream treats its absence as an error.
7. With markers present, every existing completion path still behaves exactly as it does today.
