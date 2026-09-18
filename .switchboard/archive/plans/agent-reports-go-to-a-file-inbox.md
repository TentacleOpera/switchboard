# Agents Post Updates to a File Inbox the Orchestrator Reads

## Goal

Give agents a place to post updates — finished, blocked, a question, a status reply — as files. Any orchestrator with local file access can read them, whether it is a pty terminal, an IDE chat sidebar, or a cloud session with the repo checked out.

### Why

**`ptySendPrompt` assumes the orchestrator is a pty.** It often is not. An orchestrator running in an IDE chat sidebar or a web chat with local file access can read and write the repo but cannot be messaged, so "ask the lead for an update" has no reply channel — the lead can be prompted, and its answer has nowhere to go.

**Plan files cannot carry these updates.** Completion reports already live there, and that works precisely because plan files are write-once-at-the-end: a mid-work edit breaks completion detection (`switchboard-contracts` #3). "I am blocked", "I need a decision", and status replies all arrive mid-work by definition, so putting them in the plan file corrupts the one signal that does work today.

**Files are the only channel every host shares.** A pty can be messaged, an HTTP client can call the API, a sidebar chat can do neither reliably — but all three can read a directory.

**Half of this already exists, unused.** `ScheduledJobsService` ships `.switchboard/instructions/inbox/` with timestamped markdown files, frontmatter, `claimed/` markers and a staleness window — `writeInstruction` (`src/services/ScheduledJobsService.ts:64`), `isInboxItemClaimed` (`:97`), `claimInboxItem` (`:115`). `SparkContextExporter.ts:211-212` documents the convention to external agents. `writeInstruction` has no caller anywhere in `src` (only `src/test/scheduled-jobs-and-connections.test.js`). The mechanics are proven and idle; they simply run the other direction (instructions *to* agents, not reports *from* them).

**The system's own notices have the same hole.** The extension already tells the orchestrator when a seat finished or went quiet, as a `[switchboard:turn-end]` pty message (`TaskViewerProvider.ts:1243-1246`, and the standalone twin at `src/standalone/bootstrap.ts:1879-1882`). That is the *same* channel with the *same* assumption: a non-pty orchestrator never receives it. Fixing the lead's reply channel while leaving the system's notices pty-only would leave the stated goal — "any orchestrator with local file access can read them" — half met.

## What is added

**A reports directory: `.switchboard/orchestrator/reports/`.** One file per report, never rewritten, mirroring the existing instructions-inbox conventions rather than inventing new ones:

```
---
from: Coding-lead
kind: blocked          # finished | blocked | question | status
planId: <id>           # or feature:
created: 2026-08-16T21:14:03Z
---

Subtask 3 needs a decision on the migration key before I can continue.
```

**Agents post to it.** The team prompt gains one line: post an update here when you finish, when you are blocked, and when asked for status. This sits alongside the existing `ptySendPrompt` callback rather than replacing it — a pty-hosted lead reporting to a pty-hosted head keeps working exactly as it does now.

**The orchestrator reads it every tick and marks what it has handled**, using the existing `claimed/` marker pattern so a report is not acted on twice. Reading is a directory listing: no API, no extension, no host assumptions.

**Nothing is deleted.** Completion reports stay in plan files. `ptySendPrompt` stays. This adds the channel that works when neither is available.

### Clarification — who does the writing (and why no new zero-caller function)

The plan's own strongest observation is that `writeInstruction` shipped and was never called. Repeating that mistake is the main way this plan fails while looking finished, so the writer split is stated explicitly:

- **Agent-authored reports are plain file writes by the agent.** A lead has file access by definition; it writes the markdown itself. No endpoint, no TS writer, no host assumption. This is the primary path and it is a *documented contract*, not code.
- **System-authored reports are the only TS writer, and it has a real call site from day one** — the turn-end notifier, in both hosts. If a report writer lands with no caller, this plan has not landed.

> **Superseded:** *(implicit in the original plan)* the reports channel is a documented directory convention only; the extension writes nothing to it.
> **Reason:** the orchestrator's second signal source — `[switchboard:turn-end]` — is extension-generated and pty-only. A non-pty orchestrator would gain lead replies and still lose every system notice, so verification 4 ("completes a full tick using files alone") could pass on a board where no lead happens to post while the seat-quiet signal is silently unavailable. It also repeats the zero-caller failure the plan itself diagnoses.
> **Replaced with:** the turn-end notifier mirrors each notice into `.switchboard/orchestrator/reports/` as `from: system`, alongside the existing pty send. Both hosts, same shared writer.

### Clarification — reuse the existing mechanics, do not fork them

`writeInstruction` / `claimInboxItem` / `isInboxItemClaimed` hardcode `.switchboard/instructions/inbox/`. Reuse means **parameterising the existing functions on the directory**, not copying them:

- Extract the frontmatter-flatten + timestamped-filename + write body into `writeInboxFile(dirAbs, req, prefix)`; `writeInstruction` becomes a thin wrapper over it with `prefix = 'instr'` and the instructions inbox path, so its shipped behaviour and its existing test are unchanged.
- Add `isInboxItemClaimedIn(inboxDirAbs, filename, stalenessHours)` / `claimInboxItemIn(inboxDirAbs, filename, agentId)`; the existing two-arg forms delegate to them with the instructions path. Shipped signatures keep working byte-for-byte (PRD contract #2).

One claim-marker implementation means the format the persona documents to agents and the format the extension writes cannot drift.

### Clarification — `.switchboard/orchestrator/inbox/` already exists on disk and is not this

The working tree has an empty `.switchboard/orchestrator/inbox/` directory (created 2026-08-05). It is a stub left by `orchestration-3-agent-request-channel-and-session-log.md`, which was never built: `grep -rn "orchestrator/inbox" src/` returns nothing, and the only `/orchestrator/*` HTTP route that exists is `GET /orchestrator/session-log` (`LocalApiServer.ts:3950`). Do not wire `reports/` into it, do not treat its presence as a shipped channel, and do not delete it as part of this plan — it is inert and out of scope.

## Relationship to the tick

`orchestrator-persona-becomes-a-tick.md` names two signals for its lane guards: completion reports in plan files, and asking the lead. This plan is what makes the second one work for a non-pty orchestrator — the question goes out however the host can send it, and the answer comes back as a file.

A pty-hosted orchestrator does not need this plan to function. Every other host does.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, feature

## User Review Required

None.

## Complexity Audit

### Routine

- Creating a directory and documenting a frontmatter shape.
- Adding one line to the team prompt in `agentPromptBuilder.ts`.
- Extracting three existing functions' bodies into directory-parameterised cores and re-pointing the shipped wrappers at them.
- Documenting the channel in the persona and in `switchboard-orchestration/SKILL.md`.

### Complex / Risky

- **Two hosts, one behaviour.** The turn-end notifier exists twice (`TaskViewerProvider.ts:1243`, `src/standalone/bootstrap.ts:1879`). Mirroring it in one host only produces a channel that works under `npx` and not in VS Code, or the reverse — the exact divergence PRD contract #1 exists to prevent.
- **Concurrent writers.** Two leads finishing in the same second must not collide. The shipped filename scheme is second-resolution plus a 5-digit random, written with a plain `writeFile` — a silent clobber is possible today.
- **Claim staleness is a re-delivery window, not a lock.** `isInboxItemClaimed` returns `false` once a claim is older than `stalenessHours` (default 24). A long-lived session can legitimately re-surface a report it already handled.

## Edge-Case & Dependency Audit

### Race Conditions

- **Same-second, same-kind collision.** `writeInstruction` builds `instr-<ISO-to-the-second>-<kind>-<5-digit-random>.md` and writes with a plain `fs.promises.writeFile`, which truncates an existing file. Two leads posting `status` in the same second collide with probability ~1e-5 per pair and lose one report silently. Fix in the extracted core: write with `flag: 'wx'` and retry with a fresh random up to 5 times, returning `{success:false, error}` if all attempts collide. This also hardens the shipped instructions inbox.
- **Read-while-write.** The orchestrator lists the directory while a lead is mid-write and may read a truncated file. Mitigated by the malformed-report rule below (skip and log, never crash) and by the report being re-read on the next tick if it was not claimed.
- **Claim vs. read.** Two orchestrators are not a supported topology (the orchestrator is a singleton), so claim markers are a de-duplication record across *ticks of one agent*, not a mutual-exclusion lock between agents. Do not present them as a lock.

### Security

- **Frontmatter forgery.** The shipped `flatten()` strips CR/LF from every frontmatter value precisely so a multi-line body cannot forge keys (asserted by `src/test/scheduled-jobs-and-connections.test.js:163`). The extracted core must keep it — losing it lets a report body inject `kind:` or `from:`.
- **Path traversal.** `filename` reaches `claimInboxItemIn` from a directory listing, so it is machine-supplied — but the function must still reject any name containing a path separator or `..` before joining, since the persona documents the call to agents.
- **Local-only by design.** `.switchboard/*` is gitignored (`.gitignore:52`, verified with `git check-ignore`), so reports never reach a commit. No gitignore change is needed and none should be made — an unattended orchestrator committing report churn would pollute the merge-back flow.

### Side Effects

- Creates `.switchboard/orchestrator/reports/` and `reports/claimed/` in any workspace where the orchestrator is seated. Bootstrap must be lazy in the same way `bootstrapInstructionsDirectory` is (`ScheduledJobsService.ts:44-47` returns `null` when `.switchboard` is absent) so a non-Switchboard folder is never littered — see the scaffold-litter hazard.
- The turn-end notifier gains a filesystem write per notice. It is fire-and-forget: a write failure must be logged and swallowed, never allowed to suppress the pty send that works today.
- Reports accumulate across sessions. No pruning is in scope; the directory is gitignored and small.

### Dependencies & Conflicts

- **`src/services/ScheduledJobsService.ts`** — shared with nothing else in this feature. Sole editor.
- **`src/services/TaskViewerProvider.ts:1243`** and **`src/standalone/bootstrap.ts:1879`** — the turn-end notifier. `orchestration-starts-as-a-conversation.md` edits a *different* region of `TaskViewerProvider.ts` (`startOrchestratorFromKanban`, `:10227-10413`). Non-overlapping, but the same file: serialise the edits, do not run both in parallel (PRD *Orchestration discipline*).
- **`.agents/skills/switchboard-orchestration/SKILL.md`** — this plan appends a reports-channel section; `switchboard-skill-becomes-a-launcher.md` appends the verb-rail traps. Append-only, distinct sections, but serialise.
- **`.agents/skills/switchboard-orchestrator/SKILL.md`** — the persona documents reading the channel. That file is rewritten wholesale by `orchestrator-persona-becomes-a-tick.md`; this plan must NOT edit it. Hand the read protocol to the persona plan instead (see Dependencies).

## Dependencies

- `sess_orchestrator_tick — orchestrator-persona-becomes-a-tick.md` owns `.agents/skills/switchboard-orchestrator/SKILL.md` and documents how the tick drains this directory. This plan supplies the format and the mechanics only.
- `sess_shipped_inbox — ScheduledJobsService` inbox conventions (`writeInstruction` / `claimInboxItem` / `isInboxItemClaimed`) and their regression test `src/test/scheduled-jobs-and-connections.test.js`.
- No dependency on the automation-modes work. This subtask can land at any time, before or after everything else in the feature.

## Adversarial Synthesis

**Risk summary.** The dominant risk is shipping a second unused channel: a documented directory nobody writes to and a tick that never finds anything, which reads as "done" because the directory exists. Mitigations: the only TS writer added is the turn-end mirror, which has a live call site in both hosts on day one, and the agent-authored path is a prompt line rather than a function so its absence is visible in the prompt diff. Secondary risks are a silent same-second clobber (closed by exclusive-create with retry, which also fixes the shipped instructions inbox) and host divergence (closed by mirroring in `TaskViewerProvider` and `standalone/bootstrap` in the same change).

## Proposed Changes

### `src/services/ScheduledJobsService.ts`

- **Context.** Lines 64-121 hold `writeInstruction`, `isInboxItemClaimed`, `claimInboxItem`, all hardcoded to `.switchboard/instructions/inbox/`. `bootstrapInstructionsDirectory` (`:42`) lazily creates the tree and seeds standing jobs — instruction-specific, not reusable as-is.
- **Logic.** Split path resolution from mechanics. Mechanics take an absolute directory; the shipped wrappers supply the instructions path so their behaviour and signatures are unchanged.
- **Implementation.**
  - `export async function writeInboxFile(dirAbs: string, req: InstructionRequest, prefix = 'instr'): Promise<InstructionWriteResult>` — holds the current body of `writeInstruction` from the `flatten` definition onward, with `dirAbs` in place of the resolved `inboxDir` and `prefix` in place of the literal `instr`. Writes with `{ encoding: 'utf8', flag: 'wx' }`; on `EEXIST`, regenerate `rand` and retry, max 5 attempts, then return `{ success: false, error }`. Keeps `flatten()` on every frontmatter value.
  - `writeInstruction` becomes: bootstrap, then `return writeInboxFile(path.join(baseDir, 'inbox'), req, 'instr')`. Same public signature, same result shape.
  - `isInboxItemClaimedIn(inboxDirAbs, filename, stalenessHours = 24)` / `claimInboxItemIn(inboxDirAbs, filename, agentId = 'external-agent')` — current bodies with the joined path replaced by `inboxDirAbs`. Both reject a `filename` containing `/`, `\`, or `..` before joining. `isInboxItemClaimed` / `claimInboxItem` delegate with the instructions path.
  - `bootstrapOrchestratorReportsDirectory(workspaceRoot): Promise<string | null>` — returns `null` when `.switchboard` is absent (same lazy guard as `:44-47`); otherwise `mkdir -p .switchboard/orchestrator/reports/claimed` and return the reports dir. No standing-job seeding.
  - `writeOrchestratorReport(workspaceRoot, req): Promise<InstructionWriteResult>` — bootstrap, then `writeInboxFile(reportsDir, req, 'report')`.
- **Edge cases.** `.switchboard` absent → `{ success:false, error }`, no directories created. Five consecutive `EEXIST` collisions → honest failure, not a silent drop. Existing tests at `src/test/scheduled-jobs-and-connections.test.js:148-170` must pass untouched.

### `src/services/TaskViewerProvider.ts` (turn-end notifier, `:1243-1246`)

- **Context.** The notifier composes one of three `[switchboard:turn-end]` strings and delivers it to the orchestrator terminal.
- **Logic.** Keep the pty send exactly as is; add a fire-and-forget mirror to the reports directory.
- **Implementation.** After composing the message, `void writeOrchestratorReport(root, { from: 'system', kind: <'finished' | 'blocked'>, planId, body: <the same message text> }).catch(() => { /* logged, never fatal */ })`. `finished` for the seat-finished variant; `blocked` for both the gone-quiet and feature-stall variants.
- **Edge cases.** The write must not be awaited in a way that can delay or throw before the pty send. A workspace without `.switchboard` returns `null` from bootstrap and the mirror is a no-op.

### `src/standalone/bootstrap.ts` (turn-end notifier, `:1879-1882`)

- **Context.** The standalone host's twin of the above.
- **Logic / Implementation.** Identical mirror, same helper, same `from: 'system'` mapping.
- **Edge cases.** Both hosts must produce the same frontmatter for the same event — that equivalence is the acceptance signal, not "it compiles".

### `src/services/agentPromptBuilder.ts`

- **Context.** `CODING_COMPLETION_REPORT_DIRECTIVE` (`:884`) is the completion handshake appended to coding prompts; `appendCompletionDirective` (`:896`) is the idempotent guard around it.
- **Logic.** Add a sibling one-line directive for mid-work updates. It must not be folded into the completion directive — that one is load-bearing for completion detection and its text is asserted elsewhere.
- **Implementation.** New exported constant, e.g. `ORCHESTRATOR_REPORT_DIRECTIVE`: post a report to `.switchboard/orchestrator/reports/` as `report-<UTC timestamp>-<kind>-<5 digits>.md` with the documented frontmatter when you finish, when you are blocked, when you have a question, and when asked for status. Appended to team/lead prompts alongside the completion directive.
- **Edge cases.** The directive must say explicitly that it is *in addition to*, never *instead of*, the plan-file completion report — an agent that reads it as a replacement breaks completion detection for every card.

### `.agents/skills/switchboard-orchestration/SKILL.md`

- **Context.** The agent-facing contract doc; it already documents the session log at `:336`.
- **Logic.** Add a short reports-channel section next to it.
- **Implementation.** Directory path, the four `kind` values, the frontmatter fields, the `claimed/<filename>.claim` marker with `claimed_ts` / `agent`, the 24-hour staleness default, and the rule that a report is a message *to* the orchestrator while the session log is the orchestrator's own record.
- **Edge cases.** Do not describe this as an HTTP surface — there is no endpoint and none is in scope.

### `.claude/skills/switchboard-orchestration/SKILL.md`

- **Context.** Generated mirror of the above (`ClaudeCodeMirrorService.ts` `MIRROR_MANIFEST`).
- **Implementation.** Regenerate rather than hand-edit, per the control-plane source-of-truth rule.

## Verification Plan

1. A lead posts a `blocked` report; an orchestrator reading only the filesystem sees it on its next tick.
2. The same report is not acted on twice across ticks — the claim marker holds.
3. A mid-work `blocked` report does not touch the plan file, and completion detection for that subtask still fires normally when the work later finishes.
4. An orchestrator running in an IDE chat sidebar — no pty, no API reachable — completes a full tick using files alone.
5. A pty-hosted lead reporting to a pty-hosted head still works unchanged; nothing is forced through files that has a live terminal path.
6. Two leads posting at the same moment produce two files, neither clobbering the other.
7. A malformed or truncated report is skipped with a log line, not a crashed tick. A report with an unrecognised `kind` is read as `status` rather than skipped — mis-binning a lead's message is better than dropping it.
8. A seat goes quiet under the VS Code host: the `[switchboard:turn-end]` pty message is still sent **and** a `from: system`, `kind: blocked` report file appears.
9. The same scenario under `npx switchboard` produces a report file with the same frontmatter shape — byte-comparable frontmatter across hosts.
10. `writeInstruction` still writes to `.switchboard/instructions/inbox/` with `instr-` filenames and unchanged frontmatter; the shipped instructions channel is untouched.
11. A workspace with no `.switchboard` directory gains no `orchestrator/` tree from seating an orchestrator.

### Automated Tests

Not run this session (SKIP TESTS directive). The target file is the existing `src/test/scheduled-jobs-and-connections.test.js`, extended with: the exclusive-create retry path, `writeInboxFile` frontmatter-forgery resistance at a non-default directory, and `claimInboxItemIn` rejecting a traversal filename. The four shipped assertions at `:148-170` must pass unmodified — that is the byte-compatibility signal for the refactor.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

## Completion report (2026-08-17, appended by lead-1)

Implemented in `2268fb5e`. `writeInboxFile(dirAbs, req, prefix)` was extracted from `writeInstruction` with exclusive-create (`flag: 'wx'`) and a five-attempt EEXIST retry, closing the shipped same-second clobber; `isInboxItemClaimedIn` / `claimInboxItemIn` take an absolute directory and reject any filename containing `/`, `\\` or `..`; the shipped two-argument forms delegate unchanged. `bootstrapOrchestratorReportsDirectory` keeps the lazy null guard so a non-Switchboard folder is never littered. The turn-end notifier now mirrors each notice into the reports directory as `from: system` in BOTH hosts (`TaskViewerProvider.ts:1280`, `standalone/bootstrap.ts:1929`), so the new writer has live call sites on day one — the zero-caller failure this plan was written to avoid. `ORCHESTRATOR_REPORT_DIRECTIVE` is a separate constant, not folded into the completion directive.

Verified by lead-1 against the diff rather than the coder's account. Compilation and tests not run — SKIP COMPILATION / SKIP TESTS were in force for this run, so this plan's written Verification Plan remains unexecuted. Note: the coder reported completion to the lead over `ptySendPrompt` and was never instructed to append this report itself, so the board saw no completion signal for this card until now.

## Review Findings

Reviewed 2026-08-17 with tests run. The refactor is sound — `writeInstruction`'s signature and inbox path are unchanged, the exclusive-create retry closes the shipped clobber, `flatten()` survives, and the turn-end mirror is wired in both hosts with an identical outcome→kind mapping. **MAJOR, fixed:** the reports-channel section this plan explicitly required in `.agents/skills/switchboard-orchestration/SKILL.md` was never written, so the four `kind` values, the frontmatter contract, the `claimed/<file>.claim` marker and the 24-hour staleness window existed nowhere agent-facing — the persona said "claim what you act on" with no format at all. Section added and the mirror regenerated. **MINOR, fixed:** both hosts' `.catch(() => { /* logged, never fatal */ })` logged nothing *and* could not see the real failure, since `writeOrchestratorReport` returns `{success:false}` rather than throwing; both now log the returned error. **Zero automated coverage existed** for any of the new functions despite the plan naming three specific cases — added behaviourally in the new `test:contract:orchestrator-tick` gate (concurrent same-second posts, frontmatter forgery at a non-default directory, traversal rejection, lazy bootstrap, and the both-hosts wiring that prevents a repeat of the zero-caller failure). Files changed: `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `.agents/skills/switchboard-orchestration/SKILL.md` (+ mirror), `src/test/orchestrator-tick-and-reports-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Remaining risk: `claimInboxItemIn` silently no-ops on a rejected traversal filename, so such an item would re-surface every tick — unreachable from a directory listing, left as-is.
