# Team lead escalation must exhaust cheap recovery before declaring a subtask blocked

## Goal

Replace the terminal branch in the coding-team head prompt's escalation clause with an
ordered recovery ladder, so a lead stops reporting "blocked — no higher seat available"
while cheap, obvious fixes remain untried. Teams are unreleased dev work, so this is a clean
text edit with no migration.

### The problem

A team lead abandoned a subtask after two failed review attempts, reporting that
"escalation rules meant max 2 attempts and no higher seat available". The outstanding fix
was small. The lead could have cleared the failing seat and re-prompted it with the named
defects, handed the subtask to an idle seat on its own team, or made the fix itself. It did
none of these — not because it lacked the means, but because the prompt told it to stop.

### Root cause

`NEW_CODING_HEAD_PROMPT` (`src/services/teamWiring.ts:649-656`) states:

> "When a seat fails review on the same subtask twice, do not send that subtask to it a
> third time — escalate one rung along intern → coder → lead, name the specific defects in
> the dispatch, and say in your status report which seat you moved it to and why; **if the
> seat that failed twice is a lead, or your team has no seat above it, stop and report to
> the human** instead of dispatching again (or unattended: record the blocked card to
> `.switchboard/mission-control/reports/` and proceed to the next queue item)."

This is a **single vertical ladder with a terminal rung**. The lead behaved correctly; the
rule is wrong in three specific ways:

1. **It counts attempts against the seat when what is exhausted is the context.** A seat
   whose context is poisoned by two failed attempts is not the same agent as that seat
   cleared and re-prompted with the defects named. The prompt makes no such distinction, so
   "clear and retry" reads as a forbidden third attempt.
2. **Retry is vertical-only.** The prompt does say "dispatch the next subtask to an idle
   seat that has not already worked on it" — but only for the *next* subtask. Lateral
   hand-off of a *failing* subtask to an idle peer is never mentioned.
3. **"escalate one rung along intern → coder → lead" never says what the top rung means.**
   Dispatch to a lead seat, or do it yourself? The surrounding prompt frames the lead
   purely as a dispatcher ("You lead this team. Your coders work the subtasks"), so a lead
   reads "no seat above it" as terminal and never considers its own hands.

### This is not a capability gap

Every recovery route is already reachable by a lead over HTTP, in both hosts:

- `POST /terminals/verb/ptyClearTerminal` with `{"name":"<seat>"}` — handled in
  `src/standalone/bootstrap.ts:1848` and, on the extension side, in
  `TaskViewerProvider.ts:532,566`. No composition-root wiring is missing.
- `POST /terminals/verb/ptySendPrompt` — targeted re-dispatch.
- `POST /terminals/verb/ptyListTerminals` — returns `status` and `lastDataAt` per seat, so
  idleness is observable, and `parentInstanceId` for the team-membership test.
- `/terminals/verb/` has **no verb allowlist** (`LocalApiServer.ts:8099`) — any verb is
  reachable.

The fix is therefore entirely instructional. No new endpoints, no new
service seams, no host-parity work.

### Decisions taken (confirmed with the user)

- **The lead may implement the fix itself, but last** — only when the outstanding defect is
  small and localized, and only after the seat routes are exhausted. Lead context holds the
  whole feature state; burning it on implementation is the same hazard that
  "one subtask per cleared seat before rotation" guards against for coders.
- **The two-attempt cap stays, scoped per seat per context.** Clearing a seat and
  re-dispatching with named defects starts a fresh budget, hard-capped at one such reset per
  seat per subtask so it cannot loop.
- **Scope is the coding head prompt only.** The review-team head prompt has no attempt cap
  at all (adding one is new design, not a fix), and the mission-control orchestrator's
  equivalent dead end (`stallCount >= 3` → hard skip; "an escalated item must stay
  escalated") is unattended, where "try harder" carries real cost. Both are separate plans
  if wanted.

## Implementation

### 1. Rewrite the escalation clause

The clause lives in **three byte-identical copies**, all with the same line breaks:

| File | Line | Symbol |
| :--- | :--- | :--- |
| `src/services/teamWiring.ts` | 649-656 | `NEW_CODING_HEAD_PROMPT` |
| `src/webview/terminals.js` | 11243-11249 | `NEW_CODING_HEAD_PROMPT_CLIENT` |
| `src/webview/kanban.html` | 4828-4834 | Coding team `headPrompt` |

`src/test/coding-head-prompt-contract.test.js` asserts the three assembled strings are
byte-identical (it reassembles each `'...' + '...'` chain), so the split points may differ
but the assembled text must not. Edit all three in the same change.

Replace the sentence beginning "When a seat fails review on the same subtask twice…"
through "…proceed to the next queue item)." with:

> When a seat fails review on the same subtask twice, do not send that subtask to that seat
> in that same context again. Work down this ladder and take the first rung that applies,
> naming the specific defects in every dispatch: (1) clear that seat's context — POST
> /terminals/verb/ptyClearTerminal with {"name":"&lt;the seat&gt;"} against the port in
> .switchboard/api-server-port.txt — then re-dispatch the subtask to it with a prompt naming
> exactly what to fix; a cleared seat is a fresh attempt, not a third one, and you may do
> this once per seat per subtask; (2) hand the subtask to an idle seat on your team that has
> not worked on it, clearing it first if it holds unrelated context; (3) escalate one rung
> along intern → coder → lead; (4) if the outstanding fix is small and localized, make it
> yourself; (5) only when every rung above is exhausted, stop and report to the human instead
> of dispatching again (or unattended: record the blocked card to
> .switchboard/mission-control/reports/ and proceed to the next queue item). Say in your
> status report which rung you took and why. Never report a subtask blocked for want of a
> higher seat without having tried rungs 1, 2 and 4.

Constraints the replacement text already satisfies — verify they still hold after any
rewording:

- Preserves every literal pinned by `stage-marker-commit-contract.test.js:386-400`:
  `intern → coder → lead`, `seat fails review on the same subtask twice`,
  `stop and report to the human instead of dispatching again`.
- Contains no form of the word "advance" (`!/advanc/i`), no `targetColumn`, and no literal
  `/kanban/dispatch` — all asserted by the contract tests. "re-dispatch" is safe; the
  assertion is on the path string `/kanban/dispatch`.
- Does not weaken the existing team-membership invariant. Rung 2 says "an idle seat **on
  your team**"; the prompt's standing rule that "a standalone seat of the same role is not
  yours to drive" is unchanged and still governs. Borrowing an out-of-team idle seat stays
  forbidden.

### 2. No migration — teams are unreleased dev work

`headPrompt` is stored per agent group in the DB (`agentGroupInstantiation.ts:136` passes
`group?.headPrompt`), and the kanban.html value is a creation template, so editing the three
source copies governs **newly created teams only**. That would normally demand a
`migrateAgentGroups` step under the repo's migration rule.

It does not here: **the team/lead feature has only ever existed in unreleased dev work**, so it
takes a clean break — no migration, no compat shim, no frozen snapshot constant, no recogniser.
A group carrying the old clause is a dev-install artefact; recreate the team.

Do not add a migration step "just in case". A recogniser for text that never shipped is dead
code that later migrations have to keep matching against.

### 3. Update the pinned-literal tests

`src/test/stage-marker-commit-contract.test.js:386-400` pins load-bearing literals. The
three listed above survive the rewrite by design, so the existing assertions should pass
unchanged — confirm rather than assume. Add assertions for the new guarantees:

- the prompt names `ptyClearTerminal` as an available recovery action;
- the prompt no longer contains the old dead-end fragment
  `'if the seat that failed twice is a lead, or your team has no seat above it, stop and
  report to the human'`;
- `stop and report to the human` appears only as the last rung.

## Verification Plan

1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/coding-head-prompt-contract.test.js`
   — all six invariants pass, in particular the three-way byte-identity check across
   `teamWiring.ts`, `terminals.js` and `kanban.html`.
2. Run `src/test/stage-marker-commit-contract.test.js` — the pinned load-bearing literals
   still resolve and the new assertions pass.
3. `npx tsc --noEmit -p tsconfig.json` — no type regressions.
4. Manual, extension host: create a fresh Coding team and confirm the lead's standing orders
   carry the ladder text.
5. Manual, standalone host: same check via the standalone bootstrap. No composition-root
   wiring changes here — `ptyClearTerminal` is already handled in both hosts
   (`bootstrap.ts:1848`, `TaskViewerProvider.ts:532`) — but confirm a standalone-spawned lead
   receives the new text, since both hosts read the same stored group.
6. Confirm a team created before this change still runs. It keeps the old clause (no migration
   by design); it must not error, and recreating the team must pick up the new text.
7. End-to-end: drive a subtask to two review failures on one seat and confirm the lead
   clears and re-prompts that seat rather than reporting blocked; then force rung 1 to fail
   and confirm it moves laterally to an idle team seat before escalating.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, refactor
