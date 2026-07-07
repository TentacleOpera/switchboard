# Author the Orchestrator Persona Workflow (`.agents/workflows/orchestrator.md`)

## Goal

Author the orchestrator agent's persona as a Switchboard workflow at `.agents/workflows/orchestrator.md`, and register it in the mirror manifest so it is discoverable as a skill. This is the agent that the Orchestration mode launches into the orchestrator terminal; it encodes the wake/triage protocol, the verify-via-git rule, the planner-escalation boundary, and the merge-back procedure that subtasks 4 and 5 rely on.

### Problem / background / root cause

Every role in Switchboard is defined by a workflow/skill file under `.agents/` (the single source of truth), which `ClaudeCodeMirrorService` mirrors into `.claude/skills/` for native discovery (`src/services/ClaudeCodeMirrorService.ts:46`, `MIRROR_MANIFEST`). The orchestrator must follow the same pattern rather than hard-coding behaviour in a prompt string, so its behaviour is versioned, editable, and consistent with `improve-plan`, `switchboard-chat`, etc. Subtasks 4 (kickoff) and 5 (wake/triage/merge) are the *engine*; this file is the *behaviour* those hooks invoke, so it must exist as a stable, referenceable artifact.

Two source-of-truth facts shape every edit in this plan (verified in code):

- **The `.claude/` layer is generated.** `generateClaudeMirror` (`ClaudeCodeMirrorService.ts:305`) walks `MIRROR_MANIFEST` (`:46`), reads each source from `.agents/` (`resolveSourceFile`, `:267` — a directory entry reads `<dir>/SKILL.md`, a flat entry reads the `.md` itself), and writes `.claude/skills/<name>/SKILL.md`, tracking what it wrote in `.claude/.switchboard-generated.json` (`:146`, `:375-387`). User-authored `.claude/skills/` dirs are never touched (invariant documented at `:13-16`).
- **CLAUDE.md's protocol block is generated from AGENTS.md.** The scaffolder `ensureProtocolFile` (`src/extension.ts`, around `:3076-3115`) always reads the bundled `AGENTS.md` at the extension root as the single protocol source and writes it verbatim into the workspace `AGENTS.md` managed block, and — with `CLAUDE_PREAMBLE` prepended via `buildManagedInner` (`ClaudeCodeMirrorService.ts:174-193`) — into CLAUDE.md's `<!-- switchboard:claude-protocol:start/end -->` block (`:166-167`). So the registry tables are edited **once, in the repo-root `AGENTS.md`** (the bundled source), and CLAUDE.md follows. Hand-editing CLAUDE.md's managed block is wasted work — the scaffolder rewrites it.

## Metadata
**Tags:** docs, backend, feature
**Complexity:** 4
**Project:** Switchboard

## User Review Required

None. Two judgment calls arose during planning and are decided here rather than deferred:

1. **Mirror invocation mode is `'no-model'`** (explicit `/orchestrator` only), not the originally guessed `'no-user'`. Rationale in Proposed Changes — `'no-user'` (`user-invokable: false`) is the *model-auto-invocable* mode used for read-only info skills, which is the most dangerous possible mode for a side-effecting persona that merges branches and moves cards with the confirm gate off.
2. **The persona's post-merge worktree cleanup step is conditional.** The `worktree_cleanup` skill / `POST /worktree/cleanup` endpoint it would call are designed (in the reviewed merge-prompt-button plan) but not yet in `src/` — the persona instructs "use the skill if present, otherwise record the un-cleaned worktree in the session log and escalate cleanup to the human."

## Complexity Audit

### Routine
- Authoring a markdown workflow file following the established conventions (frontmatter `description:` + `# Title` + sections — `memo.md:1-5`, `improve-plan.md:1-5`; the mirror falls back to the first H1 for the name, `ClaudeCodeMirrorService.ts:236-243`, `:326-328`).
- One array entry appended to `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts:46-144`) — same shape as the ~35 existing entries.
- Two table rows in the repo-root `AGENTS.md` (Workflow Registry table at `AGENTS.md:18-26`; Available Skills table at `:78-109`), from which CLAUDE.md regenerates.

### Complex / Risky
- **The persona text is load-bearing for three sibling engines.** Subtask 4 executes its kickoff section, subtask 5 executes its wake/triage/merge sections, and subtask 1 launches a terminal pointed at it. A vague escalation boundary or a wrong merge order here silently degrades the entire feature — this is a document with the blast radius of code.
- **Invocation-mode taxonomy is easy to get backwards.** In `buildSkillMd` (`:290-295`), `no-model` → `disable-model-invocation: true` and `no-user` → `user-invokable: false` (spelled with a "k", `:293`). The manifest's own family comments (`:69`, `:94`) show side-effecting skills are `no-model` and read-only skills are `no-user`. Picking `no-user` here would let any agent auto-load an unattended-merge persona on a description match.
- **The merge-back text must be command-precise.** Per the merge-prompt design (`.switchboard/plans/merge-prompt-button-agent-driven-worktree-merge.md`), agents must be given explicit `git -C <target checkout> merge <branch>` invocations — prose like "merge into integration" gets executed in the wrong CWD.
- **Dev-repo scaffolder wrinkle.** The *installed* extension rewrites the workspace's AGENTS.md/CLAUDE.md managed blocks from *its own bundled* AGENTS.md when they differ (`ensureProtocolFile` is idempotent against the running version's bundle). Editing this repo's AGENTS.md is still correct — it is the next VSIX's bundled source — but an older installed dev build may transiently revert the managed block until the new build is installed. Expected behaviour, not a bug; noted so the implementer doesn't "fix" it.

## Edge-Case & Dependency Audit

**Race Conditions**
- *None in this subtask's own writes* (three files, all human-authored edits). The persona *text*, however, must encode wake idempotency for subtask 5: every wake re-derives state from git/board/inbox ground truth (no carried in-context state), and inbox handling follows subtask 3's `processed/` discipline so an interrupted wake never double-processes a request.
- *Managed-block regeneration vs. manual edit:* the installed extension can rewrite the repo's AGENTS.md/CLAUDE.md managed blocks from its older bundled copy on activation (see Complexity Audit). The durable edit is the repo AGENTS.md that ships in the next VSIX.

**Security**
- The persona is side-effecting (merges branches, moves cards, creates features unattended). Mitigations: `no-model` invocation so it can never be auto-loaded by description; a frontmatter description that states it is launched by the Orchestration mode and is not for ad-hoc use; and hard rules in the body (coding/review scope only, planner questions escalate, ground truth over self-report).
- Board operations go through the localhost-only LocalApiServer (`POST /kanban/move` at `LocalApiServer.ts:1344`, `/kanban/feature*` at `:1346-1354`) via `move-card.js`, which prefers the API path and treats direct-DB as recovery-only. The persona forbids raw SQL writes outright.

**Side Effects**
- Mirror regeneration writes `.claude/skills/orchestrator/SKILL.md` and updates `.claude/.switchboard-generated.json`; no new `settings.json` allow entries are needed (`Bash(node *)`, `Bash(curl *)`, `Bash(source *)`, `Bash(sqlite3 *)` already ship in `SWITCHBOARD_ALLOW_ENTRIES`, `ClaudeCodeMirrorService.ts:151-157` — everything the persona shells out to is covered).
- A missing source file never fails the mirror — entries whose source is absent are skipped (`:321-323`) — so landing the manifest entry before/after the workflow file is order-safe.
- The dev repo's `.claude/skills/` will not show the new skill until a VSIX built with the updated `MIRROR_MANIFEST` runs; harmless, because the engine (subtasks 1/5) reads `.agents/workflows/orchestrator.md` directly.

**Dependencies & Conflicts**
- **Subtask 3 defines the paths this persona hard-codes**: `.switchboard/orchestrator/inbox/` (+ `processed/`), the request field contract (`from`, `stage`, `type`, `planId`/`feature`, `body`, `worktreePath`), and `.switchboard/orchestrator/session-log.md`. Author this workflow after — or in lockstep with — subtask 3 so the strings match exactly.
- **Subtask 1** (`startOrchestrator` handler) launches the terminal that consumes this file; **subtask 4** executes the kickoff section; **subtask 5** re-invokes the wake section each tick.
- **Kickoff reuses `group-into-features`** (`.agents/skills/group-into-features/SKILL.md`) — SCAN (`kanban-board.md`, planId comments) → READ → PROPOSE → EXECUTE via `create-feature.js`, with step 4 CONFIRM explicitly skipped in this mode; the skill itself is not modified by this plan.
- **Merge-back's cleanup step** depends on the not-yet-implemented `worktree_cleanup` skill + `POST /worktree/cleanup` endpoint (designed in the merge-prompt-button plan). The persona references them conditionally (see User Review Required #2) so this plan does not block on that one.

## Dependencies

None in `sess_` form (no known session IDs apply). Sibling ordering within the feature:

- **After / alongside subtask 3** (`orchestration-3-agent-request-channel-and-session-log.md`) — the inbox and session-log convention must be fixed before the persona's Comms section can name exact paths and fields.
- **Consumed by subtask 4** (`orchestration-4-kickoff-group-and-fan-out.md`) and **subtask 5** (`orchestration-5-wake-triage-and-merge-back.md`) — they execute the kickoff and wake sections respectively.
- **Launched by subtask 1** (`orchestration-1-automation-mode-foundation.md`) — its `startOrchestrator` handler injects the prompt pointing at this file (a placeholder prompt is acceptable there until this lands).
- **Soft dependency:** the merge-prompt-button plan's `worktree_cleanup` skill/endpoint for post-merge cleanup (conditional reference; escalate to human if absent).
- **Co-requisite contract with subtask 5:** the wake/termination marker protocol (`last-wake-complete` touched as the persona's final act each wake; `batch-complete` written on batch end and consumed by the engine, which alone stops the loop) is defined in `orchestration-5-wake-triage-and-merge-back.md` and must be mirrored verbatim in this persona's Wake Protocol and Batch Completion sections.

## Adversarial Synthesis

The three real risks are: (1) picking the wrong mirror invocation mode — `no-user` reads like "not user-facing" but actually means *model-auto-invocable*, the worst mode for an unattended-merge persona; (2) authoring the merge-back and comms sections against paths/contracts that subtask 3 and the merge-prompt plan haven't frozen yet, leaving the persona referencing files that don't exist; and (3) registering the tables in the generated CLAUDE.md instead of the bundled AGENTS.md source, where the scaffolder will silently revert the edit. Mitigations: `invocation: 'no-model'` with a defensive description, conditional cleanup wording plus lockstep authoring with subtask 3, and all table edits going to repo-root AGENTS.md only.

## Proposed Changes

### `.agents/workflows/orchestrator.md` (new file)

**Context.** Workflow files are flat markdown with a minimal YAML frontmatter carrying `description:` (parsed by `parseSource`, `ClaudeCodeMirrorService.ts:206-227`; quotes stripped `:229-234`), followed by a `# Title` (the H1 becomes the skill name fallback, `:236-243`) and numbered/H2 sections. `memo.md` demonstrates the hard-rules + protocol-steps style; `improve-plan.md` demonstrates the constraints-first style. The orchestrator persona combines both: hard rules up top, then two executable protocols (kickoff, wake).

**Logic — content contract (preserved from the original plan).** The workflow must specify:

- **Role & scope.** The orchestrator manages a batch through **coding and code review only**. It never automates planning; planner-stage questions escalate to the human.
- **Kickoff protocol** (consumed by subtask 4): run `group-into-features` end-to-end **without the confirm gate**, then sweep all remaining standalone plans into a single **`Miscellaneous`** feature so nothing is ungrouped; ensure each feature has worktrees + terminals; dispatch each feature's subtasks by stage; then stop and sleep.
- **Wake/triage protocol** (consumed by subtask 5): on each system wake, (1) read the request inbox, (2) **verify real progress from git and board state — never trust an agent's self-reported "done"**, (3) write a triage summary to the session log, (4) act: advance a stage, dispatch a research agent for a well-formed request, escalate planner-stage or unresolvable items to the human, or run merge-back for a completed feature.
- **Verify-via-git rule.** Define the concrete signals: branch ahead of base, commits present, tests where applicable, card column. Self-report is a nudge, not status of record.
- **Merge-back procedure.** Feature by feature, following the agent-driven merge pattern (subtask → feature integration branch → main), resolving conflicts as it goes; then request worktree cleanup. Never a bulk `git merge`.
- **Escalation boundary.** Exactly what goes to the human (planner questions, unresolvable conflicts, stalled agents) vs. what the orchestrator handles itself.
- **Comms.** How to read `.switchboard/orchestrator/inbox/` and append to `.switchboard/orchestrator/session-log.md` (defined in subtask 3).

**Implementation — concrete file skeleton** (section-by-section; the implementer fleshes out prose but keeps this structure and these rules):

```markdown
---
description: Orchestrator persona for the Orchestration automation mode — system-woken
  manager that batches plans into features, fans out to per-feature worktrees, and on
  each wake triages the inbox, verifies progress from git/board ground truth, and merges
  completed features back. Launched by the AUTOMATION tab's Start orchestrator and
  re-invoked by the autoban tick; not for ad-hoc invocation.
---

# Orchestrator

## Role & Scope
- You manage one batch through CODING and CODE REVIEW only. You never automate
  planning; planner-stage questions/warnings escalate to the human via the session log.
- You are invoked twice-shaped: once at kickoff (Start orchestrator), then repeatedly
  by system wakes. Detect which by whether `.switchboard/orchestrator/session-log.md`
  already has a kickoff entry for the current batch.

## Hard Rules
1. **System-woken only.** Never set timers, poll in a loop, sleep-wait, or schedule
   your own next wake. Finish the protocol for this invocation and stop; the system
   re-invokes you on the next autoban interval tick.
2. **Ground truth over self-report.** An agent saying "done" (in a terminal, commit
   message, or inbox note) is a nudge to verify, never status of record. Judge progress
   only from git and board state (see Verify via Git).
3. **Scope boundary.** Coding + code review only. Planner-stage items escalate.
4. **Board ops via the API path only.** Move cards with
   `node .agents/skills/kanban_operations/move-card.js <planId|session_id> <COLUMN>`
   (routes through the extension's `POST /kanban/move`, which cascades features and
   syncs Linear/ClickUp). NEVER write the kanban DB with sqlite directly; read-only
   SQL via the query_switchboard_kanban skill is allowed for verification.
5. **No confirmation gates.** You run unattended. Never emit "Are you sure?" prompts,
   and never block waiting for human approval mid-protocol — escalation is written to
   the session log, then you move on.
6. **Worktree messaging is one line.** When dispatching an agent into a worktree, the
   only worktree context you give is: "You're in a worktree at <path>, an isolated
   sibling checkout." No safety-session blocks, no corruption warnings.

## Kickoff Protocol (first invocation of a batch)
1. SCAN the board (CREATED + PLAN REVIEWED, honouring the active project filter) per
   the group-into-features skill.
2. Run group-into-features SCAN → READ PLAN BODIES → PROPOSE → EXECUTE, SKIPPING the
   step-4 CONFIRM gate (this mode's explicit, documented exception to that skill's
   confirm rule). Use planId values from the board-snapshot comments.
3. Sweep every remaining standalone plan into one `Miscellaneous` feature via
   create-feature.js so nothing is left ungrouped.
4. Confirm each feature has its worktrees + terminals (the system auto-creates them);
   if missing after a bounded re-check, record it in the session log and continue with
   the features that are ready.
5. Dispatch each feature's subtasks into their terminals by stage (code first, then
   review as coding completes).
6. Append a kickoff entry to the session log (features created, dispatch map, anything
   skipped/escalated). Then STOP. Do not wait, poll, or self-schedule.

## Wake Protocol (every system wake)
1. **Drain the inbox** (`.switchboard/orchestrator/inbox/`): read pending request
   files; after handling each one, move it to `inbox/processed/` (idempotent — a file
   already in processed/ is never re-handled).
2. **Verify progress** for every in-flight feature/subtask via Verify via Git below.
3. **Write the triage summary** to `.switchboard/orchestrator/session-log.md` (dated:
   what was read, what was verified, actions taken, escalations).
4. **Act**, in priority order: advance verified-complete subtasks to their next stage;
   dispatch a research agent for a well-formed research request; escalate planner-stage
   or unresolvable items; run Merge-Back for any feature whose subtasks are all coded
   AND reviewed.
5. **Report completion, then STOP.** As the final act of every wake, append the summary
   line to the session log AND touch `.switchboard/orchestrator/last-wake-complete` —
   the engine's single-flight gate reads only that marker's mtime (contract defined in
   subtask 5; mirror it verbatim). The system decides when you wake next.

## Verify via Git (status of record)
- Commits ahead of base: `git -C <worktree> rev-list --count <base>..HEAD` > 0.
- Working tree state: `git -C <worktree> status --porcelain` (dirty tree = still working
  or abandoned mid-edit — do not advance).
- Card column (read-only kanban query) matches the claimed stage.
- Tests where the plan specifies them.
- Stall detection: no new commits AND no inbox traffic across two consecutive wakes →
  escalate as a stalled agent.

## Merge-Back (one feature at a time)
1. Pick ONE completed feature. Never bulk-merge several at once.
2. For each subtask branch: `git -C <integration worktree path> merge <subtask branch>`;
   resolve conflicts in the integration checkout (keep both sides' intent; prefer the
   incoming feature work where they overlap); commit the merge.
3. When all subtasks are in: `git -C <main checkout path> merge <integration branch>`,
   resolving conflicts the same way.
   If a conflict cannot be resolved coherently at either level: run `git merge --abort`
   FIRST — never leave MERGE_HEAD or conflict markers in a shared checkout — then
   escalate. (Abort-eject-escalate; the unattended standard, confirmed by research
   2026-07-07: GitHub merge queues, Renovate, Bors-NG, and Gerrit all abort rather
   than leave a conflicted tree. This deliberately diverges from the attended
   merge-prompt guidance of "never abort without asking the user".)
4. Verify the merged result (build/tests as applicable), then request worktree cleanup:
   use the worktree_cleanup skill (`.agents/skills/worktree_cleanup.md`) if it exists;
   otherwise record the un-cleaned worktrees in the session log for the human.
5. Log the merge in the session log; only then consider the next completed feature.

## Escalation Boundary
- **To the human (via session log):** planner-stage questions/warnings, merge conflicts
  you cannot resolve coherently (after `git merge --abort` — see Merge-Back), stalled
  agents, malformed/ambiguous inbox requests, missing worktrees/terminals that block
  a feature.
- **Handled yourself:** stage advancement, research-agent dispatch for well-formed
  requests, ordinary merge conflicts, re-dispatching an agent whose terminal died.

## Comms Reference
- Inbox: one file per request in `.switchboard/orchestrator/inbox/`; fields per the
  request contract (from, stage, type, planId/feature, body, worktreePath). Handled
  files move to `inbox/processed/`.
- Session log: `.switchboard/orchestrator/session-log.md`, append-only, dated entries.
  This is the human's "what happened overnight" record — write it for them.

## Batch Completion
When every feature is merged or escalated: write a final session-log summary (merged
features, escalations outstanding) and create `.switchboard/orchestrator/batch-complete`.
The ENGINE detects that marker and stops the loop on its next tick — you never touch
automation state yourself. Do not restart or re-group.
```

**Edge cases.**
- The exact inbox filename pattern and field contract come from subtask 3 — if its plan changes the paths, this file changes with it (lockstep authoring).
- The kickoff SCAN follows `group-into-features`' documented input (`.switchboard/kanban-board.md` + planId comments); the wake-time *verification* deliberately does not trust that snapshot and uses read-only kanban queries + git instead.
- Keep the persona aligned with the "system-woken, not self-scheduling" decision — the workflow must not instruct the agent to set its own timers (Hard Rule 1 encodes this).
- The workflow references file paths and skills defined in sibling subtasks; note the dependency so it is authored after (or alongside) subtask 3's inbox/log convention is fixed.

### `src/services/ClaudeCodeMirrorService.ts` — `MIRROR_MANIFEST` entry

**Context.** `MIRROR_MANIFEST: MirrorEntry[]` at `:46`; entry shape at `:27-38` — `{ source: string; name: string; invocation: SkillInvocation; allowedTools?: string; descriptionFallback?: string }`, with `SkillInvocation = 'default' | 'no-model' | 'no-user'` (`:25`). Mode semantics in `buildSkillMd` (`:281-298`): `default` = slash + model-auto; `no-model` = adds `disable-model-invocation: true` (`:290-291`, "explicit /name only" — the side-effecting proxy family, `:69-88`); `no-user` = adds `user-invokable: false` (`:292-295`, the read-only/model-auto family, `:94-127`). Workflows currently all mirror as `default` (`:47-57`).

**Implementation.** Add to the workflows block (after `:57`, keeping the family grouping):

```ts
// /orchestrator — Orchestration-mode persona. Side-effecting (unattended grouping,
// dispatch, merges): explicit /orchestrator or system launch ONLY — never model-auto.
{ source: 'workflows/orchestrator.md', name: 'orchestrator', invocation: 'no-model', allowedTools: 'Bash' },
```

The original plan's registration intent is preserved: *"Add an entry to `MIRROR_MANIFEST` in `ClaudeCodeMirrorService.ts` for `workflows/orchestrator.md` → skill name `orchestrator` (choose the appropriate invocation mode — likely `no-user`/model-launched, since the mode launches it rather than the user typing `/orchestrator`)."* — with the mode guess **corrected**: the mode's launch path injects a prompt that reads the `.agents/` file directly (mirror modes only govern *discovery*), and `no-user` would make the persona *model-auto-invocable* by description match, which is exactly wrong for a side-effecting persona. `no-model` matches the manifest's own taxonomy for side-effecting skills and still allows a human to run `/orchestrator` deliberately (useful for a manual resume/debug wake). `allowedTools: 'Bash'` mirrors the other shell-out skills (`move-card.js`, `git`, `sqlite3` reads).

**Edge cases.** Entry lands safely before or after the workflow file exists (missing source → skipped, `:321-323`). The dev repo's `.claude/skills/orchestrator/` appears only once a build with the new manifest runs — the engine does not depend on it (it reads `.agents/workflows/orchestrator.md` directly).

### `AGENTS.md` (repo root — the bundled protocol source; CLAUDE.md regenerates)

**Context.** The Workflow Registry table is at `AGENTS.md:18-26`; the Available Skills table at `:78-109`. This file is the extension's bundled protocol source: `ensureProtocolFile` (`src/extension.ts` ~`:3076-3115`) copies it into workspace `AGENTS.md` and (with `CLAUDE_PREAMBLE`) into CLAUDE.md's managed block. Per the original plan: *"Add it to the skills/workflow tables in `CLAUDE.md`/`AGENTS.md` for discoverability, consistent with the other entries"* — operationally that means **edit AGENTS.md only**; both targets regenerate from it.

**Implementation.**
- Workflow Registry row (append after the `/memo` row at `:26`):

  | `/orchestrator` *(system-launched)* | **`orchestrator.md`** | Orchestration-mode batch manager — system-woken persona that groups plans into features (confirm gate off + `Miscellaneous` sweep), fans out to per-feature worktrees, then on each wake triages the inbox, verifies progress via git/board ground truth, and merges features back one at a time. Launched by the AUTOMATION tab's Start orchestrator; not for ad-hoc use. |

- Available Skills row (append near the workflow-derived skills, e.g. after `improve-remote-plan` at `:108`):

  | `orchestrator` | Launched by the Orchestration automation mode (Start orchestrator button / autoban wake). Do NOT invoke ad hoc — side-effecting unattended batch manager (grouping, dispatch, merge-back). Manual `/orchestrator` is for deliberate resume/debug only. |

- Also reconcile the existing kanban prose at AGENTS.md ~`:72` ("Execution agents must NEVER attempt to update kanban columns…") with one added sentence: the **orchestrator persona is the sanctioned exception** — it moves cards via `move-card.js`/`POST /kanban/move` (the API path a human's click takes), never via SQL. Without this sentence the protocol file forbids the very behaviour the persona mandates.

**Edge cases.** Do not touch CLAUDE.md's managed block by hand. Expect the *installed* dev extension to transiently rewrite the repo's managed blocks from its older bundle until a build containing this change is installed — do not "fix" that by re-editing CLAUDE.md.

## Verification Plan

### Manual Verification
- **Format conformance:** `orchestrator.md` has parseable frontmatter (single-line `description:` — `parseSource` at `ClaudeCodeMirrorService.ts:206-227` only handles simple `key: value` lines, so keep the YAML flat) and an H1; visually matches `memo.md` / `improve-plan.md` conventions.
- **Mirror regeneration:** with a dev build running, trigger the mirror and confirm `.claude/skills/orchestrator/SKILL.md` is generated with `disable-model-invocation: true` and `allowed-tools: Bash` in its frontmatter, is listed in `.claude/.switchboard-generated.json`, and that no user-authored `.claude/skills/` dir was modified. (Preserved from the original plan: "Mirror regeneration picks up the new workflow into `.claude/skills/orchestrator/SKILL.md` without touching user-authored skills.")
- **Dry-read review:** a fresh agent given only `.agents/workflows/orchestrator.md` can state, unambiguously: the kickoff steps in order, what it does on a wake, the concrete git signals it checks, the exact merge command shape (`git -C <target> merge <branch>`, subtask → integration → main), and which situations escalate vs. get handled. (Preserved from the original plan: "A dry read of the workflow by an agent yields an unambiguous kickoff and wake/triage procedure (reviewed manually).")
- **Negative checks on the persona text:** contains no timer/sleep/self-scheduling instruction; no confirm-gate language; no multi-line worktree safety boilerplate (one-line worktree message only); no `sqlite3` write instruction; card moves only via `move-card.js`/API.
- **Registry rows:** the two AGENTS.md rows render correctly in the markdown tables; the kanban-prose exception sentence reads consistently with the existing paragraph.

### Automated Tests *(deferred per session directive — described, not run)*
- A manifest test asserting the `orchestrator` entry exists with `invocation: 'no-model'` and `source: 'workflows/orchestrator.md'`, and that `generateClaudeMirror` on a fixture workspace emits `disable-model-invocation: true` frontmatter for it.
- A lint-style content test on `.agents/workflows/orchestrator.md`: frontmatter parses via the same `parseSource` logic; body contains the required section headings (Role & Scope, Hard Rules, Kickoff Protocol, Wake Protocol, Verify via Git, Merge-Back, Escalation Boundary, Comms Reference); body matches none of the forbidden patterns (`setInterval|sleep loop|confirm\(|window.confirm|Are you sure`).

## Out of scope

- The engine hooks that launch and wake the orchestrator (subtasks 1, 4, 5) and the inbox/log implementation (subtask 3). This subtask is the persona document + its registration.

## Uncertain Assumptions

- **Subtask 1's launch-prompt mechanics.** Assumed the `startOrchestrator` handler injects a short prompt telling the terminal agent to *read* `.agents/workflows/orchestrator.md` (the Suggest Features button precedent), rather than inlining the whole body. The persona is written to be self-contained either way, but the kickoff-vs-wake detection heuristic (session-log presence) should be revisited if subtask 1 instead passes an explicit `mode=kickoff|wake` argument in the prompt.
- **`.switchboard/kanban-board.md` snapshot freshness during unattended runs.** The kickoff SCAN follows `group-into-features`' documented reliance on that snapshot; its regeneration cadence when no human is driving the board was not verified in code. The plan hedges by routing all *wake-time* verification through read-only kanban queries + git, but if the snapshot can be stale at kickoff, the kickoff SCAN should also fall back to a direct read-only query.

The user was advised to run web research (or a targeted code-read of the snapshot writer and subtask 1's launch handler once drafted) to confirm these before implementation.

---

**Recommendation:** Complexity 4 → **Send to Coder.** The code delta is trivial (one manifest entry, two table rows), but the persona document is load-bearing protocol consumed by three sibling engines and must be authored with command-level precision.

**Stage Complete:** PLAN REVIEWED

## Review Findings

Reviewed against commit `fcd9846`. No changes required. `.agents/workflows/orchestrator.md` is faithful to the content contract and — critically — its marker protocol matches the engine exactly: Wake Protocol step 5 touches `last-wake-complete` (ISO content) and Batch Completion creates `batch-complete`, which are precisely the files subtask 5's tick reads/gates on. The `MIRROR_MANIFEST` entry uses `invocation:'no-model'` (not the dangerous `no-user`) with `allowedTools:'Bash'`, and the `AGENTS.md` registry rows + the kanban-prose "sanctioned exception" sentence landed as specified (CLAUDE.md regenerates from AGENTS.md — correctly left untouched). Validation: static review + cross-check against the engine's marker reads. Remaining risk: the merge-back cleanup step references the `worktree_cleanup` skill conditionally, which is fine since that skill is now shipped.
