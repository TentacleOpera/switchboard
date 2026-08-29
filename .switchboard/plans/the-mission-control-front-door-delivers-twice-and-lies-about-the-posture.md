# The /switchboard front door arms against an endpoint that does not exist, delivers the persona twice, and hardcodes the wrong posture

## Goal

Three surgical fixes to the kickoff seam: repair step 2's dead endpoint and legacy paths so a
`/switchboard` session can arm at all, stop the launcher telling the agent to read a document it was
just handed inline, and derive `UNATTENDED` from the session mode instead of hardcoding it true on
every door. Both are independent of any rescope of the Mission Control role — they are wrong under
the current scope and would still be wrong under a broader one.

### Problem Analysis

**One builder, four doors, content inlined.** `buildMissionControlKickoffPrompt`
(`TaskViewerProvider.ts:11728`) reads the runtime runsheet (`switchboard-mission-control-internal`
when host-delivered, `-external` when `deliveryMode === 'self'`) plus the 619-line
`switchboard-mission-control/SKILL.md`, concatenates them with a `---`, prepends *"You are Switchboard
Mission Control. Read and follow the combined document below"*, and appends `UNATTENDED=true`,
`WORKSPACE_ROOT`, `ACTIVE_PROJECT_FILTER` and one of four mode instructions. Callers:
`:11817` (deliver to an adopted seat), `:11966`, `:12041` (host vs self delivery), and three sites in
`src/standalone/bootstrap.ts`. `POST /mission-control/adopt` returns
`{ mode, prompt, seat, liveDelivery, note? }` (`LocalApiServer.ts:5716-5717`), so the **full document
is already in the agent's context** the moment the curl returns.

**Defect 0 — step 2 arms against an endpoint that does not exist.** The rename from *orchestrator* to
*Mission Control* moved the endpoints and the on-disk paths. `.agents/workflows/switchboard.md` was
never updated, so it instructs four things that are all wrong:

| the launcher says | line | reality |
| :--- | :--- | :--- |
| write `.switchboard/orchestrator/session.md` | `:102` | persona writes `.switchboard/mission-control/session.md` |
| call `POST /orchestration/confirm` — *"the only call that arms"* | `:103` | **no such route exists** |
| read `.switchboard/orchestrator/reports/` | `:106` | persona reads `.switchboard/mission-control/reports/` |
| *"Never call `POST /orchestration/start`"* | `:109` | warns against a route that does not exist either |

Verified exhaustively: `grep -rn "'/orchestration"` across `src/` returns nothing, and the API server
registers only `/mission-control/{adopt,confirm,handoff,session-log,start,stop}`.
`migrateLegacyOrchestratorDir` (`ScheduledJobsService.ts:199`) exists precisely because
`.switchboard/orchestrator/` is the legacy tree.

**So an agent that follows `/switchboard` literally cannot arm a session.** It reaches the one call the
launcher calls "the only call that arms", gets a 404, and has no documented fallback — while
simultaneously holding the persona, which it was also told to read, saying `/mission-control/confirm`.
Two contradictory instructions, one of them dead. This is a more direct cause of the reported
floundering than any property of the document's length, and step 1 of the same file is unaffected —
the board-liveness logic is correct.

The blast radius is bounded: `grep` across `.agents/` and `.claude/` finds these four lines and their
mirrored copies in `.claude/skills/switchboard/SKILL.md`, and nothing else.

**Defect 1 — the launcher asks for it a second time.** `.agents/workflows/switchboard.md` step 2 says:

> The response carries `prompt` — the pre-flight instruction. **Follow it in this session**: read
> `.agents/protocols/switchboard-mission-control/SKILL.md`, run the pre-flight, report what you find,
> propose a goal, and wait for the user to answer *here*.

Two errors in one sentence. It mislabels a complete persona (~704 lines: 85-line external runsheet or
25-line internal one, plus 619 shared) as "the pre-flight instruction", and it instructs a read of the
file whose contents are already inline. The agent ends up holding two copies of the shared logic
before it looks up a single endpoint in the 364-line `switchboard-mission-control-http` skill. This is
a mechanical cause of the observed "agent reads for a long time, then asks a vague question" — not a
consequence of the document's length.

**Defect 2 — `UNATTENDED=true` is unconditional.** It sits in `baseLines` (`:11761`); no branch
touches it. So the `/switchboard` door — where a human just typed the command and is waiting at the
terminal — is told nobody is watching. The prompt then contradicts itself within a few lines: the
flag says unattended, while the `interview` branch says *"propose a goal for this session, and STOP…
The user will answer in this terminal."* The persona inherits the confusion at Hard Rule 4: *"No
confirmation gates. You run unattended… never block waiting for human approval"* — which its own
`## Pre-flight` section then has to walk back: *"The Hard Rule against confirmation gates governs the
armed session; the pre-flight interview is the attended phase that precedes arming, and waiting for
the user's answer here is the whole point."* The document already knows there are two postures. The
flag does not.

**The flag's blast radius is exactly one behaviour.** `UNATTENDED=true` is consumed by
`manage-features/SKILL.md:412` to gate the grouping confirm-skip, and
`mission-control-tick-and-reports-contract.test.js:322` asserts that is *"the only remaining effect of
UNATTENDED=true"* since the `Miscellaneous` sweep was deleted. (`UNATTENDED IMPROVER CONTRACT` at
`agentPromptBuilder.ts:1963` is a separate directive for improver runs and is out of scope.) So making
the flag mode-aware changes one thing: during an attended interview, grouping asks instead of
skipping — which is the correct behaviour for a session with a human in it.

### Root Cause

Two renames landed without their callers. `rename-the-orchestrator-to-mission-control.md` moved the
endpoints and directories but did not sweep `.agents/workflows/`, leaving the launcher pointing at the
pre-rename surface. Separately, the kickoff prompt was written for one door (the panel's Start button,
feeding an unattended overnight run). `POST /mission-control/adopt` was added later so `/switchboard` could adopt the seat in place,
and it reused the same builder verbatim. Neither the launcher's instructions nor the posture flag were
revisited for a door with a human standing in it.

### Non-goals

- **Not the rescope.** Whether Mission Control's primary jobs are building missions, overseeing
  missions and acting as a remote interface — rather than unattended dispatch — is a separate and
  larger question. These two defects are wrong under either scope.
- **Not shortening the 619 lines.** One doc edit to Hard Rule 4 for internal consistency; no cut.
- **Not the standalone `deliveryMode` question.** `bootstrap.ts` passes no `deliveryMode`, and the
  runsheet is `-external` only when the value is exactly `'self'`, so standalone always receives the
  **internal** runsheet ("The host wakes you… you do NOT start a wake loop"). Whether that is correct
  depends on whether standalone's host actually delivers wakes — unverified, and recorded here as a
  question rather than folded into this fix.

## Metadata

**Complexity:** 3
**Tags:** bugfix, docs, reliability
**Feature:** 73ebf150-50f9-4e8f-b9db-58af49202c6a

## Proposed Changes

1. **Repair step 2's endpoint and paths** in `.agents/workflows/switchboard.md` — ship this first; it is
   the only one of the three that makes the door functional rather than merely tidy.
   `POST /orchestration/confirm` → `POST /mission-control/confirm`; `.switchboard/orchestrator/session.md`
   → `.switchboard/mission-control/session.md`; `.switchboard/orchestrator/reports/` →
   `.switchboard/mission-control/reports/`. Delete the `POST /orchestration/start` warning rather than
   renaming it: `/mission-control/start` is a real route with a legitimate purpose (the panel's Start
   button), so a blanket "never call this" would be wrong advice about a live endpoint. Replace it with
   the accurate constraint — do not start a *second* Mission Control terminal from here, because this
   session has already adopted the seat.

2. **Fix the launcher's read instruction** in `.agents/workflows/switchboard.md`. Replace the read instruction
   with an accurate description: the response's `prompt` field **is** the complete persona — runsheet
   plus shared logic plus the mode instruction — and is to be followed directly. State explicitly that
   no file is to be read, because an agent told to "follow the persona" will otherwise reach for the
   path it can see in the text.

   Keep the inlining. The server picks the runsheet from `deliveryMode` and appends the mode-specific
   instruction; an agent reading files itself would have to be told which runsheet applies, which is
   coupling the response already removes.

   **Edit the source, not the mirror.** `.claude/skills/switchboard/SKILL.md` is generated from this
   file by `generateClaudeMirror`. Today it must be regenerated (or hand-synced) after the edit; if
   `delete-the-claude-mirror-generator.md` has landed first, both files are committed source and both
   must be edited. Whichever order, verification 3 asserts they agree.

3. **Derive the posture from the mode.** Remove `UNATTENDED=true` from `baseLines` and emit it per
   branch, keyed to the three-way branch that already exists at `:11769-11783`:

   | mode | condition | flag |
   | :--- | :--- | :--- |
   | `interview` | no session file | `ATTENDED=true` |
   | `stale-session` | session file, not armed | `ATTENDED=true` |
   | `resume` | session file, armed | `UNATTENDED=true` |

   No new plumbing: the branch is the signal. Both attended modes end by telling the agent the user
   will answer in the terminal, so the flag now agrees with the instruction beside it.

   Emit `ATTENDED=true` rather than `UNATTENDED=false`. The one consumer
   (`manage-features/SKILL.md:412`) tests for the literal presence of `UNATTENDED=true`, so a `false`
   value would read as absent and work by accident; a positive flag makes the attended case
   assertable and greppable.

4. **Update `manage-features/SKILL.md:412`** to name `ATTENDED=true` as the case where the confirm
   gate applies, so the skill states both postures rather than one and an absence.

5. **Key Hard Rule 4 to the flag** in `switchboard-mission-control/SKILL.md`. It currently asserts
   "You run unattended" unconditionally and is walked back by `## Pre-flight` 110 lines later. Make it
   conditional on the flag in the prompt and drop the walk-back. One rule, two postures, stated where
   the rule is.

6. **Leave `no-persona` alone.** That branch returns a standalone stand-by message with no flags and
   no persona; it is correct as-is.

## Verification Plan

1. **Every endpoint the launcher names exists.** Assert that no `/orchestration/` string appears in
   `.agents/workflows/switchboard.md` or `.claude/skills/switchboard/SKILL.md`, and that every
   `POST /…` path either is registered in `LocalApiServer.ts` or is accompanied by an explicit
   "does not exist" note. A route-existence assertion, not a spelling one — this defect is a rename
   that outran its callers, and the same class recurs on the next rename.
2. **A `/switchboard` session can actually arm.** End to end: run step 1, adopt, confirm, and assert
   `missionControlArmed` becomes true. Today this fails at the confirm call with a 404, so it is the
   regression test for the headline defect and must fail against the current tree.
3. **The launcher never asks for a second read.** Assert `.agents/workflows/switchboard.md` contains
   no instruction to read `switchboard-mission-control/SKILL.md`, and that it states the `prompt`
   field is the persona. A grep-level assertion, because this defect is a sentence, and a sentence is
   what regresses.
4. **The adopt response is self-sufficient.** Assert the `prompt` returned by
   `POST /mission-control/adopt` contains both the runsheet's first heading and the shared logic's
   `## Hard Rules`, proving an agent following it needs no file access.
5. **Launcher and mirror agree.** Assert `.claude/skills/switchboard/SKILL.md` and
   `.agents/workflows/switchboard.md` match modulo frontmatter — the same drift guard
   `delete-the-claude-mirror-generator.md` specifies, applied here so this edit cannot land in one
   copy only.
6. **Flag per mode.** Three assertions on `buildMissionControlKickoffPrompt`: `interview` and
   `stale-session` prompts contain `ATTENDED=true` and **not** `UNATTENDED=true`; `resume` contains
   `UNATTENDED=true` and not `ATTENDED=true`. Assert on the returned prompt string, not on internal
   state.
7. **Substring safety.** Assert the `resume` prompt's `UNATTENDED=true` cannot satisfy a naive
   `ATTENDED=true` substring test, and that the consumer's check distinguishes them — `UNATTENDED=true`
   contains `ATTENDED=true` as a substring, which is the obvious way this fix breaks silently.
8. **The existing contract test still holds.** `mission-control-tick-and-reports-contract.test.js:322`
   asserts the confirm-skip is the only effect of `UNATTENDED=true`. Update it to cover both flags and
   assert the effect count is still one.
9. **Grouping asks in an attended interview.** Drive `manage-features` with an `ATTENDED=true` prompt
   and assert the confirm gate applies; with `UNATTENDED=true` and assert it is skipped. This is the
   one behavioural change in the plan and must be tested directly, not inferred from the flag.
10. **Both hosts.** All four extension call sites and the three in `src/standalone/bootstrap.ts` go
   through the same builder, so the flag fix covers both roots by construction — assert that by
   calling the builder directly in a host-agnostic test rather than by exercising either host.

## Outstanding Questions

- **[user]** Should the panel's Start button (`POST /mission-control/start`) count as attended? It is
  a deliberate human click and its interview says the user will answer in the terminal, so this plan
  treats it as attended by virtue of its mode — the same as `/switchboard`. If a panel start is meant
  to mean "set it going and walk away", that door needs its own signal rather than inheriting the
  mode's.
- **[user]** Does the standalone host deliver wakes via `ptySendPrompt`? If not, its three call sites
  need `deliveryMode: 'self'` so the agent receives the external runsheet and arms its own wake loop —
  otherwise a standalone Mission Control session is told not to self-wake by a host that will never
  wake it. Recorded as a non-goal above; worth its own plan if the answer is no.
