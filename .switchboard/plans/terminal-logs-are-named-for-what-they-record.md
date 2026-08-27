# Terminal logs are named for what they record — plan, terminal, and CLI

## Goal

Name each terminal log file after the work it contains — the plan, the terminal,
and the CLI that ran — so a log can be found by any of those without opening it.
This is the prerequisite for treating the logs as a searchable record of work done.

### Problem Analysis

**The only searchable field today is which terminal the work happened in.**
`TerminalLogWriter` writes `.switchboard/logs/<terminal-name>-<session-id>.md`
(`terminalLogWriter.ts:4`). The terminal name is meaningful; the session id is an
opaque handle. So "show me the log for plan X" cannot be answered by a filename —
only by opening files until one matches, and "which CLI produced this" cannot be
answered at all.

**That is the whole gap between a pile of logs and a record of work.** The files
already contain what happened: ANSI stripped, CR-redraws collapsed, and a `##`
heading opened per prompt delivery so the document has a dispatch-keyed outline.
The content is good. It is unaddressable.

**Two existing contracts constrain the naming, and one of them is easy to break.**

1. `_handleTerminalLogList` (`LocalApiServer.ts:4831-4838`) lists a terminal's
   sessions by filtering on `sanitize(terminalName) + '-'` as a **filename
   prefix**, and the viewer's session sidebar reads that endpoint. Any format that
   does not start with the terminal name breaks the only UI that reads these files.
2. `.switchboard/logs/` is gitignored, and a contract test asserts it with no
   un-ignore negation (`terminal-session-log-contract.test.js:438-449`). Logs must
   not start landing in the code repo as a side effect of anything here.

**And one thing the current format gets right by accident: one file is one
session.** A file whose name claims a plan must contain that plan's work and not
another's — but a terminal can be dispatched several plans without a session
boundary between them. So naming for a plan is only honest if the plan is part of
what defines a file.

### Root Cause

The filename was designed to identify a *stream* (which terminal, which run), at a
time when logs were something you opened from the terminal you were watching. Using
them as a record of work asks a different question — which plan, by what — and the
name answers neither.

### Non-goals

- **Publishing logs anywhere.** That is
  `terminal-logs-publish-to-the-board-state-repo.md`.
- **Un-ignoring `.switchboard/logs/`.** It stays gitignored and the contract test
  stays green.
- **Changing what is written into the log**, or the ANSI/CR handling.
- **Retention or pruning.** `retention-and-archive-for-unbounded-growth.md` owns
  that policy; this plan only changes names and roll triggers.
- **Renaming existing log files.** See migration.
- **Confirm gates.** Per project rule, none.

## Metadata

**Complexity:** 4
**Tags:** backend, cli, feature, reliability
**Feature:** 2440474a-cbe2-4876-b65d-3ccffd000aa3

## Dependencies

None. `terminal-logs-publish-to-the-board-state-repo.md` depends on this — an
opaque filename published remotely is no more searchable than an opaque filename
locally.

## Proposed Changes

### 1. The filename

```
<terminal>-<cli>-<planSlug>-<planIdShort>-<sessionId>.md
coder-1-claude-milestones-tab-in-the-kanban-panel-a3f19c2b-s7k2m.md
```

**The terminal name stays first, and that is not an aesthetic choice.** The
listing endpoint's prefix filter and the viewer's sidebar both depend on it
(`LocalApiServer.ts:4831`). Searchability does not care about field order — a glob
or grep matches a substring anywhere in the name — so leading with the terminal
costs nothing and avoids changing a working contract to gain nothing.

**Both a slug and an id, because they answer different questions.** The slug is
what a human greps and what makes a directory listing readable; the short planId is
what makes the match exact, since two plans can slug identically and a remote
reader correlating a log to a card needs the id, not the topic.

**The CLI segment** is the executable token of the terminal's startup command
(`CustomAgentConfig.startupCommand`, `agentConfig.ts:104`) — `claude`, `codex`,
`gemini` — falling back to the custom agent's `name`, then to `shell` for a plain
terminal. It is the field that answers "was this the CLI that did the thing I am
seeing" after a fleet has run several.

**Sanitization and length.** Every segment is reduced to `[a-zA-Z0-9._-]`, matching
the endpoint's existing sanitizer so the prefix still matches. The plan slug is
capped (60 chars) and the whole name kept well under the 255-byte filesystem limit
— a plan topic is free text and some are long. Cap by truncating the slug only:
the id and session segments are what keep the name unique, so they must never be
the part that gets cut.

**An unassigned terminal gets the literal token `unassigned`**, not an omitted
segment. Omitting one makes the format positionally ambiguous, and the first
consumer to split on `-` gets a plan id where it expected a CLI.

### 2. The plan becomes part of what defines a file

The writer already rolls the log on session boundaries (`clearTerminalContext`,
`queue/done`) and at `LOG_CAP_BYTES` (10 MiB). **Add a plan change as a roll
trigger.**

After that, one file means *one terminal working one plan with one CLI*, which is
exactly the unit the name claims and the unit a reader wants. Without it, a
terminal handed a second plan keeps appending to a file named for the first, and
the name is a lie that nobody can detect from outside.

The cost is more files. That is the intent — the alternative is fewer files that
cannot be addressed.

Rolling reuses the existing session-roll path, so the new file is a normal
`<...>-<sessionId>.md` the endpoint and sidebar already find. Per the writer's own
note, rotation must never produce a `.md.1`: that would put history behind the
endpoint's `.md` filter.

### 3. Where the plan identity comes from

Prompt delivery already notifies the writer (`onPrompt`, used for the `##`
headings). Extend that notification with the plan id and topic, which the dispatch
path already knows — the writer must not look anything up, because it runs in the
pty child (`ptyHost.ts:53`) and has no database.

That keeps the writer a pure sink, which is why it works identically in both hosts
today (`bootstrap.ts:2742` and `ptyHost.ts:53`). Giving it a DB dependency is the
change that would divide the hosts.

### Migration

Log files exist on the disks of ~4,000 installs in the old format.

- **Nothing is renamed.** The viewer losing visible history is worse than an era of
  inconsistent names, and a rename pass over unknown quantities of files on someone
  else's disk is not worth its risk.
- **Readers accept both formats.** The listing endpoint already matches on prefix
  and `.md`, so old files keep listing with no change; anything that *parses*
  segments must treat the old two-segment form as `terminal` + `session` with no
  plan or CLI, rather than failing or mis-splitting.
- **`.switchboard/logs/` stays gitignored** — assert the existing contract test
  still passes rather than assuming it.

## Verification Plan

1. **Name composition** — a dispatched plan produces all five segments; verify the
   slug, the short id, and the CLI token against the terminal's startup command.
2. **The prefix contract holds** — `GET` the terminal-log list for a terminal whose
   logs use the new format and assert every file is returned. Then assert a
   terminal whose logs use the **old** format still lists. Both, in one test: this
   is the contract most likely to be broken silently by a format change.
3. **Plan change rolls the file** — dispatch plan A, then plan B, to one terminal
   without a session boundary. Assert two files, each named for its own plan, and
   that A's file contains no output produced after B's dispatch.
4. **Unassigned** — a manually opened terminal with no dispatched plan produces
   `unassigned` in the plan segment and a parseable name.
5. **Sanitization and length** — a plan topic containing `/`, `:`, spaces, unicode,
   and 300 characters produces a safe name under the filesystem limit, with the
   truncation taken from the slug and the id and session segments intact.
6. **Uniqueness** — two plans whose topics slug identically produce different
   filenames.
7. **No `.md.1`** — force a size roll and assert the rotated file is a normal
   `.md` the endpoint returns.
8. **The writer stays dependency-free** — assert it takes plan identity as an
   argument and performs no DB or config lookup. A source-text assertion: this is
   what keeps the two hosts identical.
9. **Gitignore** — the existing contract test passes unchanged.
10. **Both hosts** — run a dispatch under the extension host (pty child) and the
    standalone host and assert byte-identical naming from each.

### Goal Invariants

- A log can be found by plan, by terminal, or by CLI, from its name alone.
- A file named for a plan contains only that plan's work.
- Every existing log file remains listable and readable.
- Logs stay out of the code repository.
- The writer needs no database, so both hosts name files identically.
