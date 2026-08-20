# Split the Orchestrator Skill by Runtime Entry Point

## Goal

Split the single orchestrator skill into two thin runtime-specific entry points — one for external agents (self-wake required) and one for PTY-resident agents (host-woken) — that both reference a shared logic document containing the orchestration job. The wake contract becomes a fact stated by the entry point, not a conditional the agent must self-resolve.

### Problem analysis — root cause

One skill covers two runtimes with opposite wake contracts:

- **PTY-resident** (Start button, or adopt with a live fleet terminal): the host delivers turn-end notices to the agent's terminal via `ptySendPrompt`. The host IS the wake mechanism. The autoban scheduler can also pop the queue directly without the orchestrator's involvement.
- **External** (adopt without a terminal name, or terminal not live): the host cannot `ptySendPrompt` to the agent. Turn-end notices land in `.switchboard/orchestrator/reports/` (`TaskViewerProvider.ts:11112`). Nobody wakes the agent. It MUST self-wake or the session dies on arrival.

The skill says *"the agent itself is the only thing that wakes it — the server will not"* (`:232-233`). That is **true for external, false for PTY-resident.** A PTY-resident orchestrator IS woken by the server. The skill never tells the PTY agent it's exempt, and never tells the external agent that the claim applies specifically to it.

This is the same failure mode as `switchboard-cloud`: telling an agent what it can't do in prose doesn't work. The agent reads what it wants to do and treats constraints as soft. A conditional branch ("if you're external, self-wake; if you're PTY-resident, you're woken by the host") makes it worse — the agent has to correctly self-identify its runtime, then follow the right branch. Two places to get it wrong instead of one.

The fix is structural, not prose: the entry point the agent was launched with IS the runtime identification. No self-diagnosis, no conditional. Each runsheet states its own wake contract as a fact in the first paragraph. The shared logic never mentions wake at all.

### What is runtime-specific vs shared

**Runtime-specific (moves to the runsheets):**
- `## Self-Wake` section (`:317-352`) — entirely external.
- Step 4 of the confirmation sequence (`:238-244`) — "Start the wake mechanism (self-wake mode only)." External: the full step. Internal: "Skip this step — the host delivers your prompts."
- Lines `:230-236` — "Arming is server-side only... the agent itself is the only thing that wakes it." External only.
- `## Context Is Cleared Every Tick` (`:463-498`) — the section is shared (clearing is required every tick), but the "who does the clearing" paragraph (`:470-478`) splits: the self-wake part ("there is no deliverer to do it for you") moves to the external runsheet; the host-delivered part ("ptySendPrompt's clearBeforePrompt does it") moves to the internal runsheet.
- `## Session Completion` (`:628`) — "Stop the self-wake background script." External only. Internal: no script to stop.

**Shared (stays in the shared logic document):**
- Role & Scope, Advisory Entries, Hard Rules, Port Discovery
- Pre-flight (minus step 4's wake-specific language)
- Handoff/arm decision point, the handoff sequence
- The Tick, Signals, What Is Ready To Go
- On confirmation (minus step 4)
- Context Is Cleared Every Tick (the shared parts: clearing is required, why cleared rather than continuous, the three things that must survive)
- Verify via Git, Transitions You Own, What You Never Do
- Merge-Back, Escalation Boundary, Session Log, Session File

## Metadata

**Complexity:** 4
**Tags:** docs, refactor, feature
**Feature:** 69d427d8-cf87-4977-825b-d3553b869745

## User Review Required

- **Naming.** The user suggested `/switchboard` for external and `/switchboard-internal` for internal, but `/switchboard` is already the launcher workflow (`.agents/workflows/switchboard.md`). This plan uses `switchboard-orchestrator-external` and `switchboard-orchestrator-internal` as skill names. Confirm or rename.
- **The split boundary for "Context Is Cleared Every Tick."** The section is shared (clearing is required) but the mechanism paragraph splits by runtime. The shared logic states the obligation; each runsheet states its mechanism. Review this boundary before coding.

## Complexity Audit

### Routine
- Extracting shared sections from the current SKILL.md into the restructured shared logic document — mechanical cut/paste of everything that isn't wake-specific.
- Writing two short runsheets (20-40 lines each) — wake contract + "the shared orchestration logic follows."
- Updating the AGENTS.md skill table to list the two entry points.

### Complex / Risky
- **Getting the split boundary right.** The Self-Wake section, step 4, and the "who does the clearing" paragraph are runtime-specific. Everything else is shared. An incomplete split leaves the shared logic mentioning wake, which recreates the confusion. A too-aggressive split moves shared orchestration logic into a runsheet, which duplicates it.
- **`buildOrchestratorKickoffPrompt` must route each entry path to the correct runsheet.** The Start button always passes `deliveryMode: 'host'`. The adopt path passes `'host'` when `liveDelivery: true` (terminal name resolved and live), `'self'` when `false`. Getting this wrong sends the external runsheet to a PTY terminal or vice versa — the agent either sets up a redundant wake loop or skips a required one.
- **Test gate sensitivity.** `orchestrator-tick-and-reports-contract.test.js` reads one file (`PERSONA = '.agents/skills/switchboard-orchestrator/SKILL.md'`). After the split, test-gated strings are distributed: most live in the shared logic, but the self-wake assertions (`## Self-Wake`, `there is no deliverer to do it for you`, `you are the deliverer`) move to the external runsheet. The test must read both files or the self-wake gate goes red.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the skill files are static documents. The restructure is a one-time edit. Persona edits serialise (no concurrent edits to the orchestrator skill files while this runs).
- **Security:** No security surface. The split doesn't introduce new API calls, credentials, or data paths.
- **Side Effects:** `buildOrchestratorKickoffPrompt` is called by both `startOrchestratorFromKanban` (Start button → PTY) and `adoptOrchestratorSeat` (HTTP adopt → external or PTY). The change must correctly route each to its runsheet. The combined document (runsheet + shared logic) replaces the current single-file persona in the injected prompt — the agent receives one document, not two.
- **Dependencies & Conflicts:** Subtask 4 (the five-site seat-routed fix) lands inside the shared logic AFTER this restructure. This plan must go first. Persona edits serialise — no concurrent edits to the orchestrator skill files while this runs. The `switchboard-orchestration` skill (the HTTP surface for fleet agents) is separate and unaffected.

## Dependencies

- `seat-routed-queue-4-orchestrator-presents-the-seat-routed-queue.md` — depends on this plan. Subtask 4's five-site fix lands inside the shared logic document this plan creates. This plan goes first; subtask 4 goes second and alone.
- No dependency on subtasks 1-3 — the split is about the skill's structure, not about seat routing. But it's in this feature because subtask 4 depends on it and persona edits serialise.

## Adversarial Synthesis

Key risks: (1) the split boundary is subjective — the "Context Is Cleared Every Tick" section is shared in obligation but split in mechanism, and getting this wrong either duplicates content or leaves wake mentions in the shared logic. (2) `buildOrchestratorKickoffPrompt` routing could send the wrong runsheet to the wrong runtime — mitigated by deriving `deliveryMode` from `liveDelivery`, which the adopt path already computes. (3) the test gate reads one file and the self-wake assertions move to the external runsheet — mitigated by updating the test to read both files. (4) the internal runsheet is so short (host wakes you, skip self-wake, read shared logic) that an agent might skip reading the shared logic — mitigated by the kickoff prompt inlining both, not just referencing the shared logic.

## Implementation

1. **Restructure `.agents/skills/switchboard-orchestrator/SKILL.md` into the shared logic document.** Strip the runtime-specific sections identified above (`## Self-Wake`, step 4 of confirmation, the "arming is server-side only" note, the self-wake half of "Context Is Cleared Every Tick", the "stop the self-wake background script" line in Session Completion). Everything else stays. The document retains its current path — the test gate and `buildOrchestratorKickoffPrompt` already read it there. Add a header note: *"This is the shared orchestration logic. It is injected after a runtime-specific runsheet that states the wake contract. It does not mention wake — wake is a runtime concern, not an orchestration concern."*

2. **Create `.agents/skills/switchboard-orchestrator-external/SKILL.md`** — the external runsheet:
   - **Wake contract (first paragraph):** "You are an external agent. No host process wakes you — turn-end notices land in `.switchboard/orchestrator/reports/` and nobody delivers them to your terminal. You MUST start the self-wake loop before your first tick, or the session dies on arrival. Arming means you stay alive and self-wake."
   - **The Self-Wake section** (moved verbatim from the current skill, `:317-352`).
   - **Step 4 of the confirmation sequence** (moved verbatim, `:238-244`).
   - **The self-wake half of "Context Is Cleared Every Tick"** — the paragraph about "there is no deliverer to do it for you" and "you are the deliverer" (`:470-478`).
   - **Session Completion's self-wake line** — "Stop the self-wake background script" (`:628`).
   - **Reference:** "The shared orchestration logic follows. It covers Hard Rules, the tick, dispatch, handoff, signals, and the session file — everything you do when awake. It does not mention wake; that is this runsheet's job."

3. **Create `.agents/skills/switchboard-orchestrator-internal/SKILL.md`** — the internal runsheet:
   - **Wake contract (first paragraph):** "You are running in a Switchboard PTY terminal. The host wakes you: turn-end notices are delivered to your terminal via `ptySendPrompt`, which clears your context and hands you a fresh prompt each time. You do NOT self-wake — there is no background sleep loop to start, and no script to stop at session end. The autoban scheduler can also pop the queue directly without your involvement."
   - **Step 4 of the confirmation sequence (internal variant):** "Skip the wake mechanism — the host delivers your prompts. Proceed to `## The handoff sequence` or begin ticking."
   - **The host-delivered half of "Context Is Cleared Every Tick"** — the paragraph about `ptySendPrompt`'s `clearBeforePrompt` doing the clearing (`:470-478`, the host half).
   - **Reference:** "The shared orchestration logic follows. It covers Hard Rules, the tick, dispatch, handoff, signals, and the session file — everything you do when awake."

4. **Modify `buildOrchestratorKickoffPrompt`** (`TaskViewerProvider.ts:10836`) to take a `deliveryMode: 'host' | 'self'` parameter and read the appropriate runsheet + the shared logic:
   - Read the runsheet file (external or internal) and the shared logic file.
   - Concatenate: runsheet preamble + shared logic body.
   - The combined document replaces the current `baseLines` (the persona content).
   - The branch-specific instruction (interview / resume / stale-session) is appended after the combined document, unchanged.
   - `startOrchestratorFromKanban` (`:10895`) passes `deliveryMode: 'host'` — it injects into a terminal.
   - `adoptOrchestratorSeat` (`:11087`) passes `deliveryMode: 'host'` when `liveDelivery: true` (terminal name resolved and live), `'self'` when `false`. The `liveDelivery` value is already computed at `:11121`.

5. **Update the test gate** (`src/test/orchestrator-tick-and-reports-contract.test.js`):
   - The `PERSONA` constant (`:55`) reads the shared logic file. Add a second read for the external runsheet: `const EXTERNAL_RUNSHEET = '.agents/skills/switchboard-orchestrator-external/SKILL.md'`.
   - The self-wake assertions (lines 193-217: `## Self-Wake`, `there is no deliverer to do it for you`, `you are the deliverer`) assert against `EXTERNAL_RUNSHEET` instead of `persona`.
   - All other assertions (Hard Rules, the tick, handoff, signals, session file) continue to assert against `persona` (the shared logic).
   - Add one new assertion: the shared logic file does NOT contain `## Self-Wake` or `self-wake` — the split is complete, not partial.
   - Add one new assertion: the internal runsheet states the host-wake contract and does NOT mention self-wake.

6. **Update the AGENTS.md skill table** to list the two entry points:
   - `switchboard-orchestrator-external`: "External orchestrator entry point — self-wake required. For agents outside Switchboard (Claude web, Cursor, etc.) that adopt the orchestrator seat over HTTP."
   - `switchboard-orchestrator-internal`: "PTY-resident orchestrator entry point — host-woken. For the Start orchestrator button and adopted seats with a live terminal."
   - `switchboard-orchestrator`: "Shared orchestration logic — not directly launched. Injected after a runtime-specific runsheet by `buildOrchestratorKickoffPrompt`."

7. **Mirror check — no-op.** Confirmed by subtask 4's earlier search: no `.claude/skills/switchboard-orchestrator/SKILL.md` exists. Grep before declaring done as a safety check, but no mirror write is expected. If a `.claude/` mirror of the shared logic exists, it must be deleted or kept in sync — but none is expected.

## Verification Plan

1. **Shared logic has no wake mentions.** Assert the restructured `.agents/skills/switchboard-orchestrator/SKILL.md` does not contain `## Self-Wake`, `self-wake`, `WAKE`, or `there is no deliverer`. The split is complete.
2. **External runsheet has the self-wake contract.** Assert `switchboard-orchestrator-external/SKILL.md` contains `## Self-Wake`, the wake loop script, `there is no deliverer to do it for you`, and `you are the deliverer`.
3. **Internal runsheet has the host-wake contract.** Assert `switchboard-orchestrator-internal/SKILL.md` states the host wakes the agent via `ptySendPrompt`, says to skip self-wake, and does NOT contain `## Self-Wake` or the wake loop script.
4. **Test gate green.** `orchestrator-tick-and-reports-contract.test.js` passes with the updated file reads. All existing assertions survive (shared logic for orchestration assertions, external runsheet for self-wake assertions).
5. **`buildOrchestratorKickoffPrompt` routing.** Start button → internal runsheet + shared logic. Adopt with live terminal → internal runsheet + shared logic. Adopt without terminal → external runsheet + shared logic. Assert the combined document contains the correct wake contract as its first section.
6. **No content lost.** Every section in the current SKILL.md appears in either the shared logic or one of the runsheets. A manual diff: shared sections in shared logic, runtime-specific sections in the appropriate runsheet, nothing dropped.
7. **Head-paced regression.** A PTY-resident orchestrator on a head-paced team produces exactly today's behaviour — the shared logic is unchanged for orchestration, and the internal runsheet only adds the wake contract (host-woken, skip self-wake) which is what already happens today.

No `npm run compile` dependency for the skill file edits. The `buildOrchestratorKickoffPrompt` change is TypeScript and needs compile clean. Run as the **only** agent stream in the orchestrator skill files while it runs — persona edits serialise.

---

## Completion Report

Split the orchestrator skill into two runtime-specific runsheets plus a shared logic document. Restructured `.agents/skills/switchboard-orchestrator/SKILL.md` into shared logic — stripped `## Self-Wake`, step 4 of confirmation, the "arming is server-side only" note, the self-wake half of "Context Is Cleared Every Tick", the "you are the deliverer" paragraph, the self-wake session model bullet, and the "stop the self-wake background script" line in Session Completion; added header note. Created `.agents/skills/switchboard-orchestrator-external/SKILL.md` (external runsheet: self-wake required, full Self-Wake section, step 4, self-wake clearing mechanism, session-completion stop line) and `.agents/skills/switchboard-orchestrator-internal/SKILL.md` (internal runsheet: host-woken via `ptySendPrompt`, skip step 4, host-delivered clearing). Modified `buildOrchestratorKickoffPrompt` in `TaskViewerProvider.ts` to take `deliveryMode: 'host' | 'self'`, read the appropriate runsheet + shared logic, and concatenate them; `startOrchestratorFromKanban` passes `'host'`, `adoptOrchestratorSeat` passes `'host'` when `liveDelivery` is true else `'self'`. Updated `orchestrator-tick-and-reports-contract.test.js` with `EXTERNAL_RUNSHEET`/`INTERNAL_RUNSHEET` reads, moved self-wake assertions to the external runsheet, added assertions that shared logic has no wake mentions and internal runsheet states host-wake. Updated `AGENTS.md` skill table with the three entries. Test gate green; no `.claude/` mirror exists. No issues encountered.

## Review Findings

Reviewed both runtime runsheets, shared logic, and every `buildOrchestratorKickoffPrompt` caller in `src/services/TaskViewerProvider.ts`. Fixed the MAJOR fail-open path that silently injected shared logic when the selected runtime runsheet was missing; kickoff now returns `no-persona` unless both documents exist. Added a wired contract assertion, and the orchestrator gate, compile-tests, and compile passed. No remaining runtime-routing ambiguity was found.
