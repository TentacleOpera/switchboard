# Team lead escalation must exhaust cheap recovery before declaring a subtask blocked

## Goal

Replace the terminal branch in the coding-team head prompt's escalation clause with an
ordered recovery ladder, so a lead stops reporting "blocked — no higher seat available"
while cheap, obvious fixes remain untried. Ship it to existing installs via a surgical
`migrateAgentGroups` clause replacement.

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

The fix is therefore entirely instructional plus a migration. No new endpoints, no new
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

### 2. Migrate stored head prompts (load-bearing — without this the fix reaches nobody)

`headPrompt` is **stored per agent group in the DB**, not read from the constant at spawn
time: `agentGroupInstantiation.ts:136` passes `group?.headPrompt` into `wireSpawnedTeam`.
The kanban.html value is a *creation template*, and the Agent Groups UI
(`kanban.html:5703,6035`) lets users edit the stored text. So editing the three source
copies changes **newly created teams only**. Every existing install — ~4,000, many on older
versions — keeps the dead-end clause forever.

Add a step to `migrateAgentGroups` (`src/services/teamWiring.ts`), which already runs on
every read path that can trigger auto-start:

- For each group with a string `headPrompt`, if it contains the **exact old clause
  substring**, replace that substring with the new clause. Match on the old text, not on
  the whole prompt.
- If the old substring is absent (user rewrote it, or already migrated), leave the group
  untouched. Never overwrite a whole stored `headPrompt` — that clobbers customization.
- Set `changed = true` only when a replacement actually occurred, preserving the function's
  existing "return `null` when nothing changed" contract so the caller does not write.
- Keep the function pure (it does not touch the DB) and idempotent — a second pass finds no
  old substring and is a no-op.
- Export the old and new clause strings as named constants so the migration and the tests
  reference one source of truth.

Preserve every unknown key on each group, per the repo's migration rule.

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
3. New unit test for the migration, covering: a group carrying the exact old clause is
   rewritten; a user-customized prompt without the old clause is left byte-identical; a
   second pass over already-migrated groups returns `null` (no write); unknown keys on the
   group survive.
4. `npx tsc --noEmit -p tsconfig.json` — no type regressions.
5. Manual, extension host: create a fresh Coding team, confirm the lead's standing orders
   carry the ladder text. Then take an install whose stored group still has the old clause,
   trigger a read path that runs `migrateAgentGroups`, and confirm the stored prompt now
   carries the ladder while any user edits elsewhere in the prompt are intact.
6. Manual, standalone host: same two checks via the standalone bootstrap. No composition-root
   wiring changes here — `ptyClearTerminal` is already handled in both hosts
   (`bootstrap.ts:1848`, `TaskViewerProvider.ts:532`) — but confirm the head prompt reaching
   a standalone-spawned lead is the migrated text, since both hosts read the same stored
   group.
7. End-to-end: drive a subtask to two review failures on one seat and confirm the lead
   clears and re-prompts that seat rather than reporting blocked; then force rung 1 to fail
   and confirm it moves laterally to an idle team seat before escalating.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, refactor
