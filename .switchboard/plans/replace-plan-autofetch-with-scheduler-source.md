# Replace the Plan Auto-Fetch Service with a Dedicated "Fetch Cloud Plans" Scheduler Source

## Goal

Retire the over-engineered plan auto-fetch feature (`PlanAutoFetchService` + the `project.html` "⚙ AutoFetch" modal + its `switchboard.planAutoFetch.*` settings) and replace it with a single new **Scheduler source** in the AUTOMATION tab that dispatches an agent, on a timer, to grab the latest plan files off new remote branches.

### Problem / root-cause analysis

The current auto-fetch is heavy machinery aimed slightly off its own target:

- **Its only real use case** is pulling in plans authored on a cloud VM (Claude VM / GPT VM) that pushes plan files up so the local `.switchboard/plans/` can absorb them.
- **But cloud VMs push those plans on _new branches_**, and `PlanAutoFetchService` only ever fast-forwards the **default branch**. Its whole cycle is: `git fetch origin <default-branch>` → guard (must be *on* the default branch, clean tree, fast-forwardable, every new commit from a *trusted author*) → `git merge --ff-only`. It structurally cannot pick up plans sitting on a feature branch — which is exactly where they are. So it carries a large maintenance surface (backoff maps, trusted-author allow-lists, control-plane git-root resolution, a modal, five VS Code settings, and a host service running on a 60s timer) while not actually serving the workflow it exists for.
- **The owner's real workflow is already agent-driven**: "I just ask an agent to grab the latest plans on new branches." That is precisely the Scheduler's native shape — *a prompt sent to an agent on a recurring timer*. The Scheduler mode even ships an empty sibling stub (`reconcile`, "Reconcile cloud work") demonstrating the intended pattern.

The fix is to delete the bespoke service and express the capability where it belongs: as one more Scheduler source, `fetch-plans`, that ships an authored preset prompt so it works with zero configuration — the automated version of the manual habit.

### Verified during the improve pass (measured facts — additive, nothing above removed)

Every claim below was read out of the code at HEAD.

**Confirming the root cause (the plan's diagnosis is correct):**

1. `PlanAutoFetchService.ts` is 328 lines. It fetches only the default branch
   (`:193`, `git fetch <remote> <defaultBranch>`), and **hard-skips whenever HEAD is not the
   default branch** (`:203–206` → status `"On feature branch '<x>' (not default '<y>')"`).
   The structural-inability claim is exact.
2. The full guard chain is present as described: control-plane git-root resolution
   (`:129–140`), exponential backoff map (`:154–163`), clean-tree check (`:210–215`),
   fast-forwardable ancestry check (`:220–230`), trusted-author allow-list seeded from
   `git config user.email` (`:241–253`), `git merge --ff-only` (`:256`), 60s timer
   (`:78–95`).
3. Reference count is small and fully enumerable — `grep -rl` over `src/`:
   `PlanAutoFetchService.ts`, `extension.ts`, `PlanningPanelProvider.ts`,
   `webview/project.html`, `webview/project.js`, **and `src/generated/verbAllowlist.ts`**
   (see gap #6). Outside `src/`: `package.json` and
   `docs/remote_control_production_sequencing_implementation_audit.md`. **No test file
   references it** — deletion breaks no test.

**Gaps found in the plan as written (each is corrected in Part A / Part B below):**

4. **`_buildReconcilePrompt()` is not an empty stub.** `KanbanProvider.ts:5317–5341` is a
   fully authored ~20-line preset prompt (fetch/prune, scan `.switchboard/plans/` for new
   `## Completion Report` sections, forward-only card moves via `move-card.js`, never SQL).
   The pattern to copy therefore already exists and lives in **`KanbanProvider`**, not
   `TaskViewerProvider`.
   > **Superseded:** "The Scheduler mode even ships an empty sibling stub (`reconcile`,
   > 'Reconcile cloud work') demonstrating the intended pattern."
   > **Reason:** Factually inverted in a way that changes the implementation. `reconcile`
   > ships a complete authored preset; what is missing is not the *preset* but the *wiring
   > of presets into the local-terminal tick path* (gap #5). The plan's step 5 would have
   > modelled the new builder on `_buildMcpMonitorPrompt` in the wrong class.
   > **Replaced with:** `reconcile` ships a complete authored preset at
   > `KanbanProvider.ts:5317`, reachable **only** from the COPY-PROMPT path. Model
   > `buildFetchPlansPrompt` on `_buildReconcilePrompt`, and wire it into **both** prompt
   > paths (Part B steps 5–7).
5. **There are two independent scheduler prompt paths, and only one of them has presets.**
   - **COPY PROMPT / external targets** → `KanbanProvider._buildSchedulerPrompt`
     (`:5392–5442`) dispatches on `job.source` and *does* call authored builders:
     `_buildBoardBatchPromptCore` for `board-batch`, `_buildReconcilePrompt` for
     `reconcile`, `_buildCustomPrompt` for `custom`. It appends
     `SCHEDULER_TARGET_CONTRACTS[target].prerequisites` for `antigravity`/`cloud`.
     Entry point: `KanbanProvider.ts:10029` (`case 'schedulerPrompt'`), triggered from
     `kanban.html:10346`.
   - **Local-terminal tick** → `TaskViewerProvider._schedulerTick` (`:22241`). Its
     non-comms branch is **only** `prompt = (job.promptOverride || '').trim(); if (!prompt)
     return;` (`:22298–22300`), with an in-code comment stating *"plan 3 supplies authored
     builders for board-batch/reconcile/custom via the same dispatch; until then
     promptOverride is the carrier."*
   Consequence: a `fetch-plans` preset added **only** to `_schedulerTick` leaves COPY PROMPT
   emitting `{prompt: null, error: 'No prompt produced.'}` for the new source — the plan's
   own verification step *"With target = antigravity / cloud, confirm COPY PROMPT yields the
   preset text"* would fail. Both sites must be wired, from **one** shared builder.
6. **`src/generated/verbAllowlist.ts` carries both removed verbs and is auto-generated.**
   `PLANNING_VERBS` contains `planAutoFetchRunNow` and `setPlanAutoFetchEnabled`. Header:
   *"AUTO-GENERATED — do not edit; run `npm run catalog:generate`."* Source of truth is
   `protocol-catalog.json` (10 occurrences of the two verbs), regenerated by
   `scripts/generate-protocol-catalog.js`; `npm run catalog:check` fails on drift
   (`scripts/generate-verb-allowlist.js:86`), and `scripts/check-protocol-parity.js` is a
   second guard. Part A omitted this step entirely — and the plan's own `grep -rin
   "planAutoFetch" src/` verification **would** have caught it with no instruction on how to
   fix it.
7. **The enabled-toggle write path and the service's read path disagree today.** The webview
   toggle posts `setPlanAutoFetchEnabled` → `PlanningPanelProvider.ts:3770` writes
   `pathConfig.updateConfigWorkspace('planAutoFetch.enabled', …)` (the DB `config` table),
   while `PlanAutoFetchService` reads **only**
   `vscode.workspace.getConfiguration('switchboard.planAutoFetch')` (`:31–32`, `:68`,
   `:108`). So flipping the modal checkbox never actually enabled the service. This is a
   pre-existing defect that **strengthens** the case for deletion (the feature was
   partly inert) and adds one cleanup item: a stale `planAutoFetch.enabled` row may exist in
   the DB `config` table. See the migration note.
8. **`_startSchedulerOutputCapture` behaves as the plan assumes.** `TaskViewerProvider.ts:22319`
   writes non-comms output to `.switchboard/scheduler-<job.id>-latest.md` (`:22326–22328`)
   and is called only *after* a prompt is sent (`:22287`, `:22305`).
9. **All `kanban.html` line numbers in Part B are stale by ~75–80 lines** (the file drifted
   after the plan was drafted). Corrected inline in Part B. `ScheduledJob.source` at
   `GlobalIntegrationConfigService.ts:96` is still accurate.

### Non-goals

- Not touching the Scheduler engine's core model (source → prompt, target → agent surface). The new source rides the existing tick/dispatch path.
- Not building a new host-side git service. The agent does the git work via the preset prompt, against whatever target the user selects (local terminal / Antigravity / cloud).
- Not repurposing the existing `reconcile` source — this is a **dedicated, separately-named** source (decision confirmed with owner).
  - *Clarification (not a new requirement):* Verified Fact 4 shows `reconcile`'s preset already opens with `git fetch --prune` and scans `.switchboard/plans/`, so the two sources overlap on mechanics. They remain distinct on **purpose**: `reconcile` *moves cards* for work already done; `fetch-plans` *imports plan files* that do not exist locally yet. The owner's separate-source decision stands unchanged.
- **Not** retrofitting presets onto `board-batch` / `reconcile` / `custom` in the local-terminal tick path. That is the pending "plan 3" work referenced in `TaskViewerProvider.ts:22295–22297`. This plan touches the tick's non-comms branch **additively only** — see the Dependencies section.

## Metadata

**Complexity:** 6
**Tags:** refactor, feature, frontend, backend

> **Superseded:** `**Complexity:** 5`
> **Reason:** Three verified facts push it up: the new preset must be wired into **two**
> prompt paths across **two** provider classes from one shared builder (Verified Fact 5),
> a generated-artifact regeneration step with its own CI guard was missing (Fact 6), and
> the tick-path edit lands in a region a pending sibling plan will also restructure
> (Dependencies). Still comfortably under 7 — no new architectural pattern, no data-
> consistency risk, and removal is mechanical.
> **Replaced with:** `**Complexity:** 6` → Send to Coder.

## User Review Required

- **None.** The one judgement call the original draft left implicit — whether deleting
  `PlanAutoFetchService` also removes a *control-plane pull* capability (the docs audit
  `docs/remote_control_production_sequencing_implementation_audit.md:241` names it the
  "control-plane pull target") — is answered by the plan's own Goal: the owner states the
  only real use case is pulling VM-authored plans, and the service's control-plane handling
  is merely git-root *resolution* (`PlanAutoFetchService.ts:129–140`), not a distinct sync.
  Decision: delete it; the new Scheduler source is the replacement. Recorded as a side
  effect in the Edge-Case audit rather than deferred back to the user.

## Complexity Audit

### Routine

- The removal (Part A) is mechanical deletion across six known files plus two regenerated
  artifacts. No test references the service; the reference set is fully enumerated.
- Widening the `ScheduledJob.source` union is a one-token additive change.
- The new config row, dropdown option, and `collectJobFromRow` packing are direct copies of
  the adjacent `board-batch` code in the same function.
- Authoring the preset prompt is prose, with an exact in-repo model
  (`_buildReconcilePrompt`, `KanbanProvider.ts:5317`).

### Complex / Risky

- **Two prompt paths in two classes must stay in sync** (Verified Fact 5). Wiring one and
  not the other yields a source that works locally and silently produces nothing on COPY
  PROMPT — a partial-success failure mode that reads as "done".
- **Generated artifacts** (`protocol-catalog.json`, `src/generated/verbAllowlist.ts`) must
  be regenerated and committed, or `catalog:check` / `check-protocol-parity` fail CI
  (Verified Fact 6).
- **Overlap with pending "plan 3"** in `_schedulerTick`'s non-comms branch — a merge/design
  collision risk, not a correctness one.
- **The preset prompt instructs an agent to run git commands in the user's live working
  tree.** A careless verb (`checkout <branch>`, `merge`, `reset`) could switch branches or
  clobber local edits. The prompt's wording is load-bearing safety, not decoration.
- **Removing `package.json` configuration contributions** on a published extension
  (~4,000 installs) — analysed in the migration note.

## Part A — Remove the Plan Auto-Fetch feature

*(All line numbers re-verified at HEAD during this improve pass.)*

1. **Delete the service.** Remove `src/services/PlanAutoFetchService.ts` in full (328 lines).
2. **`src/extension.ts`** — remove the import (**line 41**), the
   `new PlanAutoFetchService(...)` construction + `initialize()` +
   `context.subscriptions.push(...)` block (**from line 728**), and the
   `planningPanelProvider.setPlanAutoFetchService(planAutoFetchService)` wiring
   (**line 1184**).
3. **`src/services/PlanningPanelProvider.ts`** — remove the import (**line 42**), the
   `_planAutoFetchService` field (**line 278**), the `setPlanAutoFetchService` setter
   (**lines 319–321**), the two `planAutoFetchState` status-push sites (the initial push
   **653–659** and the `onDidChangeConfiguration` push **686–691**, gated on
   `switchboard.planAutoFetch`), and the two message handlers `setPlanAutoFetchEnabled`
   (**3766–3775**) and `planAutoFetchRunNow` (**3777–3793**).
4. **`src/webview/project.html`** — remove the "Auto-Fetch Plans" modal (`#autofetch-modal`,
   **lines 1534–1563**, including the `#kanban-auto-fetch-enabled` checkbox at 1549, the
   `#btn-plan-auto-fetch-now` button at 1554, and the `#kanban-auto-fetch-status` span at
   1555).
5. **`src/webview/project.js`** — remove **all six** sites (the original draft listed five;
   the dynamic meta-bar listener is easy to miss because the button is injected after
   render):
   - the `planAutoFetchState` message handler (**418–443**);
   - the `#kanban-meta-autofetch-btn` "⚙ AutoFetch" button markup in the meta bar template
     (**line 2030** — note: this button lives in `project.js`, **not** `project.html`; the
     original draft placed it in `project.html`);
   - the dynamic `dynamicAutofetchBtn` → `openAutofetchModal` listener (**2132–2135**);
   - `autofetchModal` / `btnCloseAutofetchModal` refs and the
     `openAutofetchModal` / `closeAutofetchModal` functions (**2182–2195**);
   - `#btn-plan-auto-fetch-now` → `planAutoFetchRunNow` post (**2197–2204**);
   - `#kanban-auto-fetch-enabled` change → `setPlanAutoFetchEnabled` post (**2205–2212**).

   Then `grep -in "autoFetch\|auto-fetch\|autofetch" src/webview/project.js` to confirm zero
   remaining hits.
6. **`package.json`** — remove the five `switchboard.planAutoFetch.*` configuration
   contributions: `enabled` (**551**), `intervalSeconds` (**557**), `remote` (**564**),
   `defaultBranch` (**570**), `trustedAuthors` (**576**) — through the end of the
   `trustedAuthors` block.
7. **Regenerate the protocol catalog and verb allowlist** *(new step — Verified Fact 6)*:
   ```bash
   npm run catalog:generate     # rewrites protocol-catalog.json AND src/generated/verbAllowlist.ts
   npm run catalog:check        # must pass — asserts no drift
   ```
   Commit both regenerated files. Expect `planAutoFetchRunNow` and
   `setPlanAutoFetchEnabled` to disappear from `PLANNING_VERBS` and from all 10
   `protocol-catalog.json` occurrences. **Do not hand-edit either file.**
8. **Changelog** — note that background plan auto-fetch is removed and the Scheduler
   `fetch-plans` source replaces it.
9. **Leave `docs/remote_control_production_sequencing_implementation_audit.md` alone.** It is
   a dated historical audit (it references `PlanAutoFetchService.ts:373–389`, line numbers
   that no longer exist in a 328-line file — it was already stale). Rewriting history is not
   this plan's job; the file's two `PlanAutoFetch` hits are expected residue and must not be
   treated as a dangling reference.

### Migration note (published extension, ~4,000 installs)

- The `switchboard.planAutoFetch.*` keys shipped in released versions, but they are **VS Code settings, not user data**. Removing the contribution points only stops them being surfaced/validated; any value already in a user's `settings.json` is silently ignored by VS Code — nothing is destroyed. **No migration or `*.migrated.bak` archival is required**, and removing them is a safe clean break. (Call this out explicitly in the PR so a reviewer doesn't flag it against the migrations rule.)
  - *Clarification (Verified Fact 7):* one **additional** persisted key exists that the
    original note did not cover — `PlanningPanelProvider.ts:3770` wrote
    `planAutoFetch.enabled` into the DB `config` table via
    `pathConfig.updateConfigWorkspace`. That row may exist on installs where the user
    touched the modal checkbox. It is a dead orphan row: nothing will read it once the
    handler is gone. **Decision: leave it.** Per CLAUDE.md the migration duty is to avoid
    *destroying* shipped state, and an unread row destroys nothing; a `DELETE` migration
    against `config` for a defunct key is more risk than the row. State this in the PR.
- No plan files are affected — this removes a *fetch mechanism*, never any `.switchboard/plans/` content.
- Any user who had auto-fetch enabled loses a background behavior; the new Scheduler source is the documented replacement. Note this in the changelog.
  - *Clarification:* per Verified Fact 7, users who enabled it **via the modal checkbox**
    were never actually running it (the toggle wrote to a key the service never read). Only
    users who set `switchboard.planAutoFetch.enabled` directly in `settings.json` lose a
    behaviour that was working.

## Part B — Add the `fetch-plans` Scheduler source

*(All `kanban.html` line numbers below are re-verified at HEAD. The original draft's numbers were ~75–80 lines low.)*

1. **`src/services/GlobalIntegrationConfigService.ts`** — extend the `ScheduledJob.source`
   union (**line 96**) to include `'fetch-plans'`:
   `source: 'comms' | 'board-batch' | 'reconcile' | 'custom' | 'fetch-plans';`
   No `schemaVersion` bump (`SCHEDULER_SCHEMA_VERSION` stays `1`, **line 114**) — this is an
   additive, backward-compatible enum widening (existing persisted jobs never carry the
   value; old code never emits it). Add a one-line doc comment noting the new source and its
   `sourceConfig` shape (`{ remote?: string; branchGlob?: string }`). Also update the
   source list in the interface's doc comment at **line 37**, which currently reads
   "board-batch / reconcile / custom are others".
2. **`src/webview/kanban.html` — source dropdown** (**lines 10219–10225**, the array fed to
   `sourceSelect`): add `{ value: 'fetch-plans', label: 'Fetch cloud plans' }`. Ordering:
   `board-batch → fetch-plans → reconcile → custom → comms`. Update the adjacent ordering
   comment at **10219** and the sources comment at **10100**.
3. **`src/webview/kanban.html` — per-source config UI**: mirror the board-batch config row
   (**10263–10292**, `batchConfigRow`) with a `fetchConfigRow` exposing two optional inputs,
   `data-field="fetchRemote"` (placeholder `origin`) and `data-field="fetchBranchGlob"`
   (placeholder `*`, e.g. `claude/*` to scope to VM branches), prefixed by a `FETCH:` label
   span to match the `BATCH:` convention. Reuse the same inline `cssText` strings as the
   board-batch inputs. Append it to `row` immediately after `batchConfigRow`
   (**line 10292**).
4. **`src/webview/kanban.html` — `refreshSubForms`** (**lines 10364–10379**): add
   `const isFetch = sourceSelect.value === 'fetch-plans';` and
   `fetchConfigRow.style.display = isFetch ? 'flex' : 'none';` alongside the existing
   `isBatch` toggle at **10371**. `refreshSubForms()` is already called on `change` for both
   selects and once on render (**10380–10382**) — no new wiring needed.
5. **`src/webview/kanban.html` — `collectJobFromRow`** (**lines 10388–10425**): in the
   `sourceConfig` block (**10404–10410**), add
   ```js
   const fetchRemoteEl = rowEl.querySelector('input[data-field="fetchRemote"]');
   const fetchGlobEl = rowEl.querySelector('input[data-field="fetchBranchGlob"]');
   if (source === 'fetch-plans') {
       sourceConfig.remote = (fetchRemoteEl && fetchRemoteEl.value) || 'origin';
       sourceConfig.branchGlob = (fetchGlobEl && fetchGlobEl.value) || '*';
   }
   ```
   Note the existing `if (source === 'board-batch')` guard is a sibling `if`, not an
   `else if` — keep the same shape.
6. **New shared builder — `src/services/schedulerPresets.ts`** *(corrected location — see
   Verified Fact 5)*. A module-level exported pure function, so **both** prompt paths call
   one copy:
   ```ts
   export function buildFetchPlansPrompt(job: { sourceConfig?: Record<string, unknown> }): string
   ```
   It reads `remote` (default `'origin'`) and `branchGlob` (default `'*'`) from
   `job.sourceConfig` and returns the authored prompt (content in step 8). Model the voice,
   numbered-step structure, and closing "constraint recap" line on
   `KanbanProvider._buildReconcilePrompt` (`KanbanProvider.ts:5317–5341`).

   > **Superseded:** "add a `job.source === 'fetch-plans'` case that builds an **authored
   > preset prompt** (new private helper `_buildFetchPlansPrompt(job)`, modeled on
   > `_buildMcpMonitorPrompt`)" — i.e. a private method on `TaskViewerProvider` only.
   > **Reason:** Two defects. (a) Wrong sibling: `_buildMcpMonitorPrompt`
   > (`TaskViewerProvider.ts:22436`) builds the *comms* prompt from `McpMonitorConfig`; the
   > correct model is `_buildReconcilePrompt` (`KanbanProvider.ts:5317`), a
   > `sourceConfig`-driven authored preset. (b) Wrong home: the COPY-PROMPT path lives in
   > `KanbanProvider._buildSchedulerPrompt` and **cannot call a private method on
   > `TaskViewerProvider`**, so a private helper there would leave `antigravity`/`cloud`
   > targets emitting `error: 'No prompt produced.'` — failing this plan's own verification
   > step for those targets.
   > **Replaced with:** one exported function in a new `src/services/schedulerPresets.ts`,
   > imported by both `KanbanProvider._buildSchedulerPrompt` (step 7) and
   > `TaskViewerProvider._schedulerTick` (step 9). Single copy of the prompt text; both
   > targets work.
7. **`src/services/KanbanProvider.ts` — `_buildSchedulerPrompt`** (**lines 5392–5442**): add
   a branch before the `custom` fallback:
   ```ts
   } else if (source === 'fetch-plans') {
       body = buildFetchPlansPrompt(job);
   ```
   This is what makes COPY PROMPT work for `antigravity`/`cloud` — the existing tail
   (**5434–5441**) appends `SCHEDULER_TARGET_CONTRACTS[target].prerequisites` automatically,
   so no extra work for external targets.
8. **Preset prompt content** (`buildFetchPlansPrompt`): instruct the agent to, from the
   workspace root:
   - `git fetch <remote> --prune` (default `origin`);
   - list remote branches matching `<branchGlob>` sorted by recency, e.g.
     `git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/remotes/<remote>/<branchGlob>'`;
   - for each, enumerate `.switchboard/plans/*.md` present on that branch
     (`git ls-tree --name-only <remote>/<branch> -- .switchboard/plans/`) and copy in **only
     files that do not already exist locally**, via
     `git show <remote>/<branch>:<path> > <path>`;
   - **never switch the local branch, never stage anything, never overwrite an existing
     local plan file.** Explicitly forbid `git checkout`, `git switch`, `git merge`,
     `git reset`, and `git pull` — `git show >` is the only sanctioned write, because it
     touches the working tree and nothing else. *(This replaces the draft's suggested
     `git checkout <remote>/<branch> -- .switchboard/plans/`, which writes to the **index**
     as well as the working tree and would both stage files and overwrite local edits — see
     Uncertain Assumptions.)*
   - end by writing a one-line summary (branches scanned, files copied, files skipped and
     why) to `.switchboard/scheduler-<jobId>-latest.md`, so the existing scheduler-output
     capture (`TaskViewerProvider._startSchedulerOutputCapture`, **:22319**, which watches
     exactly that path — Verified Fact 8) surfaces results in the panel like every other
     source;
   - close with a constraint recap line, matching `_buildReconcilePrompt`'s final-line
     convention: *read-only against git history, additive-only in the working tree, never
     switch branches, never overwrite, idempotent across runs.*
9. **`src/services/TaskViewerProvider.ts` — `_schedulerTick`** (**line 22241**; the non-comms
   branch begins at the comment on **22294** and the override read is **22298–22300**):
   change
   ```ts
   prompt = (job.promptOverride || '').trim();
   if (!prompt) return;
   ```
   to
   ```ts
   prompt = (job.promptOverride || '').trim();
   if (!prompt && job.source === 'fetch-plans') {
       prompt = buildFetchPlansPrompt(job);
   }
   if (!prompt) return;
   ```
   This preserves the override-precedence contract exactly (a non-empty `promptOverride`
   still wins) and keeps every other source's current behaviour byte-identical — an empty
   override still skips the tick for `board-batch`/`reconcile`/`custom`, leaving that to
   plan 3. Note the tick also requires a live matching terminal (**22247–22255**) before
   reaching this point; that gate is unchanged.
10. **Mode description** (`kanban.html` **line 9011**, the `'scheduler'` help text): insert
    "fetch cloud plans" into the sources list so the dropdown help stays accurate. Also
    consider the `promptArea` placeholder at **10317** ("For board-batch/reconcile leave
    blank to use the preset") — after this change that sentence is true for `fetch-plans`
    and still aspirational for `board-batch`/`reconcile` on the local-terminal path; adding
    `fetch-plans` to that list is accurate and in scope.

## Edge-Case & Dependency Audit

**Race Conditions**
- `_schedulerTick` is already serialised per job via `_schedulerTickQueues`
  (`TaskViewerProvider.ts:484`, `:22225–22226`) and guarded by `_schedulerInFlight`
  (`:22257`), so overlapping fetch-plans ticks cannot double-dispatch. No new locking.
- The **agent's** git work is not serialised against the extension. If a `fetch-plans` tick
  fires while the user is mid-`git rebase`, the preset's read-only/additive-only constraint
  is the only protection — which is why step 8's forbidden-verb list is load-bearing rather
  than stylistic.
- Copying a plan file into `.switchboard/plans/` triggers the plan watcher's import. That is
  the intended outcome, and imports are instant (no polling needed). Two branches carrying a
  same-named plan file resolve to "first one wins, second skipped" by the
  does-not-exist-locally rule — deterministic, and the summary file records the skip.

**Security**
- The preset prompt runs git against a user-configured `remote` and `branchGlob`. Both are
  free-text webview inputs interpolated into shell commands the agent runs. Keep them inside
  single quotes in the emitted commands and do not build any `eval`-style construct; a
  hostile glob is a self-inflicted footgun rather than a privilege escalation (the agent
  already has shell access), but the prompt should not model sloppy quoting.
- Deleting the trusted-author allow-list removes a signature-style guard. Accepted and
  intentional: it only ever gated `--ff-only` merges on the default branch, whereas the new
  flow never merges and never advances HEAD — it copies untracked files into the working
  tree, which the user reviews before committing. Net risk is lower, not higher.
- No secrets, tokens, or credentials are touched by either part.

**Side Effects**
- **Control-plane pull is removed.** `docs/…_audit.md:241` names `PlanAutoFetchService` the
  "control-plane pull target". In the code that amounts to git-root *resolution* for
  repo-scoped control planes (`PlanAutoFetchService.ts:129–140`) plus the default-branch
  fast-forward — there is no separate control-plane sync to lose. After Part A, nothing
  auto-pulls a control-plane repo on a timer. Decided (User Review Required): acceptable,
  since the Goal states plan-pulling is the only real use case, and a `fetch-plans` job
  covers it on demand.
- The 60s host timer and its `initialize()` startup cycle disappear — one less background
  git process on activation. Strictly a win for the "refresh storm starves the ext host"
  class of problem.
- The AUTOMATION tab's Scheduler gains a source; the project view loses a meta-bar button.
  Both are additive/subtractive UI, no layout reflow risk beyond the removed button's slot.

**Dependencies & Conflicts**
- **Pending "plan 3"** — `TaskViewerProvider.ts:22295–22297` explicitly reserves the
  non-comms branch for authored builders for `board-batch`/`reconcile`/`custom`. Step 9 is
  written to be *additive* (a `job.source === 'fetch-plans'` guard inside the existing
  `if (!prompt)` region) precisely so plan 3 can generalise it without reverting this work.
  If plan 3 lands first, step 9 collapses into "add `fetch-plans` to the dispatch map plan 3
  introduced" — re-read that region before editing.
- **Pending "plan 4"** — `KanbanProvider.ts:10029–10033` and `:10047–10050` reference plan 4
  retiring the standalone `antigravity-batch` mode and owning the Scheduler UI's
  prerequisites rendering. No overlap with the files this plan edits, but expect churn in
  `kanban.html`'s scheduler panel.
- **Generated artifacts** — `protocol-catalog.json` + `src/generated/verbAllowlist.ts` must
  be regenerated (Part A step 7) or CI fails via `catalog:check` /
  `scripts/check-protocol-parity.js`.
- **No test depends on `PlanAutoFetchService`** (verified). The four `autoban-*.test.js`
  files in `src/test/` do not reference it.

## Dependencies

- None blocking. Two *pending sibling plans* interact with the same regions and are
  documented above rather than as hard dependencies: "plan 3" (authored builders for the
  remaining non-comms sources, `TaskViewerProvider.ts:22295`) and "plan 4" (Scheduler UI /
  `antigravity-batch` retirement, `KanbanProvider.ts:10032`). Either order works; whichever
  lands second must re-read the other's touched region. No `sess_*` dependency.

## Adversarial Synthesis

**Risk summary.** The dominant risk is a **partial wiring that reads as success**: the new
source's preset reaching the local-terminal tick but not the COPY-PROMPT path, so
`antigravity`/`cloud` targets silently emit "No prompt produced" while the dropdown, the
config row, and the round-trip test all pass. Second is **incomplete removal** — two
generated artifacts (`protocol-catalog.json`, `src/generated/verbAllowlist.ts`) still carry
the deleted verbs and fail CI unless regenerated. Third is the **preset prompt's git verbs**:
this is the one place where prose becomes destructive, so `git show >` must be the only
sanctioned write and `checkout`/`merge`/`reset`/`pull` must be explicitly forbidden.
Mitigations: one shared `buildFetchPlansPrompt` imported by both paths; an explicit
`catalog:generate` step; a forbidden-verb list inside the prompt itself.

## Verification Plan

Because `dist/` is not used in testing (per repo rules — test via the installed VSIX, `src/` is source of truth), verify against `src/`:

*Not executed during this improve pass — this session was directed to skip compilation and automated tests. Every item below is an implementer step.*

**Part A (removal) — confirm nothing dangles:**
- `grep -rin "planAutoFetch\|PlanAutoFetch\|auto-fetch\|autofetch" src/ package.json` returns **no** matches (case-insensitive) except, if desired, a changelog entry.
  - *Clarification:* this grep **includes `src/generated/verbAllowlist.ts`**. If it still
    hits there, Part A step 7 (`npm run catalog:generate`) was skipped — that is the
    expected failure signature, not a stray reference.
- `grep -n "planAutoFetch" protocol-catalog.json` returns **no** matches (10 occurrences
  before the change) *(new check)*.
- `npm run catalog:check` passes *(new check — asserts the regenerated artifacts match)*.
- `src/services/PlanAutoFetchService.ts` no longer exists.
- TypeScript compiles clean: `npm run compile` succeeds with no unresolved-symbol errors from the removed import/field/setter.
- Build a VSIX, install it, open a Switchboard workspace: the project view shows **no** "⚙ AutoFetch" button and the `#autofetch-modal` is gone; VS Code Settings search for "Plan Auto Fetch" returns nothing.
- `docs/remote_control_production_sequencing_implementation_audit.md` still has its two
  historical `PlanAutoFetch` hits — **expected**, do not "fix" (Part A step 9).

**Part B (new source) — confirm it works end to end:**
- In the AUTOMATION tab, select **Scheduler**, add a job, and confirm **"Fetch cloud plans"** appears in the source dropdown; selecting it reveals the remote / branch-glob config row and hides the board-batch row.
- Switch the source away from `fetch-plans` and back; confirm the fetch config row hides and
  re-shows (proves the `refreshSubForms` toggle, step 4) *(new check)*.
- Save the job, reload the panel, and confirm the job round-trips (source, `sourceConfig.remote`, `sourceConfig.branchGlob`, interval all persist via `getSchedulerConfig`).
- Leave both config inputs blank, save, reload → confirm the defaults `remote: 'origin'` and
  `branchGlob: '*'` were persisted, not empty strings *(new check)*.
- With `target = local-terminal` and a running job terminal, let a tick fire (or shorten the interval): confirm the agent receives the preset prompt with **no** `promptOverride` set, that it fetches and copies a plan file authored on a matching remote branch into local `.switchboard/plans/`, and that `.switchboard/scheduler-<jobId>-latest.md` is written and surfaced in the panel.
- After that tick, run `git status` and `git diff --cached` → the copied plan file appears as
  **untracked**, nothing is staged, and `git rev-parse --abbrev-ref HEAD` is unchanged.
  *(new check — this is the one that catches a destructive git verb in the preset.)*
- Re-run the same tick with the plan file already present locally → confirm it is **skipped**
  (not overwritten) and the skip is named in the summary file *(new check — idempotency)*.
- Set a non-empty `PROMPT` override and confirm it takes precedence over the preset (override contract preserved).
- With `target = antigravity` / `cloud`, confirm **COPY PROMPT** yields the preset text —
  **and that it includes the target's prerequisites block appended by
  `_buildSchedulerPrompt`**. An empty clipboard or a "No prompt produced." warning here is
  the exact symptom of wiring only `_schedulerTick` and skipping Part B step 7 *(sharpened
  check — Verified Fact 5)*.

**Regression guard:**
- Confirm the existing `comms`, `board-batch`, `reconcile`, and `custom` sources are unaffected (dropdown, sub-forms, tick dispatch, and the `autoban-state-regression` test still pass).
  - *Clarification:* the referenced test is `src/test/autoban-state-regression.test.js`
    (confirmed present, alongside `autoban-controls-regression`,
    `autoban-no-valid-tickets-regression`, and `autoban-reviewer-prompt-regression`).
- COPY PROMPT for `reconcile` and `board-batch` still yields their existing preset text
  unchanged (proves step 7's new `else if` did not disturb the dispatch chain) *(new check)*.
- Confirm no `confirm()` / `window.confirm()` gate is introduced anywhere in the removed/added webview paths (repo hard rule).

### Automated Tests

- **No new automated test is added.** Part A is deletion covered by existing CI guards
  (`npm run compile`, `npm run catalog:check`, `scripts/check-protocol-parity.js`), and Part
  B's substance is a prompt string plus webview DOM wiring — neither has an existing harness,
  and the repo's scheduler coverage is regression-style (`src/test/autoban-*.test.js`), not
  unit tests over prompt builders.
- **Existing suites that must stay green:** the four `src/test/autoban-*.test.js` regression
  tests, `npm run catalog:check`, and `npm run compile`.
- If a cheap unit test is wanted, `buildFetchPlansPrompt` is a pure exported function
  (Part B step 6) and is trivially assertable — e.g. defaults applied when `sourceConfig` is
  empty, and none of the forbidden verbs (`git checkout`, `git switch`, `git merge`,
  `git reset`, `git pull`) appear in the output. That last assertion is the highest-value
  test available here and is worth the five lines.

## Uncertain Assumptions

The user was advised to run web research to confirm these **before implementation**; the
ready-to-run research prompt was supplied in chat.

1. **What VS Code actually does with a `settings.json` key whose contribution point was
   removed.** The migration note asserts it is "silently ignored". Nothing is *destroyed* —
   that much is certain, since the value simply stays in the user's JSON file — but VS Code
   may surface an "Unknown Configuration Setting" diagnostic on the orphaned key, which is a
   visible (if harmless) wart across ~4,000 installs and worth knowing before the PR claims
   silence.
2. **Whether `git checkout <tree-ish> -- <path>` writes the index as well as the working
   tree.** Step 8 replaces the draft's suggested `git checkout <remote>/<branch> --
   .switchboard/plans/` on the understanding that it stages the copied files *and*
   overwrites local modifications, whereas `git show <ref>:<path> > <path>` touches only the
   working tree. Confidence is high but not absolute, and it is load-bearing for the
   preset's safety wording (and for the `git diff --cached` verification check). Worth a
   confirm, including whether `git restore --source=<ref> --worktree` is the cleaner modern
   equivalent.
3. **Whether `git for-each-ref` glob patterns behave as assumed for
   `refs/remotes/<remote>/<branchGlob>`** — specifically whether a `*` in the pattern
   matches across `/` (so `claude/*` behaves as a user would expect for a nested branch
   name like `claude/feat/x`). If it does not, the preset needs a different enumeration
   (e.g. `git branch -r --list`) or explicit guidance on glob shape.

---

**Recommendation: Send to Coder** (complexity 6).

## Completion Report

Implemented removal of PlanAutoFetchService and added the dedicated "fetch-plans" Scheduler source. Removed `PlanAutoFetchService.ts`, UI modal elements in `project.html`/`project.js`, provider handlers in `PlanningPanelProvider.ts`/`extension.ts`, and settings in `package.json`. Added shared prompt builder `src/services/schedulerPresets.ts`, updated `ScheduledJob.source` in `GlobalIntegrationConfigService.ts`, wired UI inputs in `kanban.html`, and connected the preset prompt to both `KanbanProvider.ts` (COPY PROMPT) and `TaskViewerProvider.ts` (local terminal tick). Regenerated protocol catalog and verb allowlist clean via `npm run catalog:generate`.

## Review Pass — 2026-07-30

Independent reviewer pass against this plan as source of truth. Verification was
**executed** (no skip-tests / skip-compilation directive was present in the dispatch).

### Findings

| Sev | Location | Finding |
| :-- | :-- | :-- |
| CRITICAL | `src/services/schedulerPresets.ts:35` (pre-fix) | The summary path was emitted as the **literal** string `.switchboard/scheduler-${JOB_ID}-latest.md` — `\${JOB_ID}` was escaped inside the TS template literal, so no job id was ever interpolated. `TaskViewerProvider._startSchedulerOutputCapture` (`:22334`) watches `.switchboard/scheduler-<job.id>-latest.md`, so **no `fetch-plans` run could ever surface output in the panel**. Directly violates Part B step 8 / Verified Fact 8. Compounded by the trailing escape hatch *"(or output it directly)"*, which invited the agent to skip the file entirely. |
| MAJOR | `.github/workflows/integration-tests.yml:25–26` | Gate-wiring hole. `npm run catalog:check` (defined `package.json:796`) is named by this plan's `### Automated Tests` as a CI guard, but CI invoked only its first half (`node scripts/generate-protocol-catalog.js`). The `generate-verb-allowlist.js` byte-identity assertion — the guard over the artifact Part A step 7 had to regenerate — was **not invoked by CI under any name**. (Set-equality drift was incidentally covered by `parity:check` at `:35`; structural/ordering drift was not.) |
| MAJOR | `src/test/autoban-*.test.js` | Gate-wiring hole. The plan's *"Existing suites that must stay green"* names all four `autoban-*.test.js` files. They are referenced by **zero** npm scripts and **zero** CI steps — orphan files. Two of the four (`autoban-controls-regression`, `autoban-state-regression`) are **red at HEAD**, confirmed pre-existing by re-running them against `4d335c3^`. Not fixed here — see Deferred. |
| MINOR | `GlobalIntegrationConfigService.ts:37` | Part B step 1 explicitly required updating this doc comment's source list; it still read *"board-batch / reconcile / custom are others"*. |
| MINOR | `kanban.html:10112` | Part B step 2 explicitly required updating the scheduler-panel sources comment; it still read *"board-batch / reconcile / custom are the others"*. |
| MINOR | `KanbanProvider.ts:5396–5401` | `_buildSchedulerPrompt`'s dispatch docblock enumerated four sources while the body dispatched five — `fetch-plans` undocumented at its own dispatch site. |
| MINOR | `schedulerPresets.ts:15` | The Security section requires user-configured values be single-quoted in emitted commands. `git for-each-ref` quoted correctly; `git fetch ${remote} --prune` did not. |
| NIT | `src/webview/project.html:1512` | The Auto-Fetch modal deletion removed 7 `<div>` opens but only 6 closes, leaving an orphan `</div>`. **No behavioural impact** — it lands on a *pre-existing* unclosed `<div class="container">` (opened `:1233`, previously auto-closed at `</body>`), and the two elements it displaces are `position: fixed` with `.container` establishing no containing block. Net effect: the file is now div-balanced where it previously was not. |

### Fixes applied

1. **`src/services/schedulerPresets.ts`** — signature widened to `{ id?: string; sourceConfig?: … }`; the real `job.id` is now interpolated into the summary path (both call sites already pass the whole `job`). Removed the *"(or output it directly)"* escape hatch and replaced it with an explicit *"write that file even when nothing was copied; it is the only channel by which this job's result reaches the Switchboard panel."* Single-quoted `remote` in `git fetch`, and the ref/path arguments in `git ls-tree` / `git show`. Added `never stage anything` to the constraint recap. Added a docblock recording that `job.id` is load-bearing and naming the watcher it must match.
2. **`.github/workflows/integration-tests.yml`** — the drift-check step now runs `npm run catalog:check` (both generators) instead of the catalog generator alone, and is renamed accordingly. The check is green as of this pass, so this wires a passing gate, not a red one.
3. **`GlobalIntegrationConfigService.ts`**, **`kanban.html`**, **`KanbanProvider.ts`** — the three stale source-list doc comments now include `fetch-plans`.
4. **`src/webview/project.html`** — the orphan `</div>` annotated as the `.container` close, recording that it is intentional and why the elements after it are unaffected.

### Files changed in this review pass

`src/services/schedulerPresets.ts`, `src/services/GlobalIntegrationConfigService.ts`,
`src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/webview/project.html`,
`.github/workflows/integration-tests.yml`.

### Validation results (executed)

| Check | Result |
| :-- | :-- |
| `npm run compile` (webpack) | ✅ compiled, 0 errors (3 pre-existing optional-dep warnings: `bufferutil`, `utf-8-validate`, `canvas`) |
| `npm run compile-tests` (`tsc -p tsconfig.test.json`) | ✅ clean, exit 0 |
| `npm run catalog:check` | ✅ `[catalog] OK — no drift (599 arms, 512 verbs)` / `[allowlist] OK` |
| `npm run parity:check` | ✅ allowlist ≡ catalog, generic dispatchers in place |
| `npm run test:contract:drag-guard` | ✅ passed |
| `autoban-no-valid-tickets-regression` | ✅ passed |
| `autoban-reviewer-prompt-regression` | ✅ passed |
| `autoban-controls-regression` | ❌ **pre-existing red** — verified identical failure at `4d335c3^` |
| `autoban-state-regression` | ❌ **pre-existing red** — verified identical failure at `4d335c3^` |
| `grep -rin "planAutoFetch\|auto-fetch\|autofetch" src/ package.json` | ✅ zero matches |
| `grep -c planAutoFetch protocol-catalog.json` | ✅ 0 (was 10) |
| `src/services/PlanAutoFetchService.ts` exists | ✅ removed |
| `project.html` div balance (stack scan) | ✅ 0 unclosed, 0 orphan (parent had 1 unclosed) |
| `buildFetchPlansPrompt` behavioural assertions | ✅ no literal `${JOB_ID}`; emits `.switchboard/scheduler-abc-123-latest.md` for `id:'abc-123'`; defaults `origin` / `*` applied on empty `sourceConfig`; `remote`/`branchGlob` overrides honoured; **none** of `git checkout`/`switch`/`merge`/`reset`/`pull` appear as instructions (only inside the negated constraint recap) |

### Deferred

- **Wiring the four `autoban-*.test.js` into CI.** Two are red at HEAD for causes predating
  this plan. `integration-tests.yml:67–76` states the repo's own convention verbatim —
  *"a permanently-red gate is worse than no gate… Wire them in the same change that greens
  them."* Greening them is outside this plan's scope; the hole is recorded above.
- **A unit test over `buildFetchPlansPrompt`.** The plan's `### Automated Tests` section is
  authoritative (*"No new automated test is added"*) and phrases the forbidden-verb assertion
  as optional. The repo also has no harness that imports `.ts` from a plain-node `src/test/`
  script. The assertions were instead executed ad hoc in this pass (row above) and pass.
- **Part A step 8 (changelog).** The repo has **no** `CHANGELOG.md` (nor any changelog file or
  README changelog section) — there is no target to edit. Step is N/A, not skipped.

### Remaining risks

- **Prompt correctness is unverified end-to-end.** `buildFetchPlansPrompt` was asserted as a
  string; no live `fetch-plans` tick was run against a real remote. The plan's runtime
  checks — copied file appears untracked, nothing staged, `HEAD` unchanged, idempotent
  re-run skips — still require a VSIX install and a manual pass.
- **`Uncertain Assumptions` 2 and 3 remain unconfirmed.** The preset assumes
  `git show <ref>:<path> >` touches only the working tree (it does not write the index) and
  that `for-each-ref` globs match across `/` for nested branch names like `claude/feat/x`.
  The former is high-confidence; the latter is not — if `*` does not cross `/`, a user
  entering `claude/*` will silently scan nothing. The summary file will show
  "0 branches scanned", which is the detectable signature.
- **The preset instructs an agent to run git in the live working tree.** Mitigated by the
  forbidden-verb recap (verified absent as instructions), not enforced by code.
- **Pending sibling plans 3 and 4** still overlap `TaskViewerProvider._schedulerTick`'s
  non-comms branch and the `kanban.html` scheduler panel. Step 9's additive shape is
  preserved, so plan 3 can generalise it without a revert.
- **Orphan DB row** `planAutoFetch.enabled` in the `config` table remains by design
  (migration note); nothing reads it.

## Review Completion Report

Reviewed the implementation against this plan and fixed the defects found. The one material
bug was in `src/services/schedulerPresets.ts`: the summary-file path was emitted as a literal
`${JOB_ID}` placeholder rather than the job's id, so no `fetch-plans` run could ever have
surfaced output through `TaskViewerProvider._startSchedulerOutputCapture` — the exact channel
Part B step 8 and Verified Fact 8 exist to preserve; the builder now takes `job.id` and
interpolates it, and the "(or output it directly)" escape hatch is gone. Also wired
`npm run catalog:check` into CI (only half of it ran before, leaving the regenerated verb
allowlist ungated), refreshed three stale source-list doc comments the plan explicitly
required, tightened shell quoting in the preset, and annotated the orphan `</div>` left by
the modal deletion in `project.html`. Files changed: `schedulerPresets.ts`,
`GlobalIntegrationConfigService.ts`, `KanbanProvider.ts`, `kanban.html`, `project.html`,
`.github/workflows/integration-tests.yml`. Verification: `compile`, `compile-tests`,
`catalog:check`, `parity:check`, `test:contract:drag-guard` and two of four `autoban-*` tests
all pass — the two red `autoban-*` tests were confirmed pre-existing by re-running them
against `4d335c3^`; the four `autoban-*` files are wired into neither `package.json` nor CI,
which is reported above and left for the change that greens them.

