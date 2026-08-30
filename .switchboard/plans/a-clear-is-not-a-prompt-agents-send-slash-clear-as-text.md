# A clear is not a prompt: agents send "/clear" as prompt text and it silently lands as literal text

## Goal

Make an agent asked to clear a team terminal actually clear it. Today an agent — a Mission
Controller, or the `/switchboard` console agent — reaches for `ptySendPrompt` with `"/clear"` as
the payload, which cannot work, and nothing tells it so: the call returns success and the
terminal keeps its context.

### The problem

Asked to clear team terminals, an agent sends the clear through
`POST /terminals/verb/ptySendPrompt` with `data: "/clear"` instead of the dedicated
`ptyClearTerminal` verb. The terminal is not cleared. The call reports success.

### Root cause — two different write paths, and the prompt path cannot carry a slash command

`ptyPromptDelivery.ts` implements two deliberately separate mechanisms:

- **`writeSlashCommand` / `writeSlashCommandLocked` (`:53`, `:64`)** — writes `CLEAR_INPUT_LINE`
  (`\x15`, Ctrl+U) to empty the CLI's persistent input buffer, waits `CLEAR_INPUT_SETTLE_MS`,
  writes the command, then writes the submitting CR as its own separate write after a real
  delay. A slash command is a **keypress sequence**.
- **`sendPromptToPty`** — bracketed-paste framing (`\x1b[200~` … ), chunked writes. A prompt is
  a **paste**.

The file states the incompatibility outright, at `:38-41`:

> *"It MUST land OUTSIDE any bracketed-paste block — i.e. before `\x1b[200~`, never after it.
> **Inside the block it is absorbed as literal text** and silently prefixes the payload."*

and at `:33-36` describes precisely the failure the agent hits:

> *"Agent CLIs keep a persistent input buffer: anything already sitting in it concatenates with
> the next write, so `/clear` lands as `…text/clear` — a prompt, not a command, and the context
> is never reset."*

So `"/clear"` sent as `data` is delivered inside a bracketed-paste block, as text, to a CLI that
would only have treated it as a command had it arrived as keypresses on an emptied input line.

**Two independent reasons it cannot work, either one sufficient:**

1. **Framing.** As above — pasted text is text.
2. **The appends.** `ptySendPrompt` appends the standing-orders block and the seat directive
   block by default. The payload the CLI receives is not `/clear`; it is `/clear` followed by
   the marker block and hundreds of words of orders. Even on a path that did interpret leading
   slash commands, this would not be one.

### Root cause 2 — the correct verb exists and the failure is silent

`ptyClearTerminal` is implemented in both hosts (`bootstrap.ts:1848`; extension side at
`TaskViewerProvider.ts:532,566`), takes `{ name }`, is reachable at
`POST /terminals/verb/ptyClearTerminal` with no verb allowlist on the route
(`LocalApiServer.ts:8099`), and **is** documented — in
`.agents/skills/switchboard-orchestration/SKILL.md:216` and its
`switchboard-mission-control-http` twin:

> *"Reset a named terminal's context. Send it when you put a terminal at rest… Never send it to
> your own terminal, and never use `ptyClearAllTerminals`."*

So this is not a missing capability or an undocumented one. Two things defeat the documentation:

- **`ptySendPrompt` is the verb every agent already knows.** It is in the drive prefix's staging
  example, in the coder's standing orders, in the callback contract. `ptyClearTerminal` appears
  once, in a table, in a skill the agent may not have loaded. Reaching for the familiar verb is
  the default behaviour, not a lapse.
- **Nothing fails.** `ptySendPrompt` with `data: "/clear"` is a perfectly valid prompt send. It
  returns `{ success: true }`. The agent has no signal, reports the clear as done, and the
  operator finds a full terminal.

The `/switchboard` front door makes this likelier: `.agents/workflows/switchboard.md` has no
clear guidance at all, deferring wholesale to *"the `switchboard-orchestration` skill documents
every endpoint"*.

## Implementation

### 1. Make the wrong call fail loudly instead of silently succeeding

In the `ptySendPrompt` path, detect a payload whose `data`, once trimmed, is a bare slash
command — `/clear` above all — and reject it with an actionable error naming the verb to use
instead (`ptyClearTerminal` for `/clear`) rather than delivering it as a paste.

- Reject, never silently redirect. A caller that believes it sent a prompt and actually
  triggered a context reset is a worse failure than the one being fixed; the error is what
  teaches the agent, and agents read errors.
- Scope the check to a payload that is **only** the slash command. A legitimate prompt may
  quote `/clear` in prose, and must still send.
- Apply it at the shared boundary so both hosts inherit one rule, and confirm by inspection
  that the extension and standalone arms behave identically — this is a validation change on the
  `pty*` rail, where `validateVerbPayload('taskViewer', verb, body)` already runs
  (`LocalApiServer.ts:8099` region), so that is the natural home.

### 2. Put the clear verb in front of the agents that need it

- **`.agents/workflows/switchboard.md`** — add a short "resting a terminal" note to
  `## Everything else`: clearing a terminal is `ptyClearTerminal`, never a prompt; a slash
  command sent as prompt text is delivered as text.
- **The Mission Control persona** (`.agents/protocols/switchboard-mission-control/SKILL.md`) —
  it has a `## Messaging Leads` section giving the `ptySendPrompt` curl recipe and no clear
  recipe at all. Add the counterpart, with the same "never your own terminal, never
  `ptyClearAllTerminals`" constraints the orchestration skill already states.
- **`switchboard-orchestration` / `switchboard-mission-control-http`** — the row exists; add one
  sentence stating the negative, that `/clear` sent through `ptySendPrompt` is delivered as
  literal text and does nothing. Documenting the right call has not been enough; the wrong call
  has to be named.

### 3. Do not add a new endpoint

`ptyClearTerminal` is the dedicated clear path and it works. The gap is discovery and a silent
failure, not a missing surface. Adding a second clear route would leave two, and the wrong one
would still return success.

### Related, not owned here

- `feature_plan_20260817091718_clear-the-cli-input-line-before-every-slash-command.md` owns the
  Ctrl+U input-line reset that makes `writeSlashCommand` reliable. This plan depends on that
  path being correct and does not change it.
- `feature_plan_20260815140920_proactive-clear-when-a-lead-rests-a-coder-terminal.md` owns
  teaching the lead *when* to clear. This plan owns *how* any agent clears at all.

## Verification Plan

1. Send `POST /terminals/verb/ptySendPrompt` with `{"name":"<seat>","data":"/clear"}` and confirm
   it is rejected with an error naming `ptyClearTerminal`, and that the terminal received
   nothing.
2. Confirm `{"data":"Explain what /clear does in this CLI."}` still sends normally — the guard
   must not catch prose that mentions a slash command.
3. Confirm `POST /terminals/verb/ptyClearTerminal` with `{"name":"<seat>"}` clears the seat, in
   **both** hosts (`bootstrap.ts:1848` and the extension arm).
4. Reproduce the original bug on the pre-fix build for the record: send `/clear` as `data`,
   capture the terminal showing the literal text plus the appended standing-orders block, and
   confirm the response was `success: true`.
5. Ask a `/switchboard` agent, in a live session, to clear a team terminal, and confirm it now
   reaches `ptyClearTerminal` on the first attempt after reading the updated workflow.
6. `npx tsc --noEmit -p tsconfig.json`, plus any verb-payload validation contract test.

## Metadata

**Feature:** 25e6a03f-26a5-444d-8089-43368af27bcd
**Complexity:** 4
**Tags:** backend, reliability, bugfix
