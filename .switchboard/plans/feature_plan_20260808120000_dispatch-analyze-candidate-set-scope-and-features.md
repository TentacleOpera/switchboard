# Analyze on the Planned column sends the wrong candidate set — project scope and feature atomicity

## Goal

Make the `dispatch-analysis` prompt describe **the column the user actually pressed Analyze on**: the Planned cards of the *active project*, with features presented as single indivisible units rather than exploded into their subtasks.

### Problem

Pressing **Analyze** on the Planned column staged plans from projects the user was not looking at, and handed the agent a plan list that named every feature's subtasks individually — inviting it to promote subtasks out from under their feature. Both were observed in a live run on 2026-08-08: the analysis pass evaluated a `Website`-project docs plan alongside `Browser Switchboard` work, and the prompt listed 12 subtasks under 5 feature parents.

### Root cause — two independent defects on the same prompt path

**Defect 1 — the candidate set is never project-scoped.**

`dispatchAnalyze` (`src/services/KanbanProvider.ts:10114-10139`) sources candidates from `_visibleColumnCards(workspaceRoot, 'PLAN REVIEWED')` at `:10123`. That helper (`:508-512`) filters `_lastCards` on `workspaceRoot`, `column`, and `!card.featureId` — deliberately mirroring the webview's board-display contract for *subtasks*, but it has no project dimension at all.

`_lastCards` is populated in `_refreshBoardImpl` (`:3457-3459`) from `db.getBoardFilteredByProject(workspaceId, null, repoScope)` when a repo scope is set, or `db.getBoard(workspaceId)` otherwise — note the literal `null` in the project position. **The project filter is never applied backend-side.** It is owned by the webview: `boardProjectFilter` (`src/webview/kanban.html:4404`) with `applyBoardProjectFilter` (`:4423-4429`) doing the three-way split, and the code explicitly notes the board owns this view filter *independently* of the backend's `_projectFilter` mirror (`:7722`).

> **Superseded:** "`filterCardsByProject` (`:4424-4428`) doing `cards.filter(c => c.project === boardProjectFilter)`"
> **Reason:** The helper is named `applyBoardProjectFilter` (`:4423`); `filterCardsByProject` does not exist anywhere in the repo. The described body is also only the third of its three branches — it returns the input unchanged for `null` and filters `!c.project` for `'__unassigned__'`.
> **Replaced with:** `applyBoardProjectFilter` (`:4423-4429`): `null` → input unchanged; `'__unassigned__'` → `cards.filter(c => !c.project)`; else `cards.filter(c => c.project === boardProjectFilter)`.

So the backend cannot infer the user's project from `_lastCards`. It *can*, however, already read the initiating client's filter off the message — see the Scope note below, which corrects the original plan's mechanism.

**Defect 2 — features are exploded into subtasks by the shared dispatch builder.**

`_visibleColumnCards` correctly excludes subtasks, so `plannedIds` leaves `dispatchAnalyze` as feature parents and loose plans only. The subtasks are re-added downstream: the batch path resolves plans through `TaskViewerProvider._resolveKanbanDispatchPlans` (`:4978-4991`), which calls `this._kanbanProvider!.buildDispatchPlans(...)` under the comment *"Plan arrays for dispatch MUST come from KanbanProvider.buildDispatchPlans — do not hand-roll (feature subtasks get silently dropped otherwise)"*. `buildDispatchPlans` stamps `isSubtask: true` on expanded rows (`KanbanProvider.ts:4046`), and `buildPromptDispatchContext` (`src/services/agentPromptBuilder.ts:377-391`) emits a `  - [SUBTASK] …` line for each.

> **Superseded:** "`TaskViewerProvider.ts:19509` builds the plan array via `this._kanbanProvider.buildDispatchPlans(...)`, whose contract is documented at `:19498-19503`."
> **Reason:** Wrong call site for this path. `:19433-19445` is the **single-plan** dispatch (`buildDispatchPlans(root, [planRecord])`). Analyze goes through `handleKanbanBatchTrigger` (`:5402`), whose plan resolution is `_resolveKanbanDispatchPlans` at `:4978-4991`. A coder sent to `:19509` would edit the wrong function.
> **Replaced with:** `TaskViewerProvider._resolveKanbanDispatchPlans` (`:4978-4991`), reached from `handleKanbanBatchTrigger` (`:5417`).

That expansion is *correct* for a coder dispatch — the coder must see the subtasks it is implementing. It is *wrong* for analysis, where the unit of the decision is the feature.

**Why defect 2 is dangerous, not merely noisy.** A plan list that names subtasks individually reads as an invitation to promote them individually. Doing so is destructive: `moveCardToColumn` on a subtask triggers `recomputeFeatureColumnFromSubtasks` (`KanbanProvider.ts:6762`), which re-derives the parent feature's column from the minimum subtask ordinal — silently relocating a feature card the user never touched. Meanwhile a subtask promoted to DISPATCH does not even *appear* there: every column render filters `displayCards.filter(card => !card.featureId)` (`kanban.html:6388`, `:6481`). The user would see a feature jump columns and the staged work vanish.

The correct primitive already exists and is the one to steer toward: `POST /kanban/move` on a **feature** card runs `db.cascadeFeatureByPlanId` (`KanbanProvider.ts:6931`, `:7000`), moving the feature and all its subtasks in one transaction.

### Scope note

The skill side of this has already landed — `.agents/skills/dispatch-analysis/SKILL.md` now scopes by a `PROJECT=` line (falling back to the literal `PLANS TO PROCESS` list when absent) and carries a "features are one unit" step. This plan makes the *prompt* honour that contract. The skill's fallback means it behaves correctly both before and after this plan lands; the plan removes the reliance on that fallback.

### Verified against the tree (improve pass, 2026-08-08)

Line references above were re-read on `main`. Five mechanism corrections came out of the pass; each is carried as a Superseded callout at its point of use, and the facts they rest on are:

- **The webview already sends the board's project filter on every verb.** `postKanbanMessage` (`kanban.html:4668-4680`) stamps `initiatorProject: message.initiatorProject !== undefined ? message.initiatorProject : boardProjectFilter` onto **every** outbound board message, verbatim (`null` and `'__unassigned__'` both preserved), under the comment *"the initiating client's own view filter rides on EVERY board verb … stamped centrally so no sender can be missed by a sweep."* `msg.initiatorProject` is therefore already available inside the `dispatchAnalyze` arm today. The `projectFilter:` field on `suggestFeatures` (`:4468`) is the older per-sender spelling, not the pattern to copy.
- **The sentinel mapping is already solved.** `KanbanProvider._cardMatchesProjectFilter(card, projectFilter)` (`:11570-11577`) implements exactly the three-way semantics: `null`/`''` → all; `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`'__unassigned__'`, defined at `KanbanDatabase.ts:915`) → `cardProject === ''`; else exact match. `suggestFeatures` uses it (`:11512`).
- **There is no `overrides` parameter on `triggerBatchAgentFromKanban`.** Extension: `(role, sessionIds, instruction?, workspaceRoot?, targetTerminalOverride?, apiOriginated?)` (`extension.ts:1675`). Standalone: `(role, sessionIds, instruction?, targetRoot?, terminalName?)` (`bootstrap.ts:827`). The 5th positional — the `undefined` the arm passes at `:10135` — is `targetTerminalOverride`, consumed at `TaskViewerProvider.ts:5546`/`:5560` as a terminal *name*.
- **Standalone `dispatchAnalyze` runs the shared arm.** `bootstrap.ts`'s `kanbanVerb` has no `dispatchAnalyze` case; its `default:` arm (`:1426-1435`) delegates to `kanbanProvider.handleServiceVerb(verb, { initiatorProject: projectFilter, ...payload, workspaceRoot: root })` — note it already injects the standalone's own `projectFilter` as a fallback beneath the payload. So candidate filtering is shared by construction; only the **prompt string** forks between hosts.
- **The standalone prompt builder does not expand subtasks.** `buildDispatchAnalysisPrompt` (`bootstrap.ts:271-286`) formats `records` built one-per-sessionId from `db.getPlanBySessionId` (`:1333-1344`) — `buildDispatchPlans` is never involved, `KanbanPlanRecord` has no `isSubtask` field, and `_visibleColumnCards` already excluded subtasks upstream. There is nothing there for an `isSubtask` filter to remove.
- **Undeclared verb payload fields are accepted but conventionally declared.** `validateVerbPayload` (`verbSchemas.ts:48-77`) type-checks only declared fields and passes extras through; the `dispatchAnalyze` schema (`:359-363`) currently declares `workspaceRoot` only. Sibling verbs declare `initiatorProject: { type: 'string' }` with a comment explaining why it must stay optional and why an explicit `null` is accepted (`:186-191`, `:201`, `:208`).
- **The batch trigger can fragment a batch across terminals.** `handleKanbanBatchTrigger` partitions `validPlans` by feature (`:5537-5566`); when every group resolves to the same target agent it merges into one `sharedGroup` carrying all plans (`:5576-5588`), but when groups resolve to **different** agents it dispatches one prompt per group (`:5590-5600`). See Edge-Case → Side Effects.
- **`_targetColumnForRole('planner')` returns `'PLAN REVIEWED'`** (`TaskViewerProvider.ts:3802-3805`), so the batch trigger's per-plan `_updateKanbanColumnForSession` writes the column the candidates are already in. The pass is column-neutral for parents and loose plans.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, bugfix
**Project:** Browser Switchboard

> **Superseded:** **Complexity:** 4 · **Tags:** backend, frontend, bugfix, dispatch, agents
> **Reason:** Two corrections. (1) `dispatch` and `agents` are not in the allowed tag vocabulary and drop silently on import. (2) The threading mechanism the plan proposed does not exist, so the real change is larger than three small edits: both host registrations of `switchboard.triggerBatchAgentFromKanban` need a new parameter, `TaskViewerProvider.handleKanbanBatchTrigger` must forward it into `generateUnifiedPrompt`'s overrides, and `verbSchemas.ts` gains an entry. That is a cross-host signature change plus a boundary-schema change — mid-range, not routine.
> **Replaced with:** **Complexity:** 5 · **Tags:** backend, frontend, bugfix

## User Review Required

None.

## Complexity Audit

### Routine

- Reading `msg.initiatorProject` in the `dispatchAnalyze` arm — already on the message, no webview change.
- Filtering the candidate list with the existing `_cardMatchesProjectFilter` helper.
- Emitting a `PROJECT=` line into the two dispatch-analysis prompt strings.
- Filtering `isSubtask` rows out of the extension host's prompt plan list.
- Adding `initiatorProject: { type: 'string' }` to the `dispatchAnalyze` verb schema.

### Complex / Risky

- **Threading the resolved scope to the prompt builder crosses a command boundary in two hosts.** There is no spare parameter (see the Superseded callout in Change 2). Both registrations and `handleKanbanBatchTrigger` need a new, explicitly-named argument. Getting this wrong by reusing the 5th positional would silently hijack terminal selection.
- **Two hosts, one prompt.** The dispatch-analysis prompt exists twice: `KanbanProvider.ts:4736-4746` and a standalone mirror at `src/standalone/bootstrap.ts:271-286` (reached from the `triggerAction` arm at `:1352-1353`, whose comment reads *"Mirrors `KanbanProvider.generateUnifiedPrompt`'s dispatch-analysis arm"*). A change to one and not the other is a silent parity break in exactly the host the parity guard work exists to protect.
- **The unassigned sentinel is not "no filter".** `boardProjectFilter` uses `'__unassigned__'` for "cards with no project" (`kanban.html:4425-4426`) and `null` for "show everything". Collapsing those two into a falsy check inverts the filter for the Unassigned board — it would analyse every project instead of only unpinned plans. Mitigated by delegating to `_cardMatchesProjectFilter` rather than re-deriving the mapping.
- **Suppressing subtask expansion must not reach coder dispatch.** `buildDispatchPlans` is the sanctioned single builder precisely because hand-rolled arrays drop subtasks. The suppression belongs at the dispatch-analysis prompt arm, filtering the builder's output — not inside `buildDispatchPlans`, and not by giving callers a new way to skip it.
- **`verbSchemas.ts` is a shared file** across all provider work (PRD orchestration discipline) — append the field to the existing `dispatchAnalyze` block and serialise against concurrent schema edits.

## Edge-Case & Dependency Audit

### Race Conditions

- The user switches project between pressing Analyze and the agent's re-query. The prompt's `PROJECT=` line is a frozen snapshot resolved at prompt-generation time — the same race-free pattern the plan-pin directive uses. The agent must not re-derive the filter itself; the skill already forbids it.
- **Two clients pressing Analyze concurrently.** The editor webview and a browser tab share one `KanbanProvider`. This is why the scope must travel as an explicit argument rather than being stashed on the provider instance between the arm and the prompt build: the interval spans several awaited DB reads inside `_resolveKanbanDispatchPlans`, so an instance field could be clobbered by the second client and each pass would analyse the other's project. `msg.initiatorProject` is per-message and immune.
- A card enters Planned after prompt generation. The skill re-queries and picks it up **within the stated scope**, which is the intended behaviour.

### Security

- None. No new endpoint, no new persisted state, no widening of what an agent may move. The new payload field is declared in `verbSchemas.ts` so the HTTP boundary type-checks it (PRD contract #5).

### Side Effects

- The prompt gets shorter — subtask lines disappear. Any downstream consumer keying off `[SUBTASK]` in a *dispatch-analysis* prompt would see nothing; nothing does, since this instruction routes to one skill.
- With scoping in place, pressing Analyze on an Unassigned or project-filtered board stages strictly fewer cards than before. That is the fix, not a regression, but it will look like one to anyone who benchmarked the old behaviour.
- **Pre-existing and NOT fixed by this plan: a fragmented batch produces a fragmented analysis.** `handleKanbanBatchTrigger` partitions by feature and, when the groups resolve to *different* target agents (per-feature worktree mode → `_resolveAgentTerminalForPlan(role, root, worktreePath, …)` at `:5546`/`:5560`), sends one prompt per group (`:5590-5600`). Each of those dispatch-analysis prompts then lists only its own group's plans — and a parallelism analysis that cannot see the other candidates cannot compute a non-overlapping set. The common single-planner-terminal case takes the `allSameTarget` merge (`:5576-5588`) and is unaffected, which is why this has not been observed. It is the same class of "wrong candidate set" defect this plan is about; it is called out here rather than fixed because the fix touches the shared batch dispatcher for every role. See Change 6.
- **Pre-existing and NOT fixed by this plan: the batch trigger persists a column write per expanded row.** `handleKanbanBatchTrigger` calls `_updateKanbanColumnForSession(root, sessionId, targetColumn)` for every plan in the group (`:5495`), including subtasks that `buildDispatchPlans` expanded. For `role: 'planner'` the target is `'PLAN REVIEWED'` (`:3802-3805`), i.e. where the parents already are — a no-op for them. A subtask sitting *ahead* of its parent (its own column further down the pipeline than the parent's minimum-ordinal position) would be written back to `PLAN REVIEWED`. Change 3 filters the *prompt*, not this loop, so the behaviour is unchanged by this plan; it is recorded so nobody reads "read-only analysis pass" as meaning the dispatch path writes nothing.

### Dependencies & Conflicts

- **`src/webview/kanban.html` is heavily contended.** Five other Planned plans edit it: `feature_plan_20260803135239_optimistic_backlog_card_movement.md`, `feature_plan_20260803075219_kanban-column-counts-ignore-project-filter.md`, `feature_plan_20260803170350_serialize-feature-subtask-block-regeneration.md`, `dispatcher-auto-send-to-coder-terminals.md`, and the sibling `feature_plan_20260808120100_dispatch-toggle-staged-count-badge.md`. Per the one-agent-stream-per-file rule this must not run beside any of them. **After the Change 1 correction this plan no longer edits `kanban.html` at all** — the contention is therefore only a concern if a future revision re-adds a webview edit.
- **`src/services/KanbanProvider.ts`** is contended with the same set plus `standalone-push-parity-guard.md` and `standalone-state-builders-delegate-to-getfullstatemessages.md`. This plan does edit it — serialise.
- **`src/services/TaskViewerProvider.ts`** is newly in scope (Change 2b) and is contended with the standalone-parity plans. Serialise.
- **`src/services/verbSchemas.ts`** is shared across all provider work per the PRD — append-only, serialise.

## Dependencies

- **None hard.** `dispatcher-column-and-bounce-analysis.md` (`CODE REVIEWED`) already shipped the Dispatch view, the Analyze button and the `dispatchAnalyze` arm this plan repairs — it has landed, so this is a remediation on live code.
- No session (`sess_…`) dependencies.

## Adversarial Synthesis

Key risks: (1) the plan's original threading mechanism did not exist — the 5th positional of `triggerBatchAgentFromKanban` is `targetTerminalOverride`, so passing scope there would hijack terminal selection and abort the batch on `_isValidAgentName`; (2) a `PROJECT=` line and the candidate filter derived from two different values would tell the agent one thing and show it another, and the skill would faithfully re-scope an already-wrong list; (3) collapsing `null` and `'__unassigned__'` inverts the filter on the Unassigned board. Mitigations: one resolved scope value produced once in the `dispatchAnalyze` arm and threaded as an explicitly-named argument through both host registrations; the existing `_cardMatchesProjectFilter` owns the sentinel mapping; `msg.initiatorProject` (already stamped centrally on every board verb) replaces the proposed duplicate `projectFilter` field, so the two hosts and the webview cannot drift. Named residual: a batch fragmented across per-feature terminals yields a fragmented analysis (pre-existing, Change 6).

## Proposed Changes

### 1. `src/webview/kanban.html` — no change required

> **Superseded:** At the `dispatchAnalyze` case (`:5922-5925`), extend the posted message with `projectFilter: boardProjectFilter ?? null`, mirroring `suggestFeatures` (`:4468`).
> **Reason:** Redundant, and it re-opens a problem the codebase has already closed. `postKanbanMessage` (`:4668-4680`) already stamps `initiatorProject: boardProjectFilter` onto **every** outbound board message, verbatim, explicitly *"so no sender can be missed by a sweep."* `msg.initiatorProject` is therefore in the `dispatchAnalyze` arm today, with both sentinels intact. Adding a second field carrying the same value re-creates the per-sender duplication the central stamp exists to eliminate, and gives the arm two spellings that can disagree. (`boardProjectFilter ?? null` is also a no-op — the variable is already `null` or a string.) `suggestFeatures`' `projectFilter:` is the legacy spelling, not a precedent.
> **Replaced with:** No webview edit. Change 2 reads `msg.initiatorProject`. The `suggestFeatures` duplicate is left alone — removing it is a separate, unrelated cleanup.

### 2. `src/services/KanbanProvider.ts` + `src/services/TaskViewerProvider.ts` + `src/extension.ts` + `src/standalone/bootstrap.ts` — scope the candidate set, and thread the resolved scope to the prompt

**Logic:** Resolve the initiating client's project **once**, in the arm, into a single value. Use that one value both to filter the candidates and to write the `PROJECT=` line, so the two can never disagree. Thread it to the prompt builder as an explicitly-named argument.

**(a) `KanbanProvider.ts`, `dispatchAnalyze` arm (`:10114-10139`)** — after `_visibleColumnCards` returns:

```ts
// The initiating client's own view filter, stamped on every board verb by
// postKanbanMessage (kanban.html:4668-4680). `undefined` (a raw API caller that
// sent no filter) means "no scope" → all cards, preserving prior behaviour.
// null and '__unassigned__' are meaningful sentinels — pass them through.
const analysisScope: string | null =
    msg.initiatorProject === undefined ? null : msg.initiatorProject;
const sourceCards = this._visibleColumnCards(workspaceRoot, 'PLAN REVIEWED')
    .filter(card => this._cardMatchesProjectFilter(card, analysisScope));
```

Keep the existing empty-set guard and its `showInformationMessage`, but word it so an empty *scoped* column is distinguishable from an empty column — e.g. `No Planned plans in <scope label> to analyze for parallel dispatch.` where the scope label is the project name, `the Unassigned board`, or omitted for `null`.

> **Superseded:** "Resolve `msg.projectFilter` once into a scope value: `null` → all; `'__unassigned__'` → `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` semantics (cards whose `project` is empty); any other string → that exact project name."
> **Reason:** That mapping already exists as `_cardMatchesProjectFilter` (`:11570-11577`) and is what `suggestFeatures` uses (`:11512`). Re-deriving it hand-rolls a second copy of the sentinel logic the Complexity Audit itself names as the riskiest part of the change.
> **Replaced with:** `.filter(card => this._cardMatchesProjectFilter(card, analysisScope))` — one call, existing helper, sentinels already correct.

Emit the scope line in the dispatch-analysis prompt arm (`:4736-4746`), between `API_PORT` and the plan list:

```
PROJECT=<name> | <unassigned> | <all>
```

Resolve the three forms from the threaded scope: a non-empty name that is not the sentinel → `PROJECT=<that name>`; `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` → `PROJECT=<unassigned>`; `null`/`''`/anything unresolvable → `PROJECT=<all>`. These are the exact three spellings the skill's table accepts (`.agents/skills/dispatch-analysis/SKILL.md`, step 1).

**(b) Threading — a new named argument, not a reused positional.**

> **Superseded:** "Thread the resolved scope through `triggerBatchAgentFromKanban` to the prompt arm. The command already carries an `overrides` parameter position (`:10135` passes `undefined`); use it rather than adding a positional argument, so the standalone registration (`bootstrap.ts:827`) does not need a signature change it cannot supply."
> **Reason:** There is no `overrides` parameter. The `undefined` at `:10135` is the **5th positional**, which is `targetTerminalOverride` in the extension (`extension.ts:1675`) and `terminalName` in standalone (`bootstrap.ts:827`). It is consumed as a terminal *name* at `TaskViewerProvider.ts:5546` and `:5560` (`String(targetTerminalOverride || '').trim()`). Passing a project name there would make the batch try to dispatch to a terminal called e.g. `Browser Switchboard`, fail `_isValidAgentName`, show *"No agent assigned to role 'planner'"*, and return `false` — Analyze would stop working entirely.
> **Replaced with:** add a trailing, explicitly-named parameter to both registrations and forward it through the batch trigger, as below.

- `extension.ts:1675` — extend to `(role, sessionIds, instruction?, workspaceRoot?, targetTerminalOverride?, apiOriginated?, analysisScope?: string | null)` and pass it into the options object already being constructed: `{ apiOriginated: !!apiOriginated, analysisScope }`.
- `TaskViewerProvider.handleKanbanBatchTrigger` (`:5402-5408`) already takes `options?: Partial<ConfiguredKanbanDispatchOptions>`. Add `analysisScope?: string | null` to that interface and forward it at the single `generateUnifiedPrompt` call inside `dispatchToGroup` (`:5581`): `{ instruction, analysisScope: options?.analysisScope }`.
- `KanbanProvider.generateUnifiedPrompt`'s `overrides` type gains `analysisScope?: string | null`; the dispatch-analysis arm (`:4736`) reads it.
- `bootstrap.ts:827` — extend the registration signature the same way and forward the scope into the `handlePtyVerb('triggerAction', …)` payload (see Change 4).
- `KanbanProvider.ts:10130-10136` — pass `analysisScope` as the new 7th argument.

**Edge cases:**

- A project name containing a newline would corrupt the prompt block; project names come from the `projects` table and are user-authored, so strip `\r`/`\n` when writing the line.
- An unresolvable or unexpected scope value resolves to `PROJECT=<all>` **and says so** — never silently to a project.
- Callers that do not pass the new argument (every other `triggerBatchAgentFromKanban` call site — `:5688`, `:5760`, `:8423`, `:9139`, `:9212`, `:9283`, `:9354`, `:10211`) get `undefined`, which the prompt arm never reads because they do not use the `dispatch-analysis` instruction. No behaviour change for them.

**(c) `src/services/verbSchemas.ts` — declare the field the arm now dereferences.**

Add to the existing `dispatchAnalyze` block (`:359-363`):

```ts
dispatchAnalyze: {
    fields: {
        workspaceRoot: { type: 'string' },
        initiatorProject: { type: 'string' },
    },
},
```

Optional, never `required` — a required field would reject valid payloads from shipped webview builds, and the validator accepts an explicit `null` for non-required fields, which is a meaningful sentinel here (see the comment at `:186-191` for the same reasoning on `createFeature`). Undeclared fields already pass through (`:48-77`), so this is PRD contract #5 compliance rather than a runtime fix — but the contract requires schemas to be field-accurate for what the arm dereferences.

### 3. `src/services/KanbanProvider.ts` — drop subtask rows from the dispatch-analysis prompt only

**Logic:** The analysis unit is the feature. Keep `buildDispatchPlans` as the single builder and filter its output at the one arm whose contract differs.

**Implementation:** In the dispatch-analysis arm (`:4736-4746`), before `buildPromptDispatchContext(plans)`:

```ts
const analysisPlans = plans.filter(p => !p.isSubtask);
const dispatchContext = buildPromptDispatchContext(analysisPlans);
```

`buildPromptDispatchContext` renders a non-subtask feature as `- [FEATURE: <topic>] Plan File: …` (`agentPromptBuilder.ts:387-389`, gated on `plan.featureTopic && !plan.isSubtask`) and a subtask as `  - [SUBTASK] …` (`:384-386`, gated on `plan.isSubtask && plan.featureTopic`), so feature parents keep their labelling with no change to the builder.

**Edge cases:** If filtering leaves zero plans — possible only if the candidate set were somehow all subtasks, which `_visibleColumnCards` already prevents — fall back to the unfiltered list rather than dispatching an empty `PLANS TO PROCESS` block, and log it. An empty plan list is a prompt that reads as "analyze nothing".

### 4. `src/standalone/bootstrap.ts` — the `PROJECT=` line in the standalone prompt

**Logic:** The standalone prompt builder (`:271-286`) is documented as byte-for-byte the shape of the extension's, and the `triggerAction` arm that calls it (`:1352-1353`) says it mirrors `generateUnifiedPrompt`'s arm. Parity is the contract.

**Implementation:**

- `buildDispatchAnalysisPrompt(records, root, apiPort)` gains a `scope` parameter and emits the same `PROJECT=` line, resolved by the same three-form rule as Change 2. Extract the resolver into one shared place if a suitable module already exists on the standalone side; otherwise duplicate the three-line mapping and pin it with the parity test in the Verification Plan.
- The registration at `:827` forwards the new `analysisScope` argument into the `handlePtyVerb('triggerAction', { role, sessionIds, instruction, terminalName, analysisScope }, …)` payload; the `triggerAction` arm (`:1352-1353`) passes it to the builder.
- If the scope arrives `undefined` (a browser build older than this change), fall back to the standalone's own `projectFilter` variable, which the `kanbanVerb` default arm already maintains (`:1428`) and `setProjectFilter` already writes. Emit `PROJECT=<all>` when that too is `null` — an omitted line silently re-enables the skill's `PLANS TO PROCESS`-only fallback, which is correct but hides the gap.

> **Superseded:** "Apply the `PROJECT=` line **and the `isSubtask` filter** to the standalone builder… The standalone registration of `triggerBatchAgentFromKanban` (`:827`) takes fewer parameters than the extension's (`extension.ts:1675`). Passing scope via the `overrides` object — change 2 — keeps both signatures valid."
> **Reason:** Two errors. (a) There is nothing for an `isSubtask` filter to do here: `buildDispatchAnalysisPrompt` formats `records` fetched one-per-sessionId via `db.getPlanBySessionId` (`:1333-1344`) — `buildDispatchPlans` is never called, `KanbanPlanRecord` carries no `isSubtask` field, and `_visibleColumnCards` already excluded subtasks upstream. A coder told to add the filter would either add dead code or invent a field. (b) The "overrides object" does not exist (see Change 2b), so it cannot be what keeps both signatures valid — the standalone registration needs the same explicit new parameter.
> **Replaced with:** the standalone change is the `PROJECT=` line plus the new parameter, nothing more. Also note that **candidate filtering needs no standalone mirror at all**: `bootstrap.ts`'s `kanbanVerb` has no `dispatchAnalyze` case, so the verb falls through to `default:` (`:1426-1435`) and runs the *same* `KanbanProvider` arm Change 2 edits.

**Edge cases:** A standalone board with no project filter set emits `PROJECT=<all>` explicitly. The `'__unassigned__'` sentinel survives `setProjectFilter`'s `payload.project || null` (`:1339` region) as a string, so it maps to `<unassigned>` correctly.

### 5. `.agents/skills/dispatch-analysis/SKILL.md` — already landed, verify only

The skill was updated on 2026-08-08 with the `PROJECT=` scope table (step 1), the features-are-one-unit step (1a), and report-as-you-move (step 5). No further edit. Confirmed during this improve pass: the table's three accepted forms are exactly `PROJECT=<name>`, `PROJECT=<unassigned>`, `PROJECT=<all>`, plus a "no `PROJECT` line" row that falls back to the literal `PLANS TO PROCESS` list. Changes 2 and 4 must emit those spellings verbatim.

### 6. Named residual — batch fragmentation across per-feature terminals (not fixed here)

**Clarification, not new scope.** `handleKanbanBatchTrigger` sends one prompt per feature group when the groups resolve to different target agents (`:5590-5600`); only the `allSameTarget` path merges them into a single prompt covering all candidates (`:5576-5588`). Under per-feature worktree mode, an Analyze press can therefore produce several dispatch-analysis prompts, each blind to the others' candidates — which defeats a parallelism analysis as thoroughly as the two defects this plan fixes.

Two options, and the choice is deliberate:

- **Fix here:** in `handleKanbanBatchTrigger`, force the single-group path when `instruction === 'dispatch-analysis'` (the pass is read-only and terminal-agnostic, so per-feature worktree routing buys nothing). Small, but it edits the shared batch dispatcher used by every role.
- **Defer:** leave it, and record it.

**This plan defers it** — the shared dispatcher is the wrong thing to touch inside a targeted prompt fix, and the fragmentation is unobserved because the common configuration takes the merge path. The Verification Plan includes a manual step to detect it, so the deferral is visible rather than silent. If that step reproduces, raise it as its own plan.

## Verification Plan

### Automated Tests

1. A contract test asserting the `dispatchAnalyze` arm filters its candidate cards by `msg.initiatorProject`, with four cases: named project (only that project's Planned cards), `'__unassigned__'` (only cards with empty `project`), `null` (all), and `undefined` (all — the raw-API-caller default). Assert via `_cardMatchesProjectFilter`'s observable effect on the dispatched id list, not by re-implementing the mapping in the test.
2. A contract test asserting the generated dispatch-analysis prompt contains no `[SUBTASK]` line when the candidate set includes a feature with subtasks — and still contains the `[FEATURE: …]` line for its parent.
3. A parity test in the style of `src/test/cross-client-scope-contract.test.js` asserting both prompt builders (`KanbanProvider.generateUnifiedPrompt`'s dispatch-analysis arm and `bootstrap.buildDispatchAnalysisPrompt`) emit a `PROJECT=` line, and that the only three value forms either can produce are `<all>`, `<unassigned>`, and a bare name — i.e. the spellings the skill's table accepts.
4. A source-text guard asserting the `dispatchAnalyze` call to `switchboard.triggerBatchAgentFromKanban` passes the scope in the **7th** argument position and still passes `undefined` in the 5th (`targetTerminalOverride`). This is the assertion that would have caught the superseded threading mechanism.
5. A schema test asserting `VERB_SCHEMAS.kanban.dispatchAnalyze.fields.initiatorProject` exists and is **not** `required`, and that `validateVerbPayload('kanban', 'dispatchAnalyze', { workspaceRoot: '/x', initiatorProject: null })` returns ok — the explicit-null sentinel must pass the boundary.

### Manual Verification

1. Filter the board to `Browser Switchboard`, press Analyze on Planned. The prompt's `PLANS TO PROCESS` contains only `Browser Switchboard` plans, and `PROJECT=Browser Switchboard` appears above it.
2. Switch to a different project with Planned cards, press Analyze. The set changes accordingly — no cross-project leakage.
3. Set the board to the Unassigned view, press Analyze. `PROJECT=<unassigned>` and only unpinned plans appear — not every plan.
4. Clear the project filter, press Analyze. `PROJECT=<all>` and the full workspace Planned column.
5. With a feature holding 3 subtasks in Planned, press Analyze. The prompt shows one `[FEATURE: …]` line and **zero** `[SUBTASK]` lines.
6. Empty scoped column: filter to a project with no Planned cards, press Analyze. The information message names the scope; no agent is dispatched.
7. Terminal selection unbroken: press Analyze and confirm the prompt lands in the existing planner terminal (not a new one, and no *"No agent assigned to role 'planner'"* error). This is the check for the corrected argument position.
8. **Fragmentation probe (Change 6):** with per-feature worktrees active on two Planned features that route to different planner terminals, press Analyze and count the dispatched prompts. One merged prompt = fine. Two prompts each listing one feature = the deferred defect reproduced; raise it as its own plan.
9. Repeat 1 and 5 under `npx switchboard` — same prompt shape in the standalone host, including the `PROJECT=` line.

## Rejected Alternatives

- **Add a new `projectFilter` field to the `dispatchAnalyze` message.** Rejected: `postKanbanMessage` already stamps `initiatorProject` on every board verb (`kanban.html:4668-4680`) precisely so no sender needs its own copy. A second field is a second thing to keep in sync.
- **Read `this._projectFilter` backend-side instead of taking it from the message.** Rejected: it is a mirror the board's view filter diverges from by design (`kanban.html:7722` — *"The board owns its view filter (`boardProjectFilter`) independently of the backend singleton mirror"*), it is deliberately not seeded in the constructor (`KanbanProvider.ts:432-437`), and with two clients on one provider it holds whichever client wrote last. Analysing against it would stage the wrong project whenever the two disagree — an intermittent version of the exact bug being fixed.
- **Stash the resolved scope on the provider instance between the arm and the prompt build.** Rejected: the interval spans several awaited DB reads inside `_resolveKanbanDispatchPlans`, so two concurrent clients (editor webview + browser tab) would each read the other's scope. Per-message threading has no such window.
- **Reuse the 5th positional (`targetTerminalOverride` / `terminalName`) to carry the scope.** Rejected on the code: it is consumed as a terminal name (`TaskViewerProvider.ts:5546`, `:5560`) and would abort the dispatch on `_isValidAgentName`.
- **Add a `skipSubtaskExpansion` option to `buildDispatchPlans`.** Rejected: that function is the single builder specifically because per-caller variation dropped subtasks before. Filter its output instead.
- **Project-filter `_visibleColumnCards` itself.** Rejected: it is shared by Advance All, Prompt All, Complete All and the batch planner/coder prompts (`:9018`, `:9046`, `:9073`, `:9234`, `:9537`, `:9810`). Those may well deserve the same scoping, but changing the shared helper turns a targeted bug fix into a board-wide behaviour change with six unaudited call sites.
- **Rely on the skill's `PLANS TO PROCESS`-only fallback and change no code.** Rejected: it makes correctness depend on the prompt's plan list being right, which is the thing that is wrong — and the skill's freshness re-query then widens within an already-wrong scope.

## Agent Recommendation

Complexity 5 → **Send to Coder.** Four files plus a schema entry and a standalone mirror. The risk is concentrated in the new argument's position (a reused positional silently breaks terminal selection) and the `'__unassigned__'` sentinel, both of which are covered by named tests.

## Completion Summary

Implemented both defects' fixes across six files. **Defect 1 (project scoping):** the `dispatchAnalyze` arm now reads `msg.initiatorProject` (already stamped on every board verb by `postKanbanMessage`), resolves it into `analysisScope`, and filters candidates through the existing `_cardMatchesProjectFilter` helper — no sentinel re-derivation. The scope is threaded as a new 7th named argument (`analysisScope?: string | null`) through `extension.ts` → `TaskViewerProvider.handleKanbanBatchTrigger` → `generateUnifiedPrompt`'s overrides, and through `bootstrap.ts`'s registration → `handlePtyVerb('triggerAction')` → `buildDispatchAnalysisPrompt`. Both prompt builders emit a `PROJECT=<name>|<unassigned>|<all>` line using the same three-form resolver. **Defect 2 (subtask explosion):** the extension host's dispatch-analysis prompt arm filters `isSubtask` rows out of `buildDispatchPlans`' output before calling `buildPromptDispatchContext` (the standalone builder needs no filter — it uses `getPlanBySessionId` records with no `isSubtask` field). **Files changed:** `src/services/agentPromptBuilder.ts` (added `analysisScope` to `PromptBuilderOptions`), `src/services/KanbanProvider.ts` (arm filtering + prompt `PROJECT=` line + `isSubtask` filter), `src/services/TaskViewerProvider.ts` (added `analysisScope` to `ConfiguredKanbanDispatchOptions` + forwarded at `dispatchToGroup`), `src/extension.ts` (7th param on registration), `src/standalone/bootstrap.ts` (function signature + registration + `triggerAction` fallback to `projectFilter`), `src/services/verbSchemas.ts` (declared `initiatorProject` on `dispatchAnalyze` schema). No issues encountered. Change 6 (batch fragmentation) deferred as planned.

## Review Findings

Two MAJOR findings fixed. (1) The `PROJECT=` resolver mapped an *unthreaded* scope (`undefined`) to `PROJECT=<all>`, so the single-plan planner path that allowlists this instruction (`TaskViewerProvider.ts:19458`) would have told the agent to widen to every project — strictly worse than the pre-scoping behaviour; `undefined` now emits no line at all (the skill's "use `PLANS TO PROCESS` verbatim" fallback) while `null` still correctly emits `<all>`. (2) The plan's five Verification-Plan automated checks did not exist; the duplicated three-form mapping was also the drift risk the plan itself flagged, so the resolver was extracted to one shared `buildAnalysisScopeLine` in `agentPromptBuilder.ts` (imported by both hosts) and `src/test/dispatch-analysis-scope-contract.test.js` was added (13 assertions covering all five checks plus a sentinel-parity pin), wired as `test:contract:dispatch-analysis-scope` in `package.json` and invoked by `.github/workflows/integration-tests.yml`. **Files changed by review:** `agentPromptBuilder.ts`, `KanbanProvider.ts`, `bootstrap.ts`, `package.json`, `.github/workflows/integration-tests.yml`, new `src/test/dispatch-analysis-scope-contract.test.js`. **Validation:** `tsc -p tsconfig.test.json` clean; `catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check`, `lint` (0 errors) all green; new contract test 13/13; `cross-client-scope` 18/18, `browser-planner-dispatch-surface` 7/7, `browser-panel-verb-routing` 11/11 — the one red in `verb-engine-kanban` (`focusTerminal` `{silent:true}` arg) is pre-existing at HEAD and untouched by this diff. **Remaining risks:** standalone's `KanbanProvider._lastCards` is populated only as a side effect of arms that call `this.refresh()` (e.g. `toggleDispatchView`), so standalone Analyze depends on that ordering; Change 6 (batch fragmentation across per-feature terminals) is still deferred; a project name with surrounding whitespace would emit trimmed in `PROJECT=` while the candidate filter matched it untrimmed.
