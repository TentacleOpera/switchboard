# A Finished-Seat Notice Tells the Lead What To Do Next

## Goal

The `completed` turn-end notice carries evidence and one closing instruction, so a lead woken by it acts immediately instead of re-deriving the situation. Today it is a bare fact — `Seat 'X' finished its turn on 'Y'.` — and the recipient is left to guess whether to review, advance the card, dispatch the next subtask, or do nothing.

### Problem analysis

**The principle is already stated in this codebase, and already implemented — for one arm out of three.** `PlanIngestionEngine.ts:1010-1013`, in the feature-stall composer:

> `// head woken with the state acts immediately; a head woken with "check`
> `// on your coders" has to re-derive everything.`

The `stalled` arm honours it. It builds a multi-line body listing every un-accepted subtask with its column, seat, silence duration and plan-file write age (`:1014-1030`), and closes with an explicit instruction (`:1031`):

> `Register the next subtask (attributePastedPrompt) and dispatch it, or accept the remaining subtasks to end this watch.`

The `blocked` arm is getting the same treatment in `feature_plan_20260817141200_seat-gone-quiet-notice-flaps-and-spams-the-lead.md`, whose digest body closes with:

> `Check each seat and unblock it, or re-dispatch its plan. No action is needed for a seat that is simply working.`

**The `completed` arm has neither.** Both of its firing sites pass no `body`:

- `PlanIngestionEngine.ts:476` — the silence-sweep arm.
- `PlanIngestionEngine.ts:1337` — the file-edit arm, which is the one that actually fires in practice (its own comment at `:1319-1326` explains that the sweep's `completed` arm is unreachable for any plan file this watcher imports, because `clearWorkingState` here has already NULLed `dispatched_at`).

With no `body`, both fall through to the host's inline one-liner at `TaskViewerProvider.ts:1408-1409` and its standalone twin at `bootstrap.ts:2031-2032`:

```
[switchboard:turn-end] Seat 'lead-1-intern' finished its turn on '<plan>'.
```

**Why the recipient cannot fall back on its own instructions.** A turn-end notice is delivered with `standingOrders: false` and the seat block suppressed. This is deliberate and correct — the docblock at `TaskViewerProvider.ts:1386-1392` explains that appending the recipient's own standing orders would tell an orchestrator to report to *its* head. The consequence is that **the one message whose entire purpose is "decide what happens next" is the one message stripped of every directive.** Evidence and instruction have to live in the body or they do not exist.

**Observed.** A lead dispatched a subtask directly to an intern seat. The intern finished; the lead received the bare line above and had no stated role beyond it — no instruction to verify the diff, advance the card, or dispatch the next subtask. The lead's job continues after a member finishes, and the notice is where that continuation is either handed over or dropped.

**The doctrine the notice must carry already exists in prose, in a document the lead may never have loaded.** `.agents/skills/terminal-coder-dispatch/SKILL.md:280-294` ("The review turn") states it exactly: *"review the actual diff, not the coder's account of it. The message is a claim; `git diff` is the evidence."* Same file, `:225-227`, quotes the current one-liner verbatim and appends the missing half in prose — *"The coder's plan file advanced. Review the diff (see The review turn)."* That sentence is the instruction this plan moves into the wire, where every recipient gets it whether or not it loaded the skill.

### Scope — what this plan does not own

Three adjacent plans already own the notice *firing correctly*; this one owns *what it says*. Do not re-diagnose any of them:

| Plan | Owns |
|---|---|
| `a-lead-dispatched-plan-is-never-registered.md` | writing `dispatched_terminal`/`dispatched_at` at the delivery layer, so a lead-dispatched seat produces a notice **at all** |
| `feature_plan_20260817141300_lead-dispatched-coders-never-get-the-completion-report-directive.md` | the outbound directive that makes the coder write its plan file, which is what *triggers* the `completed` arm |
| `feature_plan_20260817141200_seat-gone-quiet-notice-flaps-and-spams-the-lead.md` | pacing/aggregation **and** the composed body for the `blocked` arm |

This plan changes the `completed` arm only. It is independent of all three: none of them touches the `completed` body, and this one touches nothing else.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, docs

> **Superseded:** `**Complexity:** 3` / `**Tags:** backend, agent-protocol, reliability`
> **Reason:** `agent-protocol` is not in the allowed tag vocabulary (the importer takes only the documented list), and the plan now carries a second deliverable — the two skill documents that quote the notice string verbatim, plus the `mirror:check` drift gate that fails CI if the `.claude/` mirror is not regenerated with them. Complexity 3 also mismatched the plan's own "Send to Coder" recommendation, which starts at 4.
> **Replaced with:** `**Complexity:** 4`, tags `backend, reliability, docs`. The recommendation is unchanged and now consistent.

## User Review Required

None. The closing-line wording is decided below; the delivery flags stay exactly as they are.

## Architecture Decision — compose the body in the engine, change no host

`notifyTurnEnd` already reads `info.body ?? (…inline fallback…)` on both hosts (`TaskViewerProvider.ts:1408`, `bootstrap.ts:2031`). Supplying a `body` for `completed` therefore needs **no host change** — the same finding the pacing plan reached for `blocked` (its change note: *"both hosts already honour it … no host change is required for the message"*). The engine is also the only side that has the evidence: the record, the dispatch stamp, and the workspace root.

The delivery flags do **not** change. `standingOrders: false` and the suppressed seat block stay as they are, for the reason the docblock gives. The instruction rides in the body, which is the only channel that reaches this recipient.

The closing line is **one line**, matching the two sibling arms. A finished-seat notice arrives on every completion in a running team; anything longer becomes per-completion boilerplate that a lead learns to skip. The whole body is **two lines**: one header line carrying the facts and the inline evidence clauses, one instruction line.

### Why not a shared composer across all three arms

A single `_composeTurnEndBody(outcome, …)` covering `completed`, `blocked` and `stalled` looks tidier and is the wrong move right now. The `blocked` body is being authored concurrently by the pacing plan **in this same file**, and the PRD's orchestration discipline is explicit: one agent stream per provider file, same-file parallel edits collide. A shared abstraction would force the two plans into the same function body. Keep a separate composer, physically adjacent to the stall composer so the three are read together; unify later if the three ever converge on a shape, which they have not.

## Complexity Audit

### Routine

- One pure, side-effect-free string builder — no I/O, no `await`, no DB access.
- Two call sites already inside `try`/`catch`, each with the record in hand.
- Two one-line comments on the host fallbacks; no host behaviour changes.
- A one-line edit to one skill document, plus its generated mirror.

### Complex / Risky

- **Plan `topic` reaches an agent's prompt for the first time on this channel.** The body is delivered into the lead's terminal as text. A newline or a directive-shaped phrase in a plan title would break the two-line shape or forge a second instruction line. Flatten and truncate it (see Proposed Changes).
- **Two documents quote the current string verbatim**, and `npm run mirror:check` fails CI on `.claude/` drift. Changing the notice without changing both is a half-landed change of exactly the kind that reads as green.
- **Same-file concurrency** with the `blocked`-arm pacing plan and the lead-dispatch registration plan. Serialise, do not parallelise.

## Edge-Case & Dependency Audit

**Race Conditions.** None added. Single-fire is already owned by the `transitioned` boolean at both sites (`:468`, `:1336`); the composer is a synchronous pure function called on the same gate and introduces no new state, no timer and no await. It must be called **inside** each site's existing `try` block so a throw is logged by the handler already there rather than escaping past the notifier call. Because it does no I/O, its output cannot be stale relative to the gate that produced it.

**Security.** `record.topic` and `record.planFile` are user/agent-authored strings that this change pastes into another agent's prompt. `planFile` already travels on this channel; `topic` is new to it. Both are flattened (`replace(/[\r\n]+/g, ' ')`) and `topic` is truncated to 80 characters, so a multi-line or over-long title cannot break the two-line shape or append a line that reads as a second instruction. No new file reads, no new network, no new writes.

**Side Effects.** The composed body is mirrored verbatim into `.switchboard/orchestrator/reports/` by both hosts' `writeOrchestratorReport` call. That is a *feature* — the non-pty orchestrator gets the same evidence — and it is safe: `writeInboxFile` (`ScheduledJobsService.ts:74-108`) flattens only the frontmatter values (`from`, `kind`, `planId`, `feature`) and appends `req.body` verbatim below the closing `---`. A multi-line body cannot forge a frontmatter key. Report files grow by one line each.

**Dependencies & Conflicts.**
- `src/services/PlanIngestionEngine.ts` is also edited by `feature_plan_20260817141200_seat-gone-quiet-notice-flaps-and-spams-the-lead.md` (the `blocked` digest). Same file → serialise the two dispatches; do not run them in parallel worktrees against the same file.
- `a-lead-dispatched-plan-is-never-registered.md` changes the delivery layer, not this file, but it is what makes a lead-dispatched seat produce a `completed` notice at all. Without it this body is correct and simply never fires for that path. This plan does not depend on it to be verifiable — a board-dispatched seat exercises the same arm.
- `.claude/skills/` is generated from `.agents/` by `generateClaudeMirror` and guarded by `npm run mirror:check`. Any `.agents/skills/**` edit must ship with the regenerated mirror in the same change.

## Dependencies

- None blocking. The three sibling plans listed under **Scope** are adjacent, not prerequisite: this plan is verifiable against a board-dispatched seat, which already produces a `completed` notice today.
- Sequencing constraint (not a dependency): serialise against the `blocked`-arm pacing plan, which edits the same file.

## Adversarial Synthesis

Key risks: (1) the evidence clause originally specified — plan-file write age — is degenerate at the arm that actually fires, because the write *is* the trigger, so it would have shipped a "0s ago" line that looks like evidence and carries none; (2) the closing instruction named an action (`Rest the seat`) that does not exist anywhere in this repo, which would have taught every lead a verb it cannot call; (3) two skill documents quote the notice string verbatim and a CI mirror gate fails on drift, so a text-only change has a documentation half that no test for the code half would catch. Mitigations: evidence is turn duration derived from `dispatchedAt` (meaningful at both sites, no `stat`); the instruction is rewritten against the doctrine already in `terminal-coder-dispatch/SKILL.md` and names the real verb `attributePastedPrompt`, matching the stall arm; the doc + regenerated mirror are deliverables of this plan with `npm run mirror:check` as the gate.

## Proposed Changes

### `src/services/PlanIngestionEngine.ts` — a shared `completed` body composer

- **Context:** Two call sites construct the same notifier payload without a body — `:476` (sweep) and `:1337` (file-edit, the live one). The stall composer at `:1010-1032` is the working reference for shape, tone and cost.

- **Logic:** Add one **module-scope exported** function beside the class, adjacent to where the stall composer's output is built:

  ```ts
  export function composeCompletedTurnEndBody(
      record: Pick<KanbanPlanRecord, 'topic' | 'kanbanColumn' | 'featureId' | 'dispatchedAt'>,
      seatName: string,
      planFile: string,
      nowMs: number
  ): string
  ```

  > **Superseded:** `Add one private composer, _composeCompletedBody(record, planRoot, nowMs)`.
  > **Reason:** A `private` method cannot be exercised by a test without constructing the engine (a DB, a host, a logger) — the clause-omission matrix is exactly the thing worth unit-testing, and gating it behind engine construction is why such tests get downgraded to source-string assertions. `planRoot` was only there to `stat` the plan file, which this revision no longer does.
  > **Replaced with:** a module-scope exported pure function taking a structurally-typed record, the seat name, the plan path and `nowMs`. It stays physically beside the stall composer so the bodies are still read and edited together, and it is directly unit-testable from `out/`.

  It returns exactly two lines:

  ```
  [switchboard:turn-end] Seat '<seat>' finished its turn on '<planFile>' — "<topic>" (column <kanbanColumn>, feature <featureId>, worked <duration>).
  Verify the diff (git diff) before you trust the report, then close out that subtask, register the next one (attributePastedPrompt), and dispatch it. The system moves cards as work progresses — never move one yourself.
  ```

  1. **Line 1 — header + inline evidence.** It opens with the `[switchboard:turn-end]` marker and is a strict superset of today's one-liner, so anything a human or agent recognises today still matches. The marker is not optional: `.agents/skills/terminal-coder-dispatch/SKILL.md` and `.agents/skills/switchboard-orchestration/SKILL.md` both teach agents to recognise it, and the report mirror is indexed by it.
  2. **Evidence clauses**, built into an array and joined with `, `, each dropped when its source is unavailable rather than guessed:
     - `column <record.kanbanColumn>` — dropped when empty.
     - `feature <record.featureId>` — dropped when null/empty (a standalone plan).
     - `worked <duration>` — from `nowMs - Date.parse(record.dispatchedAt)`; dropped when `dispatchedAt` is absent or unparseable (`!Number.isFinite`), matching the sweep's own treatment of an unparseable stamp at `:421-424`. Format: `${Math.round(ms/1000)}s` under 120 s, else `${Math.round(ms/60000)}m` — a lead-dispatched coder routinely works 40 minutes, and `2400s` is a number nobody reads.
     - If **every** clause is empty, the parenthetical is omitted entirely — never `()`.
     - `— "<topic>"` is likewise dropped when `topic` is empty.
  3. **Line 2 — one closing instruction**, verbatim:

     > `Verify the diff (git diff) before you trust the report, then close out that subtask, register the next one (attributePastedPrompt), and dispatch it. The system moves cards as work progresses — never move one yourself.`

  > **Superseded (2026-08-30, already applied in `src/`):** `Verify the diff (git diff) before you trust the report, then advance the card or register the next subtask (attributePastedPrompt) and dispatch it.`
  > **Reason:** "advance the card" is the exact word `team-heads-must-not-move-cards` removed from `NEW_CODING_HEAD_PROMPT` because *"a team lead interpreted the word 'advance' … as a general instruction to move cards to new columns."* That plan scoped itself to the prompt text (its line 435: "Turn-end notification delivery — unchanged"), so the wording came back here — on a notice that reaches the same lead, on every coder completion, contradicting its own standing orders minutes apart.
  > **Replaced with:** the line above. `TURN_END_VERIFY_INSTRUCTION` (`PlanIngestionEngine.ts`) already carries it, `terminal-plan-attribution-contract` now guards it with `!/advanc/i`, and the endpoint for closing out is deliberately not restated because `composeAcceptanceInstruction` follows this sentence on the relay path. **Do not re-introduce the old text when coding this plan.**

  > **Superseded:** `Verify the work against git — the diff and the tests, not the seat's own report — then advance the card or dispatch the next subtask. Rest the seat if you have no further work for it.`
  > **Reason:** Two defects. (a) **"Rest the seat" is not a thing.** `grep -rn "rest the seat\|restSeat\|ptyRest" src/ .agents/` returns zero hits — there is no verb, no endpoint and no UI control by that name, so the sentence instructs every lead to perform an action that does not exist. (b) The rest of it restates, in different words, doctrine that already has a canonical phrasing in `terminal-coder-dispatch/SKILL.md:280-284` ("review the actual diff, not the coder's account of it… the message is a claim; `git diff` is the evidence") and drops the one thing the stall arm gets right — naming the actual verb (`attributePastedPrompt`) the recipient must call. A two-sentence instruction is also boilerplate on a per-completion message.
  > **Replaced with:** the single line above — same doctrine, canonical wording, real verb named, one sentence.

- **Implementation:**
  - **File-edit site (`:1337`)** — `clearedRecord` is captured at `:1308` *before* `updatedRecord.dispatchedAt` is nulled at `:1309`, so `clearedRecord.dispatchedAt` still holds the dispatch stamp. Pass `clearedRecord`, `clearedRecord.dispatchedTerminal`, `relativePath`, `Date.now()`. Call it inside the existing `try` at `:1337` so a throw hits the handler already there.
  - **Sweep site (`:476`)** — pass `record`, `terminalName`, `record.planFile`, `Date.now()`, inside the existing `try`.

  > **Superseded:** `the sweep site (:476) has record and the stat result from :447-448. Pass the already-computed mtime rather than re-stat-ing.`
  > **Reason:** Factually wrong on two counts. The `stat` at `:447` is declared with `const` **inside** the inner `for (const planRoot …)` loop's `try` block; it is out of scope at `:476`, where only the `completed` boolean survives. More importantly the evidence itself is degenerate: at the file-edit site — the arm that actually fires in practice, per the comment at `:1319-1326` — the plan-file write is precisely what triggered the notice, so its age is always ~0 s. A "plan file written 0s ago" clause is decoration that reads as evidence.
  > **Replaced with:** turn duration derived from `record.dispatchedAt`, which is present at both sites, meaningful at both, and needs no `stat` and no filesystem access at all. The stall arm stats because its subtasks have *no* outstanding dispatch to compare against (its own comment at `:1019-1023` says so); that is not true here, where a dispatch stamp is guaranteed by the arm's own precondition.

  - The composer must not throw: build the clause array defensively (`String(x || '')`, `Number.isFinite` on the parsed stamp) so a missing field drops its clause and the header plus instruction always survive.
  - `topic` and `planFile` are flattened with `replace(/[\r\n]+/g, ' ')`; `topic` is additionally truncated to 80 characters with a trailing `…`. See the Security note above.

- **Edge cases:** Empty `kanbanColumn` → clause omitted; the instruction still reads correctly. No `featureId` (standalone plan) → omitted; "advance the card" still applies. Absent or unparseable `dispatchedAt` → duration omitted; the seat still finished. Empty `topic` → the `— "…"` clause is omitted. All clauses empty → no parenthetical at all.

  > **Superseded:** ``planFile`` empty (the malformed case the `??` fallback exists for) → return no body and let the host's inline one-liner run.
  > **Reason:** Unreachable from both call sites, so it is an edge case invented for a test to pass. The sweep site guards `if (!record || !record.planFile || !record.dispatchedAt) continue;` at `:420`; the file-edit site is driven by `relativePath`, which is the path of the file that just fired the watcher. The host's `info.body ?? …` fallback is not being removed — it still serves the `stalled` arm, which deliberately passes `planFile: ''` (`:1040`) — but nothing in the `completed` path can reach it once a body is supplied, and pretending otherwise adds a branch and a test that assert nothing.
  > **Replaced with:** the composer is documented as being called only with a non-empty `planFile`; the host fallback is left exactly as it is, unreferenced by this arm.

### `src/services/TaskViewerProvider.ts` (`:1405-1412`) and `src/standalone/bootstrap.ts` (`:2029-2035`) — no behavioural change

- **Context:** Both compose the inline `completed` string as the `info.body ?? (…)` fallback.
- **Logic:** No change. Add a one-line comment on each `completed` arm naming `composeCompletedTurnEndBody` as the real producer, so the next reader does not edit the fallback believing it is the live string — the same comment the pacing plan adds to the `blocked` arm.
- **Implementation:** Verify **both** hosts honour a supplied `body` for `completed` before relying on it — confirmed present at `TaskViewerProvider.ts:1408` and `bootstrap.ts:2031`; re-confirm after any concurrent edit by the sibling plans, which touch the same two arms.

### `.agents/skills/terminal-coder-dispatch/SKILL.md` (`:225-227`) — the doc that quotes the old string

*Clarification, not new scope: this is the same deliverable — the notice text — in its documented form.*

- **Context:** "What the wake looks like" quotes the `completed` notice verbatim: `` `Seat '<coder>' finished its turn on '<plan file>'.` `` followed by prose that supplies the missing instruction — *"The coder's plan file advanced. Review the diff (see The review turn)."* Once the wire carries the instruction, that prose describes a message that no longer exists.
- **Logic:** Update the quoted `completed` example to the new two-line body and shorten the prose to note that the notice now carries the review instruction and the card's state inline. Leave the `blocked` bullet alone — it belongs to the pacing plan. Leave "The review turn" section unchanged; it is the source of the new wording, not a duplicate of it.
- **Implementation:** `.agents/` is the control-plane source of truth. After editing it, regenerate the mirror rather than hand-editing `.claude/skills/terminal-coder-dispatch/SKILL.md` (the generator rewrites frontmatter, so the two files are not line-identical):

  ```bash
  npm run compile-tests
  node -e "const {generateClaudeMirror}=require('./out/services/ClaudeCodeMirrorService');console.log(generateClaudeMirror(process.cwd(), require('./package.json').version))"
  npm run mirror:check
  ```

- **Edge cases:** `.agents/skills/switchboard-orchestration/SKILL.md:321` and `.agents/skills/switchboard-orchestrator/SKILL.md:181` mention `[switchboard:turn-end]` but do **not** quote the completed body — they describe the report mirror. The marker is preserved by this change, so neither needs editing. Do not touch them.

## Verification Plan

1. Dispatch a subtask directly to a team member. When it writes its plan file, the lead receives a two-line notice: the header naming seat, plan file, title, column and turn duration, then the instruction line.
2. The same notice is **not** followed by a standing-orders block or a seat directive block — the delivery flags are unchanged.
3. Complete a subtask that belongs to a feature. The header carries `feature <id>`. Complete a standalone plan. That clause is absent and the line still reads correctly.
4. Complete a plan dispatched with no resolvable `dispatchedAt` (or corrupt the stamp). The `worked …` clause is absent; header and instruction are present.
5. Complete a plan whose title contains a newline and a 200-character tail. The notice is still two lines and the title is truncated.
6. Drive a feature end to end with a lead and two coders. Every completion carries the instruction; the lead acts without asking what to do, and the notice never exceeds two lines.
7. Under `npx switchboard`, the same completion produces the same body — the two hosts do not diverge.
8. A `blocked` and a `stalled` notice in the same session are unchanged by this work.
9. `.switchboard/orchestrator/reports/*.md` for the completion contains the full two-line body below intact frontmatter (a single `kind:` key).

### Automated Tests

- A unit test over `composeCompletedTurnEndBody` covering the clause matrix: each of `topic` / `kanbanColumn` / `featureId` / `dispatchedAt` present and absent. Assert each missing clause is **dropped**, never rendered as `undefined`, an empty value, or a stray `()`/`, ,`; assert the header and instruction survive every combination.
- A unit test on duration formatting: 45 s → `worked 45s`; 14 min → `worked 14m`; unparseable `dispatchedAt` → clause absent.
- A unit test asserting the body is exactly two lines, that line 1 starts with `[switchboard:turn-end]`, and that line 2 is the instruction — with the `attributePastedPrompt` verb name and `git diff` both present, so a future reword cannot silently drop the actionable half.
- A unit test asserting a `topic` containing `\n` and 200 characters yields a single header line of bounded length.
- A source assertion that **both** `completed` notifier call sites in `PlanIngestionEngine.ts` pass a `body:` — in the style of the existing checks in `src/test/terminal-plan-attribution-contract.test.js`.
- A two-host source assertion that neither host's `completed` arm stops honouring `info.body`, in the style of the existing `info.body ?? (…)` checks.
- `npm run mirror:check` — the `.claude/` mirror must be regenerated with the `.agents/` skill edit or CI fails.
- Re-run `src/test/orchestrator-tick-and-reports-contract.test.js` unchanged as a cheap regression check.

  > **Superseded:** *"the turn-end mirror writes the body to `.switchboard/orchestrator/reports/`, so a longer body must not break the frontmatter flattening that test pins."*
  > **Reason:** Overstates the risk and misnames the mechanism. `writeInboxFile` (`ScheduledJobsService.ts:81-90`) applies `flatten()` only to the frontmatter values and appends `req.body` verbatim after the closing `---`; the test at `orchestrator-tick-and-reports-contract.test.js:300-310` pins a newline in `kind`, not in `body`. A multi-line body cannot forge a frontmatter key — and the `stalled` arm already ships multi-line bodies through this exact path today.
  > **Replaced with:** re-run the suite unchanged as a regression check on the two-host mirror wiring it also pins (`:332-355`), not as a flattening risk.

**Recommendation: Send to Coder** (complexity 4).

## Completion Report

Implemented `composeCompletedTurnEndBody` in `src/services/PlanIngestionEngine.ts` and wired it into both completed notifier call sites (sweep and file-edit). Added referencing comments in `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts`. Updated the completed notice documentation in `.agents/skills/terminal-coder-dispatch/SKILL.md`. Added unit test coverage for the clause matrix, duration formatting, and newline/length bounds alongside source assertions in `src/test/terminal-plan-attribution-contract.test.js`. No issues encountered.


## Review Findings

Reviewed in place against the plan. `composeCompletedTurnEndBody` (`src/services/PlanIngestionEngine.ts:1973`) matches the specified shape exactly — two lines, superset header, clause-dropping parenthetical, `dispatchedAt`-derived duration, flattened/80-char-truncated topic — and both `completed` call sites (`:587` sweep, `:1800` file-edit) pass it inside their existing `try`, with `clearedRecord` captured before `dispatchedAt` is nulled. Both hosts still honour `info.body` and still deliver with `standingOrders: false` / seat block suppressed; `.agents/` + regenerated `.claude/` mirror agree and `mirror:check` is wired in CI. Two fixes applied: the plan's named "unparseable `dispatchedAt` → clause absent" test was missing (only the `null` short-circuit was covered, so the `Number.isFinite` guard was untested and `worked NaNs` could ship) — added to `src/test/terminal-plan-attribution-contract.test.js`; and four host comments still described the notice as "one-line" / claimed the engine passes no body — corrected in `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts`. Validation: `compile-tests` clean, `test:contract:terminal-plan-attribution` 41/41, plus `orchestrator-tick`, `terminal-coder-dispatch`, `standing-orders-marker`, `seat-safeguards`, `queue-pipeline`, `mirror:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `verb-returns:check` all green; eslint 0 errors. Remaining risk is cosmetic only: `slice(0, 80)` can split a surrogate pair in an emoji plan title, and the clause matrix is combinatorial rather than exhaustive per-field.
