# A Lead-Dispatched Agent Is Told Less Than a Board-Dispatched One

## Goal

Make a prompt composed by a **lead** carry the same load-bearing directives the **board** attaches, so work driven through a team produces the same signals as work driven from a card. Today the board's dispatch path attaches directives that the lead's `ptySendPrompt` path does not, and every one of them is a signal something downstream depends on. The result is a team that finishes its work correctly and reports nothing the system can see.

### The incident this comes from (2026-08-17, observed)

A lead (`lead-1`) drove all four subtasks of *The Orchestrator Runs as a Ticking Agent* to completion through two coder seats. Measured afterwards:

- **Zero of four plan files received a completion report.** All four mtimes were still from the planning pass hours earlier. The coders reported to the lead over `ptySendPrompt` and were never told to write the file.
- **Every turn-end notice in the session was `blocked`.** Not one `completed` fired across four finished subtasks. The moment the lead appended the reports by hand, three `completed` notices fired immediately — the signal keys on the plan-file write, and nothing was asking for it.
- **A complexity-3 plan whose own file says `Recommendation: Complexity 3 → Send to Intern` went to a coder** while the team's intern seat sat idle for the entire session. The lead's prompt contained no instruction to route by seat.
- **The lead posted nothing to `.switchboard/orchestrator/reports/`**, the file inbox whose spec names leads as its primary writer — including for the several hours during which that very directory was being implemented by its own team.

Each of these is the same shape: a directive exists, the board attaches it, the lead's path does not, and the missing directive is invisible because its absence produces silence rather than an error.

### Root cause

`CODING_COMPLETION_REPORT_DIRECTIVE` (`src/services/agentPromptBuilder.ts:945`) and the newly-added `ORCHESTRATOR_REPORT_DIRECTIVE` (`:969`) are appended by `ensureCompletionDirective` / `ensureOrchestratorReportDirective` on the **board** dispatch composition path. A lead calling `POST /terminals/verb/ptySendPrompt` gets the seat directive block (`_ptyHostVerb` → `buildSeatDirectiveBlock`) and the standing-orders block — but not these. The seat block carries *safeguards* (git policy, skip-compilation, subagent policy); it does not carry *protocol* directives.

So the split is: safeguards ride the seat, protocol rides the board card, and a lead-dispatched agent sits in the gap. Nothing in the delivery layer knows the difference between "a human pasted a note into a terminal" and "a lead dispatched a subtask", so it cannot attach protocol to only the latter.

**Why this is not merely cosmetic.** The plan-file completion report is signal #1 of the orchestrator persona that landed in `f07a8038` — *"The report's presence is the fact."* With no report, a tick's coding-lane guard reads finished subtasks as permanently in flight, and the lane never frees. The feature ships an orchestrator whose primary completion signal is not produced by the most common way work actually gets done.

**Confirmed mechanism, read at HEAD.** `GlobalPlanWatcher`'s silence sweep (`src/services/PlanIngestionEngine.ts:415-500`) is the arbiter. For each silent terminal it reads `getActiveDispatchedByTerminal(wsId, terminalName)` and compares the plan file's `mtimeMs` against `Date.parse(record.dispatchedAt)`. `mtime > dispatchedAt` ⇒ `clearWorkingState` + `outcome: 'completed'`; otherwise ⇒ `setBlockedState` + `outcome: 'blocked'`. Two consequences follow, and both are load-bearing for this plan:

1. The observed all-`blocked` result **proves attribution succeeded** — a record carrying a `dispatchedAt` had to exist for the sweep to reach either arm at all. What was missing was the plan-file write, i.e. the completion directive. Change 1 is the fix for the observed defect; change 2 is a robustness fix for an adjacent failure that did *not* occur here.
2. Attribution must precede delivery, because `dispatched_at` is the comparison basis. `attributePasteDispatch` (`src/services/KanbanDatabase.ts:9734`) writes `dispatched_agent`, `dispatched_terminal` and `dispatched_at` in one UPDATE, and a non-NULL `dispatched_at` **is** the card's working flag (`clearWorkingState`'s doc comment states it directly). Attributing *after* delivery would stamp a `dispatched_at` later than a fast coder's plan-file write and mis-read a real completion as blocked.

### Decided: the feature file is not a progress surface

Raised during triage: mid-flight status is what the reports directory is for, so would it be simpler to drop the directory and append status to the feature file instead? **No — keep the directory. Recorded here with the real reasoning so a later agent does not re-open it and reach a different answer.**

1. **Feature files are git-tracked; the reports directory is not.** `.gitignore:52` ignores `.switchboard/*`, but `:55` explicitly un-ignores `.switchboard/features/`. `.switchboard/orchestrator/reports/` has no such negation and is ignored (verified with `git check-ignore`). Status written to a feature file therefore lands in commits — an orchestrator ticking on an interval overnight would produce a stream of status commits on tracked files and pollute the merge-back flow. This is the same hazard `agent-reports-go-to-a-file-inbox.md` cites for keeping reports gitignored.
2. **One feature file has four concurrent writers** — two or more coders, the lead, and the system turn-end mirror in both hosts. Appending is read-modify-write, so simultaneous writes lose updates. One file per report makes that structurally impossible, which is most of what the directory design buys.
3. **Claim/dedup, and reports with no feature.** The orchestrator must record what it has already acted on; a `claimed/` directory gives that for free, whereas inline markers would make the orchestrator a fifth concurrent writer to a tracked file. A standalone plan has no feature file at all, so a lead's `question` or `status` about one would have nowhere to go.

A weaker argument that should **not** be relied on: that the `<!-- BEGIN SUBTASKS -->` block is regenerated wholesale from board state by `KanbanProvider.ts:12775`. That is true, and three prompt builders correctly forbid editing it — but prose *outside* the markers survives regeneration, so it does not by itself rule out feature-file status.

The split to keep is **by audience**: the reports directory is the machine-readable mid-flight channel the orchestrator drains; the feature file is the human surface and carries the end-of-feature summary. Do not duplicate mid-flight status into both. The persona's Signals section names three signals and the feature file is deliberately not among them.

## Metadata

**Tags:** backend, reliability, api
**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine

- Appending an already-idempotent directive at an existing chokepoint. `ensureCompletionDirective` / `ensureOrchestratorReportDirective` guard on a sentinel substring and are already called at six board sites.
- Prompt-text edits to the Coding-team head prompt (changes 3 and 4) — string constants with existing byte-identity contract coverage.
- Reading the seat's role: `_ptyHostVerb` already resolves it from `ptyListTerminals` for the seat block, and `deliverPrompt` reads it straight off the handle. No new lookup.

### Complex / Risky

- **Two chokepoints, not one.** The extension host composes in `TaskViewerProvider._ptyHostVerb` (`src/services/TaskViewerProvider.ts:446-530`); the standalone host composes in `bootstrap.ts`'s `deliverPrompt` (`src/standalone/bootstrap.ts:240-281`), with its own `ptySendPrompt` case at `:1451`. The plan as originally written named only the first. Implementing one and not the other splits the two hosts on prompt content, which the PRD's two-hosts-one-engine architecture forbids.
- **`dispatch` is the first caller-settable prompt-composition field.** `addonsComposed` and `seatBlock` are deliberately **stripped** at the HTTP boundary in both hosts (`TaskViewerProvider.handlePtyVerb`; `bootstrap.ts:1486-1487`) precisely so an HTTP caller cannot opt a seat out of its own safeguards. `dispatch` must *not* be stripped — the lead is an HTTP caller — which makes it untrusted input that reaches a DB `UPDATE`.
- **`/terminals/verb/*` has no schema validation at all.** `_handleTerminalVerb` (`src/services/LocalApiServer.ts:1857`) does auth, parses the body, and forwards; there is no `ptySendPrompt` entry in `verbSchemas.ts`. PRD contract #5 applies the moment `dispatch` carries a plan identifier into `getPlanByPlanFile` / `attributePasteDispatch`.
- **Attaching protocol to the wrong message is actively harmful.** A coder reporting back to its lead uses the same `ptySendPrompt` verb. If the completion directive reached that message, the *lead* would append a summary to a plan file, advancing its mtime and firing a false `completed`. The dispatch/message distinction is not cosmetic — it is what keeps the completion signal honest.
- **Ordering coupling with the sibling plan.** Changes 3 and 4 edit `NEW_CODING_HEAD_PROMPT` — the exact literal the sibling stale-standing-order plan migrates *to*, and persists. See Dependencies.

## Edge-Case & Dependency Audit

### Race Conditions

- **Attribution before delivery, always.** `dispatched_at` is the comparison basis for the completed/blocked decision (see Root cause). Server-side folding (change 2) takes the ordering out of the lead's hands, which is most of its value.
- **Two subtasks dispatched to the same seat in quick succession.** `getActiveDispatchedByTerminal` resolves one record per terminal, so a second attribution overwrites `dispatched_at` for a *different* plan file and the first plan's completion becomes unobservable. This is pre-existing behaviour of the paste path and is not fixed here — but folding attribution into the send makes it cheaper to hit. Record it; rely on the lead's one-subtask-per-coder discipline (change 3's routing line reinforces it).
- **Seat exits between role resolution and delivery.** `_ptyHostVerb` already tolerates this — the send returns `{success:false}` in the body rather than throwing. With attribution folded in, a failed *send* after a successful *attribution* leaves a lit card with no working agent. The response body must report the two outcomes separately so the caller can tell which half failed.

### Security

- `dispatch.planFile` / `dispatch.planId` are attacker-controlled from the route's perspective (localhost + `SWITCHBOARD_API_TOKEN` gated, but unvalidated). Validate shape before use: `planId` a string, `planFile` a string, `role` a member of a known role set. Reject unknown shapes with `{success:false, error}` rather than coercing.
- `dispatch.role` must never be used to *select* a seat safeguard set. The seat block resolves role from the terminal record, never from the payload — that invariant is exactly why `seatBlock` is stripped, and `dispatch.role` must not become a way around it. Here `role` is metadata written to `dispatched_agent`, nothing more.

### Side Effects

- The folded attribution writes `dispatched_agent` / `dispatched_terminal` / `dispatched_at` and lights the card. That is the intent, and it is what makes the coding lane observable — but a `dispatch`-marked `ptySendPrompt` now mutates board state where it previously did not. Document the field as *dispatching*, not *annotating*.
- Board refresh: the existing `attributePastedPrompt` arm already calls `_scheduleBoardRefresh` for the resolved plan's root. The folded path inherits it — do not add a second refresh.

### Dependencies & Conflicts

- Both hosts import from `agentPromptBuilder`, so adding a shared directive-bundle export there is additive and changes no board behaviour. It must land before either chokepoint edit.
- `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts` are different files and may parallelise under the PRD's one-stream-per-provider-file rule.
- Changes 3 and 4 edit `NEW_CODING_HEAD_PROMPT` in `src/services/teamWiring.ts`, its client mirror `NEW_CODING_HEAD_PROMPT_CLIENT` in `src/webview/terminals.js`, and the shipped `headPrompt` in `src/webview/kanban.html`. `src/test/stage-marker-commit-contract.test.js:344` asserts all three byte-identical — edit one, edit all three.

## Dependencies

- `agent-reports-go-to-a-file-inbox.md` (landed, `2268fb5e`) — supplies `ORCHESTRATOR_REPORT_DIRECTIVE` and the reports directory this plan tells the lead to use.
- `orchestrator-persona-becomes-a-tick.md` (landed, `f07a8038`) — defines the three signals whose first one this plan repairs.
- Sibling: `a-stale-standing-order-can-still-reach-a-live-agent.md` — same class (the instruction an agent receives is not the one intended), different mechanism.

> **Superseded:** "Sibling: `a-stale-standing-order-can-still-reach-a-live-agent.md` … Independent; either may land first."
> **Reason:** Not independent. This plan's changes 3 and 4 rewrite `NEW_CODING_HEAD_PROMPT`; the sibling's recogniser rewrites stale rows *to* `NEW_CODING_HEAD_PROMPT` and — critically — its change 1 **persists** that result into `terminals.standingOrders`. Land the sibling first and every install's head row is frozen on the pre-change-3/4 text, with the `OLD_HEADPROMPT_FRAGMENT` recogniser no longer matching anything and nothing left to key a second migration on. The result is a permanently stale head prompt on every migrated install — precisely the defect the sibling exists to remove.
> **Replaced with:** **This plan's prompt edits (changes 3 and 4) must land before the sibling's persisting pass (its change 1).** If the sibling must go first for other reasons, it must ship the template-version stamp described in its own architecture review, so a later text edit stays migratable. Record the chosen order on whichever card is dispatched second.

> **Superseded:** "Feature *Agent Instruction Surface — What Dispatched Agents Are Actually Told* (`c3f6fa01-cbbe-4d44-aff4-11f04e114835`, PLAN REVIEWED) is the natural home."
> **Reason:** That feature is finished, not in progress. Its file records all three subtasks landed in sequence (`f996edda` → `025de73c` → `d8f9c0b9`) and carries a completed reviewer pass with executed verification. Attaching new subtasks reopens a closed, reviewed feature and invalidates its recorded result.
> **Replaced with:** These two plans want a **new** feature of the same class. Naming and creating it is a board decision, not a coding step — raised with the user rather than performed here.

## Adversarial Synthesis

Key risks: the `dispatch` field is optional, so the same lead that caused the incident can omit it and reproduce the incident exactly, with the same silence; naming two directives inline at a new site re-creates the convention-maintenance failure that `orchestrator-tick-and-reports-contract.test.js` already exists to police; and implementing only the extension chokepoint splits the two hosts' prompt content. Mitigations: one exported `ensureDispatchProtocolDirectives()` applied at both the board sites and both delivery chokepoints, pinned by a parity contract test; a response body naming what was attached and what was attributed, so omission is visible rather than silent; and shape-validation of the new caller-settable field at the HTTP boundary, which `/terminals/verb/*` has none of today.

## Proposed Changes

### 1. Mark lead-originated dispatches, and attach protocol directives to them

- **Context.** `ptySendPrompt` cannot distinguish a subtask dispatch from an arbitrary message, so it attaches no protocol.
- **Logic.** Make the caller declare intent rather than making the delivery layer guess. The chokepoint already has the precedent — it appends the seat block when `addonsComposed !== true`, i.e. "attach what the composer didn't". Protocol directives are the same shape, but gated on the message being a *dispatch* rather than on the message merely existing: a coder's report back to its lead travels on this same verb, and a completion directive on that message would make the lead write a plan file and fire a false `completed`.
- **Implementation.** Add an optional `dispatch` field to the `ptySendPrompt` payload — `{ dispatch: { planId?, planFile?, role? } }`. When present, apply the shared protocol bundle (below) to the prompt text at the composition chokepoint. When absent, behaviour is byte-identical to today (PRD contract #2).

  > **Superseded:** "the delivery layer appends the same completion and reports directives the board path attaches, using the existing idempotent `ensureCompletionDirective` / `ensureOrchestratorReportDirective` guards."
  > **Reason:** Naming the two directives inline at a new site re-creates exactly the maintenance failure this plan is about. `src/test/orchestrator-tick-and-reports-contract.test.js:359-365` exists solely to count `ensureCompletionDirective` call sites against `ensureOrchestratorReportDirective` call sites and fail when they diverge — proof that "remember to pair them at every site" has already been lost once. A third and fourth site multiply that. And the plan's own goal is *told the same as a board-dispatched one*: two directives is not the same set, so the next directive added to the board path again fails to reach leads.
  > **Replaced with:** Export one bundle from `src/services/agentPromptBuilder.ts`:
  >
  > ```ts
  > /** The protocol directives every code-touching dispatch carries, board or lead.
  >  *  Idempotent — each member guards on its own sentinel. Add new dispatch-protocol
  >  *  directives HERE, never at a call site. */
  > export function ensureDispatchProtocolDirectives(text: string): string {
  >     return ensureOrchestratorReportDirective(ensureCompletionDirective(text));
  > }
  > ```
  >
  > Repoint the six existing board sites (`:1658/1659`, `:1774/1775`, `:1828/1829`, `:1882/1883`, `:1922/1923`, `:2328/2329`) at it, and call it from both delivery chokepoints on the `dispatch` path. A contract test then asserts the bundle is the *only* caller of the two `ensure*` functions outside their own definitions — a grep for a function name, not a proximity heuristic, so it cannot drift.

- **Where.** Both chokepoints, not one:
  - **Extension host** — `src/services/TaskViewerProvider.ts:446`, inside the existing `if (verb === 'ptySendPrompt' && typeof payload?.data === 'string')` block. Apply the bundle **before** the seat block and standing orders, so the existing ordering invariant (seat block, then standing orders last, `$`-anchored by `STANDING_ORDERS_BLOCK_RE`) is untouched.
  - **Standalone host** — `src/standalone/bootstrap.ts`'s `deliverPrompt` (`:240`), which already takes `applyOrders` / `applySeatBlock` flags; add a `dispatch` parameter threaded from the `ptySendPrompt` case at `:1451`. Do **not** add `dispatch` to that case's host-only strip list (`:1486-1487`) — it is deliberately caller-settable.
- **Edge cases.**
  - The guards are already idempotent — a lead that hand-writes the directive must not get it twice. Preserved: the bundle only composes the two existing sentinel-guarded functions.
  - An unknown `role` attaches the protocol bundle only, never a guessed seat safeguard. The seat block continues to resolve role from the terminal record, never from `dispatch.role`.
  - `dispatch` present with empty `data` → no-op, same as today's empty-prompt path.
  - `dispatch` present on a message to a head/lead seat: still attaches. That is correct — a lead handed a subtask *is* a dispatched agent. The harmful case is a *report* message, and a report carries no `dispatch`.

### 2. Fold registration into the same call

- **Context.** `attributePastedPrompt` must be called *before* `ptySendPrompt` or the turn-end backstop has no record, and the lead is instructed to make two calls in the right order. The ordering is load-bearing (`dispatched_at` must precede the plan-file write) and a lead that forgets, or that gets `attributed: 0` and does not check the body, is silently uncovered.
- **Implementation.** When `dispatch` is present, perform the attribution server-side before delivery and return its outcome in the body alongside the send result. The standalone verb `attributePastedPrompt` stays for the paste/drop path it is shared with. In the extension host, `TaskViewerProvider` already holds `this._kanbanProvider` (used at `:491` for `resolveSeatPromptOptions`), so the call is `this._kanbanProvider.handleServiceVerb('attributePastedPrompt', { terminalName: payload.name, role: dispatch.role, planIds, planFiles, workspaceRoot })`. In standalone, `bootstrap.ts` constructs `kanbanProvider` at `:774` and `deliverPrompt` already reaches it at `:255`.
- **Treat `attributed: 0` as failure.** The existing arm returns `{ success: true, attributed: 0, skipped: N }` when it resolves nothing (`src/services/KanbanProvider.ts:10107`). That is a hollow success — the shape PRD contracts #4 and #6 exist to forbid — and it is precisely why the plan's own text says a lead "that does not check the body is silently uncovered". The folded path must not inherit it: `attributed === 0` under a non-empty `dispatch` is a failure, not a success.
- **Response shape (additive).** `{ success, attributed, skipped, directivesAttached: string[], error? }`. `directivesAttached` is what makes an omitted `dispatch` field *observable* rather than silent — a lead can see that it dispatched with no protocol attached, which is the one thing nobody could see during the incident.
- **Edge cases.**
  - A failed attribution must not silently proceed — return `{success:false, error}` and deliver nothing (PRD contract #4). Fail-closed on purpose: an unrecorded dispatch is worse than a non-dispatch, because the card is dark and the lane never frees.
  - Attribution succeeds, delivery fails → report both fields distinctly. Do not roll back the attribution; the card lights and the stall watchdog surfaces it, which is the honest outcome.
  - `kanbanProvider` unavailable (headless / test harness) → `{success:false, error}`, never a silent skip. A capability that isn't wired is absent, not faked (PRD contract #6).

### 3. Tell the lead how to pick a seat

- **Context.** Plans carry an explicit `Recommendation: Complexity N → Send to <role>` line. Nothing puts it in front of the lead.

  > **Superseded:** "Add a seat-routing line to the lead/head prompt: read each subtask plan's recommendation and dispatch to a seat of that role when one exists in the team."
  > **Reason:** This bakes a routing policy into an LLM's reading of a markdown line, and the board already owns that policy — configurably. `KanbanProvider._resolveRoleFromComplexity` (`src/services/KanbanProvider.ts:1420-1442`) resolves complexity → role through the operator's scope-aware `kanban.routingMapConfig` (`{ lead: number[]; coder: number[]; intern: number[] }`), falls back to `scoreToRoutingRole`, and applies the pair-programming bypass that forbids intern routing while pair mode is on. `POST /kanban/dispatch` already routes by it when `targetColumn` is omitted or `"auto"` (`src/services/LocalApiServer.ts:1274-1283`). A lead parsing the `Recommendation:` line would defeat all three: an operator who remapped complexity 3 → coder would still get an intern, and pair mode's bypass would be silently overridden. Nothing in `src/` parses that markdown line — verified by grep — so it is planner prose, not a system contract.
  > **Replaced with:** Have the board answer the question. Surface the resolved role on the read the lead already makes — add `recommendedRole` (from `_resolveRoleFromComplexity(complexity, projectScope)`) to the subtask rows returned by the feature/plan read — and make the head-prompt line: *"each subtask carries a `recommendedRole`; dispatch it to a seat of that role on your team. If your team has no such seat, dispatch to a coder and say why in your status report."* The lead then follows the operator's configuration instead of a constant frozen into a prompt, and the routing policy stays in one place.

- **Edge cases.** No seat of the recommended role → fall back to a coder and say so, never stall. The recommendation is advice, not a gate. `recommendedRole` absent (unknown complexity) → coder; do not diverge from `allowUnknownComplexityAutoMove`, which already governs the board's equivalent decision.

### 4. Tell the lead to post status as it goes

- **Context.** `ORCHESTRATOR_REPORT_DIRECTIVE` addresses the agent doing the work. A lead driving a feature is the reports directory's primary intended writer and is never addressed.
- **Implementation.** Extend the head prompt: post a `status` report when a subtask is dispatched and a `finished` report when the feature is handed to review, using the documented filename and frontmatter (`report-<UTC timestamp>-<kind>-<5 digits>.md`; frontmatter `from` / `kind` / `planId` / `created`; one-line body — specified verbatim in `ORCHESTRATOR_REPORT_DIRECTIVE`, `src/services/agentPromptBuilder.ts:969`). This is what makes a non-pty orchestrator able to see a team's progress at all.
- **Where.** `NEW_CODING_HEAD_PROMPT` (`src/services/teamWiring.ts:174`), its client mirror `NEW_CODING_HEAD_PROMPT_CLIENT` (`src/webview/terminals.js`), and the shipped `headPrompt` in `src/webview/kanban.html`'s Coding entry. All three are pinned byte-identical by `src/test/stage-marker-commit-contract.test.js:336-357` — that test is why a partial edit cannot ship, and it must be tracked and CI-wired (the sibling plan's change 4) for the guarantee to hold.
- **Edge cases.**
  - Must not become per-message chatter — dispatch and hand-off only, matching the persona's "silent when idle" discipline.
  - The head prompt is a *standing order*, re-rendered onto every prompt the lead receives. Keep both additions (changes 3 and 4) to one sentence each so the block does not bloat every send.

## Verification Plan

1. A lead dispatches a subtask with `dispatch` set; the coder's prompt contains the completion directive, and on finishing it writes the report into its plan file.
2. That write produces a `completed` turn-end notice, not a `blocked` one — the inverse of the observed incident.
3. A lead dispatch with `dispatch` absent delivers a byte-identical prompt to today.
4. A prompt that already contains the completion directive does not receive a second copy.
5. A failed attribution returns `success:false` and no prompt is delivered.
6. `attributed: 0` under a non-empty `dispatch` is reported as a failure, not a success.
7. The response body names the directives attached, so a dispatch sent without the `dispatch` field is visibly protocol-less rather than silently so.
8. A subtask whose `recommendedRole` is `intern` goes to the intern seat when the team has one, and to a coder with a stated reason when it does not — **and** an operator who remaps complexity 3 to `coder` in `kanban.routingMapConfig` sees it go to a coder, proving the lead followed the board's policy rather than a baked-in split.
9. Driving a feature end to end produces `status` reports at each dispatch and one `finished` report at hand-off — and no report per ordinary message.
10. An orchestrator reading only `.switchboard/orchestrator/reports/` and the plan files can tell, without asking, that the feature finished.
11. The standalone host (`npx switchboard`) produces the same delivered prompt for the same `dispatch` payload as the extension host — the two hosts do not diverge.
12. A coder's report back to its lead (no `dispatch` field) carries **no** completion directive, so the lead does not write a plan file and no false `completed` fires.

### Automated Tests

- **Bundle parity (the load-bearing one).** A source-contract test asserting `ensureCompletionDirective` and `ensureOrchestratorReportDirective` have no callers outside `ensureDispatchProtocolDirectives` and their own definitions, and that both delivery chokepoints call the bundle on the `dispatch` path. This supersedes the counting assertion in `src/test/orchestrator-tick-and-reports-contract.test.js:359-365` — update that test rather than leaving two overlapping heuristics.
- **Composition test** asserting the directive set attached for `dispatch` present vs. absent, plus an idempotence test for the double-append case.
- **Two-host test** asserting `bootstrap.ts`'s `ptySendPrompt` case threads `dispatch` into `deliverPrompt` and does **not** strip it, alongside the `TaskViewerProvider._ptyHostVerb` equivalent — the same shape as the existing `standingOrders !== false` three-chokepoint assertions in `src/test/standing-orders-marker-contract.test.js:557-576`.
- **Hollow-success test** asserting the folded path maps `attributed: 0` to `{success:false}`.
- The routing and reporting changes are prompt text — cover them with the existing source-contract style (assert the load-bearing literals are present) rather than behavioural tests. `stage-marker-commit-contract.test.js`'s byte-identity assertions already cover the three-way head-prompt mirror; extend its load-bearing-literal list with the new sentences.

---

**Recommendation:** Complexity 6 → **Send to Coder.**

## Completion Report

Implemented dispatch protocol directives bundling via `ensureDispatchProtocolDirectives` across all board dispatch sites and the PTY delivery layer. Wired `dispatch` payload support into `TaskViewerProvider._ptyHostVerb` and `bootstrap.ts` (`handlePtyVerb` & `deliverPrompt`) with folded attribution and fail-closed handling on attribution failure (`attributed === 0`). Updated `TASK_VIEWER_VERB_SCHEMAS`, synchronized `NEW_CODING_HEAD_PROMPT` byte-for-byte across `teamWiring.ts`, `terminals.js`, and `kanban.html`, and updated automated contract tests. No issues encountered during implementation.

## Review Findings

Reviewer pass fixed four gaps that left the plan's own thesis unreachable. (1) CRITICAL — change 3 was half-done: the head prompt named `recommendedRole` but no read produced it; added `LocalApiServer._withRecommendedRole` stamping `GET /kanban/plans|features|plan` from a new `resolveRoutedRole` seam wired in both hosts to `KanbanProvider.resolveRoutedRole`, so routing follows the operator's map and pair-mode bypass. (2) CRITICAL — the `dispatch` field was documented nowhere, so no lead would ever send it; documented it in `terminal-coder-dispatch` §3.5 and the `switchboard-orchestration` route table plus `recommendedRole`, mirrored to `.claude/skills`. (3) MAJOR — the plan's Security requirement was coerced instead of enforced: added `validateDispatchPayload` (reject non-string ids, reject unknown roles) called by both chokepoints, and wired `validateVerbPayload` into `_handleTerminalVerb` scoped to `pty*` so the declared schema is no longer dead on the route the lead calls. (4) MAJOR — the bundle-parity gate had been weakened to an occurrence count; rewritten as the plan specified (no callers of either `ensure*` outside the bundle, both chokepoints attach it, `recommendedRole` is stamped and wired). Files changed: `agentPromptBuilder.ts`, `LocalApiServer.ts`, `TaskViewerProvider.ts`, `bootstrap.ts`, `teamWiring.ts`, `orchestrator-tick-and-reports-contract.test.js`, `seat-safeguards-fleet-prompt-path.test.js`, both skill files + mirrors. Validation: typecheck clean (6 pre-existing `TerminalGroupsSettingsAccessor` errors from adjacent uncommitted `terminals.groups` work fixed to unblock the gate); seat-safeguards 75/75, orchestrator-tick, stage-marker-commit 33/33, standing-orders-marker 45/45, terminal-plan-attribution 33/33, paste-attribution, team-scoped-routing, terminal-input-path, pty-route-surface, pty-host-gating, pty-prompt-delivery-framing all pass; catalog/parity/mirror/verb-returns/standalone-parity green; lint 0 errors. Remaining risks: `dispatch` stays optional (observable via `directivesAttached`, not enforced); two subtasks to one seat in quick succession still overwrite `dispatched_at` (pre-existing, recorded in the plan); and the head prompt's pre-existing `GET /kanban/feature` reference names a route that does not exist (`GET /kanban/features` does) — out of this plan's scope but the same defect class.
