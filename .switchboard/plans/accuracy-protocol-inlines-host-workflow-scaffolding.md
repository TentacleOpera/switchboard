# The Accuracy Protocol Inlines Host-Workflow Scaffolding a Coder Cannot Use

kanbanColumn: CREATED

## Goal

When the accuracy protocol is embedded into a dispatched coder's prompt, it carries the steps and nothing else. No slash command, no artifact system, no delegation vocabulary, no phase state machine.

### Problem analysis

`accuracy` is stored in `control_plane` with `delivery=inline` and a body of **4,732 bytes**, and `buildAccuracyDirective` (`protocolDirectives.ts:148`) embeds that body verbatim into the prompt. Every dispatched coder with Accuracy Mode on receives all of it.

Most of it is scaffolding from the host workflow it used to be, and is either meaningless or actively wrong in an inlined prompt:

**`## File Creation Rules`** — *"always use `IsArtifact: false` to prevent path validation errors."* This one is **real and must not be cut**. `IsArtifact` is an Antigravity tool parameter and the rule is load-bearing there — an Antigravity seat that omits it hits path validation errors writing into `.switchboard/`. It is noise only for seats that have no such parameter (Claude Code, Devin).

So this section is what proves the trim has to be **host-conditional, not a deletion**: one static body is dispatched to seats with different tool vocabularies, and no single string is correct for all of them. Everything listed below it, by contrast, is wrong on *every* host including Antigravity, because it describes a conversational workflow that no dispatched seat is in.

**`## No-Artifact Rule`** — *"`/accuracy` is a solo, in-conversation workflow. Do NOT write out artifacts to disk."* Names a slash command the agent did not invoke and cannot invoke, to forbid an artifact system it does not have.

**`## Quick Reference` — *"Valid Actions: None (solo workflow, no cross-agent delegation)"*** — "Valid Actions" is the `send_message` vocabulary, which `CLAUDE.md` states is Antigravity-only and to be ignored. The section exists to say the list is empty.

**Step 1** — *"Activate accuracy mode via the `/accuracy` command."* The agent did not activate anything; the body was inlined into its prompt by the dispatcher. The first instruction it reads describes something that already happened, by a mechanism it has no access to.

**MCP reference** — the same step mentions MCP tool availability. Switchboard removed its MCP server (confirmed: `extension.ts:894-928` kills orphaned MCP processes and scrubs stale MCP config entries — "The MCP server was removed").

**`## Final-Phase Recovery Rule`** — *"use the Kanban UI to manually move the card."* A dispatched agent has no UI, and the control plane forbids agents moving cards. It also carries phase-completion bookkeeping — *"Mark Phase 5 complete in your reply. The workflow automatically terminates when all phases are done"* — describing a state machine that does not exist on this path.

**Why it matters beyond tidiness.** Inlined bodies are re-presented in full on every dispatch that enables the mode, so this is paid per dispatch, per seat. It also instructs the coder to do impossible things, which is worse than saying nothing: an agent that looks for a `/accuracy` command it cannot invoke is spending turns on scaffolding rather than the task.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, backend, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Editing one body string in `src/services/bundledProtocols.ts` (the seed source for the `accuracy` `control_plane` row).
- Removing four sections that are orphaned host-workflow scaffolding (`No-Artifact Rule`, `Quick Reference`, `Final-Phase Recovery Rule`, the `/accuracy` activation line, and the MCP reference).
- Renumbering the surviving steps (old 2–6 become 1–5 once the old "Start" step is dropped).
- Recomputing the `contentHash` field (see Complex/Risky — the one non-trivial step).

### Complex / Risky

- **The `contentHash` must be recomputed or the trim does not ship.** `seedControlPlane` (`KanbanDatabase.ts:6804`) compares `content_hash` to decide whether to update an existing row; a changed body with a stale hash leaves the DB row at the old 4,732 bytes forever, so every verification passes against the *new* source while the *dispatched* prompt carries the *old* body. The hash is `sha256(body, utf8)` (verified: the stored hash matches a fresh sha256 of the body). This is a silent-failure fallback — the exact class of bug the project rules exist to prevent.
- **`bundledProtocols.ts` says "Auto-generated. Do not edit directly" but no generator was ever shipped.** The reconnect plan's Change 1 (a `scripts/generate-bundled-protocols.js` generator + drift gate) was *not* shipped — its completion report lists it under "Changes not yet shipped." So the implementer must edit `bundledProtocols.ts` by hand despite the header. Do not block on the missing generator.
- **Over-cutting is the silent failure on the other side.** The trim must remove the *host* scaffolding and keep the *work* (the five phases). Cutting a phase to "tighten" the body defeats the goal while passing a size check.

## Edge-Case & Dependency Audit

1. **The `materialize` protocols may legitimately keep some of this.** A protocol read from a file by an agent that invoked it by name has a different context from one pasted into a prompt. Do not apply the same cut blindly to the 18 materialised rows.
2. **`buildAccuracyDirective` handles the unresolved case correctly** — it emits *"resolve via `switchboard api GET /protocol/accuracy`"* rather than a path (`protocolDirectives.ts:85`). That behaviour stays.
3. **Changing a `control_plane` row changes what every future dispatch carries.** The row is edited by changing `bundledProtocols.ts` (body + `contentHash`) and letting the next host startup reseed via `ProtocolService.seedProtocols` → `db.seedControlPlane`. `seedControlPlane` preserves an existing `override_body` via `COALESCE` (`KanbanDatabase.ts:6779`), so a user who hand-overrode the accuracy body locally keeps their override — the trim reaches only seats whose row matches the bundled hash. Do not write to the DB directly; edit the bundle and reseed.
4. **Host-conditional emission needs a default that fails visibly.**

   > **Superseded:** "The dispatcher knows the seat's CLI family, so the file-creation rule can be emitted for Antigravity and withheld elsewhere."
   > **Reason:** The CLI family is known at *spawn* (`clearReadiness.ts:203`, `ptyFleetService`), but it is **not threaded into the prompt builder**. `PromptBuilderOptions` (`agentPromptBuilder.ts:243-429`) has `cliPath` (a path string) and `clearAntigravityContext` (a per-role config boolean) — no `cliFamily` field. So host-conditional emission is a wiring change across both composition roots (`extension.ts` and `standalone/bootstrap.ts`), the exact seam-drift trap AGENTS.md warns about — not a string toggle.
   > **Replaced with:** Keep the `IsArtifact: false` line **unconditionally** in the trimmed body. This is the plan's own fallback principle applied literally: "guessing 'not Antigravity' is the quiet failure; guessing 'Antigravity' is the visible, harmless one." Keeping the line for all hosts *is* guessing Antigravity for everyone — a non-Antigravity seat ignores a parameter it does not have (harmless noise), while an Antigravity seat gets the rule it needs. Host-conditional emission is recorded below as an **optional follow-up** with its real wiring cost, not the default for this plan.

5. **The trimmed body still has to teach the method.** The risk in cutting is going too far and leaving a coder without the phases; the sections named above are the ones that describe the *host*, not the work. The five phases that must survive are enumerated in Proposed Change #2, and Verification step 4 checks each by name.

## Dependencies

- None blocking. The `control_plane` table, `ProtocolService.resolveProtocol`, and `buildAccuracyDirective` all landed together (`8258ce4b` + the reconnect plan). This plan edits only the stored body.

## Adversarial Synthesis

Key risks: (1) the `contentHash` is not recomputed, so the seed never propagates the trim — a silent failure where verification passes against source but the dispatched prompt is unchanged; (2) over-cutting drops a phase while a size check still passes; (3) the `File Creation Rules` contradiction sends the implementer to delete the load-bearing `IsArtifact` line. Mitigations: recompute `sha256(body, utf8)` explicitly; enumerate the five surviving phases and assert each by name; keep `File Creation Rules` unconditionally and record host-conditional emission as an optional follow-up with its wiring cost.

## Proposed Changes

### `src/services/bundledProtocols.ts` — the `accuracy` entry (lines 11-17)

This is the only file that changes. The `accuracy` entry's `body` string is replaced and its `contentHash` is recomputed. `delivery` stays `"inline"`, `version` stays `"1.0.0"`.

**Context.** `bundledProtocols.ts` is the seed source for every `control_plane` protocol row. `ProtocolService.seedProtocols` (`ProtocolService.ts:19`) maps `BUNDLED_PROTOCOLS` into `ControlPlaneEntry` rows; `seedControlPlaneFromBundle` calls it at host startup in **both** roots (`extension.ts` via `ClaudeCodeMirrorService`, `standalone/bootstrap.ts:861`). `seedControlPlane` (`KanbanDatabase.ts:6804`) updates an existing row only when `content_hash`, `version`, or `delivery` differs, and preserves any user `override_body` via `COALESCE`.

**What to cut (four orphaned sections + two stale references):**
- `## No-Artifact Rule` — its *substance* (don't write tracking files to disk; keep output in your reply) already survives inline in the per-step instructions ("Do NOT create any tracking files on disk", "Do NOT write these findings to a file", "Do NOT produce a plan-in-reply"). The section header only framed that substance around a `/accuracy` slash command the agent did not invoke.
- `## Quick Reference` / "Valid Actions" — names an empty `send_message` list that is Antigravity-only and to be ignored.
- `## Final-Phase Recovery Rule` — Kanban-UI card moves and phase-state-machine bookkeeping that do not exist on the inlined path.
- The `/accuracy` activation sentence in old Step 1 ("Activate accuracy mode via the `/accuracy` command").
- The MCP reference in old Step 1 ("This workflow operates without MCP tool dependencies") — the MCP server was removed (`extension.ts:894-928`).
- The "Mark Phase 1 complete … or via the Kanban UI if available" and "Mark Phase 5 complete … The workflow automatically terminates when all phases are done" bookkeeping lines (phase state machine).

**What stays:**
- `## File Creation Rules` (the `IsArtifact: false` line) — load-bearing for Antigravity, harmless noise elsewhere. Kept unconditionally per Edge-Case #4.
- The five phases: Deep Context Gathering, Internal Planning, Implement in verified groups, Self-Review (Red Team), Final Verification & Complete. Old steps 2–6 become 1–5.

> **Superseded:** Proposed Change #1 originally listed `File Creation Rules` among the sections to remove.
> **Reason:** It contradicts the Problem Analysis, which establishes `File Creation Rules` as "real and must not be cut" because `IsArtifact: false` is load-bearing for Antigravity. "Remove File Creation Rules" and "keep the IsArtifact rule" are the same two lines — a coder would have to guess which instruction wins.
> **Replaced with:** `File Creation Rules` stays unconditionally. Only `No-Artifact Rule`, `Quick Reference`, `Final-Phase Recovery Rule`, the `/accuracy` activation, and the MCP reference are removed.

### Concrete target body

The replacement `body` string (renumber steps 1–5; keep `File Creation Rules`; drop the four orphaned sections and the two stale references). After writing it, recompute `contentHash = sha256(body, utf8)` and set it on the entry.

```
# Accuracy — Solo High-Accuracy Coding Mode

> **Scope**: This skill is for CODING/IMPLEMENTATION agents only. It is NOT for review agents. If you are reviewing someone else's work, use the `review` skill instead.

> This workflow trades tokens for correctness. It's designed for contexts where usage is free or low-cost, so the strategy is: **invest heavily in context-gathering and planning, verify at every gate, and red-team before finishing — to minimize rework rather than to save prompts.**

## File Creation Rules
- When creating files in `.switchboard/`, always use `IsArtifact: false` to prevent path validation errors.

## Steps

1. **Deep Context Gathering** (invest time here to avoid rework):
   - MUST read ALL files that will be modified or depend on changes.
   - MUST read existing tests, types, and interfaces related to the task.
   - MUST identify every dependency and side-effect BEFORE writing any code.
   - **WHY**: Missing context causes mistakes. Mistakes cause rework. Front-loading context is cheaper than fixing bugs later.
   - Track progress in your reply as you go (a brief checklist is fine). Do NOT create any tracking files on disk.

2. **Internal Planning** (think before you code, but do NOT present a plan-in-reply):
   - MUST map dependencies between changes internally — which must happen first?
   - MUST identify risks: what could break? What edge cases exist?
   - **DESTRUCTION CHECK**: If deleting files, MUST run `grep_search` to confirm nothing depends on them.
   - **RULE**: Spend more time thinking. A thought-through approach that prevents a rework cycle is worth far more than the tokens it costs.
   - Do NOT produce a plan-in-reply or present a plan for approval — proceed directly to Step 3 (implementation).
   - Do NOT write a plan file to disk — plan files are the domain of `/improve-plan`, not `/accuracy`.

3. **Implement in verified groups**:
   - Group related changes together — if 3 files need coordinated changes, do all 3 in one pass.
   - **HARD GATE after each group**: You MUST verify before moving to the next group:
     1. MUST call `run_command` with compile/lint/test command. Paste output.
     2. MUST read modified files back. Confirm changes are exactly as intended.
     3. If verification fails: fix immediately. If fix fails twice, **HALT** and notify user.
     4. NEVER proceed to the next group with a broken build.
   - Do as many groups as possible in a single pass — but NEVER skip the verification gate.
   - MUST track progress in your reply as you go: mark completed items `[x]` in an in-context checklist. Do NOT create or update any `task.md` (or other tracking) file on disk.

4. **Self-Review (Red Team)** — catch issues before they become rework:
   - Review ALL changes holistically as a hostile reviewer.
   - For each modified file, MUST check:
     - Does it handle edge cases (null, empty, boundary values)?
     - Are error paths covered?
     - Is it consistent with existing code style?
     - Could it break anything else in the codebase?
   - MUST list ≥3 concrete potential failure modes per modified file.
   - Document findings in your reply under a `### Red Team Findings` heading with specific line numbers. Do NOT write these findings to a file.
   - Fix all issues found — NEVER leave them for later.

5. **Final Verification & Complete**:
   - MUST run final compile/test across the whole project via `run_command`.
   - Review the complete diff for consistency.
   - Output: `**ACCURACY VERIFICATION COMPLETE**`
   - Do NOT create or update any tracking file on disk.
```

**Implementation steps:**
1. Replace the `accuracy` entry's `body` string in `bundledProtocols.ts:13` with the target above (escaped as the existing entries are — `\n` for newlines, `\"` for quotes).
2. Recompute `contentHash`: `node -e "const c=require('crypto');console.log(c.createHash('sha256').update(require('fs').readFileSync(0,'utf8'),'utf8').digest('hex'))"` piped the new body, or `crypto.createHash('sha256').update(body,'utf8').digest('hex')` in a scratch script. Set it on `bundledProtocols.ts:16`.
3. Do **not** change `delivery` (`"inline"`) or `version` (`"1.0.0"`).
4. No other file changes. The reseed happens automatically on the next host startup in both roots.

### Audit the other twelve inline protocols

> **Superseded:** "They came from the same workflow format, so the same sections are likely present in others, paid on the same per-dispatch basis."
> **Reason:** Audited all 13 `delivery=inline` rows in `bundledProtocols.ts`. Only `accuracy` carries host-workflow scaffolding. The other 12 are clean: `advise_research`, `clickup-api`, `clickup-attach`, `clickup-create-subpage`, `clickup-create-task`, `clickup-fetch`, `clickup-modify-task`, `generate-diagram`, `get-tickets`, `linear-api` are API/workflow docs with no slash-command, artifact, Valid-Actions, or Kanban-UI scaffolding; `improve-plan` and `improve-feature` are legitimate *planner* workflows where slash-command references (`/improve-feature --high-low`) and phase tracking are the actual workflow content a planner needs, not orphaned scaffolding.
> **Replaced with:** The audit is already done — only `accuracy` needs the cut. The implementer confirms the finding (grep the 12 bodies for `IsArtifact`, `No-Artifact`, `Valid Actions`, `Final-Phase`, `Kanban UI`) and stops. No other inline body is edited.

### Keep the body in the database, not in a file

The fix is to the `control_plane` row's content (via its seed source, `bundledProtocols.ts`). Do not solve this by materialising the protocol to disk instead — inline delivery is correct for something the agent must have in front of it, and the storage overhaul moved these into the database deliberately.

### Optional follow-up (not part of this plan): host-conditional `IsArtifact` emission

If the one line of `IsArtifact` noise on non-Antigravity seats is later judged worth removing, the change is: add a `cliFamily?: CliFamily` field to `PromptBuilderOptions` (`agentPromptBuilder.ts`), thread it from both composition roots (`extension.ts` dispatch site and `standalone/bootstrap.ts` dispatch site — the family is already known at spawn in `ptyFleetService`/`clearReadiness`), and have `buildAccuracyDirective` (`protocolDirectives.ts:148`) emit the `File Creation Rules` line only when `cliFamily === 'antigravity' || cliFamily === 'unknown'` (unrecognised keeps it — the visible/harmless default). This is a wiring change across both roots and must land in both per AGENTS.md. It is **out of scope** for this plan; the unconditional keep is correct and safe.

## Verification Plan

### Automated Tests

- No test reads the `accuracy` body content from `bundledProtocols.ts` (the protocol-body tests read `switchboard-mission-control*`, `switchboard-contracts`, `deep-planning`, etc. — none read `accuracy`). So the body edit requires no test update.
- `pair-programming-comprehensive.test.ts:251` asserts the coder prompt `includes('SKILL.md')` when accuracy is on. This is **pre-existing** and about the directive *wrapper* (`buildAccuracyDirective` emits "the workflow below" + body, or the fetch instruction when unresolved — neither contains `SKILL.md`), not the body. It is unrelated to this trim and is not made worse by it. Do not touch it in this plan.
- `claude-protocol-block-size-contract.test.js:82,212` asserts `IsArtifact` is absent from the emitted *AGENTS.md block* — a different surface from the inlined accuracy directive. Keeping `IsArtifact` in the accuracy body does not affect it. No conflict.

### Goal Invariants

- The `accuracy` entry's `body` in `src/services/bundledProtocols.ts` contains none of: `/accuracy` (the slash command), `No-Artifact Rule`, `Valid Actions`, `MCP`, `Kanban UI`, `Final-Phase Recovery`, `automatically terminates`.
- The `accuracy` entry's `body` still contains all five phase headings: `Deep Context Gathering`, `Internal Planning`, `Implement in verified groups`, `Self-Review (Red Team)`, `Final Verification & Complete`.
- The `accuracy` entry's `body` still contains `IsArtifact: false` (the `File Creation Rules` line survives).
- The `accuracy` entry's `contentHash` in `bundledProtocols.ts` equals `sha256(body, utf8)` of the new body (the seed-propagation invariant — without this, the trim does not reach any dispatched seat).
- The `accuracy` entry's `body` length is materially smaller than 4,732 bytes.
- The other 12 `delivery=inline` entries in `bundledProtocols.ts` are unchanged (the audit found no other body needs the cut).
- The unresolved-protocol fallback in `protocolDirectives.ts:85` still names `switchboard api GET /protocol/accuracy` (unchanged — this plan edits only the body, not the builder).

## Uncertain Assumptions

- **`IsArtifact: false` is a load-bearing Antigravity tool parameter** that prevents path validation errors when writing into `.switchboard/`. This is a claim about Antigravity's tool API behavior (a third-party platform) and is not verifiable from this repo's code — the codebase includes the rule and treats `IsArtifact` as host-only in one emitted surface (`claude-protocol-block-size-contract.test.js`), but no code documents *why* Antigravity requires it. The user was advised to run web research to confirm this before implementation. The plan's decision (keep the line unconditionally) is safe regardless: a harmless line kept is never worse than a load-bearing line dropped.

## Outstanding Questions

- None. The trim scope, the `IsArtifact` keep, and the contentHash recompute are all settled by the code investigation above.
