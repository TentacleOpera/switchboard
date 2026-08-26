# The pre-flight names six checks and supplies one command, so Mission Control probes its way through startup

## Goal

Make Mission Control's startup a small, fixed number of calls with a known answer for every check.
Today five of its six pre-flight checks have no prescribed query and two of them cannot be answered
over the HTTP surface at all, so the agent invents its own discovery — probing endpoints and falling
back to the database — before it gets to the work.

### Problem Analysis

**The pre-flight defines six checks and instruments one.**
`.agents/protocols/switchboard-mission-control/SKILL.md:167` opens *The six checks*:

| # | Check | Prescribed command? |
| :--- | :--- | :--- |
| 1 | Is there a coding *team* for the features in scope — not merely a coding agent? | **none** |
| 2 | Is there a planner or planning team? | **none** |
| 3 | If the research prompt is active, is there a researcher to serve it? | **none** |
| 4 | What is the worktree strategy, and does the board match it? | **none** |
| 5 | Is there anything to do at all? | yes — the `ready ()` helper at `:104-112` |
| 6 | Are there loose plans that were probably meant to be grouped? | **none** |

The output contract above them is strict — "A passing check produces no output… no diagnostic
narration, no terminal listings, no port-probing output" — but strictness about *output* does not
tell the agent how to *obtain* the answer. Five checks are stated as questions with no way to ask
them, so the agent goes looking. Probing is the only behaviour the document leaves available.

**Two of those checks are unanswerable over HTTP, by construction.** `GET /health`
(`LocalApiServer.ts:7319-7337`) returns `terminals` as a **flat array of names** —
`terminals: string[]`, plus `terminalCount`. No roles, no team membership, no pacing. Checks 1 and 2
ask specifically for *teams* and *roles*, and the only reader of that data,
`_readRegisteredTeamGroups` (`LocalApiServer.ts:4869`), is **private with no HTTP route**. It reads
`TERMINALS_GROUPS_KEY` (`switchboard.prompts.terminals.groups`) and the legacy `terminals.groups`
straight from the kanban DB config.

So the team roster exists only in the database, and the one documented network call returns names
without roles. An agent told "check whether a coding *team* is seated — not merely a coding agent"
has exactly two options: guess from terminal names, or read the DB. **That is the reported
behaviour — "it thrashes the endpoints and the db on startup" — arriving exactly as specified.**

**The document also mandates re-probing.** `## Port Discovery` (`:44`) says:

> Every `curl` in this skill talks to the local API, and every one of them opens with the same
> four-line resolve… paste it at the top of each block, do not assume `BASE` is already set.

Four separate blocks in the file carry that resolve (`:94`, `:231`, `:264`, `:474`), each opening
with its own `GET /health`. The rationale is sound — a shell does not survive between snippets — but
the consequence is that a startup touching three sections health-checks three times. The check is
cheap; the *appearance* is a controller pinging the board instead of starting work.

**And a second entry protocol may be in the same context.** The console persona now at
`/switchboard` opens with its own contradictory entry: "**Two commands, then report. No more.**"
(`.claude/skills/switchboard/SKILL.md:29`), with a different pair of commands — `GET /health` plus
an `awk` over `.switchboard/kanban-state-*.md`. The Mission Control protocol explicitly forbids
those exports for the ready question (`:87` — they carry no `featureId` marker, so subtask exclusion
cannot be applied). An agent holding both runs both, then reconciles the disagreement.

**The recent bundle sync widened discovery too.** `abd3659` re-added legacy flat skill files
alongside their directory form — `.agents/skills/archive.md` **and** `.agents/skills/archive/SKILL.md`,
`clickup_api.md` and `clickup-api/SKILL.md`, `deep_planning.md` and `deep-planning/SKILL.md`, and
more. An agent surveying its own capability surface now finds each skill twice.

### Root Cause

The pre-flight was written as a **checklist of judgements** rather than a **query with a known
shape**. Check 5 got an implementation because someone hit its ambiguity (which columns, which
exclusions) and pinned it down; the other five were left as prose because their answers felt
obvious. They are not obvious — two of them are not even reachable. And because the surrounding
output contract forbids narrating the probing, the agent's flailing is invisible in the report while
being entirely visible in the terminal.

### Non-goals

- **Not loosening the output contract.** The terse report is right. This plan makes the *work behind
  it* deterministic; it does not license narration.
- **Not removing the port-liveness discipline.** A port file is not liveness, and that lesson is
  hard-won. The fix is to resolve once per turn, not to stop resolving.
- **Not redesigning teams.** Reading a roster that already exists, not changing what a team is.
- **Not deleting the checks.** All six are worth asking. They need answers, not removal.

## Metadata

**Complexity:** 5
**Tags:** bugfix, backend, api, docs, performance, reliability

## User Review Required

Yes — one decision.

**Should the pre-flight become one server-side call, or six documented client calls?**
Recommendation: **add a single read endpoint that answers the whole pre-flight, and reduce the
protocol to one call plus one judgement.** Something like `GET /mission-control/preflight?workspaceRoot=…`
returning the roster with roles and pacing, the researcher/research-prompt state, the worktree
strategy and whether the board matches it, the two ready-lane counts, and the loose-plan candidates.
Reasons:

- Checks 1–4 are all *server-side state the server already reads privately*. Every one of them is a
  round trip the agent should not be composing.
- It collapses startup to one resolve and one call, which is what "gets into it" actually looks like.
- The six checks stop drifting from their implementations, because there is only one implementation.
- Check 6 ("loose plans that look related") stays a judgement — the endpoint supplies the
  *candidates*, the agent supplies the *suspicion*.

The alternative — document five more curls in the protocol — is cheaper to build and worse to own:
it still needs a new teams read endpoint (checks 1–2 cannot be served otherwise), and it leaves six
independently-driftable specs where one would do.

## Complexity Audit

### Routine

- Exposing `_readRegisteredTeamGroups` through a read route.
- Replacing the five uninstrumented checks with one documented call.

### Complex / Risky

- **The roster read must cover both config keys.** `_readRegisteredTeamGroups` deliberately reads
  `TERMINALS_GROUPS_KEY` *and* legacy `terminals.groups`, deduplicating by id with the current key
  winning, and its own comment warns that "two hand-copied loops over the same two config keys is
  exactly how one of them ends up reading a key the other does not." **Call that method; do not
  write a second loop.**
- **Legacy installs must not read as "no team".** ~4,000 installs, many on older versions, may hold
  only the legacy key. A pre-flight that reports "no coding team seated" to an operator who has one
  is worse than the probing it replaces — it is a confident false negative that will stop a session.
- **`/health` must not change shape.** `terminals: string[]` is consumed by the console persona's
  entry and by the "Terminals:" line, and older builds omit the field entirely (the protocol and
  console both handle its absence). **Add a new endpoint; do not enrich `/health` in place.**
- **Liveness vs configuration is a real distinction and must survive.** `/health` `terminals` is
  *live*; the group roster is *configured*. The console persona already draws this line explicitly
  (`.claude/skills/switchboard/SKILL.md:122-129`). A pre-flight that conflates them will report a
  configured-but-dead team as seated.
- **The endpoint must be auth-gated and workspace-scoped.** Every other route runs `_checkAuth`, and
  a bare call must not silently target the primary root — the multi-root trap Hard Rule 5 exists for.
- **Both hosts must wire it.** Per `CLAUDE.md`, the trap is composition-root wiring, not verb
  reachability: `bootstrap.ts`'s `default:` arm makes a verb audit come back green while a seam is
  unwired. Whatever callback this endpoint needs must be handed to `LocalApiServer` in
  **`src/extension.ts` and `src/standalone/bootstrap.ts`**, and the diff must show both.

## Edge-Case & Dependency Audit

**Race conditions**
- A terminal dies between the pre-flight read and the first dispatch. Unavoidable and already
  handled downstream (`:42` — no lead, record it and continue). The pre-flight is a snapshot and
  should be described as one.
- Config written while the pre-flight reads it: last-writer-wins on a config key, no partial state
  to observe.

**Security**
- The new route needs the same `_checkAuth` gate as every other. A roster names terminals and roles;
  that is not secret, but the route must not become the one unauthenticated read.
- No secrets in the payload: names, roles, pacing, counts. No prompts, no tokens, no paths beyond
  the workspace root the caller already supplied.

**Side effects**
- Startup gets quieter — that is the goal — but a genuinely broken board must still fail loudly.
  Preserve the "a failed resolve means the board is down, never that no terminals exist" rule
  (`:37-42`); a one-call pre-flight makes that misdiagnosis *easier*, not harder, because a single
  failure now carries every check.
- The console persona's two-command entry stays valid for the console; if both personas persist,
  they must not both run.

**Migration**
- New read endpoint, no schema change, no stored state, no settings. The legacy `terminals.groups`
  key is read, never rewritten — no migration is performed, and none is needed. `/health` is
  unchanged, so no client breaks.

## Dependencies

- **Interacts with:** `the-skill-sync-overwrote-the-mission-control-launcher.md` — if the console
  persona stops being the front door, its rival entry protocol stops landing in the same context and
  part of the thrash disappears without code. Land the restore first if sequencing.
- **Independent of:** the dispatch-contract and formatting plans.
- **Touches:** `switchboard-mission-control-http/SKILL.md` (the invocation companion) — a new
  endpoint belongs in its reference.

## Adversarial Synthesis

Key risks: (1) adding an endpoint whose roster read misses the legacy `terminals.groups` key, so
older installs get a confident "no coding team seated" and stop a session that would have run —
the failure the method's own comment predicts; (2) enriching `/health` instead of adding a route,
breaking the console entry and older-build handling; (3) conflating configured teams with live
terminals, so a dead team reads as seated; (4) wiring the new seam in `extension.ts` only, leaving
standalone with a pre-flight that silently answers nothing — the exact precedent `CLAUDE.md`
records for the four `PlanIngestionEngine` queue seams; (5) collapsing to one call and losing the
"board down ≠ empty board" distinction, turning one failed resolve into six false negatives.
Mitigations: call `_readRegisteredTeamGroups` rather than reimplementing it, and test a
legacy-key-only workspace explicitly; add a new route and assert `/health`'s payload is
byte-identical; keep configured and live as separate fields in the response; diff the two
composition roots by hand and cover both in verification; and make a non-200 resolve report "board
not answering" rather than any check result.

## Proposed Changes

1. **Add a workspace-scoped, auth-gated read endpoint** — `GET /mission-control/preflight?workspaceRoot=…`
   — returning: the configured team roster (groups, roles, `pacing`, head) from
   `_readRegisteredTeamGroups`; live terminals as a separate field; the research-prompt state and
   whether a researcher is seated; the worktree strategy and whether board state matches it; the two
   ready-lane counts using the same exclusions as the `ready ()` helper; and loose-plan candidates
   for check 6.
2. **Reuse the existing readers.** `_readRegisteredTeamGroups` for the roster (both config keys,
   dedup by id, current key wins) and the `ready ()` query's own filters for the lanes — no
   hand-copied second implementation of either.
3. **Keep configured and live distinct** in the response, so a configured-but-dead team cannot read
   as seated.
4. **Wire the seam in both composition roots** — `src/extension.ts` and
   `src/standalone/bootstrap.ts` — and show both in the diff.
5. **Rewrite *The six checks*** to: one resolve, one call, then the six answers read off the
   response; check 6 keeps its judgement step over the returned candidates. Preserve the output
   contract verbatim.
6. **Amend `## Port Discovery`** to resolve once per turn and reuse `BASE` within it, keeping the
   "a port file is not liveness" rule and the "failed resolve ≠ empty board" rule intact.
7. **Document the endpoint** in `.agents/protocols/switchboard-mission-control-http/SKILL.md`.
8. **De-duplicate the skill surface** — remove the flat `.agents/skills/<name>.md` copies `abd3659`
   re-added alongside their `<name>/SKILL.md` form, keeping one convention.
9. **Leave `/health` untouched.**

### Migration

New read endpoint; no schema, settings, or stored-state changes. The legacy `terminals.groups`
config key is read and never rewritten. `/health`'s payload is unchanged, so no existing client —
including older builds that omit `terminals` — changes behaviour.

## Verification Plan

1. **One resolve, one call.** Instrument the API server and run a fresh Mission Control pre-flight;
   assert **exactly one** `GET /health` and **one** pre-flight call, and **zero** direct `kanban.db`
   reads from the agent.
2. **All six checks answered from the response.** Assert every check's answer is derivable from the
   one payload — no supplementary curl, no `/catalog` probe, no `ls` of the plans directory.
3. **Legacy roster is found.** On a workspace whose teams live **only** under the legacy
   `terminals.groups` key, assert the roster is returned and check 1 does **not** report "no coding
   team seated".
4. **Current key wins on conflict.** With both keys populated and overlapping ids, assert dedup
   matches `_readRegisteredTeamGroups` exactly.
5. **Configured ≠ live.** Configure a team, kill its terminals; assert the response marks it
   configured and not live, and the pre-flight says so rather than "seated".
6. **`/health` is byte-identical.** Snapshot the payload before and after; assert no change,
   including the older-build case where `terminals` is absent.
7. **Board down reports board down.** Stop the board and run the pre-flight; assert it reports "not
   answering" and does **not** report an empty fleet, an empty board, or a missing team (`:37-42`).
8. **Both hosts serve it.** Run the pre-flight against the VS Code extension host **and** the
   standalone `npx switchboard` host; assert identical payload shapes. A green verb audit is not
   evidence — inspect the wiring in both composition roots.
9. **Auth is enforced.** Call the endpoint without credentials; assert 401 via the same `_checkAuth`
   path as its neighbours.
10. **Wrong-workspace guard.** Call with a `workspaceRoot` other than the primary in a multi-root
    setup; assert the response describes the requested root, not the primary.
11. **Output contract holds.** With all checks passing, assert the report is `Pre-flight clear.` plus
    the ready summary — no probing output, no narration.
12. **Skills are listed once.** Assert no `.agents/skills/<name>.md` duplicates a
    `<name>/SKILL.md`.
