# Agents Post Updates to a File Inbox the Orchestrator Reads

## Goal

Give agents a place to post updates — finished, blocked, a question, a status reply — as files. Any orchestrator with local file access can read them, whether it is a pty terminal, an IDE chat sidebar, or a cloud session with the repo checked out.

### Why

**`ptySendPrompt` assumes the orchestrator is a pty.** It often is not. An orchestrator running in an IDE chat sidebar or a web chat with local file access can read and write the repo but cannot be messaged, so "ask the lead for an update" has no reply channel — the lead can be prompted, and its answer has nowhere to go.

**Plan files cannot carry these updates.** Completion reports already live there, and that works precisely because plan files are write-once-at-the-end: a mid-work edit breaks completion detection (`switchboard-contracts` #3). "I am blocked", "I need a decision", and status replies all arrive mid-work by definition, so putting them in the plan file corrupts the one signal that does work today.

**Files are the only channel every host shares.** A pty can be messaged, an HTTP client can call the API, a sidebar chat can do neither reliably — but all three can read a directory.

**Half of this already exists, unused.** `ScheduledJobsService` ships `.switchboard/instructions/inbox/` with timestamped markdown files, frontmatter, `claimed/` markers and a staleness window — `writeInstruction`, `claimInboxItem`, `isInboxItemClaimed`. `SparkContextExporter` documents it to external agents. `writeInstruction` has no caller anywhere in `src`. The mechanics are proven and idle; they simply run the other direction (instructions *to* agents, not reports *from* them).

## What is added

**A reports directory: `.switchboard/orchestrator/reports/`.** One file per report, never rewritten, mirroring the existing instructions-inbox conventions rather than inventing new ones:

```
---
from: Coding-lead
kind: blocked          # finished | blocked | question | status
planId: <id>           # or feature:
created: 2026-08-16T21:14:03Z
---

Subtask 3 needs a decision on the migration key before I can continue.
```

**Agents post to it.** The team prompt gains one line: post an update here when you finish, when you are blocked, and when asked for status. This sits alongside the existing `ptySendPrompt` callback rather than replacing it — a pty-hosted lead reporting to a pty-hosted head keeps working exactly as it does now.

**The orchestrator reads it every tick and marks what it has handled**, using the existing `claimed/` marker pattern so a report is not acted on twice. Reading is a directory listing: no API, no extension, no host assumptions.

**Nothing is deleted.** Completion reports stay in plan files. `ptySendPrompt` stays. This adds the channel that works when neither is available.

## Relationship to the tick

`orchestrator-persona-becomes-a-tick.md` names two signals for its lane guards: completion reports in plan files, and asking the lead. This plan is what makes the second one work for a non-pty orchestrator — the question goes out however the host can send it, and the answer comes back as a file.

A pty-hosted orchestrator does not need this plan to function. Every other host does.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, feature

## Verification Plan

1. A lead posts a `blocked` report; an orchestrator reading only the filesystem sees it on its next tick.
2. The same report is not acted on twice across ticks — the claim marker holds.
3. A mid-work `blocked` report does not touch the plan file, and completion detection for that subtask still fires normally when the work later finishes.
4. An orchestrator running in an IDE chat sidebar — no pty, no API reachable — completes a full tick using files alone.
5. A pty-hosted lead reporting to a pty-hosted head still works unchanged; nothing is forced through files that has a live terminal path.
6. Two leads posting at the same moment produce two files, neither clobbering the other.
7. A malformed or truncated report is skipped with a log line, not a crashed tick.
