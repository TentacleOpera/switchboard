# A Seat Reports Done and Nothing Else

## Goal

`switchboard done`. No arguments. A finished seat signals that it is finished; it assembles
nothing, quotes nothing, and states no fact the host already holds.

### The bug

The host injects the seat's identity into the seat's own environment when it creates the pty
(`cmd/switchboard-pty-host/main.go:287`):

```go
env = append(env, "SWITCHBOARD_TERMINAL="+name, "SWITCHBOARD_AGENT_INSTANCE_ID="+agentID)
```

The Node pty fleet does the same (`src/standalone/ptyFleetService.ts:547`), so the variable is
present in **both** composition roots. `grep SWITCHBOARD_TERMINAL src/standalone/cli.ts` returns
**nothing**. The CLI never reads it, and every completion instruction therefore makes the agent
type the name back:

```
switchboard done --from "<your terminal name>"
```

> **Superseded:** The original bug section quoted the completion instruction as
> `POST /kanban/task/complete {"from":"…","planId":"…","workspaceRoot":"…"}` and listed all three
> fields as agent-supplied "things the host already holds."
> **Reason:** That conflates two distinct endpoints and roles. `POST /kanban/task/complete` is the
> **lead's** asserted-completion path — the lead names *which* plan is complete (`planId` is
> required, `LocalApiServer.ts:4615`); that is the lead's job, a different role. The **seat's**
> completion path is `switchboard done` → `POST /kanban/queue/done`, whose instruction is
> `done --from "<your terminal name>"` — **one** field (`from`), not three. The seat never
> supplies `planId` to `done` (it is optional, a validation guard only — `_runQueueDone` resolves
> the held card by `dispatchedTerminal === from`, `LocalApiServer.ts:6465`) and never supplies
> `workspaceRoot` (the CLI fills it from the host root, `cli.ts:2017`).
> **Replaced with:** The bug is the **one** field the seat actually supplies — `from` — which the
> host already injected into the seat's env at create. The instruction should not make the agent
> type it back.

The one field, and where the host already has it:

|| Field | Where the host already has it |
|| :--- | :--- |
|| `from` | `SWITCHBOARD_TERMINAL`, injected into this seat at create (Go pty host `main.go:287` AND Node `ptyFleetService.ts:547`) |

### Why it matters more than it looks

Every field an agent must supply is a field it can get wrong, and a decision it has to stop and
make. The measured cost, from `Coding-intern`'s session log on 2026-09-13: the seat finished its
work correctly, then spent its remaining turns working out what to send — reading
`LocalApiServer.ts:4568-4657` and `:3690-3759`, grepping `./src/standalone` for
`done|--from|task/complete|queue/done`, assembling a 3389-byte body into a temp file, and asking
the operator which call was correct. It ended at 139k/200k context with the card released and not
completed.

None of that was about the work. It was about the shape of the report.

This is the same rule as no summaries, applied to the fields instead of the prose: **the
completion post carries nothing the agent has to assemble.** A summary is the obvious case. A
terminal name the host injected is the same mistake wearing a smaller hat.

### Non-goals

- **Removing the post.** Completion is asserted, never inferred from board position. The post
  stays; only its payload goes.
- **Guessing an identity.** If `SWITCHBOARD_TERMINAL` is absent the call fails loudly and says so
  — a completion attributed to the wrong seat clears the wrong terminal, and CLAUDE.md's rule on
  identity reads applies in full.
- **Reintroducing `outcome`.** No summaries, in any field.
- **Touching the lead's `task/complete` path.** The lead's asserted-completion endpoint
  (`POST /kanban/task/complete`) legitimately requires `planId` — naming which plan is complete is
  the lead's role. This plan changes only the **seat's** `done` / `queue/done` path. The lead's
  instructions (`standingOrderFragments.ts:114`, `teamWiring.ts:652`) keep their fields.
- **Touching `switchboard next`.** `next --from` carries the same one-field friction, but `done`
  is the completion signal and the scope of this plan. `next` is noted as a parallel, not pulled in.

## Metadata

- **Complexity:** 3
- **Tags:** cli, teams, completion, ux

## User Review Required

None.

## Complexity Audit

### Routine
- Defaulting `--from` to `process.env.SWITCHBOARD_TERMINAL` in `cmdDone` (`src/standalone/cli.ts:1984`) — a three-line env read with a loud-fail branch.
- Updating the standing-order fragment strings to drop `--from "<your terminal name>"` → bare `done`. All fragments live in shared `src/services/` files reached by both composition roots, so one edit lands in both hosts.
- Updating the one existing contract test that positively asserts `done --from` (`member-completion-reminder-contract.test.js:337`).

### Complex / Risky
- The env-absent failure path: a seat the host did not create (a human shell, a misconfigured seat) must fail loudly naming the variable, never silently fall through to an empty `from` that the server 400s with a generic message. The error text is the only signal that distinguishes "you are not in a seat" from "you typed the command wrong."

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `--from` resolution is a synchronous env read before the HTTP call; the server-side `_runQueueDone` critical section is unchanged.
- **Security:** A spoofed `SWITCHBOARD_TERMINAL` in a hand-rolled shell could attribute completion to another seat. This is unchanged by the plan — the env var is already the trust source for `from` when the agent supplies it; defaulting to it does not widen the trust surface. The host-injected value is the trust anchor; a seat that overrides its own env to impersonate another seat was always able to via `--from`.
- **Side Effects:** `--from` stays accepted (human CLI use from outside a seat). No behaviour change for callers that pass it explicitly. The default only fires when the flag is absent.
- **Dependencies & Conflicts:**
  - `src/test/member-completion-reminder-contract.test.js:337` positively asserts `/done --from/.test(sent[0].body)`. Changing the member completion fragment to bare `done` turns this red. The test must be updated in the same diff (assert bare `done` is present, `--from` is absent from the *seat* route). Line 350's negative assertion (external-head members do NOT get `done --from`) still holds.
  - `src/test/cli-board-commands-contract.test.js:829` asserts `done` is a dispatched subcommand — unaffected (the verb stays).
  - `src/services/__tests__/agentPromptBuilder.test.ts:345,353,394` assert directives reference `POST /kanban/queue/done` (the HTTP path string), not `done --from` — unaffected by the CLI-arg change, but re-check after the fragment edits.

## Dependencies

- `sess_2026-09-13-coding-intern` — the measured completion-friction session that motivated this plan (the seat spent its remaining turns assembling the report instead of stopping).

## Adversarial Synthesis

Key risks: (1) the plan originally conflated the seat's `done`/`queue/done` with the lead's
`task/complete`, claiming three agent-supplied fields when the seat supplies one — corrected via
Superseded callouts so the implementer does not "fix" already-shipped host resolution or strip the
lead's required fields. (2) The verification's blanket "no agent-facing string names a field" would
falsely flag the lead's correct `task/complete` instruction — scoped to seat-facing strings only.
(3) One existing contract test (`member-completion-reminder-contract.test.js:337`) positively
asserts `done --from` and must move with the change. Mitigations: narrow scope to the `--from`
default + fragment text + the one test; leave host resolution, the lead path, the 409, and `next`
alone.

## Proposed Changes

### 1. `src/standalone/cli.ts` — `cmdDone` resolves `--from` from the env

- **Context:** `cmdDone` (`cli.ts:1984`) currently requires `--from` and exits 5 when absent (`cli.ts:2003-2007`). The seat's terminal name is already in `process.env.SWITCHBOARD_TERMINAL` (injected by both pty hosts), but the CLI never reads it.
- **Logic:** After parsing argv, if `from` is unset, read `process.env.SWITCHBOARD_TERMINAL`. If present and non-empty, use it. If absent, fail loudly: print a message that names the variable (`SWITCHBOARD_TERMINAL is not set — this command is run from inside a seat. If you are driving the CLI by hand, pass --from <seat>.`) and exit non-zero. Do **not** fall back to an empty string, `unknown`, or any placeholder — per CLAUDE.md's identity-reads rule, a default that behaves like a real value turns a loud failure into a wrong answer.
- **Implementation:** Replace the `if (!from)` block at `cli.ts:2003-2007`. Keep `--from` accepted (the human-CLI path). The body construction at `cli.ts:2016-2023` is unchanged — it still sends `from` and `workspaceRoot` to `/kanban/queue/done`; the win is the agent types nothing, not that the body is empty.
- **Edge Cases:** A human running `switchboard done` from outside a seat with no env var gets the loud-fail message naming `--from` as the manual override. A seat whose host forgot to inject the var fails the same way (a host bug, surfaced, not papered over).

### 2. `src/services/standingOrderFragments.ts` — seat-facing instructions become bare `done`

- **Context:** The seat-facing completion instructions all say `done --from "<your terminal name>"`. With `--from` defaulted, the agent should type bare `done`.
- **Logic:** Drop `--from "<your terminal name>"` from the **seat-facing** fragments only:
  - `buildMemberCompletionFragment` step 1 (`:82`, `:86`) → `run node "<cliPath>" done.` / `run node "<cliPath>" done --outcome failed with a one-line reason.`
  - `buildHeadNextFragment` (`:134`) → `run node "<cliPath>" done.`
  - `GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY` (`:208`) → `run node "<cliPath>" done.`
- **Keep the lead-facing fragments unchanged:** `buildHeadCompletionFragment` (`:114`, `task/complete` with `from`/`planId`/`workspaceRoot`) — the lead is a different role and names which plan is complete. Do NOT touch it.
- **Keep the file-based-queue route unchanged:** step 2 (`:89`, `POST /terminals/teams/<id>/queue/done with {"from":"<your terminal name>"}`) is raw HTTP, not the CLI; the seat reads its own `SWITCHBOARD_TERMINAL` env and puts `from` in the body. That path is out of scope for this plan (it still assembles one field); note it, do not change it.
- **Edge Cases:** The `<cliPath>` token substitution is unchanged. The `--outcome failed` variant keeps its `--outcome` flag (only `--from` is dropped).

### 3. `src/services/teamWiring.ts` — `TEAM_CODER_QUEUE_DONE_INSTRUCTION` becomes bare `done`

- **Context:** `TEAM_CODER_QUEUE_DONE_INSTRUCTION` (`teamWiring.ts:298-302`) says `done --from "<your terminal name>"` (and the `switchboard done --from` mirror).
- **Logic:** Drop `--from "<your terminal name>"` → `run node "<cliPath>" done (or switchboard done).` Keep the `--outcome failed` variant's `--outcome` flag.
- **Edge Cases:** This string has a mirrored copy in `terminals.js` (per the file's own comment: "Two copies only: this one and the `terminals.js` mirror"). Both must move together or `stage-marker-commit-contract.test.js` (which gates both halves) goes red. Find and update the mirror in the same diff.

### 4. `src/services/agentPromptBuilder.ts` — completion-report directives become bare `done`

- **Context:** Three directives say `done --from "<your terminal name>"`:
  - `CODING_COMPLETION_REPORT_DIRECTIVE` (`:1197`)
  - `COMPLETION_STEP_FULL` (`:1264`)
  - `COMPLETION_STEP_COMPACT` (`:1266`)
  - `MISSION_CONTROL_REPORT_DIRECTIVE` (`:1292`) references `switchboard done --from "<your terminal name>"` in prose.
- **Logic:** Drop `--from "<your terminal name>"` → bare `done` in all four. These are seat-facing (coder/reviewer/mission-control seats), not lead-facing.
- **Edge Cases:** `agentPromptBuilder.test.ts` asserts directives contain `POST /kanban/queue/done` (the HTTP path string), not `done --from` — re-run after the edit to confirm no assertion broke.

> **Superseded:** Original Proposed Change #2 ("The card resolves from the seat, not from the
> agent") and #3 ("workspaceRoot stops being an agent-supplied field") were listed as new work.
> **Reason:** Both are already shipped. `_runQueueDone` resolves the held card by
> `dispatchedTerminal === from` (`LocalApiServer.ts:6465`) — the agent never supplies `planId` to
> `done`. `cmdDone` fills `workspaceRoot` from the CLI's own root (`cli.ts:2017`) — the agent never
> types it. The HTTP handler defaults `workspaceRoot` to `this._options.workspaceRoot`.
> **Replaced with:** No host-side resolution change. The remaining work is the *instruction text*
> (the fragments still *say* `--from`), covered by Proposed Changes 2–4 above.

> **Superseded:** Original Proposed Change #5 ("POST /kanban/task/complete accepts an empty body
> from a seat, resolving identity the same way").
> **Reason:** The HTTP server cannot read the caller's `SWITCHBOARD_TERMINAL` env over a socket —
> the variable lives in the seat's process, not the HTTP request. "Empty body" is achievable only
> because the **CLI** reads the env and fills `from` (Proposed Change 1). A raw-HTTP agent (no CLI)
> still must read its own env and put `from` in the body. The `task/complete` endpoint is also the
> **lead's** path, not the seat's, and requires `planId`.
> **Replaced with:** No HTTP contract change. The win is "the agent types nothing" (CLI fills
> `from` from env), not "the body is empty." The `queue/done` body still carries `from`; the
> `task/complete` body still carries `from`/`planId`/`workspaceRoot` for the lead.

> **Superseded:** Original Proposed Change #4's claim about the 409 body at
> `LocalApiServer.ts:3740` ("The 409's remedy text names the two doors — finished, or release — and
> no fields at all").
> **Reason:** That 409 fires on the **dispatch/next** path when a team is in-flight — a
> lead/mission-control operation. Seats do not hit it (the standing orders forbid `next`). Its
> remedy correctly tells the lead to `POST /kanban/task/complete` or `POST /kanban/card/release`,
> both of which legitimately need fields. Stripping its fields would gut correct lead guidance to
> chase a seat-friction bug the 409 does not cause.
> **Replaced with:** The 409 is left untouched. It is lead-facing, out of scope.

## Verification Plan

### Automated Tests

1. **New** `src/test/bare-completion-contract.test.js`, wired as `test:contract:bare-completion`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked is not
   a gate. Asserts: `done` with no arguments and `SWITCHBOARD_TERMINAL` set completes the calling
   seat's card; with `SWITCHBOARD_TERMINAL` unset it fails naming the variable and completes nothing;
   an explicit `--from` still works and overrides the env default.
2. **Update** `src/test/member-completion-reminder-contract.test.js:337` — the fallback body
   assertion moves from `/done --from/` to bare `/done/` (and asserts `--from` is absent from the
   seat route). Line 350's negative assertion (external-head members do NOT get the POST recipe)
   stays. This test is a **dependency**, not optional — it goes red the moment the fragment changes.
3. Assert no **seat-facing** agent-facing string — payload template, standing-order fragment,
   completion directive, or skill file — instructs a seat to supply `from` to the `done` command.
   **Scope this to seat-facing (member/coder/standalone) strings only.** The lead's
   `task/complete` instruction (`standingOrderFragments.ts:114`, `teamWiring.ts:652`) legitimately
   requires `from`/`planId`/`workspaceRoot` and MUST NOT be flagged. A blanket grep over all
   agent-facing strings would either falsely flag the lead path or force a carve-out so wide it
   stops protecting the seat path — this is the assertion that keeps the fields from creeping back
   one instruction at a time, which is how `outcome` survived five corrections and a contract test.
4. Assert a seat holding two dispatched cards is told so, and neither is completed (this is
   already `_runQueueDone`'s behaviour — the test pins it so a future change cannot silently pick
   one).

### Goal Invariants

- A finished seat completes with `switchboard done` and no arguments.
- No seat-facing instruction anywhere names the `--from` field (the lead's `task/complete` instruction is out of scope and may keep its fields).
- A seat whose `SWITCHBOARD_TERMINAL` is unset completes nothing, fails loudly naming the variable, and does not fall back to a placeholder.
- The host still resolves the held card from the seat's identity (`dispatchedTerminal === from`); the agent supplies no `planId` and no `workspaceRoot` to `done`.

## Review Findings

This plan arrived with **no implementation**: `src/standalone/cli.ts` was untouched, `grep
SWITCHBOARD_TERMINAL src/standalone/cli.ts` still returned nothing, every fragment still read `done
--from "<your terminal name>"`, and neither `test:contract:bare-completion` nor its test file
existed. Proposed Change 1 is now implemented — `cmdDone` defaults `--from` to
`process.env.SWITCHBOARD_TERMINAL`, fails loudly naming the variable when it is absent or blank
(no placeholder, no `unknown`), keeps `--from` accepted and winning, and tags the resolved identity
with the source that answered (`fromSource`) on both the success and offline paths per CLAUDE.md's
identity rule. New `src/test/bare-completion-contract.test.js` (10 checks, spawning the real built
CLI in a scratch cwd so resolution order is observable without a board) is wired as
`test:contract:bare-completion` and invoked from `.github/workflows/integration-tests.yml:599`.
Proposed Changes 2–4 (stripping `--from` from the shared seat-facing instruction fragments) are
**not** implemented — see `### Review Deviations`; the card is returned to PLAN REVIEWED for that
decision. Validation: the new suite 10/10, `cli-board-commands` green, `compile-tests` and eslint
clean (0 errors).

## Deferred Findings

- CRITICAL — `src/services/standingOrderFragments.ts:82` Proposed Changes 2–4 not implemented (also `:86`, `:134`, `:208`; `teamWiring.ts:298-302` + its `terminals.js` mirror; `agentPromptBuilder.ts:1197`, `:1264`, `:1266`, `:1292`). Blocked on the extension-host divergence described under Review Deviations — an author decision, not an implementation detail.
- MAJOR — `src/services/hostSeams.ts:258` `VscodeTerminalBackend.create` passes no `env` to `vscode.window.createTerminal`, so extension-host seats created there carry no `SWITCHBOARD_TERMINAL`. Same at `TaskViewerProvider.ts:7399`, `:13122`, `:28924` and `extension.ts:3725`. This is the blocker above, and closing it is the cleanest way to unblock Changes 2–4.
- NIT — `src/services/PlanIngestionEngine.ts:1729` Two more seat-facing `done --from` sites the plan does not enumerate (`:1730`, `:2269`). They interpolate a resolved seat name rather than `<your terminal name>`, so they are not the same friction, but they must move with Changes 2–4 or the instruction set will disagree with itself.
- NIT — `src/services/standingOrderFragments.ts:89` The raw-HTTP `POST /terminals/teams/<id>/queue/done` route still has the agent assemble `{"from":"…"}` by hand. The plan explicitly notes and defers this; recorded so it is not lost.

### Review Deviations

**What I changed.** Proposed Change 1 (the CLI env default) is implemented; Proposed Changes 2–4
(the seat-facing instruction text) are not, so the Goal Invariant *"No seat-facing instruction
anywhere names the `--from` field"* is **not** met. The mechanism works — `switchboard done` with
no arguments completes the calling seat — but nothing yet tells an agent it may type it that way.

**Why the original destination was a blocker.** The plan's premise is that `SWITCHBOARD_TERMINAL`
is present in **both** composition roots. That is true for pty-fleet seats — the Go pty host
(`cmd/switchboard-pty-host/main.go:287`) and the Node fleet
(`src/standalone/ptyFleetService.ts:547`) both inject it. It is **not** true for the legacy
extension host's `vscode.window.createTerminal` seats: none of the five creation sites
(`hostSeams.ts:258`, `TaskViewerProvider.ts:7399`, `:13122`, `:28924`, `extension.ts:3725`) pass an
`env`, and the tree says so in its own words at `agentPromptBuilder.ts:1896` and
`KanbanProvider.ts:6360` ("a pty-child env var… Phone-a-Friend targets vscode.Terminal anyway,
which never carries it"). The fragments in Changes 2–4 are shared `src/services/` strings reached
by both roots — `CODING_COMPLETION_REPORT_DIRECTIVE` goes into every dispatched coder's prompt
regardless of which backend seats it. Stripping `--from` from them would hand a vscode.Terminal
seat a command that fails on first call, which is precisely the "first call must be answerable"
failure the sibling plan exists to remove — reintroduced in the other host. CLAUDE.md's
non-divergence rule makes that the author's call, not mine.

**What the author needs to decide.** Either (a) inject `SWITCHBOARD_TERMINAL` at the five
extension-host `createTerminal` sites first, then land Changes 2–4 unchanged; or (b) keep `--from`
in the shared fragments and treat the CLI default as a convenience only, which narrows this plan's
goal. Option (a) is the one that keeps the stated goal; it is new work in the legacy host and was
not in this plan's scope.
