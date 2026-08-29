# Terminal logs are a screen recording, not a conversation — read the agent's own transcript instead

## Goal

Produce a clean conversation log — user prompts and agent replies, nothing else — by reading the CLI's
**native session transcript** rather than reconstructing it from the PTY byte stream. Keep the raw
stripped log as a fallback and a debugging record; stop asking it to be something it cannot be.

### Problem Analysis

**The current writer already does the obvious thing, and the logs are still dirty.**
`src/standalone/terminalLogWriter.ts` is 503 lines that *"tee flushed pty output to
`.switchboard/logs/<terminal-name>-<session-id>.md`, stripping ANSI, collapsing carriage-return
redraws"*, with a *"comprehensive ANSI escape sequence stripper… a single regex covering CSI, OSC,
charset designation, and simple two-byte escapes."* The effort is not the problem.

**The problem is that the input is a screen recording.** An interactive CLI repaints: spinners and
token counters, status bars, cursor positioning, line clears (`\x1b[2K`, `\x1b[1A`, `\r`). The file
holds many overlapping redraws of the same line at different instants. Stripping escapes does not
recover the final text — it *removes the instructions that said which version won*, leaving every draft
concatenated. A regex cannot fix this, because reconstructing the answer requires emulating a terminal,
not filtering bytes. Correctness here means a screen-buffer emulator; the cheaper and more accurate move
is not to parse the recording at all.

**The clean text exists on disk before it ever reaches the renderer.** Claude Code writes a structured
JSONL transcript per session under `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`, one object
per turn, with the assistant's exact markdown in `message.content`. Extracting it is a few lines:
filter to `type: "user"` / `"assistant"`, take `content` blocks of `type: "text"`, join. No ANSI, no
redraws, no loss. This was demonstrated in practice, not theorised.

**It also survives something the PTY log does not.** `terminal-session-logs-as-readable-markdown.md`
records that `queue/done` clears a member's terminal by design, *"so on the ordinary completion route
the record of how the work went is gone."* A transcript on disk is independent of the terminal, so a
clear cannot destroy it. Reading the transcript fixes a durability problem as a side effect of fixing a
fidelity one.

**Nothing in the codebase knows transcripts exist.** `grep` for `.claude/projects` across `src/`
returns nothing.

### Can it "always" be applied? — no, and the design is that answer

The transcript is **per-CLI**, and Switchboard runs a fleet of different ones. `startupCommands`
(`KanbanDatabase.ts:9371`, machine-global via `GlobalIntegrationConfigService`) maps each role to a CLI
binary — `claude`, `agy`, `qwen` and whatever else a user configures. Only some write a transcript, and
none in the same place or format.

So "always" is the wrong target and pretending otherwise would produce a resolver that silently returns
nothing for two thirds of a fleet. The right shape is **a per-CLI adapter with an honest fallback**:

| seat's CLI | source | result |
| :--- | :--- | :--- |
| `claude` | `~/.claude/projects/<slug>/<uuid>.jsonl` | exact conversation |
| any CLI with a known transcript format | its adapter | exact conversation |
| everything else | today's stripped PTY log | best-effort, **labelled as such** |

The label matters more than the coverage. A best-effort log that admits it is best-effort is usable; one
that presents redraw soup as a transcript is what sent an agent hunting in the first place.

### The hard part: correlating a terminal to its transcript

The path needs a **session uuid**, and Switchboard spawns the CLI without knowing one. In a fleet this
cannot be guessed: several seats run in the same project directory concurrently, so "most recently
modified `.jsonl`" will attach one seat's log to another's — silently, and most often under load, which
is exactly when the log matters.

Three candidate mechanisms, in preference order. **This is the plan's central unknown and must be
resolved before implementation, not during it:**

1. **Assign the id at spawn.** If the CLI accepts a caller-supplied session id, Switchboard generates
   one, passes it in the startup command, and stores it on the terminal record. Deterministic, no
   guessing, survives restarts. Strongly preferred if available.
2. **Have the CLI report it.** An environment variable, a startup line, or a file the CLI writes.
   Requires parsing but is still exact.
3. **Correlate by directory and start time.** Match the transcript created soonest after the terminal
   spawned, in the project slug for that workspace. A fallback with a real collision window; if this is
   the only option, the plan must gate it on there being exactly one candidate and refuse rather than
   guess when there are several.

### Non-goals

- **Not deleting the PTY log.** It is the fallback for CLIs without adapters, and the only record of
  what actually happened on the wire when an agent misbehaves. Keep writing it.
- **Not a terminal emulator.** The alternative to a transcript is emulating a screen buffer to replay
  the recording correctly. That is the expensive path this plan exists to avoid.
- **Not tool calls.** The ask is user prompts and agent replies. `tool_use` / `tool_result` blocks are
  filtered out; the raw log keeps them for anyone who needs them.
- **Not a new store.** The output is the same `.switchboard/logs/` document the viewer and the read
  endpoint already find.

## Metadata

**Complexity:** 5
**Tags:** backend, ux, reliability

## Proposed Changes

1. **Add a transcript-source interface** with one adapter per CLI: given a terminal (its CLI, workspace
   root and session id), return an ordered list of `{role, text}` or `null` for "no adapter". `null` is
   a first-class answer, not an error.

2. **Implement the `claude` adapter.** Read the JSONL, keep objects whose role is `user` or
   `assistant`, take `content` blocks of `type: "text"`, join. Read forward and stream — the working
   example read in reverse to find the newest message, which is right for "the last reply" and wrong
   for a whole conversation. Skip malformed lines individually rather than failing the file; a
   half-written final line is normal for a live session.

3. **Resolve the session id per the section above**, storing it on the terminal record at spawn so the
   mapping survives a reconnect. Where the id cannot be established, the adapter returns `null` and the
   fallback applies — never a guessed file.

4. **Write the conversation document alongside the raw log**, not over it. Same directory, same naming
   convention so the viewer and the read endpoint find it. Each turn as a heading plus its text.

5. **Label the source in the document, always.** A one-line header stating whether this is an exact
   transcript or a best-effort PTY reconstruction. A reader — human or agent — must never have to infer
   which they are holding.

6. **Do not read outside the user's own home.** The transcript lives under `~/.claude/`, outside the
   workspace, which is fine for a process running as that user (the same reasoning as
   `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md`) but must be bounded: resolve to the
   project slug for this workspace, refuse a path that escapes the transcript root, and never follow a
   configured path outside the home directory.

## Verification Plan

1. **Clean output where the raw log is soup.** Run a Claude Code seat through a session with a long
   spinner-heavy tool run, and assert the conversation document contains each user prompt and each
   assistant reply exactly once, with no `\x1b`, no partial redraws, and no duplicated fragments.
   Diff against the same session's PTY log to demonstrate the difference is real.
2. **Concurrency does not cross the streams.** Run three seats in the **same workspace** at once, each
   given a distinct prompt. Assert each conversation document contains only its own turns. This is the
   correlation failure mode and the one most likely to be missed by a single-seat test.
3. **No adapter is a labelled fallback, not an empty file.** Configure a seat with a CLI that has no
   adapter; assert a document is still produced from the PTY log and that its header says so.
4. **An unresolvable session id refuses rather than guesses.** Simulate the ambiguous case — several
   candidate transcripts, no id — and assert the adapter returns `null` and the fallback is used, with
   no transcript attached.
5. **A terminal clear does not lose history.** Drive a seat through `queue/done` (which clears the
   terminal) and assert the conversation document still holds the turns from before the clear.
6. **Tool blocks are excluded.** Assert `tool_use` and `tool_result` content does not appear in the
   conversation document, and that it *does* still appear in the raw PTY log.
7. **A live, half-written transcript parses.** Truncate the final JSONL line mid-object and assert the
   document contains every complete turn and does not fail.
8. **Path containment.** Assert a crafted project slug cannot escape the transcript root, and that no
   read occurs outside the user's home.
9. **Both hosts.** `terminalLogWriter.ts` lives under `src/standalone/`, so establish whether the
   extension host writes these logs by another path or not at all, and wire the transcript source
   wherever the log is produced in each. Per `CLAUDE.md`, a feature landing in one composition root only
   is the documented failure here — and a log that exists under `npx switchboard` but not in the
   extension would reproduce it exactly.

## Outstanding Questions

- **[user] Which CLIs matter beyond `claude`?** `startupCommands` shows `agy` and `qwen` in use. If
  either has a transcript on disk, an adapter is cheap; if not, those seats stay on the labelled
  fallback and that should be a conscious acceptance rather than a surprise.
- **[user] Should the conversation document replace the PTY log in the viewer's default view?** Making
  it the default is the point — but the raw log must stay one click away, since it is the only place
  the ANSI and the tool traffic survive.
