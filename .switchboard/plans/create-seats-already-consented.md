# Create seats already-consented so the blocking prompt never renders

## Goal

Launch every agent seat with the flags that pre-answer its trust / ToS gate, so a
dispatch never arrives at a modal in the first place.

This is the half of the "never press Enter into a surface we cannot see" problem
that actually preserves throughput. A detection gate only stops the damage on the
way down — it catches a blocked seat and routes around it. A seat that never
blocks keeps taking work. Prevention is also the cheaper half by a wide margin:
no delivery-path change, no new runtime signal, no test surface.

Split out of `never-press-enter-into-a-surface-we-cannot-see.md`, which retains
the detection half. **This plan does not depend on that one and ships first.** It
is also the *only* available fix on the VS Code terminal path, where output
cannot be read at all (see that plan's Scope section).

### Problem Analysis

Agent CLIs put modal surfaces in front of the input box: permission prompts,
trust prompts, ToS acceptance after an update, re-auth after token expiry.
Switchboard's delivery path writes a bracketed-paste block into whatever is on
screen and then presses Enter, unconditionally. It knows two things about a seat
— `status` (`active`/`exited`) and `lastDataAt` (`ptyFleetService.ts:95-107`) —
and neither says what the seat is showing.

**Measured 2026-08-23 across eight installed CLIs, one pty session each, nothing
submitted:**

| CLI | state on spawn | lone CR into it |
|---|---|---|
| gemini | ToS consent, `● 1. Yes / 2. No`, "Enter to select" | **selected "1. Yes"** |
| qwen | ToS gate | **advanced into the auth-method picker** |
| droid | `> Login / Exit` | **started the device-auth flow, printed a device code** |
| copilot | **folder-trust menu** — `1. Yes / 2. Yes, and remember this folder / 3. No (Esc)`, "Enter to select" | not sent — no echo, so the probe refused |
| claude, devin, agy | normal input box, empty | nothing visible |
| grok | rendered blank — no data | nothing visible |

Three of eight, when showing a modal, treated a bare `\r` as "take the
highlighted option". Two of those choices are consequential.

**The copilot case is not a first-run curiosity — it is what a fresh seat looks
like in this repo, today.** A dispatch into that seat writes the payload nowhere
and then presses Enter. Count the Enters with `terminal.clearBeforePrompt` at its
default `true`: **one** from `writeSlashCommandLocked`'s submit
(`ptyPromptDelivery.ts:71`), then **two** from the prompt path (`:142`, `:145`).
Three Enters at a menu whose own label reads `↑↓ to navigate · Enter to select`.

**`/clear` is not an escape hatch.** Measured the same day: against copilot's
folder-trust menu the `/clear` text produced **zero visible change** — not a
partial landing, not a stray character. It needs the very input box it is
supposed to rescue. Against grok's (non-blocking) consent banner it reset the
context and the banner survived the redraw. So `clearBeforePrompt` is part of the
hazard, not a mitigation.

**The one human action beats every mechanism.** Choosing "2. Yes, and remember
this folder for future sessions" once removes the entire class for that CLI and
folder. This plan is the machine-side equivalent: answer the question at spawn
time, with the flag, rather than at dispatch time, blind.

### What Switchboard knows about a seat — and what it does not

This constrains the shape of the fix, so it is stated before the changes.

`agentStartupCommands[role]` is the per-role invocation string, injected at spawn
by `injectStartupCommand` (`ptyFleetService.ts:485-500`). It is **free text,
authored entirely by the user**, read from the machine-global agent config
(`GlobalIntegrationConfigService.getAgentStartupCommands`, `:463`). There are
**no built-in defaults** — `getPtyVisibleRoles` returns a `hasCommand` map
precisely so the UI can annotate roles that have none (`:379-400`).

Roles are generic (`lead`, `coder`, `intern`, `reviewer`, …
`DEFAULT_VISIBLE_AGENTS`, `:350-364`). **Nothing in the config says which CLI a
role runs.** A seat named `coder` may be copilot, claude or a wrapper script.

Two consequences:

1. There is no shipped default string to amend. The change lands in what the user
   types, which means the deliverable is a **verified table plus documentation**,
   not a code path.
2. The only place a CLI is named is the first token of the command string itself.
   Keying behaviour off that is a static CLI→flag table, which is the
   `CLI_AGENT_REGEX` liability class this codebase already deleted once
   (`ptyPromptDelivery.ts:126-131`). See Change 3 for the decision.

## Metadata

**Complexity:** 3
**Tags:** reliability, cli, configuration
**Project:** Browser Switchboard

## User Review Required

None.

## Proposed Changes

### 1. Move the probe harness into the repo, then verify every flag

The measurements above came from `esc-semantics-probe.js`, which lives in a
session scratchpad under `/private/tmp/` — ephemeral, and gone the moment that
session's directory is reaped. Move it to `scripts/` alongside the existing
`scripts/capture-cli-modes.js`, which is the shipped precedent for a
node-pty-driven CLI probe. Everything below depends on being able to re-run it.

Then verify each candidate flag rather than trusting the help text:

| CLI | what it blocked on | candidate pre-consent surface | class |
|---|---|---|---|
| copilot | folder-trust menu on spawn | `--allow-all-paths` ("disable file path verification"), env `COPILOT_ALLOW_ALL` | trust |
| copilot | — | `--allow-all` | **permission — not a default** |
| gemini | ToS / workspace trust | `--skip-trust` ("trust the current workspace for this session") | trust |
| gemini | — | `--approval-mode` | **permission — not a default** |
| claude | workspace trust dialog (per its own `--help`) | settings-based trusted directories | trust |
| claude | — | `--permission-mode`, `--dangerously-skip-permissions` | **permission — not a default** |
| qwen | ToS notice | `--approval-mode`; `telemetry.enabled` in settings.json | mixed — classify per flag |
| droid | account login | **none — auth is a human action, out of scope** | — |

The protocol per row, in a directory that CLI has never been trusted in:

1. Spawn without the flag. Record what renders.
2. Spawn with the flag. Record what renders.
3. Type 8 characters. Record whether they echo.

A flag qualifies only when step 2 renders no prompt **and** step 3 echoes.
`--allow-all-paths` is documented as disabling path verification, which is
probably but not certainly the same gate as the trust menu — step 2 is what
settles it. Record the results in the table above, in this file, with the date.

### 2. Keep trust and permission apart — never fold them together

`--skip-trust` pre-answers "is this folder yours". `--allow-all` and
`--dangerously-skip-permissions` pre-answer "may I run anything". They are not
the same kind of flag and they must not share a mechanism just because they
happen to silence the same prompt.

Only the **trust** column above is a recommended default. The permission column
is documented as available and left to the user, with the distinction stated
where it is documented — not as a footnote.

> **Superseded:** "Default the *trust* half, surface the *permission* half as an
> explicit per-role choice with its own label."
> **Reason:** `agentStartupCommands[role]` is already a free-text field the user
> authors. A user who wants `--allow-all` types `--allow-all`. A second, labelled
> control for a subset of the same string is a new surface for something the
> existing one already does, and it would need its own composition rule against
> the free text beside it.
> **Replaced with:** document both columns against the field that already exists.
> Add no control.

### 3. Document the verified flags; do not rewrite the user's command

Two options were considered for surfacing this, and the decision is deliberate:

- **Rejected — a hint in the startup-command editor** ("your copilot command is
  missing `--allow-all-paths`"), keyed off the first token of the command string.
  This is a static CLI→flag table with a UI attached. It goes stale exactly the
  way `CLI_AGENT_REGEX` did, and a stale hint that names a flag a CLI no longer
  accepts is worse than no hint — it produces a seat that fails to launch at all.
- **Chosen — documentation only.** A table in the README / setup docs, next to
  where startup commands are explained, listing the verified flag per CLI and the
  trust/permission distinction from Change 2.

Never mutate a user's configured command. Silently widening a permission on
someone's machine is the failure mode this whole programme exists to prevent; it
does not become acceptable because the code doing it means well.

### Migration

None. No schema, no config keys, no on-disk format. Documentation and one moved
script.

## Verification Plan

### Goal Invariants

- A seat created through the normal path, in a directory the CLI has never seen,
  shows no folder-trust or ToS prompt when the documented flag is configured.
- No user-configured startup command is ever rewritten by Switchboard.
- No permission-widening flag is ever applied by default.
- The probe harness is runnable from the repo, not from a session scratchpad.

### Automated Tests

None warranted. This plan adds no code path — the deliverables are a moved
script, a measured table and documentation. A test asserting the content of a
docs table would assert the table against itself.

### Manual Verification

1. `node scripts/<probe>.js` runs from a clean checkout.
2. For each CLI in the table: spawn in an untrusted directory **without** the
   flag and confirm the prompt renders; spawn **with** the flag and confirm it
   does not, and that typed text echoes.
3. Configure the verified flag as the `coder` role's startup command, spawn the
   seat, and dispatch a plan. The prompt lands and submits with no human step.
4. Confirm the docs state the trust/permission distinction, and that no default
   anywhere carries a permission-widening flag.
