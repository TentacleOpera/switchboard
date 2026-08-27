# Terminal logs are markdown on disk with two read endpoints, and no agent document mentions either

## Goal

Make terminal session logs discoverable to the agents that need them, and fix the two log endpoints
so they honour the workspace they are asked about. Mission Control is told to "check the terminal"
with no mechanism given, so it reconstructs terminal state by running commands — while a markdown
transcript of that terminal sits unread on disk.

### Problem Analysis

**The logs exist, and they are purpose-built for exactly this reader.**
`src/standalone/terminalLogWriter.ts:252` (`TerminalLogWriter`) tees every terminal's pty output to
`.switchboard/logs/<terminal-name>-<session-id>.md`. Its own header describes the design:

> Tees flushed pty output to `.switchboard/logs/<terminal-name>-<session-id>.md`, stripping ANSI,
> collapsing carriage-return redraws, and keeping agent-printed code fences from closing the log's
> own code block. Each prompt delivery opens a `##` heading so the document has an outline keyed to
> dispatch boundaries.

`onPrompt` writes `## <ISO timestamp> — <first 80 chars of prompt>` at every dispatch boundary, and
session boundaries roll the file so a cleared terminal reads as a new document. Output is wrapped in
` ```console ` fences, with the opening fence carrying an info string and the closing fence not — so
a reader handed an arbitrary tail can tell whether its slice starts mid-block. This is a document
built to be read by something that arrives late and needs to find one dispatch.

**Both hosts write them.** `src/standalone/bootstrap.ts:2743` (standalone) and
`src/standalone/ptyHost.ts:53` (the extension's pty child). No divergence here — the logs are
present in both hosts.

**Two read endpoints exist.** Routed at `LocalApiServer.ts:7412` and `:7418`:

- `GET /terminals/<name>/log` (`_handleTerminalLog`, `:4723`) — ranged tail, default 256 KB, capped
  at 2 MiB, with `Content-Range` and `X-Log-Total-Bytes` headers, `session` / `tail` / `offset`
  query params, and a `normalizeLogSlice` pass that balances fences so a mid-block slice still
  renders.
- `GET /terminals/<name>/logs` (`_handleTerminalLogList`, `:4818`) — `{ success, sessions: [{ filename, size, mtime }] }`, newest first.

**No agent-facing document mentions any of it.** Grep for `.switchboard/logs` or `terminals/.*log`
across every document an agent is given:

| Document | mentions |
| :--- | :--- |
| `.claude/skills/switchboard/SKILL.md` | **0** |
| `.agents/protocols/switchboard-mission-control/SKILL.md` | **0** |
| `.agents/protocols/switchboard-mission-control-http/SKILL.md` | **0** |
| `.agents/protocols/switchboard-mission-control-internal/SKILL.md` | **0** |
| `.agents/protocols/switchboard-mission-control-external/SKILL.md` | **0** |

The `-http` runsheet is the endpoint reference for this persona. It does not know these endpoints
exist.

**And the protocol asks for the capability by name.**
`.agents/protocols/switchboard-mission-control/SKILL.md:407`, on processing a turn-end notice:

> **`blocked`** (seat went quiet without a completion report) → **check the terminal.** If it is
> asking a question, answer it or escalate. If it crashed or ran out of context, re-dispatch the
> work to the same lead.

"Check the terminal" with no mechanism. The surrounding sections instrument everything else — the
ready query, the git verification (`git -C <worktree> log --format='%(trailers:key=Switchboard-Stage,valueonly)'`
at `:511`, `rev-list --count` at `:521`, `status --porcelain` at `:522`), the reports channel, the
`ptySendPrompt` path. So the agent does what the document trained it to do everywhere else: it runs
commands. It shells out to git, greps plan files, messages the lead and waits — reconstructing from
side effects what the transcript states directly.

**The workaround is strictly worse than the thing it replaces.** `:388` warns that terminal silence
is a lead's normal working state, and `:379` that a card resting in a coding column with
`dispatched_at` cleared is finished rather than in-flight. Distinguishing "asking a question" from
"crashed" from "idle by design" is exactly what the log's last screenful answers and what git
cannot: a question waiting at a prompt produces **no commit and no file change**. For the
`blocked` branch specifically, the documented signals are blind and the undocumented one is
decisive.

**Separately, the two endpoints ignore the workspace they are asked about.** Both build their path
from the primary root only:

- `:4731` — `const logsDir = path.join(this._options.workspaceRoot, '.switchboard', 'logs');`
- `:4830` — the same line in the list handler.

Every comparable handler in the file resolves the request's root first —
`url.searchParams.get('workspaceRoot') || this._options.workspaceRoot` at `:2541`, `:2645`, `:6298`,
`:6446`. The log handlers skip the first half. In a multi-root server, a caller passing
`?workspaceRoot=/other/repo` silently gets the **primary** root's logs: a 200, a plausible
transcript, the wrong terminal. This is the failure Hard Rule 5 exists for
(`.claude/skills/switchboard/SKILL.md:571`: "A bare call silently targets the primary root — the
wrong workspace"), and here the rule cannot help, because the parameter is not read.

### Root Cause

The log writer and its endpoints were built for the **log viewer UI** — `_handleTerminalLogList`'s
own docstring says "Used by the log viewer's sidebar to browse other sessions", and the fence
handling is written against `renderMarkdown` in `sharedUtils.js`. The agent-facing protocols were
written by a different pass and never learned the feature shipped. Nothing connects a new endpoint
to the runsheet that lists endpoints, so a capability can exist, be tested, be used by the webview,
and remain invisible to every agent indefinitely. The single-root path is the same omission in code:
the handler was written for the one-root case the viewer runs in.

### Non-goals

- **Not changing the log format.** The fence discipline, ANSI stripping, CR collapsing, `##` prompt
  headings and session rolling are all correct and load-bearing.
- **Not adding retention.** Deferred by the writer's own comment to
  `retention-and-archive-for-unbounded-growth.md`; rotation-as-session-roll stays.
- **Not making logs the status of record.** Git and the board remain authoritative (Hard Rule 1).
  The log is how you read a *terminal*, which is a different question from whether work landed.
- **Not building a new endpoint.** Two exist. They need documenting and one bug fixed.

## Metadata

**Complexity:** 3
**Tags:** bugfix, docs, api, backend, reliability

## User Review Required

Yes — one decision.

**Should the agent read the log over HTTP or straight off disk?** Recommendation: **document the
HTTP endpoints as the primary path and the file path as the fallback**, because:

- The ranged endpoint serves a **fence-normalized** slice (`normalizeLogSlice`). A `tail -c` off
  disk can start mid-block and render the remainder as prose — the exact failure the normalization
  exists to prevent.
- It caps the read (256 KB default, 2 MiB max). These files roll at 10 MiB; an unbounded read is a
  context-destroying mistake an agent will make once.
- `GET /terminals/<name>/logs` resolves the session-id suffix, which an agent cannot construct — it
  is base36 of the writer's `Date.now()`.
- The endpoints are auth-gated, and `_handleTerminalLog`'s docstring is explicit that this is
  load-bearing: "The log files may contain secrets (agent terminals echo tokens, env and paths), so
  the auth gate is load-bearing."

That last point is the one to weigh. **Documenting these logs to agents also documents a
secret-bearing surface.** The recommendation is to say so in the same paragraph: read the tail to
diagnose a blocked seat, never quote a log verbatim into a report, a session file, or a card
comment. Worth an explicit decision rather than an assumption.

Direct file reads stay documented as the fallback for a board that is down — with `tail -c` and the
fence caveat named.

## Complexity Audit

### Routine

- Adding an endpoint section to the `-http` runsheet.
- Replacing "check the terminal" with the call that checks it.
- Adding the `searchParams` read to two handlers.

### Complex / Risky

- **The workspaceRoot fix must not break the viewer.** The log viewer calls without the parameter
  today and must keep resolving to the primary root. The established `param || _options.workspaceRoot`
  ordering preserves that exactly — use it, do not invent a new resolution.
- **A root must not become a traversal vector.** The current handlers build no path from user input;
  `session` is sanitized and matched against a directory listing rather than joined. Adding a
  caller-supplied root introduces the first input-derived path segment in this handler. Validate it
  against `_allRoots` — the same cross-check `/health`'s `roots` field exists for — rather than
  joining it directly.
- **Secret exposure is the real risk of this plan.** The docstring's warning is not decorative. The
  guidance must tell the agent to read and not to quote, and to keep log content out of
  `session.md`, the reports channel, and card comments.
- **The read must be bounded by instruction, not just by the cap.** An agent handed a 2 MiB ceiling
  will request 2 MiB. Document the *diagnostic* read — a modest tail, the last `##` heading, enough
  to see whether a prompt is waiting.
- **Sanitized names, not friendly names.** The endpoint's prefix is
  `terminalName.replace(/[^a-zA-Z0-9._-]/g, '_') + '-'`. A terminal named `Claude Code` has files
  prefixed `Claude_Code-`. An agent constructing a filename from a friendly name finds nothing. Say
  this, or the fallback path fails silently.
- **`GET /health` is the wrong source for the log filename.** It returns friendly names; the list
  endpoint returns actual filenames. The documented flow is list, then read.

## Edge-Case & Dependency Audit

**Race conditions**
- The live session is being appended while read. Intended: `normalizeLogSlice` balances the fence of
  a block still being written.
- A session boundary between list and read: the named session file still exists (rolls preserve the
  old file), so the read succeeds against a now-closed session. Report the timestamp, do not assume
  it is live.
- A fleet rename mid-session: `onRename` moves the in-memory key but "the file on disk keeps its old
  name". A rename therefore splits one terminal's history across two prefixes — the list under the
  new name will not show the old file.

**Security**
- **Logs may contain secrets** — the handler's own warning. Both endpoints already run `_checkAuth`;
  the fix must not weaken it, and the new guidance must forbid verbatim quoting into any persisted
  or user-visible artifact.
- A caller-supplied `workspaceRoot` must be validated against `_allRoots`, not trusted.

**Side effects**
- Documenting a 2 MiB-capable read to a context-limited agent invites a context blowout. Mitigated
  by prescribing a diagnostic tail.
- Agents may start preferring logs over git for completion. Hard Rule 1 must be restated where the
  log guidance lands: the log tells you what a terminal is doing, git tells you what landed.

**Migration**
- Documentation plus a two-line handler fix. No schema, settings, stored state, or log-format change.
  Callers that omit `workspaceRoot` keep today's behaviour byte-for-byte, so the viewer is unaffected
  and no install changes.

## Dependencies

- **Related:** `the-pre-flight-names-six-checks-and-supplies-one-command.md` — both add endpoint
  documentation to `switchboard-mission-control-http/SKILL.md`; land them in either order but expect
  a touch in the same file.
- **Defers to:** the writer's own `retention-and-archive-for-unbounded-growth.md` for retention.
- **Reads, does not change:** `switchboard-contracts` (`dispatched_at` as the working-state latch).

## Adversarial Synthesis

Key risks: (1) documenting the logs without the secret-handling rule, so an agent helpfully pastes a
terminal transcript — tokens and env included — into a session file or a card comment, turning a
diagnostic improvement into a leak; (2) documenting the file path without the sanitized-prefix rule,
so the fallback silently finds nothing for any terminal with a space in its name; (3) fixing the
root resolution by joining a caller-supplied path without validating it against `_allRoots`,
introducing the handler's first traversal surface where none existed; (4) changing the resolution
order and breaking the log viewer, which calls without the parameter; (5) agents adopting the log as
completion evidence and abandoning git verification. Mitigations: put the no-verbatim-quoting rule
in the same paragraph as the endpoint; document the `_`-substitution prefix rule beside the file
path; validate the root against `_allRoots` and keep `param || _options.workspaceRoot` ordering
exactly; and restate Hard Rule 1 where the log guidance lands.

## Proposed Changes

1. **Fix the root resolution** in `_handleTerminalLog` (`LocalApiServer.ts:4731`) and
   `_handleTerminalLogList` (`:4830`): read `workspaceRoot` from the query string first, falling back
   to `this._options.workspaceRoot`, matching `:2541` / `:2645` / `:6298` / `:6446`.
2. **Validate the supplied root against `_allRoots`** before building a path, rejecting an unknown
   root rather than joining it.
3. **Document both endpoints** in `.agents/protocols/switchboard-mission-control-http/SKILL.md`:
   paths, query params (`session`, `tail`, `offset`, `workspaceRoot`), the `Content-Range` and
   `X-Log-Total-Bytes` headers, the default and cap, and the list-then-read flow.
4. **Replace "check the terminal" at `:407`** with the actual mechanism: list the terminal's
   sessions, read a diagnostic tail of the newest, and use the last `##` heading plus the trailing
   output to distinguish a waiting question from a crash from designed idleness.
5. **Add the secret-handling rule** in the same section: read to diagnose, never quote verbatim into
   a report, `session.md`, the reports channel, or a card comment.
6. **Document the log file layout** as the board-down fallback — `.switchboard/logs/<sanitized-name>-<session-id>.md`,
   the `[^a-zA-Z0-9._-] → _` substitution, the `##` prompt-boundary outline, the ` ```console `
   fences, and the caveat that a raw `tail -c` is not fence-normalized.
7. **Restate Hard Rule 1** where the guidance lands: the log is how you read a terminal; git and the
   board remain the status of record.
8. **Note the rename split** — after a fleet rename the pre-rename file keeps its old prefix, so a
   terminal's history can span two prefixes.

### Migration

Documentation plus a two-line handler change. No schema, settings, stored state, or log-format
changes. Callers omitting `workspaceRoot` behave exactly as today, so the log viewer and every
existing client are unaffected.

## Verification Plan

1. **Multi-root correctness.** With two roots registered, request
   `GET /terminals/<name>/log?workspaceRoot=<secondary>`; assert the secondary root's log is served.
   This fails before the fix — it returns the primary's.
2. **Viewer unaffected.** Call both endpoints with no `workspaceRoot`; assert byte-identical
   responses to pre-fix, and drive the log viewer's sidebar end to end.
3. **Unknown root rejected.** Pass a `workspaceRoot` not in `_allRoots`; assert a 4xx and that no
   filesystem read is attempted outside a registered root.
4. **Traversal.** Pass `../` sequences in `workspaceRoot` and in `session`; assert no read escapes
   the resolved root's `.switchboard/logs`.
5. **Auth still gates.** Call both endpoints unauthenticated; assert 401.
6. **A blocked seat is diagnosed from the log.** Dispatch to a terminal, have the agent stop at a
   question with no commit and no file change, deliver a `blocked` turn-end notice; assert Mission
   Control reads the log, identifies the waiting question, and answers or escalates — **without**
   running git or grepping plan files to guess.
7. **Crash vs question vs idle.** Reproduce all three and assert each is classified correctly from
   the log tail.
8. **Sanitized prefix.** Use a terminal named with a space (`Claude Code`); assert the list endpoint
   returns its sessions and the documented fallback path finds the file.
9. **Fence normalization matters.** Request an offset landing mid-` ```console ` block; assert the
   served slice renders as a code block, and that a raw `tail -c` at the same offset does not — the
   evidence for documenting HTTP as primary.
10. **Bounded read.** Assert the documented diagnostic read requests a modest tail, not the 2 MiB
    ceiling, against a log rolled near 10 MiB.
11. **No verbatim leakage.** After a log-driven diagnosis, assert no log content is copied into
    `session.md`, the reports directory, or a card comment.
12. **Session roll.** Trigger a session boundary between list and read; assert the named file still
    reads and the report states the session's timestamp rather than implying it is live.
13. **Both hosts.** Repeat 1, 6 and 8 against the extension host and standalone `npx switchboard`.
