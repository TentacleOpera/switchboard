---
description: "Board button: send the selected plans to the Manager terminal as a targeted autonomous oversight pass — the Column Oversight loop with an explicit plan list as the queue instead of a column."
---

# Board → Manager: "Run Selected Plans" Targeted Pass Button

## Goal

Add a second manager-dispatch button to the kanban board's selected-cards action bar: with N cards selected, one click sends the Project Manager terminal a prompt scoped to *"run exactly these plans autonomously"* — a **targeted oversight pass**. Clipboard fallback when no PM terminal is live (same pattern as the existing Manage launcher).

### Problem / root cause

The manager console (2026-07-10 overhaul) can run an attended sequential pass over a *column* (skill §6 Column Oversight) and the orchestrator can fan out a *feature*, but there is no path from a **board selection** to autonomous execution. The user's real unit of work is often "these 3 cards" — today that requires opening the manager and dictating the list by hand, re-describing what the board already knows. All the machinery exists; only the wiring from selection → manager prompt is missing.

### Existing pieces this composes (verified in source, 2026-07-10)

- **Selection plumbing:** the board already tracks selected cards and posts `sessionIds` arrays (`moveSelected` / `promptSelected` buttons in the column action bar, `src/webview/kanban.html:5073-5079`; funnel comment at `:4789`).
- **Manager delivery:** `TaskViewerProvider._handleDispatchProjectManager()` (line 22178) resolves the PM terminal (registered → open-by-name → clipboard fallback) with send-lock + robust send, and injects a click-time frozen snapshot (workspace root, port) into the prompt. It also pre-flights API-server liveness (refuses when the server is down) — the new handler must inherit this pre-flight. Reuse this; parameterize the prompt.
- **The autonomous runner:** manage skill §6 "Column Oversight — attended sequential pass" (WIP=1, `/kanban/dispatch` per card, mtime completion signal, halt-on-timeout, durable `oversight-state.md`, end-of-pass digest). The targeted pass is the same loop with a different queue source.
- **Per-plan dispatch:** `POST /kanban/dispatch` with `targetColumn` omitted → complexity auto-routing via `resolveRoutedRole` (1–4 intern / 5–6 coder / 7+ lead, custom maps + pair-mode bypass honored).

## Metadata
- **Tags:** feature, ui, frontend, backend
- **Complexity:** 5
- **Project:** switchboard

## User Review Required
None — all decisions resolved by the user (2026-07-10):
- **Placement:** ONE global toolbar button, next to the Create Worktree button (`btn-create-worktree`, `kanban.html:2628`), acting on the cross-column selection. Same `strip-icon-btn` pattern.
- **Icon:** `icons/25-101-150 Sci-Fi Flat icons-125.png` (robot-arms, verified present) — new `{{ICON_MANAGER_PASS}}` placeholder in the icon map (`iconMap` literal opens at `KanbanProvider.ts:10006`). The icon file is the binding spec.
- **Execution order:** board order within the selection.
- **Serialization:** ONE plan in flight at a time, end-to-end — a plan must pass CODE REVIEW before the next starts (see Scope #3a).
- **Planner exception:** planning-agent dispatches run on a separate lane — a new plan may go to a planning agent 2 MINUTES after the previous planner dispatch finishes, overlapping the coding lane (see Scope #3b).

## Scope

### ✅ IN SCOPE
1. **Global toolbar button** beside `btn-create-worktree` (`kanban.html:2628`): `strip-icon-btn` with `<img src="{{ICON_MANAGER_PASS}}">` (new placeholder → `icons/25-101-150 Sci-Fi Flat icons-125.png`, wired in the icon map at `KanbanProvider.ts:~10029`); tooltip "Run selected plans autonomously via the Manager"; enabled when the cross-column selection is non-empty; posts `{type: 'dispatchManagerForSelected', sessionIds, workspaceRoot}`.
2. **Handler + webview case** `dispatchManagerForSelected` (KanbanProvider webview arm → TaskViewerProvider, or directly on TaskViewerProvider mirroring `dispatchProjectManager`): resolves the selected plans **at click time** into a frozen snapshot — for each: planId, title, plan-file path, current column, complexity. Race-free, same pattern as the PROJECT PIN / workspace-root injection: the agent must never re-derive the selection.
3. **Prompt builder** — extends the existing manage prompt: read the manage skill, then run a **targeted pass** over exactly this plan list (embedded as a compact list, board order), autonomous within the pass (no per-card confirmation), halt the entire pass on any failure/timeout (never skip, never re-dispatch), end-of-pass digest. Injects workspace root + port as the Manage launcher does. Delivery via the same PM-terminal-else-clipboard path. Two execution lanes:
   - **3a. Coding lane — WIP 1, review-gated.** One plan end-to-end at a time: dispatch to its coding column (`/kanban/dispatch`, `targetColumn` omitted — complexity routing decides) → wait for the coding completion signal (first plan-file mtime advance after dispatch) → advance the card to CODE REVIEWED (dispatching the reviewer via the same one-call endpoint) → wait for the review completion signal (next mtime advance) → only then start the next plan. "In flight" means anywhere between coding dispatch and review completion.
   - **3b. Planner lane — 2-minute cooldown, overlaps the coding lane.** Selected plans whose next stage is planning (e.g. CREATED → PLAN REVIEWED, planner role) do not queue behind the coding lane. Consecutive planner dispatches require ≥2 minutes after the previous planner dispatch's completion signal; the cooldown timestamp is persisted in `oversight-state.md` (new `plannerLane` field alongside the new per-card lane-stage field).

     > **Superseded:** …alongside the new `stage` per-card field.
     > **Reason:** Manage skill §7 (Project Pipeline) already reserves a `stage` field in `oversight-state.md` — it records the pass-level *pipeline stage* (`SKILL.md:431` "oversight-state.md gains a `stage` field"). Reusing the same name for a per-card coding-vs-review marker creates two fields with one name and different semantics; a resumed agent reading the state file cannot tell which meaning applies.
     > **Replaced with:** Name the per-card field **`cardStage`** (values: `coding` | `review`), keeping `stage` exclusively for §7's pass-level pipeline stage. The §6 "Targeted pass" skill subsection must use `cardStage` throughout.
4. **Skill §6 variant — "Targeted pass":** subsection in `switchboard-manage/SKILL.md` (both copies + mirror): when the dispatch prompt carries an explicit plan list, that list IS the queue (board order) — skip source-column resolution. Documents the two lanes from Scope #3 (review-gated coding WIP 1; planner lane with the 2-minute cooldown) and the per-card `cardStage` tracking in `oversight-state.md` (named to avoid the §7 pass-level `stage` field — see Scope #3b). Every other rule of the pass (preconditions, mtime completion signal, audit log, digest, guardrails) is unchanged. Mixed-column selections are fine: each card enters the appropriate lane from wherever it sits.
5. **Single-pass guard:** the prompt instructs the agent that if `oversight-state.md` shows an in-flight pass, it must offer resume-or-refuse — never start a second concurrent loop.
6. **Catalog regen** (`npm run catalog:generate`) — the new webview verb lands in `protocol-catalog.json` + `verbAllowlist.ts` automatically.

### ⚙️ OUT OF SCOPE
- Any change to the oversight loop mechanics, completion signal, or state-file format — the targeted pass reuses §6 as-is.
- Feature/worktree orchestration (`/kanban/orchestration/dispatch`) — different execution model; this is the worktree-less sequential pass.
- Multi-pass concurrency (parallel targeted passes) — explicitly refused by the single-pass guard.
- MCP surface — Desktop hosts can't run oversight passes (no file writes/polling); no MCP tool for this.

## Implementation Steps
1. `kanban.html`: add the global toolbar button beside `btn-create-worktree` (`:2628`) with the `{{ICON_MANAGER_PASS}}` img; register the placeholder → `icons/25-101-150 Sci-Fi Flat icons-125.png` in the icon map (`KanbanProvider.ts:~10029`); click handler collects the current cross-column selection's `sessionIds` and posts `dispatchManagerForSelected`.
2. Webview arm + handler: resolve each sessionId → plan record (planId, topic, planFile, kanbanColumn, complexity) via the DB the provider already holds; drop unresolvable ids with a warning toast rather than aborting the batch. *(Clarification, verified 2026-07-10: the webview's `selectedCards` Map values already carry `isFeature` (`kanban.html:5782-5787`), so the click handler can pre-filter feature rows webview-side for a correct enabled-count; the extension host remains the authoritative filter and MUST also exclude epic subtasks there — the webview selection payload carries no epic linkage, so epic-subtask exclusion is only possible host-side from the DB.)*
3. Prompt builder in TaskViewerProvider (`_buildTargetedPassPrompt(plans, workspaceRoot, port)`), then reuse the delivery half of `_handleDispatchProjectManager` (extract the terminal-resolution + send/clipboard block into a shared private method to avoid duplication).
4. SKILL.md §6 "Targeted pass" subsection; sync both copies; regenerate `.claude` mirror; update the AGENTS.md/CLAUDE.md `switchboard-manage` row only if the persona summary changes (it shouldn't).
5. `npm run catalog:generate`; gates: `catalog:check`, `parity:check`, `mirror:check`.

## Complexity Audit
### Routine
- Button markup + listener (mirrors existing selected-action buttons).
- Prompt string + skill subsection.
### Complex / Risky
- **Frozen snapshot resolution:** selection must be resolved to plan records at click time in the extension host — the webview's `sessionIds` may include feature rows or epic subtasks; exclude feature rows (`isFeature`) and epic subtasks (own `kanban_column`) exactly as §6's queue rules demand, or the pass dispatches cards a worktree already owns.
- **Delivery-path extraction:** refactoring `_handleDispatchProjectManager`'s terminal-resolution block into a shared method must not change the existing Manage button behavior (send-lock keys, suffixed-name lookup, clipboard fallback message).
- **Prompt size:** large selections make large prompts; cap the embedded list (e.g. 30 plans) and instruct overflow → refuse with "select fewer or run a column pass".
- **Two-lane state tracking:** the coding lane's per-card `cardStage` (coding vs review) and the planner lane's cooldown timestamp both live in `oversight-state.md` and must survive compaction/resume — a resumed pass must know whether the in-flight card is awaiting its coding edit or its review edit, or it will mis-advance. `cardStage` is deliberately NOT named `stage` — §7 Project Pipeline already owns that field name for the pass-level pipeline stage. The lane rules are prose in the skill (agent-enforced), not tool-gated — phrasing must be absolute.

## Edge-Case & Dependency Audit
- **Race conditions:** selection resolved at click time (frozen); the pass re-reads `oversight-state.md` as ground truth per §6 — no new races.
- **No PM terminal:** clipboard fallback inherited; the prompt still contains the frozen plan list so pasting later remains correct (note: stale if the board changed meanwhile — acceptable, same as the existing Manage fallback).
- **Cards already dispatched / in terminal columns:** the snapshot includes current column; the skill's targeted-pass rules tell the agent to skip already-complete cards with a one-line note rather than halt.
- **Dependencies & conflicts:** requires the 2026-07-10 `/kanban/dispatch` + complexity auto-routing + manage-skill §6 (all in the working tree / 1.7.7+ builds). No interaction with autoban timers (pass never arms `/orchestration/start`).

## Dependencies
- `POST /kanban/dispatch` with auto-routing (shipped 2026-07-10).
- Manage skill §6 Column Oversight (shipped 2026-07-10) — the targeted pass is a queue-source variant of it.
- Existing PM-terminal delivery plumbing (`_handleDispatchProjectManager`, `TaskViewerProvider.ts:22178`).
- Soft: sibling plan `promote-project-manager-to-core-role.md` — not a code dependency, but without it a fresh install has no live PM terminal and every click lands on the clipboard fallback; ship the promotion first.

## Adversarial Synthesis
Key risks: (1) the two-lane discipline is prose-enforced — an agent that mis-reads the lane rules can double-dispatch or skip the review gate; mitigated by absolute skill phrasing, the per-card `cardStage` field, and halt-on-anomaly rules. (2) Snapshot resolution must exclude feature rows and epic subtasks host-side or the pass dispatches cards a worktree already owns. (3) Extracting the shared delivery method from `_handleDispatchProjectManager` risks regressing the existing Manage button (send-lock keys, suffixed-name lookup, fallback wording) — mitigated by extracting mechanically and re-verifying the Manage path manually.

## Proposed Changes
### src/webview/kanban.html
- New selected-action button (beside `:5073-5079`) + listener posting `dispatchManagerForSelected` with `sessionIds`.
### src/services/KanbanProvider.ts / src/services/TaskViewerProvider.ts
- Webview arm `dispatchManagerForSelected`; click-time snapshot resolution (feature-row + epic-subtask exclusion); `_buildTargetedPassPrompt`; shared terminal-delivery method extracted from `_handleDispatchProjectManager`.
### .agents/skills/switchboard-manage/SKILL.md (+ .claude mirror)
- §6 subsection "Targeted pass — explicit plan list as the queue" incl. single-pass guard and skip-complete rule.
### protocol-catalog.json + src/generated/verbAllowlist.ts
- Regenerated (new verb).

## Verification Plan
### Automated
- `catalog:check`, `parity:check`, `mirror:check` green after regen.
### Manual / behavioral
- Select 2–3 low/mid-complexity plans in different pre-code columns → click the toolbar button (icons-125 robot-arms icon renders next to Create Worktree) → PM terminal receives a prompt containing exactly those plans (titles + planIds + paths, board order) and the lane rules; the agent runs plan 1 through coding AND code review before plan 2's coding dispatch fires; cards route by complexity (1–4 → INTERN CODED etc.); the pass halts on a deliberately stalled card; digest reports per-plan outcomes.
- Planner lane: include a CREATED card in the selection alongside coding-bound cards → its planner dispatch overlaps the coding lane; a second planner-bound card waits ≥2 minutes after the first planner completion before dispatching (timestamps visible in `oversight-state.md`).
- No PM terminal registered → clipboard fallback with the same frozen list; toast matches the existing Manage fallback wording.
- Selection containing a feature row → feature row excluded from the embedded list with a visible note.
- With an in-flight `oversight-state.md`, clicking the button → agent offers resume-or-refuse, does not start a second loop.

---
**Recommendation:** Complexity 5 → Send to Coder.
