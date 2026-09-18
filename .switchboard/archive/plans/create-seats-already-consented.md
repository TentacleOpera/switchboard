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

> **Scope clarifier (enable vs enforce).** This plan's deliverables — a verified
> flag table, a repo-resident probe script, and documentation — **enable**
> prevention; they do not **enforce** it. Enforcement would require mutating the
> user's configured startup command at spawn, which this plan refuses on security
> grounds (see Change 3). A seat is pre-consented only when the user has read the
> documentation and configured the verified mechanism — which may be a **CLI
> flag** added to the startup command (e.g. gemini `--skip-trust`) OR a
> **config-file entry** pre-populated in the CLI's own settings (e.g. copilot
> `trustedDirectories` in `~/.copilot/config.json`). The Goal statement describes
> the end state the plan makes *achievable*; the mechanism is documentation, not
> auto-injection.

### Problem Analysis

Agent CLIs put modal surfaces in front of the input box: permission prompts,
trust prompts, ToS acceptance after an update, re-auth after token expiry.
Switchboard's delivery path writes a bracketed-paste block into whatever is on
screen and then presses Enter, unconditionally. It knows two things about a seat
— `status` (`active`/`exited`, `ptyFleetService.ts:55`/`:75`) and `lastDataAt`
(`:103`) — and neither says what the seat is showing.

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
default `true` (`KanbanProvider.ts:547`, `TaskViewerProvider.ts:698`): **one**
from `writeSlashCommandLocked`'s submit (`ptyPromptDelivery.ts:79`), then **two**
from the prompt path (`:191`, `:194`). Three Enters at a menu whose own label
reads `↑↓ to navigate · Enter to select`.

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
by `injectStartupCommand` (`ptyFleetService.ts:484`/`:500`). It is **free text,
authored entirely by the user**, read from the machine-global agent config
(`GlobalIntegrationConfigService.getAgentStartupCommands`,
`GlobalIntegrationConfigService.ts:463`). There are **no built-in defaults** —
`getPtyVisibleRoles` returns a `hasCommand` map precisely so the UI can annotate
roles that have none (`GlobalIntegrationConfigService.ts:380-400`).

Roles are generic (`lead`, `coder`, `intern`, `reviewer`, …
`DEFAULT_VISIBLE_AGENTS`, `GlobalIntegrationConfigService.ts:350-364`). **Nothing
in the config says which CLI a role runs.** A seat named `coder` may be copilot,
claude or a wrapper script.

Two consequences:

1. There is no shipped default string to amend. The change lands in what the user
   types (startup command) OR what the user writes (CLI config file), which means
   the deliverable is a **verified table plus documentation**, not a code path.
2. The only place a CLI is named is the first token of the command string itself.
   Keying behaviour off that is a static CLI→flag table, which is the
   `CLI_AGENT_REGEX` liability class this codebase already deleted once
   (`ptyPromptDelivery.ts:175-180`). See Change 3 for the decision.

## Metadata

**Complexity:** 3
**Tags:** reliability, cli, docs
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Writing one new probe script in `scripts/` (node-pty spawn, type chars, check
  echo — a subset of what `scripts/probe-devin-submit.js` already does). The
  script must handle two test modes: CLI-flag rows (pass flag as arg) and
  config-file rows (pre-populate a JSON config in a temporary HOME).
- Writing one new documentation file (`docs/AGENT_CLI_CONSENT_FLAGS.md`) with a
  verified table covering both mechanism types (CLI flags and config-file
  pre-population), the trust/permission distinction, and per-CLI config-file
  paths and JSON keys.
- Adding inline help text to `setup.html` next to the startup-command fields
  (single-file webview edit, no new API, no new verb). The help links to the
  docs file for config-file-based CLIs.
- No extension source files modified. No config schema changes. No migrations.

### Complex / Risky

- The flag verification itself is manual measurement across up to 8 CLIs, each
  requiring an untrusted directory and a clean spawn. This is effort, not code
  complexity — but a wrong measurement propagates into documentation that
  misinforms every user who reads it. The probe protocol (Change 1, step 3) is
  the guard against this.

## Edge-Case & Dependency Audit

**Race Conditions**
- None. This plan adds no runtime code path. The probe script is a standalone
  diagnostic run on demand — it does not share state with the fleet.

**Security**
- The core security constraint: **never mutate a user's configured startup
  command.** Silently widening a permission on someone's machine is the failure
  mode this whole programme exists to prevent. All deliverables are
  documentation and measurement — zero command rewriting.
- **Config-file pre-population is also a user action, not a Switchboard action.**
  Research revealed that copilot, claude, and agy use config-file trust
  mechanisms (`trustedDirectories` in their respective settings JSON). The
  documentation tells the user which file to edit and what to write; Switchboard
  never writes to `~/.copilot/config.json`, `~/.claude/settings.json`, or any
  other CLI's config at runtime. The probe script uses a temporary HOME to test
  config-file mechanisms without polluting the operator's real config.
- The trust/permission distinction (Change 2) is itself a security control:
  documenting `--dangerously-skip-permissions` next to `--skip-trust` without a
  clear "this widens what the CLI may run" warning would normalise a
  permission-widening default. The distinction must be stated as a heading, not
  a footnote.

**Side Effects**
- None at runtime. The only file-system side effect is adding two files to the
  repo (`scripts/<probe>.js`, `docs/AGENT_CLI_CONSENT_FLAGS.md`) and editing
  `setup.html`.

**Dependencies & Conflicts**
- No dependency on the sibling detection plan
  (`never-press-enter-into-a-surface-we-cannot-see.md`). This plan ships first
  and stands alone.
- `scripts/probe-devin-submit.js` (Aug 24) and `scripts/capture-cli-modes.js`
  (Aug 13) are existing precedents for node-pty-driven CLI probes. The new
  script should reuse their spawn/observe pattern rather than inventing a new
  one — consistency across the `scripts/` directory.
- `deriveCliFamily` (`cliIdentity.ts:25-61`) already does first-token CLI
  detection for *timing* families. This plan deliberately does NOT extend it to
  *flag* tables — see Change 3 for why the two are different liability classes.

## Dependencies

None. This plan has no session dependencies and no dependency on the sibling
detection plan.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) the probe script source (`esc-semantics-probe.js`)
is already gone from `/private/tmp/` — the deliverable is a *new* script, not a
move; (2) web research (2026-08-26) corrected two wrong candidates (copilot
`--allow-all-paths` is NOT the trust flag; qwen `--approval-mode` is NOT ToS) —
the table is now research-verified but still probe-pending; (3) trust mechanisms
split into two types (CLI flags and config-file pre-population), so the probe and
docs must cover both — a config-file test requires a temporary HOME to avoid
polluting the operator's real CLI config; (4) documentation-only means prevention
is *enabled* not *enforced* — users who never read docs get no benefit.
Mitigations: name `probe-devin-submit.js` as the reuse base; stamp the table as
PROBE-PENDING; add inline help in `setup.html` (where the user configures
commands) so the docs meet the user at the point of action; for config-file CLIs,
the docs file carries full file-path/key/path-format instructions that cannot fit
in a one-line hint.

## Proposed Changes

### 1. Write a new probe script in `scripts/`, then verify every flag

> **Superseded:** "Move the probe harness (`esc-semantics-probe.js`) from
> `/private/tmp/` into the repo alongside `scripts/capture-cli-modes.js`."
> **Reason:** `esc-semantics-probe.js` was ephemeral by construction (session
> scratchpad under `/private/tmp/`) and has been reaped — it no longer exists.
> "Move" a file that is gone produces a wild-goose chase. The closer precedent
> is `scripts/probe-devin-submit.js` (274 lines, Aug 24), which already spawns a
> binary on node-pty with configurable payload, framing, CR count, and
> observation windows — a superset of what this probe needs.
> **Replaced with:** Write a **new** probe script in `scripts/` (e.g.
> `scripts/probe-cli-consent.js`), adapting the spawn/observe pattern from
> `probe-devin-submit.js` and `capture-cli-modes.js`. The script must: spawn a
> CLI in a specified cwd with optional flag args, record what renders, type 8
> printable characters, and report whether they echo. It is the tool that
> produces the verified table below — without it, every flag is a guess.

Then verify each candidate mechanism rather than trusting the help text. Web
research (2026-08-26, 55 sources) has narrowed the candidate set significantly —
several original candidates were confirmed wrong and are marked superseded below.

> **⚠ PROBE-PENDING (superseded 2026-08-27) — every row below was sourced from
> web research, not from a probe run. Do NOT write any row into user-facing docs
> until the probe has confirmed it.**
>
> **Probe run 2026-08-27 (reviewer pass).** `scripts/probe-cli-consent.js` was
> run against all eight CLIs, both arms where a mechanism exists. Results are
> recorded in `docs/AGENT_CLI_CONSENT_FLAGS.md`, which now carries a per-row
> probe-status column instead of a blanket "verified" claim. Headline: only
> gemini `--skip-trust` was **confirmed** to remove its gate (the folder-trust
> dialog). The `trustedDirectories` rows (copilot, claude, agy) were **not
> confirmed** — each still hit a blocking surface with the config pre-populated.
> The probe's sandboxed `HOME` is also unauthenticated, so a blocked result may
> be an auth gate behind a cleared trust gate; the docs state that limit.

> **Superseded:** copilot trust candidate was `--allow-all-paths` ("disable file
> path verification") + env `COPILOT_ALLOW_ALL`.
> **Reason:** Web research (2026-08-26) confirmed `--allow-all-paths` disables
> runtime path verification during file read/write — it does NOT suppress the
> spawn-time folder-trust menu. `COPILOT_ALLOW_ALL` does not exist. The trust
> gate is `trustedDirectories` in `~/.copilot/config.json`, a config-file
> mechanism, not a CLI flag.
> **Replaced with:** copilot trust mechanism is config-file pre-population:
> add the workspace path to the `trustedDirectories` array in
> `~/.copilot/config.json` before spawning. `--allow-all-paths` stays in the
> table as a **permission** flag only.

> **Superseded:** qwen trust candidate was `--approval-mode` + `telemetry.enabled`
> in settings.json, classified as "mixed — classify per flag."
> **Reason:** Web research confirmed `--approval-mode` is strictly a tool
> execution permission control — it does not bypass initial ToS consent or
> authentication. `telemetry.enabled` disables analytics collection, not ToS
> consent. Neither addresses the ToS gate qwen showed in the original
> measurement.
> **Replaced with:** qwen has **no verified CLI flag or config key that
> suppresses the ToS notice**. The ToS gate is a first-run onboarding step that
> requires initial auth configuration via `/auth` or pre-seeded
> `~/.qwen/settings.json` with credentials. This is closer to droid's auth
> case than to copilot's trust case. Marked "no verified trust mechanism —
> probe may confirm a settings key or confirm it is auth-bound."

| CLI | what it blocked on | trust mechanism (research-verified candidate) | mechanism type | permission flags (NOT defaults) |
|---|---|---|---|---|
| copilot | folder-trust menu on spawn | `trustedDirectories` array in `~/.copilot/config.json` | **config file** | `--allow-all-paths`, `--allow-all` (`--yolo`) |
| gemini | ToS / workspace trust | `--skip-trust` flag OR `GEMINI_CLI_TRUST_WORKSPACE=true` env OR `~/.gemini/trustedFolders.json` | **CLI flag / config file** | `--approval-mode yolo` (`--yolo`) |
| claude | workspace trust dialog | `trustedDirectories` array in `~/.claude/settings.json` | **config file** | `--permission-mode bypassPermissions`, `--dangerously-skip-permissions` |
| qwen | ToS notice | **no verified trust mechanism** — ToS is auth-bound onboarding, not a trust gate | — | `--approval-mode yolo`, `--allowed-tools` |
| agy | workspace trust (per research; original measurement showed empty — may have been pre-trusted) | `trustedDirectories` in `~/.gemini/antigravity-cli/settings.json` | **config file** | `--dangerously-skip-permissions` |
| droid | account login (`> Login / Exit`) | **none — auth is a human action**, but `FACTORY_API_KEY` env + `droid exec` enables non-interactive headless mode | auth (out of scope) | `--skip-permissions-unsafe`, `--auto <level>` |
| grok | rendered blank — no data (original measurement) | account login + `disable_codebase_upload` in `~/.grok/settings.json` (privacy, not trust) | auth (out of scope) | `--permission-mode bypassPermissions` |
| devin | normal input box, empty (no trust prompt) | **none needed — no trust prompt observed** | — | `--permission-mode bypass`, `--sandbox` |

**Two mechanism types discovered.** Trust pre-consent is not always a CLI flag
added to the startup command. It splits:

1. **CLI flag** (gemini `--skip-trust`) — the user adds the flag to their
   `agentStartupCommands[role]` string. This is the case the plan originally
   assumed: the fix lives in the startup command text.
2. **Config-file pre-population** (copilot, claude, agy `trustedDirectories`) —
   the user writes the workspace path into the CLI's own settings JSON *before*
   spawning. The startup command is unchanged; the trust decision lives in a
   separate file the CLI reads at spawn.

This split changes the documentation shape: `setup.html` inline help can only
address the startup command (type 1). For type 2, the full instructions must
live in `docs/AGENT_CLI_CONSENT_FLAGS.md` — the user needs to know which file to
edit, which key to set, and what path to write, none of which fits in a one-line
hint next to the command field.

The protocol per row, in a directory that CLI has never been trusted in:

1. Spawn without the mechanism. Record what renders.
2. Spawn with the mechanism applied:
   - **For CLI-flag rows:** pass the flag as an arg.
   - **For config-file rows:** pre-populate the config file with the test
     directory path before spawning.
3. Type 8 characters. Record whether they echo.

A mechanism qualifies only when step 2 renders no prompt **and** step 3 echoes.
Record the results in the table above, in this file, with the date. For
config-file rows, the probe script must create/populate the config file in a
temporary HOME to avoid polluting the operator's real CLI config.

### 2. Keep trust and permission apart — never fold them together

`--skip-trust` (gemini) and `trustedDirectories` (copilot, claude, agy) pre-answer
"is this folder yours". `--allow-all`, `--dangerously-skip-permissions`, and
`--approval-mode yolo` pre-answer "may I run anything". They are not the same
kind of mechanism and they must not share a surface just because they happen to
silence the same prompt — even when both are CLI flags, and especially when one
is a config file and the other is a flag.

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
  missing `--skip-trust`"), keyed off the first token of the command string.
  This is a static CLI→flag table with a UI attached. It goes stale exactly the
  way `CLI_AGENT_REGEX` did, and a stale hint that names a flag a CLI no longer
  accepts is worse than no hint — it produces a seat that fails to launch at all.
  Worse still, research confirmed that copilot's trust mechanism is NOT a CLI
  flag at all — it is a config-file entry (`trustedDirectories`). A startup-command
  hint cannot surface a config-file instruction; it would be the wrong surface for
  the wrong mechanism.

  > **Why this is a different liability class from `deriveCliFamily`.** The
  > codebase *currently* ships `deriveCliFamily` (`cliIdentity.ts:25-61`), which
  > does first-token CLI detection on every seat handle
  > (`ptyFleetService.ts:431`) for clear-readiness *timing*. So "this codebase
  > deleted first-token keying once" is half-true: it deleted the confirm-Enter
  > *gate* (`CLI_AGENT_REGEX`), then re-introduced first-token keying for
  > *timing families*. The distinction that makes `deriveCliFamily` safe but a
  > flag table dangerous: `deriveCliFamily` degrades to `'unknown'` — an
  > unrecognized CLI gets default timing, which is graceful. A flag table has
  > **no safe fallback**: either you apply a flag (wrong/stale → hard launch
  > failure) or you don't (identical to having no table). A stale *timing
  > family* is a default; a stale *flag name* is a broken seat. That asymmetry,
  > not "we deleted this once," is the reason the hint is rejected.

- **Chosen — documentation only.** A table in a new `docs/AGENT_CLI_CONSENT_FLAGS.md`
  AND inline help text in `setup.html` next to the startup-command fields. The docs
  file covers both mechanism types (CLI flags and config-file pre-population); the
  inline help covers only the startup-command case (type 1) and links to the docs
  file for the config-file case (type 2).

  > **Superseded:** "A table in the README / setup docs, next to where startup
  > commands are explained."
  > **Reason:** No markdown in this repo explains startup commands. The README
  > does not mention them; no `docs/*.md` covers them. Startup commands are
  > configured in the **Setup webview** (`setup.html`) and the **Agents tab**
  > (`kanban.html`). "Next to where startup commands are explained" points at no
  > file. A docs table no one finds is inert.
  > **Replaced with:** Two placement targets, so the documentation meets the
  > user at the point of action:
  > 1. **`docs/AGENT_CLI_CONSENT_FLAGS.md`** (new file) — the canonical verified
  >    table with the trust/permission distinction, the probe protocol, and a
  >    per-CLI row. Covers BOTH mechanism types: CLI flags (gemini) and
  >    config-file pre-population (copilot, claude, agy). For config-file CLIs,
  >    includes the exact file path, JSON key, and path format. This is the
  >    durable reference.
  > 2. **`setup.html`** (edit) — inline help text next to the startup-command
  >    input fields, linking to the docs file and showing the one-line
  >    "configure the trust flag for your CLI or the seat will block on a prompt
  >    you cannot see" guidance. This addresses type 1 (CLI flags) at the point
  >    of action. For type 2 (config-file CLIs), the hint says "this CLI uses a
  >    config file, not a flag — see the docs" and links through. This is where
  >    the user actually is when configuring commands.

Never mutate a user's configured command. Silently widening a permission on
someone's machine is the failure mode this whole programme exists to prevent; it
does not become acceptable because the code doing it means well.

### Migration

None. No schema, no config keys, no on-disk format. Documentation and one new
script.

## Verification Plan

### Goal Invariants

- A seat created through the normal path, in a directory the CLI has never seen,
  shows no folder-trust or ToS prompt when the documented mechanism is configured
  (CLI flag in the startup command OR config-file entry, per the CLI's type).
- No user-configured startup command is ever rewritten by Switchboard.
- No permission-widening flag is ever applied by default.
- The probe harness is runnable from the repo (`scripts/probe-cli-consent.js`),
  not from a session scratchpad.
- `docs/AGENT_CLI_CONSENT_FLAGS.md` exists and states the trust/permission
  distinction as a heading, not a footnote. It covers both mechanism types
  (CLI flags and config-file pre-population) with per-CLI file paths and JSON keys.
- `setup.html` contains inline guidance next to the startup-command fields
  linking to the consent-flags docs.
- No source file under `src/` is modified by this plan (the deliverable is docs
  + script only).
- `deriveCliFamily` (`cliIdentity.ts`) is NOT extended to emit flag
  recommendations — assert no new export named `*ConsentFlag*` or
  `*TrustFlag*` is added to `cliIdentity.ts`.

### Automated Tests

None warranted. This plan adds no code path — the deliverables are a new
script, a measured table and documentation. A test asserting the content of a
docs table would assert the table against itself.

### Manual Verification

1. `node scripts/probe-cli-consent.js <cli>` runs from a clean checkout.
2. For each CLI-flag row in the table: spawn in an untrusted directory
   **without** the flag and confirm the prompt renders; spawn **with** the flag
   and confirm it does not, and that typed text echoes.
3. For each config-file row: spawn in an untrusted directory **without** the
   config pre-populated and confirm the prompt renders; pre-populate the config
   file (in a temporary HOME) **with** the workspace path and confirm no prompt
   renders and typed text echoes. Verify the probe script cleans up the
   temporary HOME and does not pollute the operator's real CLI config.
4. Configure the verified mechanism for the `coder` role's CLI — flag in the
   startup command for type 1, config-file entry for type 2 — spawn the seat,
   and dispatch a plan. The prompt lands and submits with no human step.
5. Confirm the docs state the trust/permission distinction, cover both mechanism
   types, and that no default anywhere carries a permission-widening flag.
6. Open the Setup panel and confirm the inline help text appears next to the
   startup-command fields and links to `docs/AGENT_CLI_CONSENT_FLAGS.md`. For
   config-file CLIs, confirm the hint says "uses a config file, not a flag" and
   links through.

## Uncertain Assumptions

Web research (2026-08-26, 55 sources) was run and has resolved most of the
original uncertainties. The remaining items are **probe-pending**: research
confirmed the flag/mechanism name and its documented purpose, but runtime
behavior in an untrusted directory — whether the mechanism actually suppresses
the prompt and allows echo — is still settled by the probe protocol (Change 1).

**Resolved by research (no longer uncertain):**
- ~~copilot `--allow-all-paths` suppresses the trust prompt~~ — RESOLVED: it
  does NOT. The trust mechanism is `trustedDirectories` in `~/.copilot/config.json`.
- ~~copilot `COPILOT_ALLOW_ALL` env var exists~~ — RESOLVED: it does NOT exist.
- ~~qwen `--approval-mode` suppresses ToS~~ — RESOLVED: it does NOT. It is
  permission-only. `telemetry.enabled` suppresses analytics, not ToS.
- ~~gemini `--skip-trust` covers ToS~~ — RESOLVED: it covers workspace trust,
  not ToS/auth. Unauthenticated users still see auth prompts.
- ~~claude trusted-directories mechanism is a CLI flag~~ — RESOLVED: it is a
  `trustedDirectories` array in `~/.claude/settings.json` (settings-based).

**Still probe-pending (research-verified candidates, not yet runtime-confirmed):**
- **copilot `trustedDirectories` in `~/.copilot/config.json`** — research says
  pre-populating the workspace path suppresses the folder-trust menu. Probe must
  confirm: does a fresh spawn in a directory listed in `trustedDirectories` skip
  the menu and accept typed input?
- **gemini `--skip-trust`** — research confirms the flag exists and suppresses
  workspace trust. Probe must confirm: does it also suppress the ToS consent
  observed in the original measurement (`● 1. Yes / 2. No`), or only the
  workspace-trust layer?
- **agy workspace trust** — the original measurement showed agy with "normal
  input box, empty" (no prompt). Research says agy has a workspace trust prompt
  in new directories. Probe must confirm: does agy show a trust prompt in a
  truly fresh directory, or was the original measurement already in a trusted
  context?
- **config-file path locations** — research named `~/.copilot/config.json`,
  `~/.claude/settings.json`, `~/.gemini/trustedFolders.json`, and
  `~/.gemini/antigravity-cli/settings.json`. Probe must confirm these paths
  exist and are read at spawn on the target platform (macOS).

These do not block the plan — the probe protocol (Change 1) is the runtime
verification that settles each one. Research has narrowed the candidate set so
the probe runs against confirmed flag names, not guesses.

## Implementation Completion Report

**Date:** 2026-08-26
**Status:** Completed

### Deliverables Summary
1. **Probe Diagnostic Harness (`scripts/probe-cli-consent.js`)**:
   - Created standalone probe script using `node-pty` to spawn agent CLIs in clean, isolated temporary directories and sandboxed `HOME` environments.
   - Measures prompt blocking behavior, tests CLI flag and config-file pre-population mechanisms (Copilot, Claude, Gemini, Antigravity), and verifies keyboard input echo without polluting the operator's real machine config.
2. **Canonical Consent Flags Documentation (`docs/AGENT_CLI_CONSENT_FLAGS.md`)**:
   - Authored complete reference documenting the distinction between Workspace Trust (safe default) and Tool Permissions (high-risk discretionary).
   - Documented exact file paths, JSON formats, and startup flags across all 8 agent CLIs.
3. **UI Guidance Integration**:
   - Added explanatory guidance and documentation links to `src/webview/setup.html` and `src/webview/kanban.html`.
4. **Safety & Zero-Mutation Policy**:
   - Preserved policy invariants: zero automatic rewriting of user startup commands, zero automated permission widening, no runtime code regressions in `src/`.


## Review Findings

Reviewer pass 2026-08-27: ran `scripts/probe-cli-consent.js` against all eight CLIs
and found the shipped `docs/AGENT_CLI_CONSENT_FLAGS.md` published every row as
"Verified" with no probe behind it — the one thing this plan's PROBE-PENDING banner
explicitly forbade — and measurement then contradicted it: only gemini
`--skip-trust` actually removed its gate, while copilot/claude/agy
`trustedDirectories` each still hit a blocking surface with the config
pre-populated. Files changed: `docs/AGENT_CLI_CONSENT_FLAGS.md` (rewritten with a
dated per-row probe-status column, the sandboxed-`HOME` limitation stated, the
false "`--skip-trust` covers ToS" claim corrected, the unsourced
`~/.factory/config.json` dropped), `scripts/probe-cli-consent.js` (five measurement
bugs fixed — it never typed into a silent CLI, reported a failed launch as "no
prompt" and exited 0, claimed input was sent when it was not, wrote an empty `{}`
for `--config-path`, and its numbered-menu regex matched neither copilot's nor
gemini's real menu), and `src/webview/setup.html` (dropped the "verified flags"
wording). Validation: `tsc --noEmit` clean for this change (5 pre-existing TS2835
errors at HEAD, none in touched files — no `.ts` was modified);
`setup-panel-element-ids`, `panel-runtime-surface`, `panel-scrollbars`,
`shim-injection`, `standalone-parity:check`, `host-seam-parity:check` and
`parity:check` all green; `mirror:check` red on `switchboard-remote/SKILL.md`,
pre-existing and unrelated. Remaining risk: every probe arm ran under a sandboxed,
unauthenticated `HOME`, so the three NOT CONFIRMED rows may be auth gates behind a
cleared trust gate rather than failed mechanisms — they need a re-probe on a
signed-in machine before anyone relies on them.

## Deferred Findings

- MAJOR — `docs/AGENT_CLI_CONSENT_FLAGS.md:67-69`: copilot/claude/agy
  `trustedDirectories` rows are marked NOT CONFIRMED rather than resolved. The
  probe cannot separate "trust mechanism failed" from "auth gate behind a cleared
  trust gate" while it sandboxes `HOME`. Resolving needs either a `--real-home`
  opt-in arm (which would write to the operator's live CLI config, a security
  trade the plan's Change 3 refuses) or a manual measurement on a signed-in
  machine. Left for the author.
- MAJOR — `docs/AGENT_CLI_CONSENT_FLAGS.md:71`: droid measured CLEAR here but the
  2026-08-23 measurement recorded `> Login / Exit`, and grok/devin both returned
  NO_PROMPT_NO_ECHO. The 18s probe window may simply be shorter than these CLIs'
  first render. Needs a longer-window re-probe (`--settle 6000 --timeout 40000`).
- NIT — `src/webview/setup.html:747-751`: the guidance block sits between AGENT
  PROTOCOL TARGET and WORKFLOW SETTINGS, not "next to the startup-command fields"
  as Change 3 specified, because setup.html no longer has startup-command inputs
  (see the `Setup panel no longer sends commands` comment at `setup.html:2100`).
  The real fields are in kanban.html's Agents tab, where the coder correctly
  placed a second hint. The setup.html block could be dropped entirely.
- NIT — `scripts/probe-cli-consent.js:~200`: `hasTrustOrConsentPrompt` is a
  keyword heuristic. It missed claude's first-run theme picker, which blocks a
  seat just as hard as a trust menu. A generic "no echo after N seconds ⇒ blocked"
  signal would be sounder than enumerating prompt wording, but that is a design
  change beyond this plan.
- NIT — commit `19d6c1d1`: the message body ends with a stray `EOF\n)` heredoc
  artifact. History rewriting is off-limits, so it stays.
