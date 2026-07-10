---
description: "Overhaul the /switchboard-manage skill UX: kill the entry wall-of-text, drop the useless recent-features list, replace the flat 6-item action list with a broad categorized menu (Plan / Code / Design & Artifacts / Features & Board / External PM / Automation / Setup & Tour), and eliminate the sidebar 'Guided Setup' button by subsuming onboarding + guided tour into the skill itself."
---

# /switchboard-manage — Skill UX Overhaul

> **Status: PLAN — reviewed & ready to build.** Companion to `a2b-generic-verb-passthrough-vscode-running.md`: that plan hardens and de-shims the verb surface; this plan makes the manager *usable*. **Sequencing: land the passthrough first** — then this plan's `guidedSetup` removal is a two-site delete plus regen, and the menu can be written against the final surface.

## Goal

Make `/switchboard-manage` feel like a real management console instead of a verbose status dump. Three concrete failures the user hit (verified against `.agents/skills/switchboard-manage/SKILL.md` and the live entry output):

1. **Entry is a wall of text.** §1 of the skill prints workspace root, 7 column counts, a feature-name list, a timestamp, and then a 6-item action list — before the user has asked for anything.
2. **The "Recent Features" list is useless noise.** It dumps 8 feature names on entry that the user never asked for and can't act on directly from the list.
3. **The action menu is too narrow.** A flat 6 bullets (browse / filter / write plans / reorganize features / dispatch / automation). It omits the things a manager actually reaches for: **write coding plans, action/advance coding plans, design & artifacts, external project management, and a guided tour / onboarding.** *(Clarification: the skill's §2 endpoint table has ~15 rows, but it is an endpoint map, not a user-facing menu — the flat 6-item list is what the entry report presents. The rewrite replaces both with one categorized menu.)*

4. **No attended column-oversight mode.** The only orchestration paths are "group into features + create worktrees" and the unattended timer engine (`/orchestration/start`). There is no way to tell the manager "progress through each plan in the coder column" — move the oldest card to the next column (firing its configured role prompt), watch for that plan's completion, then advance the next card, and so on. The user should be able to have the agent oversee the board sequentially without arming the automation timer.

Plus a structural change: **eliminate the sidebar "Guided Setup" button and subsume onboarding + a guided tour into this skill**, so there is one entry point (the Manage launcher) that both drives the board *and* onboards a new user — no separate clipboard-prompt button.

### Problem / root cause

The skill was authored as a **status reporter + thin endpoint map**, not as a **menu-driven console**. Its entry protocol optimizes for "prove liveness and dump state," so it front-loads everything (root, all columns, all features, timestamp) as prose. And onboarding lives in a *separate* surface — the `btn-guided-setup` sidebar button (`implementation.html:1536`) that copies staged tutorial prompts to the clipboard (`TaskViewerProvider._handleGuidedSetup`, `:22292`) for the user to paste into a chat. That split means a new user has two disconnected front doors (Guided Setup button vs. Manage launcher) and neither presents a coherent capability menu.

### Current state (verified in source, 2026-07-10 — re-verified at review)

> **Superseded:** Skill (two mirrored copies — update both): `.agents/skills/switchboard-manage/SKILL.md` (distributed source) and `.claude/skills/switchboard-manage/SKILL.md`.
> **Reason:** The copies are **not** mirrors today — they have already drifted. `.claude/`'s frontmatter differs deliberately (`name: switchboard-manage`, `allowed-tools: Bash`, `disable-model-invocation: true` vs. `.agents/`'s `name: Switchboard Manage`), and `.claude/` is missing the Claude Desktop MCP note block (`.agents/` lines 98-104) — apparently accidental drift. A blind file copy would clobber the host-required frontmatter.
> **Replaced with:** Two copies with **per-host frontmatter, shared body**: `.agents/skills/switchboard-manage/SKILL.md` (distributed source) and `.claude/skills/switchboard-manage/SKILL.md` (loaded copy). The rewrite must sync the **body** to both (including restoring the Claude Desktop note block to `.claude/`, which lost it in drift) while preserving each copy's own frontmatter block verbatim.

- Sidebar buttons in `src/webview/implementation.html`:
  - `btn-guided-setup` (`:1536-1537`), listener `:1803-1804` → posts `{type:'guidedSetup'}`, show/hide logic `:2190`.
  - `btn-quick-manage` markup `:1532-1534`, listener `:1799-1800` → posts `{type:'dispatchProjectManager'}` (the Manage launcher).
- `guidedSetup` handling: webview case `TaskViewerProvider.ts:10249-10251` → `_handleGuidedSetup()` (`:22292-22335`, staged clipboard prompts for agent-setup / plans / constitution / advanced-tips); service shim `taskViewerService.ts:222-224` + dispatcher case `TaskViewerProvider.ts:338`. *(Note: the shim + dispatcher case cease to exist once the A2b passthrough lands — see Dependencies & Conflicts.)*
- `hide-guided-setup-toggle` in `src/webview/setup.html` (`:598-601`, listener `:4267`, restore `:4847`).
- Manage launcher: `_handleDispatchProjectManager()` (`:22345+`) sends the manage entry prompt to a Project Manager terminal, else clipboard.
- The doc sections `_handleGuidedSetup` cites (preserve these in the interactive tour): agent setup → `docs/how_to_use_switchboard.md`, `docs/switchboard_user_manual.md` §2, §3; board/plans → user_manual §4, §17; constitution → user_manual §8 + `project.html`; advanced → user_manual §5, §7, §9, §30 + `/improve-plan` & features. (All three doc files verified present.)

## Metadata
- **Tags:** ux, docs, refactor
- **Complexity:** 6
- **Release phase:** Feature A (VS Code minimised remote-control) — usability layer on the Manage console.
- **Relates to:** `switchboard-manage-console-skill.md` (original skill), `switchboard-manage-entry-local-md-and-workspace-scoping.md` (entry protocol), `a2b-generic-verb-passthrough-vscode-running.md` (sibling subtask — the surface this menu drives).

## User Review Required
- **"Artifacts" definition.** Interpreted here as **design/doc outputs** — architectural diagrams (`generate-diagram` skill), PRD (`designDocLink`) and design-system docs (`designSystemDocLink`), and Design-panel/Stitch outputs. Confirm this is the intended scope (vs. host "Artifacts" like claude.ai pages).
- **Guided Setup button removal.** Plan deletes the sidebar `Guided Setup` button entirely and folds onboarding into the Manage skill, leaving the **Manage launcher** as the single front door. **RESOLVED (user decision, 2026-07-10): the launcher label stays "Manage" — do NOT relabel it to "Get Started / Manage" (the user has reverted that relabel repeatedly; re-applying it violates this decision). Tooltip-only update is the accepted form.** Confirm full removal (vs. keeping a hidden fallback).
- **Column-oversight polling defaults.** Completion signal is resolved (matches the system's activity-light contract: first plan-file mtime advance after dispatch — see Scope #8). Remaining tunables to confirm: 60s poll interval; stuck-card threshold defaulting to `switchboard.activityLight.timeoutMs` (10 min) — likely wants raising for plans whose coding legitimately exceeds 10 min.
- Otherwise: None.

## Scope

### ✅ IN SCOPE
1. **Rewrite the entry protocol (§1) to be concise.** Keep liveness + workspace-root resolution. Collapse the board snapshot to **one compact line** (non-empty pre-code columns + a single collapsed terminal-column total), e.g. `Board: CREATED 6 · BACKLOG 31 · CODE REVIEWED 1143 (terminal). Updated <ts>.` **Remove the recent-features list from entry entirely.** No UUIDs. Report → present the menu → stop.
2. **Replace the flat action list with a broad, categorized menu.** Present as a short grouped menu the user picks from:
   - **Plan** — write coding plans (`switchboard-chat` planning → write `.md` → `POST /kanban/plans/import`), improve a plan (`/improve-plan` / `improve-remote-plan`).
   - **Code** — action/advance a coding plan: advance a card to a coding column and fire the role prompt (`POST /kanban/verb/triggerAction` / `promptOnDrop` → `dispatchConfiguredKanbanColumnAction`), focus-code a single plan, dispatch a feature (`/kanban/orchestration/dispatch`).
   - **Design & Artifacts** — Design panel / Stitch verbs (`POST /design/verb/<name>`), generate a diagram (`generate-diagram`), PRD / design-system docs.
   - **Features & Board** — reorganize features (`POST /kanban/features/reconcile`), move/complete cards, browse/filter.
   - **External PM** — ClickUp / Linear (`/api/clickup`, `/api/linear`, `get-tickets`).
   - **Automation** — oversee a column (attended sequential pass — see #8), manage a project start to end (project pipeline — see #10), run one pass / arm / disarm (`/orchestration/start|stop`). If `oversight-state.md` shows an interrupted pass, this category leads with "Resume the interrupted pass" instead.
   - **Setup & Tour** — guided setup (onboarding) + guided tour (feature walkthrough) — see #4.
3. **Setup-state awareness on entry.** Cheaply detect gaps from local files (no heavy API): is a terminal agent registered, do plans exist (`$ROOT/.switchboard/plans/*.md`), does a constitution exist (`getConstitutionPath`). If any gap, surface **Setup & Tour → Guided setup** at the *top* of the menu with a one-line nudge; if all present, it's a normal menu item.
4. **Subsume Guided Setup + Guided Tour into the skill (interactive, no clipboard).** When the user picks guided setup, walk them through the missing step interactively **one step at a time, verifying each before advancing**, reading the same doc sections `_handleGuidedSetup` cited (preserve the mapping in Current State). Guided tour = a feature walkthrough for set-up users. This replaces the staged clipboard prompts.
5. **Remove the sidebar Guided Setup button + its plumbing** (ordering-aware — assumes A2b landed first):
   - Delete `btn-guided-setup` markup + listener + show/hide logic in `implementation.html` (`:1536-1537`, `:1803-1804`, `:2190`).
   - Delete the `hide-guided-setup-toggle` in `setup.html` (`:598-601`, `:4267`, `:4847`) and its persisted setting.
   - Remove the `guidedSetup` webview case (`TaskViewerProvider.ts:10249-10251`) and `_handleGuidedSetup()` (`:22292-22335`). *(The service shim `taskViewerService.ts:222` and dispatcher case `:338` are already deleted wholesale by the A2b passthrough; if this plan somehow runs first, remove those two sites too.)*
   - Keep the Manage launcher button label as **"Manage"** (`btn-quick-manage`, `implementation.html:1532`) — **user decision 2026-07-10 supersedes the original "Get Started / Manage" relabel; never re-apply it** — and update only its `title` tooltip so it reads as the single front door. Keep `_handleDispatchProjectManager` as-is.
6. **Honest per-item capability contract in the menu.**

   > **Superseded:** In the menu, mark items gated on the verb passthrough (Design & Artifacts panel verbs, some plan-actioning, settings) as "available once transport-parity lands" until `a2b-generic-verb-passthrough-vscode-running.md` ships. Do not present an action the skill can't perform.
   > **Reason:** Review verified the verbs are **already reachable today** — every provider's `handleServiceVerb` switch is fully populated with forwarder cases (kanbanService 134, planningService 172, designService 63, setupService 115, taskViewerService 111 forwarders), so `POST /<panel>/verb/<name>` works now for command verbs. Category-level "not yet available" gating flags would be dishonest in the opposite direction. Additionally, the skill's own §6.9 capability-ceiling text ("cannot yet: control most settings, drive/observe terminals, create worktrees…") is stale for the same reason. With A2b sequenced first, the flags are moot anyway.
   > **Replaced with:** The menu's honesty contract is about the **read/write split**, not availability: **command verbs** (move/trigger/dispatch/create/delete/reconcile/complete) are fully actionable now via `POST /<panel>/verb/<name>`; **read verbs** over the generic rail return only `{success:true}` — their data arrives on the WS hub — so for reads the menu routes to the **dedicated GET endpoints** (`/kanban/board`, `/kanban/plans`, `/kanban/plan`, `get-state.js`) or notes WS delivery. Rewrite §6.9's capability ceiling to match: the surface is complete for commands; the remaining ceiling is synchronous read-backs over the verb rail (deferred by A2b's User Review decision) and anything requiring a UI (terminal observation).

7. **Update mirrored skill copies + docs.** Apply the rewrite to both `.agents/` and `.claude/` SKILL.md **bodies**, preserving each copy's own frontmatter (see Current State — they legitimately differ). Restore the Claude Desktop note block to the `.claude/` copy. Update the `switchboard-manage` row in `AGENTS.md`/`CLAUDE.md` if the persona summary changes.
8. **New SKILL.md §: "Column Oversight — attended sequential pass."** The agent-supervised equivalent of single-column autoban: the agent replaces the automation timer with observed completion. Triggered by "progress through each plan in <column>" / "oversee the board". Protocol:
   - **Resolve once:** source column S (the queue) and target column T (the next/coding column whose configured drop action fires the role prompt) — from the user's words, or inferred from board structure and confirmed in one line. Queue = planIds from `$ROOT/.switchboard/kanban-state-<S>.md` in file order, **excluding feature rows and epic subtasks** (epic subtasks carry their own `kanban_column` and must not leak into column sweeps). Report queue size + plan names, then start.
   - **Precondition:** a terminal agent must be registered — otherwise dispatch falls back to clipboard and the loop waits forever. Refuse to start and route to Guided setup instead.
   - **Loop (WIP = 1, oldest first):** (a) move the card to T via the click-equivalent API (`POST /kanban/move` with `workspaceRoot` — persist the move *before* dispatch, per the known move↔dispatch coupling), then fire T's configured prompt (`POST /kanban/verb/promptOnDrop` / `triggerAction`) and record the dispatch timestamp + plan file path; (b) poll for completion cheaply and locally — `stat` the plan file, no API board fetches — in blocking sleep-loop chunks (`until <signal>; do sleep 60; done`, ≤10 min per shell invocation, re-invoke until signal or timeout); (c) completion signal:

     > **Superseded:** (two review iterations) first: completion = board signal OR file quiet-after-write; then: file-based with a 3-5 min quiet grace period and a status-content check, on the assumption that coders append status updates mid-work.
     > **Reason:** Both iterations contradicted the actual system contract, verified in `GlobalPlanWatcherService.ts:1020-1038`: cards move on coding *start* (never finish), the dispatch flow does not write the plan file (`updateDispatchInfoByPlanFile` is SQL-only), and coders write the plan file exactly **once, at the very end** — so the watcher treats "any mtime advance while `dispatched_at` is set" as the agent's completion edit, with no grace period and no content parsing ("No agent-authored text is trusted"). A grace period and a content marker would out-engineer the convention the whole system already relies on.
     > **Replaced with:** completion = **the first plan-file mtime advance after the dispatch timestamp** — a single `stat` comparison, exactly mirroring the activity-light OFF-switch in `GlobalPlanWatcherService`. No grace period, no content check, no board check.

     (d) **timeout** → stop the entire pass, report the stuck card, never re-dispatch, never skip silently. Default the stuck threshold to the system's own staleness window — `switchboard.activityLight.timeoutMs` (default 10 min; the `clearStaleWorkingState` sweep in `GlobalPlanWatcherService` already treats a dispatch with no plan-file edit past this age as stale) — user-tunable upward for long plans; (e) on completion, report one line (plan, duration, landing column) and advance the next card.
   - **Termination:** queue empty → summary report. Any API error or user interruption → stop and report; leave the board as-is; never move a card backward.
   - **Hard guardrails:** never arms `/orchestration/start` — this mode is session-scoped and dies with the conversation (that is its purpose); one card in flight at a time; a card is dispatched at most once per pass.
   - **Durable pass state (context-compaction survival).** A 20-plan pass runs for hours; the supervising conversation will be summarized/compacted mid-pass, and loop state held only in conversation memory gets lossy (classic failure: re-dispatching a finished card or forgetting the in-flight one). The pass therefore persists its state to `$ROOT/.switchboard/oversight-state.md` — queue (remaining planIds/files in order), in-flight card + its dispatch timestamp, completed list with durations, pass parameters (S, T, poll interval, stuck threshold) — **rewritten after every state change** (dispatch, completion, halt). Every wake/poll iteration re-reads this file as ground truth instead of trusting conversation memory; on entry, if the file exists with an in-flight card, the skill offers to resume the pass rather than start a new one.
   - **Durable pass record (audit log).** The state file is working memory, not history — a user who lets a pass run and comes back later needs a record that survives the conversation. On every pass event (each dispatch, each completion, halt/timeout, pass end) the skill **appends** a timestamped entry to `$ROOT/.switchboard/oversight-log.md` (append-only, mirroring the orchestrator's `.switchboard/orchestrator/session-log.md` pattern): pass parameters, per-card outcome + duration, and the halt reason if any. Only after writing the final pass summary to the log is `oversight-state.md` deleted. "What did the last pass do?" is answered by reading the log tail — never from conversation memory.
   - **End-of-pass digest — read the cards, don't copy them.**

     > **Superseded:** per-card content harvest into the log — record `bytesBefore` at dispatch, read the appended delta at completion, and extract status/notes/risks/questions into each log entry.
     > **Reason:** Double-recording. The plan files already ARE the durable record of substance (coders append status updates; reviewers append remaining risks) — copying their content into the log duplicates what persists on disk, and the byte-offset machinery adds state for no benefit a reader needs.
     > **Replaced with:** The log stays **mechanics-only** (which plans were actioned, outcome, duration, halt reason). At pass end — or whenever the user asks "what happened?" — the manager takes the actioned-plan list from the log and **reads those plan files' content** (their trailing status / review sections), then reports the digest: per plan, landing status, key implementation notes, remaining risks, and one aggregated **"Open questions across the pass"** list of unanswered questions the dispatched agents raised. Substance lives in the cards once; the log is just the index of which cards to read.
9. **Hard rule: the manager never codes.** Add to the skill's Hard Rules section: *"You are the manager, never the coder: never edit project source files, never spawn subagents to implement plans, never 'just do it yourself' — regardless of how the request is phrased ('manage this project', 'use your best judgment'). Execution happens only through dispatched terminal agents via the board. Your write surface is plan/feature/doc markdown and the API."* Without this, a capable agent told "manage the project" will default to coding the plans itself or fanning out coding subagents — the exact behavior this console exists to prevent.
10. **Project-pipeline wrapper ("manage this project start to end").** A thin orchestration layer over the Column Oversight primitive, for "manage project <X> from start to end" requests:
   - **Resolve scope once:** filter the board to the named project's plans (kanban-state tags / `GET /kanban/plans`); read the project's feature files' `## Dependencies & sequencing` sections to derive plan order; where no ordering is stated, oldest-first within column.
   - **Walk the pipeline stage by stage:** for each pre-terminal stage transition the board defines (e.g. PLAN REVIEWED → coding column → review column), run the same Column Oversight loop (move-dispatch-watch, WIP 1, same completion signal, same stuck threshold) scoped to the project's cards only.
   - **Same state file** (`oversight-state.md` gains a `stage` field); same termination and guardrails; the manager reports a stage summary between stages and, at the end, the same end-of-pass digest per stage plus a project-level rollup (every plan's final status, accumulated risks, and the aggregated open-questions list across all stages).
   - **Judgment boundary:** the manager may choose *order* within the dependency constraints and may pause to flag a plan that looks unready (missing sections, unresolved User Review items) — it may NOT skip stages, batch-dispatch, or reduce plans' scope. Anything ambiguous → stop and ask.

### ⚙️ OUT OF SCOPE
- The verb-surface refactor (allowlist passthrough, shim deletion, parity gate) → `a2b-generic-verb-passthrough-vscode-running.md`. This plan wires the *menu*; that plan owns the dispatcher.
- The dedicated advance-to-coding endpoint mechanics → covered by the verb rail (`triggerAction`/`promptOnDrop`); this plan only references it as a menu action.
- Changing automation/orchestrator behavior — the menu just routes to the existing `/orchestration/*`.
- Synchronous read-backs over the verb rail (request-id correlation) — deferred by A2b's User Review decision.

## Implementation Steps
1. **SKILL.md §1 rewrite:** concise liveness + one-line board snapshot; delete the feature-list block; add the setup-gap detection (agent / plans / constitution) driving menu ordering. Preserve "report then stop" and the `workspaceRoot=$ROOT` discipline.
2. **SKILL.md §2 rewrite:** replace the flat table with the 7-category menu (#2 above). Each item maps to its endpoint/skill; the read/write contract per #6. Rewrite the §6.9 capability ceiling to match #6.
3. **SKILL.md new §:** "Guided Setup & Tour" — the interactive onboarding protocol (one step at a time, per-gap doc references, verify-before-advance) replacing the clipboard flow.
3b. **SKILL.md new §:** "Column Oversight — attended sequential pass" per Scope #8 (resolve S/T once, WIP-1 loop, mtime completion signal, stuck threshold, guardrails, durable `oversight-state.md`), listed under the Automation menu category.
3c. **SKILL.md new §:** "Project Pipeline — manage a project start to end" per Scope #10 (project-scoped, dependency-ordered, stage-by-stage reuse of the Column Oversight loop, judgment boundary), also under Automation.
3d. **Hard Rules addition:** the manager-never-codes rule per Scope #9.
4. **UI removal:** strip the Guided Setup button + toggle + webview case + `_handleGuidedSetup` per #5; relabel the Manage launcher.
5. **Mirror + docs:** sync the SKILL.md **body** to the second location preserving its frontmatter; update `AGENTS.md`/`CLAUDE.md` row.
6. **Regen + gates:** rerun `npm run catalog:generate` (drops the `guidedSetup` verb from `protocol-catalog.json`; post-A2b this also regenerates `src/generated/verbAllowlist.ts` in the same script); `npm run catalog:check`; `npm run parity:check`.

## Complexity Audit
### Routine
- SKILL.md prose rewrite (entry + menu + tour section).
- Deleting the button markup, listener, toggle, and setting.
### Complex / Risky
- **Verb + catalog removal**: deleting the `guidedSetup` verb touches the webview case, `_handleGuidedSetup`, and `protocol-catalog.json` (and, post-A2b, the generated allowlist) — all must agree or `catalog:check`/`parity:check` fail. Regenerate, don't hand-edit.
- **Read/write honesty in the menu**: read-shaped menu actions must route to dedicated GET endpoints, not the verb rail (which returns bare acks for reads) — get this wrong and the "it says success but nothing came back" frustration returns in a new form.
- **Two skill copies with intentionally different frontmatter**: body-sync only; a blind file copy breaks the `.claude/` host integration (`allowed-tools`, `disable-model-invocation`).
- **Column-oversight completion detection**: single-signal by design — first plan-file mtime advance after dispatch, per the system's own contract (`GlobalPlanWatcherService.ts:1020-1038`: dispatch never writes the plan file; coders write once, at the end). The residual risk is a coder violating the write-once convention, which would fool the board's activity light identically — the oversight pass inherits the system's trust model rather than out-engineering it. The move must persist before the dispatch fires (known move↔dispatch coupling) or the card bounces back and the pass stalls on a phantom.
- **Column-oversight sweep scope**: epic subtasks carry their own `kanban_column` — a naive grep of the source column's state file would dispatch subtasks their feature worktree already owns. The exclusion rule is mandatory, not hygiene.
- **Pass-state durability**: a multi-hour pass outlives the conversation's context window; without `oversight-state.md` re-read on every wake, post-compaction supervision re-dispatches finished cards or orphans the in-flight one. The state file is the loop's memory — conversation memory is advisory only.
- **Manager-never-codes enforcement is prose-only**: the rule lives in the skill, not the tool layer — a sufficiently creative "use your best judgment" request could still tempt an agent into self-execution. Phrasing must be absolute ("never", with the rationale) since there is no code-level gate on what the manager's host lets it edit.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — prose/UI-removal change. The only ordering hazard is with the sibling A2b landing between this plan's authoring and coding; the ordering-aware step #5 covers both orders.
- **Security:** Removing the `guidedSetup` verb shrinks the reachable surface by one — no new exposure. The relabeled launcher posts the same existing `dispatchProjectManager` message.
- **Side Effects:** Removing `hide-guided-setup-toggle` must also drop its persisted `workspaceState`/settings key cleanly so no dead setting lingers. Users who had hidden the button lose nothing (the button itself is gone). The `_handleGuidedSetup` doc-section mapping must be preserved into the new skill § before deletion — it is the only place that curriculum is encoded.
- **Dependencies & Conflicts:** `a2b-generic-verb-passthrough-vscode-running.md` deletes `taskViewerService.ts` and the dispatcher switch wholesale — this plan must NOT list those as its own edit sites when A2b has landed (step #5 is written ordering-aware). Catalog regen after this plan's deletions must include the allowlist regen post-A2b. New-user reachability: with the Guided Setup button gone, the "Manage" launcher must be visible before any setup is complete (verify it is not hidden behind a setup-complete gate — its current markup at `implementation.html:1532` has no such gate). No-PM-terminal fallback: `_handleDispatchProjectManager` already falls back to clipboard — onboarding works before any agent is registered. Setup detection must stay cheap and local (file existence, `grep -c`) — no heavy API calls on entry.

## Dependencies
- **`a2b-generic-verb-passthrough-vscode-running.md`** — sibling subtask, sequenced first. It owns the dispatcher/shim/catalog machinery this plan's verb-removal step touches; landing it first makes step #5 a two-site delete plus regen.
- Existing endpoints for Plan / Features / Automation / External PM (already present) — those menu items are actionable immediately; command verbs across all panels are actionable via the existing verb rail even before A2b (see Scope #6).
- Docs referenced by the interactive tour (`docs/how_to_use_switchboard.md`, `docs/switchboard_user_manual.md`, `project.html`) — all verified present; confirm the cited section anchors (§2, §3, §4, §5, §7, §8, §9, §17, §30) still exist at rewrite time.

## Adversarial Synthesis
Key risks: (1) menu actions that are read-shaped silently returning bare acks if routed through the verb rail — mitigated by routing reads to dedicated GET endpoints in the menu contract; (2) breaking the `.claude/` skill copy's host frontmatter via blind mirroring — mitigated by the body-sync-only rule; (3) losing the onboarding curriculum when `_handleGuidedSetup` is deleted — mitigated by transplanting its doc-section mapping into the new skill § first, and verifying the cited manual anchors still exist.

## Proposed Changes
### .agents/skills/switchboard-manage/SKILL.md and .claude/skills/switchboard-manage/SKILL.md
- §1: concise entry (liveness, one-line board snapshot, no feature list, no UUIDs, setup-gap detection) → menu → stop.
- §2: 7-category menu with per-item endpoint/skill mapping and the read/write contract; §6.9 capability ceiling rewritten (commands complete; reads via GET/WS; no terminal observation).
- New §: "Guided Setup & Tour" — interactive, verify-before-advance, doc-section curriculum transplanted from `_handleGuidedSetup`.
- New §: "Column Oversight — attended sequential pass" — the timer-free single-column loop (Scope #8): resolve source/target columns once, move-then-dispatch oldest card, poll the plan file's mtime for the completion edit (first write after dispatch = done, mirroring the activity-light OFF-switch; cards never move on finish), timeout stops the pass, WIP 1, never arms `/orchestration/start`; pass state persisted to `$ROOT/.switchboard/oversight-state.md` and re-read on every wake (compaction survival, resume-on-entry).
- New §: "Project Pipeline" — project-scoped start-to-end management (Scope #10): dependency-ordered plan sequence from feature files, stage-by-stage Column Oversight reuse, stage summaries, judgment boundary (order yes; skip/batch/rescope no).
- Hard Rules: add the manager-never-codes rule (Scope #9).
- Body synced to both copies; frontmatter preserved per copy; Claude Desktop note restored to `.claude/`.
### src/webview/implementation.html
- Delete `btn-guided-setup` markup (`:1536-1537`), listener (`:1803-1804`), show/hide logic (`:2190`). `btn-quick-manage` (`:1532-1534`): tooltip update only — label stays "Manage" (user decision 2026-07-10; never relabel).
### src/webview/setup.html
- Delete `hide-guided-setup-toggle` (`:598-601`), its listener (`:4267`), restore logic (`:4847`), and the persisted setting key.
### src/services/TaskViewerProvider.ts
- Delete the `guidedSetup` webview case (`:10249-10251`) and `_handleGuidedSetup()` (`:22292-22335`). Keep `_handleDispatchProjectManager` (`:22345+`) unchanged. *(Shim/dispatcher sites only if A2b has not landed.)*
### protocol-catalog.json + src/generated/verbAllowlist.ts (generated)
- Regenerated via `npm run catalog:generate` — `guidedSetup` drops out of both.
### AGENTS.md / CLAUDE.md
- Update the `switchboard-manage` row if the persona summary changes.

## Verification Plan
*(Session directive: no compilation step and no automated test suite in this plan's verification; the coder runs the standard `npm run compile` gate before merge.)*
### Automated
- `npm run catalog:check` green after regenerating `protocol-catalog.json` (no `guidedSetup` verb; allowlist regenerated post-A2b).
- `npm run parity:check` green.
- Grep proves the button is gone: no `btn-guided-setup` / `guidedSetup` / `hide-guided-setup-toggle` references remain in `src/`.
- `diff <(sed '/^---$/,/^---$/d' .agents/skills/switchboard-manage/SKILL.md) <(sed '/^---$/,/^---$/d' .claude/skills/switchboard-manage/SKILL.md)` — bodies identical, frontmatter differs per host.
### Manual / behavioral
- Launch `/switchboard-manage`: entry is a **few lines** (liveness + one-line board snapshot + menu), **no feature list**, no UUIDs, no wall of text.
- The menu shows all 7 categories; read-shaped items route to GET endpoints and return data; command items (e.g. reorganize features, advance a plan, run a pass) execute.
- With no agent/plans/constitution, entry surfaces **Guided setup** at the top; picking it walks the user through interactively (not a clipboard copy).
- The sidebar shows a single "Manage" button (no separate Guided Setup); clicking it launches the skill; it is visible for a fresh, unconfigured workspace.
- Column oversight: with 2-3 real plans queued in a pre-coding column, say "progress through each plan in <column>" — the agent moves the oldest card, the role prompt fires in the terminal agent, the agent waits (visible poll cadence, no busy API traffic), detects completion, advances the next card, and produces a per-card summary; a deliberately stalled card trips the timeout and halts the pass with a report instead of skipping.
- Pass-state resilience: mid-pass, `oversight-state.md` exists and reflects the in-flight card; clear the conversation (or start a new session) and re-enter the skill — it detects the state file and offers to resume with the correct card, not a re-dispatch.
- Pass record: after a completed pass, `oversight-state.md` is gone but `oversight-log.md` holds the actioned-plan list and outcomes; in a **fresh session**, asking "what did the last pass do?" makes the manager read the log for *which* plans, then the plan files for *what happened* — reporting per-plan status, implementation notes, remaining risks, and the aggregated open-questions list.
- Manager-never-codes: say "manage this project from start to end, use your best judgment" against a small project — the agent dispatches through the board sequentially and at no point edits project source or spawns a coding subagent.

## Effort note
One focused session for the SKILL.md rewrite + button/verb removal + catalog regen. Sequenced after the verb passthrough, so no gating-flag follow-up pass is needed.

---
**Recommendation:** Complexity 6 → **Send to Coder**.

## Review Findings
Direct reviewer pass (2026-07-10): the SKILL.md rewrite is complete and faithful (both copies body-identical with per-host frontmatter preserved, Claude Desktop note restored, §5 tour curriculum fully transplanted from `_handleGuidedSetup`, §6 Column Oversight and §7 Project Pipeline match the plan, manager-never-codes is Hard Rule #1), and the webview-side deletions landed — but the review found and fixed two MAJOR gaps: the host-side `guidedSetup` surface had not been removed (TaskViewerProvider webview case + `_handleGuidedSetup` + orphaned `_hasRegisteredTerminalAgent`/`_hasPlans` helpers, the `hideGuidedSetup` setting handlers and hydration pushes, SetupPanelProvider's `getHideGuidedSetupSetting`/`setHideGuidedSetup` cases, the `switchboard.hideGuidedSetup` package.json contribution, and the catalog/allowlist entries). Review fixes: deleted all remaining guidedSetup/hideGuidedSetup code and reran `npm run catalog:generate` (609→606 arms, 521→518 verbs — `guidedSetup`, `getHideGuidedSetupSetting`, `setHideGuidedSetup` dropped from catalog and allowlist). Files changed in review: src/services/TaskViewerProvider.ts, src/services/SetupPanelProvider.ts, package.json, src/webview/implementation.html, protocol-catalog.json, src/generated/verbAllowlist.ts. Validation: `catalog:check`, `parity:check`, `mirror:check` all green; repo-wide grep for `guidedSetup`/`hideGuidedSetup` in src/ is clean; edited files pass a TypeScript parse check (compilation/tests excluded by session directive). Remaining risks: the interactive tour, column-oversight loop, and entry-report behavior are prose contracts verified against source anchors but not exercised live; users with `switchboard.hideGuidedSetup: true` retain a harmless orphaned settings value in their user settings. **Label correction (user decision, 2026-07-10):** the review initially re-applied the plan's "Get Started / Manage" relabel; the user had deliberately kept the label as "Manage" and reverted it — the label stays **"Manage"**, the relabel instruction is struck from this plan, and no future pass should re-apply it.
