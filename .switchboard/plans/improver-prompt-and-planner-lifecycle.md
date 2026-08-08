# Unattended Improver Contract: Outstanding Questions and Single-File Scope

## Goal

Give an improver running unattended somewhere to put a question. Add one optional plan-file section, `## Outstanding Questions`, to the `improve-plan` schema, and add two directives to the prompt an unattended improver receives: never ask in chat, and touch exactly one plan file. Without both, running `improve-plan` N-at-a-time converts two ordinary agent behaviours — asking the user, and tidying neighbouring files — into silent data loss.

### The problem

An unattended improver that hits a genuine ambiguity has three options and two of them fail silently:

- **Ask in chat** — nobody is attached to that session. The question is never seen, and the worker sits idle holding a live CLI session indefinitely. Under a parallel pass this also blocks a slot until the stuck timer halts the whole pass.
- **Guess silently** — the guess lands in the plan file, indistinguishable in form and tone from a well-founded decision, and gets coded later by an agent with no way to know it was a coin flip.
- **Write the question into the plan file** — it survives, it is attributable to the plan it concerns, and it rides the plan-file-change signal the pass already watches. No new endpoint, no inbox, no polling.

Only the third works. But an agent will do the first two by default: asking the user is the normal, correct behaviour everywhere else, and nothing in `.agents/skills/improve-plan/SKILL.md` says otherwise.

The second half is a concurrency hazard rather than a behavioural one. Every improver in a batch runs in the **same working directory** against the same `.switchboard/plans/` — worktrees are not an option, because a plan file written inside a worktree never reaches the main root, so `GlobalPlanWatcherService` never fires and nothing lands. `improve-plan` Step 2 already instructs an agent to *"recommend splitting (write separate plan files for each deliverable/phase)"*, and `improve-feature` is authorised to `git rm` siblings outright. Ten such agents in one directory will overwrite and delete each other's work while every one of them reports success.

### Root cause

`improve-plan` was written for an attended, single-plan flow where a human is present to answer and no sibling agent is running. Its required-section schema (SKILL.md Step 3) has nine entries and none of them can hold an unresolved question, so an agent that has one either asks or buries it. Running that skill unattended, N at a time, turns two reasonable defaults into a silent-failure generator.

### Why questions-in-the-plan-file is the right channel

The plan file is already the deliverable, already written once at the end, and already the artifact whose mtime advance the pass treats as completion. A question appended to it arrives with the work, through the same signal, at no extra cost. Any other channel — an inbox, a message, a status field — is a second mechanism that has to be kept in sync with the first.

---

> **Superseded — "§3 Planner protocol on wake: on each notification, read only the named plan; check for `## Outstanding Questions`; absent → kill the named worker terminal; present → collect and leave the worker alive; report at the end."**
> **Reason:** There is no wake to respond to. The engine that runs these batches is `OversightPassService`, which consumes `GlobalPlanWatcherService.onPlanDiscovered` itself and advances its own queue — no planner agent is woken, so there is no per-plan protocol for one to follow. Building it would add one planner turn per plan to a design whose stated purpose is to spend fewer turns. See `plan-update-notifies-planner.md` for the full supersession and evidence.
> **Replaced with:** The one durable requirement inside the protocol — *"report at the end, one digest naming completed plans and plans with open questions"* — moves to `plan-update-notifies-planner.md`, where it is implemented as a `hasOpenQuestions` field on the pass snapshot and a line in `oversight-log.md`. Worker teardown likewise belongs to whoever created the workers, not to a per-plan protocol. What remains here is the half that has no owner anywhere else: the section schema and the prompt directives.

> **Superseded — "§4 Card promotion and the autoban interlock: enforce the `/oversight/start` 409 check where the move happens, in the move path — not only in the planner's prompt."**
> **Reason:** The hazard is real and correctly diagnosed — `PLAN REVIEWED` does ship `autobanEnabled: true` (`agentConfig.ts:135`, verified), and arrivals do wake the engine via `db.onColumnChanged` → `_notifyAutobanWatchArrival` (`TaskViewerProvider.ts:11163`, `11216`) → 750 ms debounce → `_enqueueAutobanTick`. But the guard already exists at the only place that can arm a batch: `OversightPassService.start()` returns 409 when `isAutomationArmed()`, so a pass and autoban can never both be running from a standing start. Adding a second guard inside the generic move path would gate every ordinary human card move on automation state — a behaviour change for ~4,000 installs, to close a window that the existing guard already closes.
> **Replaced with:** No move-path guard. The residual window — a user arming autoban *mid-pass* — is real but narrow, is a property of the pass rather than of this contract, and is noted in `plan-update-notifies-planner.md`'s audit rather than defended with a second interlock here.

> **Superseded — "Verify the **linkup** contract (unpushed) for how the planner receives messages and whether it can reply."**
> **Reason:** Linkup has landed; its contract is verified and recorded in `hidden-terminal-create-and-provider-mix.md`. More to the point, this plan no longer involves messaging a planner at all.

## Metadata

**Complexity:** 3
**Tags:** docs, backend, feature
**Project:** Browser Switchboard

## User Review Required

None. The two decisions are made here: the section is omitted entirely when empty (presence is the signal), and the unattended directives are gated behind an explicit flag so the attended single-plan flow is untouched.

## Complexity Audit

### Routine

- `## Outstanding Questions` is additive to a schema that is already a list of nine required sections. It displaces nothing and is parsed by nobody today.
- The improver prompt is composed in one place. `agentPromptBuilder.ts:1200-1204` already branches on `role === 'planner'` to select the workflow path (`DEFAULT_PLANNER_WORKFLOW = '.agents/skills/improve-plan/SKILL.md'`), which is the natural insertion point for a sibling `unattended` branch.
- The `planFile` resolution rule is already documented and already correct — `.agents/skills/dispatch-analysis/SKILL.md:79-92` enumerates the three forms the field takes (absolute, workspace-relative, `file://` URI) and line 177 warns that a synthesized `<planId>.md` "will almost always miss". This plan reuses that rule rather than restating it.

### Complex / Risky

- **A prompt directive is guidance, not enforcement.** Nothing stops an improver from editing a sibling plan file; the directive only makes it unlikely. The real protection under parallelism is that each worker is *told* one path and given no list of others. Do not hand an unattended improver a directory listing, a board query, or its siblings' paths — the prompt's shape is the guard.
- **`improve-plan` Step 2 actively instructs the opposite.** It tells the agent to recommend splitting into *separate plan files*, and `improve-feature` is authorised to `git rm`. The unattended gate has to override Step 2's write-side behaviour explicitly, or a conscientious improver will follow the skill it was handed and create files nobody asked for. Note that Step 2's *recommendation* is still wanted — it is the *writing* that must be suppressed; the recommendation belongs in `## Outstanding Questions` under `[user]`.
- **An empty-but-present section is worse than no section.** If presence is the signal, an improver that writes the heading with nothing under it — a very common LLM completion habit when a schema lists a section — makes every plan look blocked. This must be treated as a schema violation, asserted in tests, and stated in the skill in the imperative.
- **Sequencing.** This must land before the parallel planner lane is used at N>1. Running N improvers in one directory without the single-file directive is the failure mode the directive exists to prevent, and it destroys work rather than merely wasting it.

## Edge-Case & Dependency Audit

**Race Conditions**
- N improvers writing N distinct files in one directory is safe at the filesystem level; the hazard is entirely at the agent-behaviour level, addressed by the scope directive.
- An improver that writes its plan file more than once produces more than one watcher event. The pass's completion test is `mtime > baseline`, and the card is removed from `inFlight` on the first match, so later writes are ignored — but they arrive *after* the pass considers the card done. Hence the existing "write the plan file once, at the end" instruction is retained verbatim in the prompt.

**Security**
- None. Documentation and prompt text only; no new surface, no new credential path.

**Side Effects**
- Adding a tenth section to the `improve-plan` schema affects the attended flow too. That is acceptable and arguably desirable — an attended improver with a question can also record it — but the *never-ask-in-chat* directive must NOT leak into the attended flow, where asking is correct. Gate the directives, not the schema.
- Any consumer that validates plan files against the required-section list must treat `## Outstanding Questions` as optional. Audit for one before shipping; if a strict validator exists, a plan without the section must remain valid.

**Dependencies & Conflicts**
- `.agents/skills/improve-plan/SKILL.md`, `.agents/skills/switchboard-orchestration/SKILL.md`, `.agents/skills/switchboard-contracts/SKILL.md`, `src/services/agentPromptBuilder.ts`, and the generated control-plane mirrors.
- **Control-plane source of truth is `.agents/` plus `AGENTS.md`** — never the generated `CLAUDE.md` or `.claude/skills` copies. Edit the source and regenerate; editing a mirror produces a change that vanishes on the next generation and is invisible to one of the two hosts.
- Skill discovery is host-split: Claude Code resolves via the mirror manifest, Antigravity via the filesystem. This plan adds a section to an existing skill and moves no file, so no manifest edit is owed — but do not relocate anything here.
- `switchboard-orchestration` (invocation) and `switchboard-contracts` (behaviour) are explicitly not to be crossed: the batch surface and how to call it go in the former, the never-ask-in-chat / questions-in-the-file rule goes in the latter.

## Dependencies

None to land. **Sequencing:** must land before `plan-update-notifies-planner.md` is exercised at `plannerConcurrency > 1`.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that the schema addition ships and the behaviour does not: a section an agent is *permitted* to use is not a section it *will* use, and an improver that has always asked the user will keep asking unless the prompt forbids it in the imperative and tells it exactly where to put the question instead. Second is the empty-heading habit — a schema that lists a section invites an agent to emit the heading with nothing under it, which under presence-as-signal marks every plan blocked; it must be an asserted violation, not a style note. Third is scope leakage under parallelism, where `improve-plan`'s own Step 2 tells the agent to write additional plan files and `improve-feature` authorises deleting siblings — the unattended gate must override both, and the prompt must not hand the worker any path but its own.

## Proposed Changes

### 1. `.agents/skills/improve-plan/SKILL.md` — the section

Add to the Required Sections list in Step 3 as an optional tenth entry, explicitly marked required-only-when-non-empty:

```markdown
10. **## Outstanding Questions** *(include ONLY when something is genuinely unresolved — omit the heading entirely otherwise)*
    - `- **[user]** <question needing a human decision> — proceeding on the assumption that <assumption>`
    - `- **[research]** <thing needing external sources, stated as a specific question> — proceeding on the assumption that <assumption>`
```

Rules stated in the imperative directly beneath it:

- **Omit the heading entirely when there is nothing outstanding.** Its presence is the signal. An empty-but-present section is a schema violation, not "done" — it forces every reader to parse prose to decide whether it matters.
- Each item states the question **and** the assumption the improver proceeded under, so the plan stays coherent and codeable before anyone answers.
- The improver **continues and completes its work regardless**. It never blocks waiting for an answer.
- This section is additive and must never displace a required section — in particular, the problem/root-cause analysis that the plan-authoring protocol requires in or below `## Goal` stays where it is.

### 2. `.agents/skills/improve-plan/SKILL.md` — the unattended gate

A short new block, explicitly scoped so the attended flow is unchanged:

```markdown
## Unattended runs

When the dispatching prompt says this run is unattended, these override the defaults above:

- **Never ask questions in chat — no one is attached to this session.** Put user decisions and
  research needs in `## Outstanding Questions`, state the assumption you are proceeding under,
  and finish the work.
- **Improve exactly one plan file: the one named in your prompt.** Do not create, modify, rename
  or delete any other file in `.switchboard/plans/`. Other workers are concurrently improving
  sibling plans in this same directory; touching their files destroys their work.
- **Step 2 still applies as a recommendation, not as a write.** If the plan should be split,
  record that under `## Outstanding Questions` as a `[user]` item. Do not write the split files.
- **Write the plan file once, at the end.**
```

### 3. `src/services/agentPromptBuilder.ts` — carry the flag

**Context.** The planner branch at 1200-1204 selects `DEFAULT_PLANNER_WORKFLOW`; `PromptBuildOptions` already carries `plannerWorkflowPath`.

**Logic.** Add `unattended?: boolean` to the options. When set and `role === 'planner'`, append the directive block below to the composed prompt — verbatim, so the skill text and the prompt text cannot drift into disagreeing:

> **Never ask questions in chat — no one is attached to this session.** If you need a user decision or external research, append it to the plan's `## Outstanding Questions` section, state the assumption you are proceeding under, and finish the work. Write the plan file once, at the end.
>
> You are improving exactly one plan: `<resolved planFile path>`. Do not create, modify, rename or delete any other file in `.switchboard/plans/`. Other workers are concurrently improving sibling plans in this same directory; touching their files will destroy their work.

`<resolved planFile path>` comes from the plan record's `planFile` field, resolved per `.agents/skills/dispatch-analysis/SKILL.md:79-92` — **never** synthesized as `<planId>.md`. A miss here is a worker that improves nothing while reporting success.

**Threading.** `OversightPassService`'s `dispatch` dep is `LocalApiServer.performKanbanDispatch`; add `unattended: true` on that call path so the flag is set by the engine that knows the run is unattended, not inferred from `apiOriginated` (which is also true for ordinary browser-board clicks).

**Edge cases.** When `unattended` is unset — every existing caller — the composed prompt is byte-identical to today's. Assert this.

### 4. `.agents/skills/switchboard-contracts/SKILL.md`

Add the behavioural rule: unattended improvers never ask in chat; an unresolved item lives in the plan file's `## Outstanding Questions`; presence of the heading means blocked, absence means done, empty-but-present is a violation.

### 5. `.agents/skills/switchboard-orchestration/SKILL.md`

Add the invocation-side note: how a caller marks a dispatch unattended, and that a completed plan carrying `## Outstanding Questions` is surfaced by `GET /oversight/status` as `hasOpenQuestions` (implemented in `plan-update-notifies-planner.md`).

## Verification Plan

### Automated Tests

1. **Prompt contract, unattended.** A prompt built with `unattended: true` for `role === 'planner'` contains the never-ask-in-chat directive, the append-to-plan instruction, the single-file scope directive, the write-once instruction, and exactly one plan path.
2. **Prompt contract, attended.** With `unattended` unset, the composed prompt is byte-identical to the current output — assert against a fixture, so the ~4,000-install attended flow is provably untouched.
3. **`planFile` resolution.** All three documented forms (absolute, workspace-relative, `file://`) resolve to a readable path; assert the builder never constructs a path from the planId.
4. **Section detection.** A plan with no `## Outstanding Questions` reads as done; one with `[user]` or `[research]` items reads as blocked; one with the heading and no items is reported as a **violation**, not as done.
5. **Schema optionality.** A plan file lacking `## Outstanding Questions` still validates against the required-section list (guards against a strict validator being added later).
6. **Skill/prompt agreement.** Assert the directive text in `agentPromptBuilder.ts` matches the block in `improve-plan/SKILL.md` — a single fixture compared against both, so the two cannot drift.
7. **Control-plane mirrors.** After regeneration, the new sections are present in the generated `CLAUDE.md` / `.claude/skills` copies and the source `.agents/` files are the only hand-edited ones.

### Manual (VSIX)

8. Dispatch 4 unattended improvers, one of them on a plan seeded with a genuine ambiguity. Confirm: none of the four asks a question in its session; the ambiguous one carries a `[user]` item under `## Outstanding Questions` naming both the question and the assumption; the other three have no such heading; and all four plan files contain only their own content — no file in `.switchboard/plans/` was created, renamed or deleted by any worker.

## Uncertain Assumptions

None. Every claim is verified against the code and skill files at HEAD and cited by file and line.

## Recommendation

Complexity 3 → **Send to Intern.**
