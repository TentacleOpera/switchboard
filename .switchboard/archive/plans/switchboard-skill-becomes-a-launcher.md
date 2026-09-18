# `/switchboard` Becomes a Launcher — Two Steps, Not a Console

## Goal

`/switchboard` does two things:

1. Start `npx switchboard` if it is not already running.
2. Start the orchestration agent.

Everything else in the current 631-line skill is deleted.

### Why

**The skill was written before `npx switchboard` existed.** It is a *conversational* board console — read the board, print a menu, browse columns, move cards, list plans, resolve IDs, run oversight passes — built for a world where the only graphical surface was the VS Code webview and an agent in another host had no way to see the board.

That world is gone. `package.json` ships `bin: { "switchboard": "./dist/standalone/cli.js" }`. **The browser board is the console.** A 631-line skill that narrates the board in markdown is a worse version of a UI the user can open, and it has to be kept in sync with that UI forever.

**What is left once the board exists is a launcher.** The two things a chat surface can do that the board cannot are: start the board when it is not running, and start the agent that drives it. Both are one step.

**Its remaining sections have owners elsewhere.** Planning belongs to the planning mode. Feature grouping, plan improvement and card moves belong to the board and its skills. The oversight-pass protocol belongs with the automation work. Plan-ID resolution exists because a conversational console had to translate for a human who could not see the board — with the board open, the problem does not arise.

### The file to edit is the authored one

> **Superseded:** the target is `.claude/skills/switchboard/SKILL.md` (631 lines).
> **Reason:** that file is generated. `ClaudeCodeMirrorService.ts` `MIRROR_MANIFEST` declares `{ source: 'workflows/switchboard.md', name: 'switchboard', invocation: 'default', allowedTools: 'Bash' }`, so the authored source is `.agents/workflows/switchboard.md` (629 lines; the mirror's extra two are generated frontmatter). Editing the mirror puts the change one regeneration away from being erased, and violates the control-plane source-of-truth rule.
> **Replaced with:** rewrite `.agents/workflows/switchboard.md`, then regenerate `.claude/skills/switchboard/SKILL.md`. Line references below are to the authored file.

## What `/switchboard` does

**Step 1 — ensure a board is running.** Check for a reachable server (`.switchboard/api-server-port.txt` plus a health check). If one answers, use it: a running VS Code extension already serves the board, and a second instance must not be started. If nothing answers, launch `npx switchboard` and report the URL.

**Step 2 — start the orchestration agent.** Hand off to the pre-flight sequence in `orchestration-starts-as-a-conversation.md`: the agent reports what is missing, proposes a session goal, and waits for the user. This skill does not duplicate that sequence; it starts it.

That is the whole skill. It should be short enough to read in one screen.

### Clarification — the health check must be a health check

A port file is not liveness. `.switchboard/api-server-port.txt` survives a crashed extension, and **every workspace's port file holds the same port**, so its presence proves nothing about *this* workspace. Step 1 reads the port, calls `GET /health`, and treats only a 200 as "a board is running". Anything else — no file, connection refused, non-200 — means launch. This is the difference between "does not start a second board" (verification 2) and "silently attaches to a dead port and reports a URL that 404s".

## What is deleted

The entry protocol and its `awk` board-count pipeline. The five-item menu and every category section beneath it. Feature management prose. Plan-ID resolution. Guided setup and tour. The column-oversight pass protocol and the project-pipeline wrapper. The management-console persona and its hard rules about being a manager rather than a coder.

None of this is trimmed or relocated wholesale — the surfaces that own each concern already exist.

## Two things must move first — verified by grep, and it is two, not three

The verb-rail traps were surveyed across `.agents/`, `.claude/` and `docs/`. The result is narrower than first stated:

> **Superseded:** all three verb-rail traps appear in exactly one file, the one being deleted; `switchboard-orchestration` has zero mentions of any of them.
> **Reason:** false for the canonical-column-ID rule, which `switchboard-orchestration/SKILL.md:116` already states verbatim — *"Column IDs are canonical uppercase (`LEAD CODED`), never state-file slugs (`lead-coded`) — both endpoints canonicalize and 400 on unknown columns"* — with the column vocabulary at `:125`. It is also imprecise for the other two: `:115` names the hazard in passing (*"raw `triggerAction` (whose exact webview field names and hollow `{success:true}` acks hide no-ops)"*) without stating the read-verb rule or giving the field names. Acting on the original claim would have re-documented a rule that already exists and could have produced a contradictory second statement of it.
> **Replaced with:** two traps must move; the third is already covered and must not be duplicated.

Move these into `.agents/skills/switchboard-orchestration/SKILL.md` **before** deleting anything:

1. **Read verbs over the verb rail return only `{success:true}`** — their data arrives on the WS hub. Reads must use the dedicated GET endpoints (`/kanban/board`, `/kanban/plans`, `/kanban/plan`). Currently at `.agents/workflows/switchboard.md:206-208`, restated at `:609-611`. Not stated anywhere in `switchboard-orchestration`.
2. **Exact webview message field names** — `triggerAction` takes `{sessionId, targetColumn}`; `promptOnDrop` takes `{sessionIds, sourceColumn, targetColumn}`. `planId` / `column` are silently wrong. Currently at `.agents/workflows/switchboard.md:231-239`, the only place in the tree where the field names appear (the `docs/TECHNICAL_DOC.md:317` row names `triggerAction` but not its payload shape). `switchboard-orchestration:115` warns the trap exists without giving the names.

**Already covered — do not move, do not restate:** canonical column IDs, never slugs. `switchboard-orchestration:116` and `:125` own it. `.agents/workflows/switchboard.md:111-112` and the parenthetical at `:233-234` are duplicates and go with the deletion.

They share one failure mode, and it is the reason they are worth preserving: **the route answers `{success:true}` and nothing happens.** An agent cannot detect this from the response, so it reports success and moves on. That is the most expensive class of bug on this surface, and this knowledge is one `git rm` from being lost.

`workspaceRoot` on every call needs no move — `switchboard-orchestration` already covers it thoroughly.

## Supersedes

`consolidate-switchboard-front-doors.md` decided `/switchboard` routes to the management console as the local hub. That plan predates `npx switchboard` in the same way this skill does, and its Decision 3 ("local mode's hub is the management console") no longer holds — the hub is the board. Its other decisions (one adaptive front door, `memo` standalone, Cowork served separately, workflow verbs reachable but not surfaced) are unaffected.

## Metadata

**Complexity:** 3
**Tags:** docs, refactor, cli

## User Review Required

None.

## Complexity Audit

### Routine

- Deleting ~600 lines from a markdown workflow and writing ~30 in their place.
- Appending two sections to `switchboard-orchestration/SKILL.md`.
- Regenerating the `.claude/` mirror.

### Complex / Risky

- **A deletion of this size is irreversible by inspection.** Once the file is gone, "what did it used to say?" is a git-history question. The two traps are the identified loss; verification 6 exists because there may be others.
- **AGENTS.md and CLAUDE.md advertise this skill as the primary front door.** Both describe `/switchboard` as "the local management console — drive the board, plans, features, dispatch, and automation … the primary front door; start here when unsure." That description becomes false. Those files are shared control-plane documents and must be edited surgically, never wholesale.
- **`allowedTools: 'Bash'` in the manifest entry.** A launcher that shells out to `npx` still needs it; do not drop the manifest field while shrinking the file.

## Edge-Case & Dependency Audit

### Race Conditions

- **`/switchboard` twice in a row** (verification 3). The health check makes step 1 idempotent. Step 2 is idempotent because `POST /orchestration/start` reuses a live Orchestrator terminal (`TaskViewerProvider.ts:10243-10257`) and, after `orchestration-starts-as-a-conversation.md`, re-delivers the pre-flight instead of arming. Both properties are inherited, not re-implemented here.
- **Two `npx switchboard` instances racing for a port.** Only reachable if two invocations both fail the health check simultaneously. Accept it: the second instance fails to bind and reports the failure, which is visible rather than silent.

### Security

- No new surface. The launcher calls two things the user could already call.
- The `npx switchboard` invocation must not be constructed from user-supplied text.

### Side Effects

- Anything reachable *only* through the console's prose becomes unreachable through chat until the user opens the board. Verification 6 is the check that no such capability exists; the two traps are the known instance and are handled.
- `.claude/skills/switchboard/SKILL.md` shrinks by ~600 lines on regeneration. Expected, not a mirror bug.

### Dependencies & Conflicts

- **`.agents/skills/switchboard-orchestration/SKILL.md`** — three subtasks in this feature append to it: this plan (two traps), `agent-reports-go-to-a-file-inbox.md` (reports channel), `orchestration-starts-as-a-conversation.md` (session file, confirm endpoint). Distinct sections; serialise the edits.
- **`.agents/workflows/switchboard.md:326`** — the "Arm / disarm the unattended engine" line that `orchestration-starts-as-a-conversation.md` would otherwise correct. If this plan lands first the line is deleted and that edit is unnecessary; if it lands second the corrected line is deleted anyway. Either order is safe — the two plans must not both edit it.
- **`orchestration-starts-as-a-conversation.md`** owns the pre-flight this skill hands off to. Landing the launcher first means step 2 points at a sequence that does not exist yet and `/switchboard` arms unattended automation with no interview — the exact footgun the console skill was written to close. **Land the conversation plan first.**
- **`AGENTS.md`, `CLAUDE.md`** — the workflow-registry rows describing `/switchboard`. Surgical row edits only.

## Dependencies

- `sess_starts_as_conversation — orchestration-starts-as-a-conversation.md` — the pre-flight step 2 hands off to. Hard prerequisite.
- `sess_verb_rail_traps — .agents/workflows/switchboard.md:206-208, :231-239` — the two facts that must be relocated before the deletion.
- `sess_mirror — ClaudeCodeMirrorService.ts MIRROR_MANIFEST` — source/mirror relationship for `.claude/skills/switchboard/SKILL.md`.

## Adversarial Synthesis

**Risk summary.** The failure mode is a clean-looking deletion that quietly takes undocumented knowledge with it: the survey found two traps that exist nowhere else, and the honest position is that a 629-line document may hold more. Mitigations are moving both before the `git rm`, grepping afterwards to prove each still appears outside git history, and verification 6 as an explicit sweep rather than an assumption. The ordering risk is equally real — shipping the launcher before the pre-flight leaves `/switchboard` as a one-click arm of unattended automation with no interview, which is strictly worse than the console it replaces.

## Proposed Changes

### `.agents/workflows/switchboard.md`

- **Context.** 629 lines. Entry protocol and board snapshot (`~:100-130`), verb-rail traps (`:206-208`, `:231-239`), the Plan section (`:241+`), the Automation menu (`:326`), the oversight-pass protocol (`~:488`), the generic-rail note (`:609-611`).
- **Logic.** Replace the whole document with the two-step launcher.
- **Implementation.** New content: a one-line purpose statement; step 1 (read `.switchboard/api-server-port.txt`, `GET /health`, use it on 200, otherwise `npx switchboard` and report the URL); step 2 (hand off to the orchestrator pre-flight); and a pointer to `switchboard-orchestration` for the HTTP surface and to the board for everything else. No menu, no board snapshot, no column narration, no oversight protocol, no persona rules.
- **Edge cases.** The mirror-manifest entry keeps `invocation: 'default'` and `allowedTools: 'Bash'`. The trailing `.claude/skills/switchboard/SKILL.md` must be regenerated in the same change, not left stale.

### `.agents/skills/switchboard-orchestration/SKILL.md`

- **Context.** Owns the HTTP/verb contract for agents. `:115-116` already discuss dispatch and column canonicalisation.
- **Logic.** Add the two missing traps near the existing verb-rail material; add nothing about canonical columns.
- **Implementation.** A short "Verb-rail traps" block: (1) read verbs (`get*`/`fetch*`/`load*`) over the generic rail return only `{success:true}` — data arrives on the WS hub — so reads use `/kanban/board`, `/kanban/plans`, `/kanban/plan`; (2) raw verbs need the exact webview field names, `triggerAction` → `{sessionId, targetColumn}`, `promptOnDrop` → `{sessionIds, sourceColumn, targetColumn}`, and `planId` / `column` silently no-op while the route still answers `{success:true}`. Close with: prefer the first-class endpoints, and verify the effect afterwards (`GET /kanban/plan` → `dispatchedAt`, column).
- **Edge cases.** Do not restate the canonical-column rule — `:116` owns it, and two statements of one rule is how they drift.

### `AGENTS.md` and `CLAUDE.md` — workflow registry rows

- **Context.** Both describe `/switchboard` as the management console and primary front door.
- **Implementation.** Rewrite the two rows to describe a launcher: start the board if nothing is running, then start the orchestration agent. Row edits only — these files are shared and must never be replaced wholesale.

## Verification Plan

1. `/switchboard` with nothing running: `npx switchboard` starts, the URL is reported, the orchestration agent comes up in pre-flight.
2. `/switchboard` with the VS Code extension already running: no second server starts, and the existing one is used.
3. `/switchboard` twice in a row does not start two boards or two orchestrators.
4. The skill contains no board listing, no menu, no column narration, and no oversight-pass protocol.
5. The skill fits on one screen.
6. Nothing that used to be reachable only through the skill is now unreachable — each former capability is available on the board or through the skill that owns it.
7. `switchboard-orchestration` documents both relocated verb-rail traps **before** the console skill is deleted. Grep the tree afterwards: the read-verb rule and both field-name payloads each still appear somewhere, and not only in git history.
8. The canonical-column rule appears exactly once in `switchboard-orchestration` after the change — the relocation did not duplicate `:116`.
9. A stale `.switchboard/api-server-port.txt` pointing at a dead port causes a launch, not an attach to a URL that 404s.
10. `.claude/skills/switchboard/SKILL.md` is regenerated, not hand-edited, and matches the authored source.

### Automated Tests

Not run this session (SKIP TESTS directive). The relevant mechanical gate already exists: `scripts/check-claude-mirror.js` verifies the `.claude/` tree matches its `.agents/` sources — run it after regeneration. Verification 7 and 8 are grep assertions and are worth adding to that check.

---

**Recommendation:** Complexity 3 → **Send to Intern.**

## Completion report (2026-08-17, appended by lead-1)

Implemented in `e72dc05d`. `.agents/workflows/switchboard.md` went from a 629-line conversational console to a 94-line two-step launcher — health-check the port then `npx switchboard`, then hand off to the orchestrator pre-flight. Both verb-rail traps were relocated into `switchboard-orchestration/SKILL.md` as a `## 4a` block BEFORE the deletion, and the canonical-column rule was deliberately not restated: it appears exactly once in that file (verification 8). `AGENTS.md` and `CLAUDE.md` registry rows were edited surgically, and `check-claude-mirror.js` passes. Routing note: this plan recommends Send to Intern and the lead sent it to a coder while the intern seat sat idle — a lead-side routing error, not a defect in this plan.

Verified by lead-1 against the diff rather than the coder's account. Compilation and tests not run — SKIP COMPILATION / SKIP TESTS were in force for this run, so this plan's written Verification Plan remains unexecuted. Note: the coder reported completion to the lead over `ptySendPrompt` and was never instructed to append this report itself, so the board saw no completion signal for this card until now.

## Review Findings

Reviewed 2026-08-17 with tests run. The deletion is clean and both verb-rail traps landed correctly in `switchboard-orchestration/SKILL.md` `## 4a` with the read-verb rule, both exact payload shapes, and no duplication of the canonical-column rule (verification 8 confirmed: exactly one occurrence). **MINOR, fixed:** step 2 handed off to `orchestration-starts-as-a-conversation.md` — a `.switchboard/plans/` file that is gitignored, not distributed with the plugin, and unreadable to the agent following the skill; it now points at the `switchboard-orchestrator` skill's `## Pre-flight` section, which ships. Gate-wiring audit: the plan's named check, `mirror:check`, IS invoked by CI (`.github/workflows/integration-tests.yml:53`) and passes; verifications 7 and 8 were named as "worth adding to that check" and were not — they are now asserted in the new `test:contract:orchestrator-tick` gate, alongside a length/console-content check for verifications 4 and 5. Files changed: `.agents/workflows/switchboard.md` and its regenerated `.claude/skills/switchboard/SKILL.md`. Remaining risk: verification 6 (nothing formerly reachable only through the console is now unreachable) is a judgement sweep no gate can make; the two identified traps are covered.
