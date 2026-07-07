# Add an Agent→Orchestrator Request Channel and Session Log

## Goal

Add the one genuinely new mechanic in this feature: an asynchronous channel for coding/review agents to raise questions, warnings, and research requests to the orchestrator, plus an append-only **session log** the orchestrator writes its triage summaries to. This is what lets the orchestrator sleep between wakes and still coordinate a fleet — agents POST requests to the LocalApiServer; the extension writes them to an inbox; the orchestrator drains them on wake.

### Problem / background / root cause

The orchestrator is system-woken and does not hold the fleet in-context, so it cannot receive synchronous messages from the agents it dispatched. Coding and (especially) review agents legitimately need to surface things mid-run — a warning, an ambiguous requirement, "I need to run research first." There is no inter-terminal messaging primitive in the local extension (the Antigravity `send_message` is not reachable here), and synchronous REPL scraping is fragile.

**The channel reuses the proven Phone-a-Friend HTTP pattern.** Phone-a-Friend already solves the hard part — agent-to-extension communication from inside a worktree. The mechanism: the LocalApiServer port is interpolated into the agent's dispatch prompt at build time (`agentPromptBuilder.ts:907`: `PHONE_A_FRIEND_DIRECTIVE(options.apiPort)`), so the agent runs a simple `curl -s -X POST http://127.0.0.1:${port}/phone-a-friend …` with no port-file discovery, no filesystem walk-up, and no worktree-root resolution. This is tested and working from worktrees. The orchestrator request channel uses the same pattern: a `POST /orchestrator/request` endpoint on LocalApiServer, with the port interpolated into fleet dispatch prompts at build time (subtask 4's job). The extension handler writes each request to `.switchboard/orchestrator/inbox/` — the extension is always running in orchestration mode (it's what wakes the orchestrator), so the LocalApiServer is up by definition.

A **session log** gives the run an auditable narrative and a place for the orchestrator to record what it did and what it escalated.

## Metadata
**Complexity:** 4
**Tags:** backend, feature, cli
**Project:** Switchboard

## User Review Required

None. Two calls that could have been escalated were decided instead:
- **Request-file format:** Markdown with YAML frontmatter (not JSON) — decided, rationale in Proposed Changes. The extension writes the file (not the agent), so the format is an internal convention, not an agent-facing API contract.
- **Gitignore posture:** both inbox and session log stay **local-only** (already covered by the existing `.switchboard/*` ignore rule; zero gitignore changes) — decided, rationale in Proposed Changes.

## Complexity Audit

### Routine
- `POST /orchestrator/request` endpoint on LocalApiServer — mirrors the shipped `_handlePhoneAFriend` handler (`LocalApiServer.ts:650-694`): auth check, JSON body parse, field validation, callback to the host. ~30 lines following a proven pattern.
- Inbox file writes from the endpoint handler — `mkdir -p` + write frontmatter+body markdown + done. The extension is the writer, so there is no worktree-root resolution, no atomic-rename protocol, no concurrent-writer collision risk.
- Session-log format spec (documentation only — the writers are subtasks 2 and 5).
- The dispatch-prompt directive that tells agents to use the channel — mirrors `PHONE_A_FRIEND_DIRECTIVE` (`agentPromptBuilder.ts:483`); subtask 4 interpolates the port at build time.

### Complex / Risky
- **Cross-subtask contract stability.** Subtasks 2, 4, and 5 all reference the paths, field names, and `processed/` rule fixed here; renaming anything later ripples across three plans.
- **Dispatch-prompt directive must reach every fleet agent.** Subtask 4's dispatch prompts must interpolate the port and include the request directive — mirroring how `PHONE_A_FRIEND_DIRECTIVE` is appended to coder/lead/intern prompts (`agentPromptBuilder.ts:1253, 1299, 1341, 1379`). A fleet agent that doesn't receive the directive can't file requests; this is a build-time contract, not a runtime discovery.

## Edge-Case & Dependency Audit

**Race Conditions**
- **Concurrent requests:** multiple agents POSTing requests simultaneously. The LocalApiServer handles HTTP requests serially per connection; the endpoint handler writes each to a uniquely-named file (`req-<UTC>-<stage>-<random>.md`). No shared append file, no collision risk.
- **Interrupted drain:** a wake killed mid-drain must be re-runnable. The processed move is per-file `mv` into `inbox/processed/`; re-running skips already-moved files. (The drain itself is subtask 5; this plan fixes the convention that makes it idempotent.)
- **Session-log interleaving:** only the orchestrator writes the session log (single writer by convention — fleet agents use the inbox, never the log), so no append lock is needed.

**Security**
- The endpoint inherits the existing localhost boundary and `_checkAuth` gate (`LocalApiServer.ts:651` — same auth as Phone-a-Friend). No new network surface.
- Field values are flattened to single lines before being written into frontmatter (strip `\n`/`\r`), so a malicious/clumsy request body cannot forge extra frontmatter keys; the free-form body goes below the closing `---` where nothing is parsed.
- The endpoint writes only under `<workspaceRoot>/.switchboard/orchestrator/` — the workspace root is resolved by the host (same `_resolveWorkspaceRoot` path every other handler uses), never from user-supplied input.

**Side Effects**
- Creates `.switchboard/orchestrator/inbox/processed/` on first request. Both are already gitignored by the existing `.switchboard/*` rule (`.gitignore:49`, managed block written by `src/services/WorkspaceExcludeService.ts:6-7`), so `git status` stays clean — no user-visible repo churn.

**Dependencies & Conflicts**
- **Consumed by** subtask 5 (wake/triage drains `inbox/`, moves to `processed/`, appends session-log summaries) and subtask 2 (persona doc references both paths). Their plans already cite `.switchboard/orchestrator/inbox/`, `processed/`, and `.switchboard/orchestrator/session-log.md` — the paths chosen here match them exactly.
- **Advertised by** subtask 4: kickoff dispatch prompts must interpolate the LocalApiServer port and include the request directive (mirroring the Phone-a-Friend build-time-interpolation pattern at `agentPromptBuilder.ts:483`). Subtask 4 owns the directive text; this plan owns the endpoint it targets.
- **Independent of** subtask 1 (mode foundation) — nothing here touches `autobanState.ts` or the UI.

## Dependencies

None (no `sess_` sessions apply).

Sibling ordering: independent of subtask 1; must land **before or alongside** subtasks 2 and 5, which consume the inbox/session-log convention fixed here; subtask 4's dispatch prompts must interpolate the port and include the request directive.

## Adversarial Synthesis

The original design's failure mode was silent misdelivery from worktree CWDs — a problem that no longer exists because the HTTP pattern (proven by Phone-a-Friend) eliminates filesystem root resolution entirely. The port is baked into the dispatch prompt at build time; the agent runs `curl`; the extension handler writes to the correct workspace root. The remaining failure mode is a fleet agent that never received the request directive in its dispatch prompt — mitigated by subtask 4 mirroring the Phone-a-Friend directive interpolation pattern. The field/path contract must be treated as frozen once subtasks 2/4/5 build against it.

## Proposed Changes

### 1. `.switchboard/orchestrator/` — inbox + session-log convention (normative spec; the writer is the LocalApiServer endpoint in section 2)

**Context.** One file per request, uniquely named. Fields: `from` (agent/terminal), `stage` (planner|coder|reviewer), `type` (question|warning|research|blocked), `planId`/`feature`, `body`, and optional `worktreePath`. Processed requests move to `inbox/processed/` so a wake never reprocesses them — mirrors the seen-set discipline used elsewhere for at-least-once handling. Sibling plans (subtasks 2 and 5) already reference these exact paths.

**Logic.**
- **Layout:**
  - `.switchboard/orchestrator/inbox/` — pending requests, one file each.
  - `.switchboard/orchestrator/inbox/processed/` — handled requests (moved, never deleted, so the human can audit).
  - `.switchboard/orchestrator/session-log.md` — append-only orchestrator narrative.
- **Request file format — DECIDED: Markdown with YAML frontmatter** (`.md`), not JSON. Rationale: the two readers are an LLM orchestrator and a human — both read markdown natively; the free-form `body` needs no escaping when it lives below the frontmatter; and it matches every other artifact convention in this repo (plans, features, SKILL.md all use frontmatter + body).
- **Request schema:**

  ```markdown
  ---
  from: coder-terminal (merge-prompt-button)
  stage: coder            # planner | coder | reviewer
  type: question          # question | warning | research | blocked
  planId: a1b2c3d4-…      # optional — the plan the request concerns
  feature: Orchestration Automation Mode   # optional — feature topic
  worktreePath: /Users/me/Documents/GitHub/worktrees/switchboard/merge-prompt-button   # optional
  created: 2026-07-07T03:15:00Z
  ---

  The plan says the config key is `feature_worktree_mode` but the code reads
  `featureWorktreeMode` — which is authoritative? Blocked on subtask 2 until answered.
  ```

  All frontmatter values are single-line (the endpoint handler strips newlines); the body below `---` is free-form markdown and is never parsed for fields.
- **Filename scheme — DECIDED:** `req-<UTC compact timestamp>-<stage>-<random>.md`, e.g. `req-20260707T031500Z-coder-19073.md`. Sortable by arrival time, stage visible at a glance, random suffix guarantees uniqueness across concurrent requests. `planId` stays in frontmatter (UUIDs are too long for filenames).
- **Gitignore posture — DECIDED: both inbox and session log are local-only.** Verified: `git check-ignore` shows `.switchboard/orchestrator/**` is already ignored by the managed `.switchboard/*` rule (`.gitignore:49`; block owned by `WorkspaceExcludeService.ts:6-7`), and `orchestrator/` is deliberately **not** added to the whitelist (`!.switchboard/plans/` etc.). Rationale: (a) this is machine-local runtime state, same class as `kanban.db` which the managed block explicitly never commits; (b) an unattended orchestrator committing session-log churn to main would pollute the auto-commit-before-review flow and invite merge conflicts with feature branches merging back. The decision is explicit and requires **zero** gitignore changes. (A future opt-in to whitelist `!.switchboard/orchestrator/session-log.md` via `WorkspaceExcludeService` is possible but out of scope.)

**Implementation.** No files are created in `.switchboard/` by this subtask at rest — directories are bootstrapped on first request by the endpoint handler (section 2). The convention spec below is referenced by subtask 2's persona doc.

**Edge Cases.** Directory bootstrap on first request; unique filenames per request (never a shared append file); idempotent drain via per-file `mv` to `processed/` (safe to re-run if a wake is interrupted mid-drain); drain ignores the `processed/` subdirectory itself.

### 2. `src/services/LocalApiServer.ts` — `POST /orchestrator/request` endpoint (new)

**Context.** The agent-to-orchestrator channel reuses the proven Phone-a-Friend HTTP pattern. Phone-a-Friend already solves the hard part — agent-to-extension communication from inside a worktree — by interpolating the LocalApiServer port into the agent's dispatch prompt at build time (`agentPromptBuilder.ts:907`: `PHONE_A_FRIEND_DIRECTIVE(options.apiPort)`), so the agent runs a simple `curl` with no port-file discovery or filesystem walk-up. This is tested and working from worktrees. The orchestrator request channel uses the same mechanism: a new endpoint that accepts typed requests and writes them to the inbox.

**Logic.** Mirror the `_handlePhoneAFriend` handler (`LocalApiServer.ts:650-694`):
- Auth: `_checkAuth(req, true)` — same gate as Phone-a-Friend (`:651`).
- Body: `{ stage: string, type: string, from?: string, planId?: string, feature?: string, body: string, worktreePath?: string }`.
- Validation: `stage` must be `planner|coder|reviewer`; `type` must be `question|warning|research|blocked`; `body` must be non-empty. Reject with 400 on violation (same shape as Phone-a-Friend's `:673-682`).
- Callback: invoke the host-supplied `onOrchestratorRequest` callback (same options-pattern as `onPhoneAFriend` at `:660`), which resolves the workspace root via `_resolveWorkspaceRoot` and writes the request file to `.switchboard/orchestrator/inbox/` following the convention in section 1.
- Response: `200 { success: true, file: "<path>" }` on success; `503` if no callback wired (headless/test); `500` on handler error — same shape as Phone-a-Friend (`:687-692`).

**Route registration.** Add alongside the Phone-a-Friend route at `:1401`:

```ts
} else if (pathname === '/orchestrator/request' && req.method === 'POST') {
    await this._handleOrchestratorRequest(req, res);
}
```

**Options type.** Add to the `LocalApiServerOptions` interface (near `onPhoneAFriend` at `:89`):

```ts
onOrchestratorRequest?: (request: {
    stage: string; type: string; from?: string;
    planId?: string; feature?: string; body: string; worktreePath?: string;
}, workspaceRoot?: string) => Promise<{ success: boolean; file?: string; error?: string }>;
```

**Implementation.** The host callback (wired in `TaskViewerProvider.ts` near the Phone-a-Friend wiring at `:1125`) resolves the workspace root, `mkdir -p` the inbox, flattens frontmatter values to single lines, writes the markdown file with the schema from section 1, and returns the path. ~30 lines of handler + ~20 lines of host callback, following a proven pattern end-to-end.

**Edge Cases.** Missing optional fields (`from`, `planId`, `feature`, `worktreePath`) → omit from frontmatter (same conditional-emit pattern as every other frontmatter writer in the repo). Concurrent requests → unique filenames via timestamp + random suffix (the handler generates the filename, not the agent). No `.switchboard/orchestrator/` directory yet → `mkdir -p` in the handler (first request bootstraps it).

### 3. Dispatch-prompt directive — subtask 4 owns the text, this plan defines the contract

**Context.** Fleet agents learn the channel the same way they learn Phone-a-Friend: a directive appended to their dispatch prompt at build time, with the port interpolated. `PHONE_A_FRIEND_DIRECTIVE` (`agentPromptBuilder.ts:483`) is the exact pattern to mirror.

**Contract.** Subtask 4's kickoff dispatch prompts must include a directive equivalent to:

```
ORCHESTRATOR REQUEST: If you hit a blocker, ambiguous requirement, or need research before proceeding, file a request to the orchestrator by running:
curl -s -X POST http://127.0.0.1:${PORT}/orchestrator/request -H "Content-Type: application/json" -d '{"stage":"coder","type":"question","from":"<your terminal>","planId":"<plan id>","body":"<your question>"}'
Use type "question" for clarifications, "warning" for risks, "research" for needing investigation, "blocked" for hard blockers. Do NOT use this for routine progress — the orchestrator checks git/board state directly.
```

The port is interpolated at build time by subtask 4 (mirroring `PHONE_A_FRIEND_DIRECTIVE(options.apiPort)` at `:907`). This plan does not author the directive text — it defines the endpoint contract the directive targets.

**Edge Cases.** A fleet agent that doesn't receive the directive can't file requests — this is a build-time contract enforced by subtask 4, not a runtime discovery. The directive is mandatory in the prompt (same as Phone-a-Friend's "you MUST notify"), but a missing orchestrator is non-fatal (the POST returns 200 on ack regardless of whether anything drains it).

### 4. Session log — `.switchboard/orchestrator/session-log.md` (format spec; writers are subtasks 2 & 5)

**Context.** Append-only markdown. The orchestrator writes a dated triage summary each wake: what it read, what it verified from git, what it advanced/dispatched/merged, and what it escalated to the human. Human-readable is the priority (this is the "what happened overnight" record).

**Logic — entry format (normative, documented in this plan):**

```markdown
## Wake — 2026-07-07T03:15Z

**Inbox:** 2 drained (req-20260707T031002Z-coder-19073.md, req-20260707T031440Z-reviewer-2214.md)
**Verified:** feature "Merge Prompt" — 3/3 subtask branches ahead of integration; feature "Tickets Editor" — no commits yet
**Actions:** advanced a1b2c3 to CODE REVIEWED; dispatched research agent for req-…-coder-…
**Escalations:** planner-stage question in req-…-reviewer-… — needs human answer
```

Rules: one `## Wake — <UTC>` heading per wake; entries only ever appended (never rewritten); a one-time `# Orchestrator Session Log` H1 is written when the file is first created; **single writer** — only the orchestrator appends (fleet agents use the inbox); escalations must appear under the `**Escalations:**` field so a human can grep one token for everything needing attention.

**Implementation.** Documentation only in this subtask; subtask 5 implements the append, subtask 2 encodes the discipline in the persona.

**Edge Cases.** File absent on first wake → `cat >>` semantics create it; log grows unboundedly → acceptable for now (append-only history is the point; rotation is a non-goal and can be a later follow-on).

## Verification Plan

Manual/behavioral verification only (per session directive — no compile runs, no automated test suites executed):

1. **Happy path — POST from the main checkout:** with the extension running, `curl -s -X POST http://127.0.0.1:<port>/orchestrator/request -H "Content-Type: application/json" -d '{"stage":"coder","type":"question","from":"manual-test","body":"Does this land?"}'` → expect `{"success":true,"file":…}` and a `req-*-coder-*.md` file in `.switchboard/orchestrator/inbox/` with valid single-line frontmatter and the body below `---`; `inbox/processed/` exists.
2. **Worktree path (the critical case):** create a scratch worktree (`git worktree add -b sb-test ../worktrees/switchboard/sb-test`), `cd` into it, POST with the port from the dispatch prompt → the request file must appear in the **main** checkout's `.switchboard/orchestrator/inbox/` (the extension resolves the workspace root, not the agent). Remove the worktree afterwards.
3. **Validation:** POST with `stage: "manager"` or `type: "status"` or empty body → 400 with a clear error. POST with valid enums → 200.
4. **Auth:** POST without a valid API token → 401 (same gate as Phone-a-Friend).
5. **Concurrency:** fire 10 POSTs in parallel → 10 distinct files, zero collisions, all parseable.
6. **Git cleanliness:** after tests 1-5, `git status` in the main checkout shows no `.switchboard/orchestrator` entries (confirms the local-only gitignore posture) — then clean up the test request files.
7. **Simulated drain (convention check for subtask 5):** manually `mv` the pending files into `inbox/processed/` and confirm a "second drain" (listing `*.md` directly in `inbox/`) sees nothing — moving/marking processed is safe to re-run.
8. **Session-log convention:** append two `## Wake — …` entries by hand following the spec and confirm they render as ordered, well-formed markdown.

### Automated Tests (deferred per session directive)

Would cover: endpoint field validation (enum enforcement, empty body rejection), filename uniqueness under parallel requests, frontmatter single-line flattening, auth gate. Not run as part of this plan.

## Out of scope

- The orchestrator's *consumption* of the inbox and its triage decisions (subtask 5) — this subtask provides the channel and log; subtask 5 acts on them.
- The dispatch-prompt directive text (subtask 4) and the persona doc that encodes the read side (subtask 2).
- Session-log rotation/pruning and any opt-in committing of the session log (would be a `WorkspaceExcludeService` whitelist follow-on).

## Research Findings Applied (2026-07-07)

The original plan's external-mechanism research (git worktree root resolution, APFS atomicity, Maildir pattern, mtime precision) was load-bearing for the file-based `request.sh` approach. With the switch to the HTTP/Phone-a-Friend pattern, none of those findings apply — the agent runs `curl` with a build-time-interpolated port, and the extension handler writes the file from the correct workspace root. No filesystem root resolution, no atomic-rename protocol, no Maildir semantics.

The one finding that remains relevant: **Phone-a-Friend is tested and working from worktrees** (user-verified), confirming that build-time port interpolation is a reliable agent-to-extension communication mechanism from any worktree CWD.

## Uncertain Assumptions

None remaining. The original plan's uncertain assumption (explicit control-plane mode marker location) was specific to the `request.sh` root-resolution chain and no longer applies.

Recommendation: **Send to Coder** (complexity 4 → effectively 2 with the HTTP pattern).

**Stage Complete:** PLAN REVIEWED
