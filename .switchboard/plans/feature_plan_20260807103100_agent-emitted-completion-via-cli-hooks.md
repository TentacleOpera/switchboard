# Agent-Emitted Completion: Let the CLI Report Turn-End Instead of Inferring It, and Surface the Blocked State the Board Cannot Currently Represent

## Goal

Have PTY-fleet agents report their own turn boundaries to the LocalApiServer via the CLI's native hook mechanism, and use those events to (a) clear the activity light the instant a turn ends rather than on filesystem-watch latency, and (b) introduce a third card state — **blocked / waiting on you** — which the board today cannot represent at all.

### Problem

Two distinct problems, one root.

**1. Completion is inferred, and the inference is lossy.** The only completion signal is the plan file's mtime advancing (`PlanIngestionEngine.ts:853` → `KanbanDatabase.ts:9588`), with a blind 10-minute timeout as backstop (`PlanIngestionEngine.ts:250`). An agent that finishes a turn without writing to the plan file produces no signal whatsoever; the card stays lit until the timer expires. The predecessor mechanism — a `**Stage Complete: <COLUMN>**` marker the agent appended — was retired and is now explicitly vestigial (`agentPromptBuilder.ts:318`, and see the stale comments at `KanbanDatabase.ts:357` and `:9584` that still describe it as the off-switch), leaving mtime as the sole carrier. Nothing replaced the agent's ability to *say* it was done.

**2. The board conflates "working" with "blocked", and blocked is the state the operator actually needs.** `working` is a single boolean derived from `dispatched_at` and its age (`isWorkingState`, `KanbanProvider.ts:142` and `bootstrap.ts:148`). An agent grinding through a build and an agent that stopped 8 minutes ago to ask "Do you want me to proceed?" render identically. For a fleet operator running many seats, "which seat is blocked on me" is the only question that determines what to do next, and the system cannot answer it. This is a missing capability, not a bug — no amount of tuning the timeout produces it.

### Root cause

Switchboard spawns the agent process itself and then declines to use that authority. `PtyFleetService.create` (`ptyFleetService.ts:75-118`) constructs the pty; `PtyTerminalBackend` accepts an `env` map (`ptyBackend.ts:78`, consumed at `:89-96`); `injectStartupCommand` (`:121-133`) delivers the user's configured launch command into the shell. Every modern agent CLI exposes a lifecycle-event mechanism — Claude Code's `Stop`, `Notification` and `SessionEnd` hooks among them. Owning the spawn means the correct signal is available for the cost of configuring it, and the system instead sniffs the filesystem for a side effect.

### Why this beats every output-based heuristic

An emitted event is deterministic, arrives at the turn boundary rather than after a debounce, names its own terminal, and requires no per-CLI TUI reverse-engineering. Output-based idle detection (sibling plan `pty-screen-state-idle-detection-headless-vt`) exists as the fallback for CLIs with no hook mechanism, and is strictly worse where hooks exist.

## Metadata

- **Complexity:** 7
- **Tags:** backend, terminals, kanban, api, database, security, feature

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a POST route to the `LocalApiServer` pathname chain (`:3486+`).
- Generating a JSON settings file under `.switchboard/`.
- Adding the new state to the card payload builders.

### Complex / Risky

- **The startup command is not an argv — it is typed into an interactive shell.** `injectStartupCommand` (`ptyFleetService.ts:121-133`) awaits `SHELL_READINESS_DELAY_MS` and then calls `handle.sendText(cmd, true)`, which writes `cmd + '\r'` into the pty (`ptyBackend.ts:100-103`). There is no argument vector to append to. Appending `--settings <path>` is therefore a **shell-text** append, subject to quoting and to whatever the user's string already does:
  - `zsh -ic 'claude'` → the flag lands **outside** the quotes, so `zsh` receives it, not `claude`. Silent misbehaviour or an error, depending on the shell.
  - `claude && echo done` → the flag lands after `done`.
  - `my-wrapper.sh` → the flag reaches the wrapper, which almost certainly rejects it.

  `GlobalIntegrationConfigService.getAgentStartupCommands()` (`:526`) returns `Record<role, string>` straight from user config, and real-world values include exactly these shapes. Blindly appending corrupts a non-trivial share of installs. The parse gate must require *both* that the first token is a known Claude Code invocation *and* that the string contains no shell metacharacters (`|`, `&`, `;`, `` ` ``, `$(`, `'`, `"`, newline). On any doubt, skip injection and leave the command untouched. A skipped injection costs a feature; a corrupted startup command costs the terminal.
- **Passing a partial `env` map replaces the entire environment.** `ptyBackend.ts:89` reads `const env = (options.env || process.env)` — an `||`, not a merge. Handing it `{ SWITCHBOARD_TERMINAL, SWITCHBOARD_API_PORT, SWITCHBOARD_HOOK_TOKEN }` spawns a login shell with **no `PATH`, no `HOME`, no `TERM`, no `SHELL`** — every fleet terminal breaks, including seats with no dispatched card. Note also that `PtyFleetService.create` currently passes only `{ name, cwd }` to `backend.create` (`:84-87`) and has never exercised the `env` option at all, so this landmine is unproven in production. Spread at the call site: `env: { ...process.env, ...switchboardVars }`. Do not "fix" the `||` inside `ptyBackend` — `create` is its only caller, so changing the semantics there is a wider blast radius for no gain.
- **Auth on the extension host is localhost-trust, so a scoped token buys identity, not isolation.** `_checkAuth` (`LocalApiServer.ts:544-576`) opens with `const expected = await this._options.getAuthToken(); if (!expected) { return true; }`, and the in-code note at `:578-581` states plainly that Switchboard has no API-token setter UI, so `getAuthToken()` is effectively always empty and auth is loopback-trust. Under standalone a session token *does* exist (Bearer header or the `sb_session` cookie). Consequences that must shape the design:
  - On the extension host, any local process — including the agent — can already `POST /kanban/move` with **no** Authorization header and be accepted. A per-terminal token that is rejected on other routes does not prevent that, because not presenting a token is the permitted path.
  - The scoped token's real and sufficient job is **terminal-identity attestation**: it proves *which* terminal is reporting, so terminal A cannot clear terminal B's card, and a random local process cannot forge turn-end for a seat it does not own. That is worth having and is the honest justification.
  - Not putting the session token in the pty env remains correct — under standalone it would hand the agent the board-admin credential outright. The change is to the rationale and to what the verification can assert, not to the decision.
- **Do not extend `_checkAuth` with a scope parameter.** It compares against exactly one `expected` value with a length-gated constant-time compare and is called from a dozen sites (`:636, 688, 742, 773, 797, 1045, 1174, 1317, 1366, …`). Widening it to accept a second token class puts every one of those at risk. Add a separate `_checkHookAuth(req)` used only by `/agent/event`. Note also that `_checkAuth`'s existing `requireAuth` parameter is **not referenced in the body** — do not build on it assuming it gates anything.
- **Do not write to the user's `.claude/` directory.** `.claude/settings.json` is shared and frequently committed; `.claude/settings.local.json` is still user-owned. Per the repo's standing rule, `.claude/` is shared territory and edits there must be surgical or absent. Generate a Switchboard-owned settings file under `.switchboard/agent-hooks/` and point the CLI at it with `--settings`, so nothing in the user's config is read-modify-written and there is nothing to clean up or migrate on uninstall.
- **A third state requires a schema migration, and the version is V59, not V58.** `working` is derived, not stored; representing "blocked" needs persistence. The highest shipped migration is V57 (`MIGRATION_V57_SQL`, `KanbanDatabase.ts:413`; chain block `:8162-8171`), but the sibling `pty-liveness-heartbeat-gates-activity-light-sweep` plan takes **V58** for `last_liveness_at`. This plan is **V59**. Two plans claiming the same version is not a merge conflict that surfaces — whichever lands second is silently skipped by the `getMigrationVersion()` gate and its column is simply never added, on every install that already ran the first. Standing repo rules apply and are non-negotiable: never edit a shipped `MIGRATION_Vnn_SQL` body, never stamp a baseline to skip the chain, and remember `SCHEMA_TABLES` is not the current schema — a fresh DB replays V20→V59.
- **`blocked` must flow through the derive layer, not just the builders.** `working` is not simply written at the card-build sites; it is *computed* by `isWorkingState`, which exists as **two independent copies** (`KanbanProvider.ts:142`, `bootstrap.ts:148`) and is consumed at four sites (`KanbanProvider.ts:1845`, `:3474`, `:3679`, `bootstrap.ts:196`), with a fifth builder hardcoding `working: false` (`KanbanProvider._buildCardsFromDbSessionIds`, `:7369`). The sibling liveness plan widens exactly these functions to a `MAX(dispatched_at, last_liveness_at)` age basis. This plan must **extend that same widened derive**, not add a parallel `blocked` computation beside it — otherwise blocked cards expire on a different clock than working cards and the two states disagree at the boundary.
- **Turn-end and waiting-for-user are separate events, which is better than this plan originally assumed.**

  > **Superseded:** "`Stop` fires on every turn end, not on plan completion. This is the crux of the design. An agent that stops to ask a question fires `Stop` exactly like one that finished. The event alone is therefore *not* a completion signal — it becomes one only in combination with whether the plan file was touched during the turn."
  > **Reason:** Web research against the Claude Code hooks reference (Aug 2026) contradicts this. `Stop` fires when the CLI completes its generation/tool turn and returns control. Pausing for the user does **not** fire `Stop` — it fires `Notification` (attention required / clarifying question), `PermissionRequest` (tool call needs approval), or `Elicitation` (MCP structured input request). The two states the board needs are therefore distinguished by the CLI itself, deterministically, rather than needing to be inferred from a filesystem side effect.
  > **Replaced with:** Register **both** families. `Stop` → candidate completion. `Notification` / `PermissionRequest` / `Elicitation` → blocked. The plan-file `updated_at` comparison survives as a **secondary** guard on the `Stop` path only (a `Stop` with no file change is suspicious, not authoritative), not as the mechanism that separates the two states.

  This removes the plan's single largest correctness risk. It does not remove the need for the `updated_at` comparison, and it does not change the schema, the endpoint, or the board work.
- **`StopFailure` exists and must be handled.** Added in v2.1.78 (March 2026), it fires when a turn terminates on an unrecoverable error or API failure. That is neither "done" nor "still working" — it is a seat that needs a human, so it maps to **blocked**, not to `clearWorkingState`. Omitting it leaves a crashed agent lit until the timeout.
- **The hook command must never exit 2.** Claude Code's hook exit-code contract is load-bearing: **0** = allow, **2** = *block / reject / interrupt* (stderr is fed back to the model), **1** = non-blocking error (logged, execution proceeds). A naive `curl` in the generated hook file returns non-zero when the POST fails — and if that propagates as 2, a transient failure to reach the LocalApiServer **interrupts the agent mid-work**. The generated command must terminate with an explicit `exit 0` (or `|| true`), and must never let a network failure select the block path. This is the concrete form of "never let a failed POST block the agent": the danger is not latency, it is the interrupt semantics of the exit code.
- **`--settings` outranks the user's own hook config, so injection can silently disable their hooks.** The documented precedence is Enterprise Managed Policies > CLI flags (`--settings`) > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`. Switchboard's file therefore wins. Whether it *replaces* the whole hooks map or merges per-event is not settled by the docs and must be probed at implementation time against the installed version. If it replaces, a user with their own `Stop` hook loses it the moment Switchboard dispatches to that seat — a silent regression in someone else's workflow, which is exactly the class of harm this plan's "write no user files" rule exists to avoid. If the probe shows replacement, the mitigation is to read the user's existing hook config and re-emit their entries alongside Switchboard's in the generated file (read-only on their side; still no writes to `.claude/`).
- **Do not set `CLAUDE_CODE_DONT_INHERIT_ENV=1`.** That variable forces Claude Code to spawn shells with an empty base environment. Hook processes otherwise inherit the CLI's environment — which is what makes the `SWITCHBOARD_*` vars readable from the hook command at all. Setting it would scrub exactly the values this design depends on. Note also that v2.1.169/170 (Aug 2026) fixed session-transcript loss "when launched from host environments inheriting pre-set environment variables" — host-injected env has a known-buggy history here, so pin the minimum-supported version rather than assuming.
- **`--safe-mode` / `CLAUDE_CODE_SAFE_MODE` strips all hooks.** A user running in safe mode emits no events. Degrades to mtime, which is the designed fallback — but it means "no events arriving" must never be treated as an error state or logged repeatedly.
- **The payload carries no terminal name.** The stdin JSON is `{ session_id, transcript_path, cwd, hookEventName, reason, last_assistant_message }`. There is no terminal identity in it, which confirms the env-injection approach is necessary rather than merely convenient. `cwd` is present and is a useful **secondary** attribution anchor for worktree seats, where the cwd is unique per terminal — worth using as a fallback when `SWITCHBOARD_TERMINAL` is missing, not as the primary key.
- **Hook names and payload shape remain version-coupled to the CLI.** The event surface grew from 5 events (mid-2025) to ~30 (mid-2026) and the release cadence is rapid (v2.1.200+ current as of Aug 2026); core fields (`session_id`, `cwd`, `hookEventName`) have stayed backward-compatible, but names have churned elsewhere (`/fork` → `/branch` in v2.1.77). Verify against the installed version at implementation time. Keep CLI-specific shape translation in the generated hook command and have the endpoint accept a normalised `{ terminal, event, planFile? }` body, so a CLI-side rename is a one-file change.

## Edge-Case & Dependency Audit

### Race conditions

- **Race between the hook and the plan-file watcher.** Both can fire for one turn. `clearWorkingState` is idempotent (`:9588`); the second arrival finds `dispatched_at` already NULL. Ensure the completion broadcast (`setOnWorkingStateCleared` → `broadcastAgentCompleted`, `extension.ts:1070`; `bootstrap.ts:426`) fires once, not twice — gate on the actual non-null→null transition, which that seam already does.
- **Determining "was the plan file touched during this turn"** must not re-stat and race the watcher. Compare the plan row's `updated_at` against the turn's start (the last dispatch or last `Stop`), using the ingestion the watcher already performed.
- **Port instability.** The API server binds an ephemeral port. A hook file written at spawn time with a stale port silently no-ops after a restart. Write the endpoint into the file at terminal-create time from the live server, and treat hook delivery as best-effort — never let a failed POST block or slow the agent.

### Security

- **The scoped token is readable by the agent, by design.** Anything in the pty's env is readable by every process the user runs in that terminal, including the agent, which can be prompted. Treat "the agent can read its own hook token" as in-scope-by-design and "the agent can read the board-admin token" as unacceptable — which is why the session token is not injected.
- **Scope enforcement is asymmetric across hosts.** Under standalone, a scoped token presented to `/kanban/move` must be rejected. On the extension host there is nothing to reject, because no-token is already accepted on every route (see the Complexity Audit). Do not write a verification step that asserts a 401 on the extension host; it will fail for reasons this plan does not introduce and cannot fix. The pre-existing loopback-trust posture is out of scope.
- **Token minting must be per-terminal and non-guessable.** A shared hook token collapses the identity guarantee that is the token's only real job.

### Side effects

- **One extra column on `plans`.** `blocked_at TEXT DEFAULT NULL`. Additive, nullable, ignored by every existing read.
- **Generated files under `.switchboard/agent-hooks/`.** One per live terminal, deleted on close. Per the repo's scaffold-litter rule, never `mkdir .switchboard` itself — it already exists for any Switchboard workspace; create only the `agent-hooks` subdirectory, and only when a hook is actually being written.
- **Inert env vars on every fleet terminal.** The three `SWITCHBOARD_*` vars are set even for non-Claude roles where no hook file is generated. Harmless and useful for debugging, but it means the env spread in `create()` runs unconditionally — which is precisely why the `{...process.env}` merge is not optional.

### Dependencies & conflicts

- **Hook fires for a terminal with no dispatched card.** The user chatting manually in a coder seat will emit `Stop` constantly. The endpoint must resolve terminal → card via `plans.dispatched_terminal` (written by `updateDispatchInfoByPlanFile`, `KanbanDatabase.ts:9545`) and no-op when there is no live `dispatched_at`. Never let a manual conversation clear an unrelated card.
- **Empty `dispatched_terminal`.** Written as `''` when the dispatcher had no terminal name (see `TaskViewerProvider.ts:912`). Unresolvable; no-op.
- **Terminal renamed after dispatch.** `rename` (`ptyFleetService.ts:159-171`) changes the fleet map key and both `friendlyName` and `name`, but not `plans.dispatched_terminal`. The env var baked at spawn time still carries the *original* name — which is the correct anchor here, since it matches what dispatch recorded. Resolve on the env-carried identity, not the current fleet name.
- **Blocked must expire.** A card left blocked by an agent that later dies would stick forever. The stale sweep must clear `blocked_at` on the same timeout it clears `dispatched_at`, and the sibling liveness plan's exited-terminal force-clear applies equally — including its `recentlyClosed` tombstone, without which an operator-killed terminal never reports as exited at all.
- **Non-Claude agents.** Codex, Gemini, Aider, Devin and custom roles have different or absent hook mechanisms. Every one of them must keep working exactly as today with no hook file, no `--settings` append, and no behaviour change beyond the inert env vars. This is additive per-agent capability, never a precondition.
- **Standalone and extension parity, and the wiring site is not where the original draft said.** The fleet is constructed **twice, in different processes**: `bootstrap.ts:1480` (`new PtyFleetService(workspaceRoot, db)`, in-process under standalone) and `ptyHost.ts:43` (`new PtyFleetService(workspaceRoot)`, inside the forked child under the extension). `TaskViewerProvider.ts:1908` spawns that child with `['--workspace', effectiveRoot]` — it does not construct a fleet. So the extension host's hook context must be plumbed **into the child** (an extra argv pair, or the existing handshake) and applied at `ptyHost.ts:43`. The child needs the *extension's* API port and a minter that reaches the extension's server, not its own.
- **Blocking prerequisite: `pty-liveness-heartbeat-gates-activity-light-sweep`.** Not merely advisory. That plan (a) takes V58 so this one can be V59, (b) provides the exited-terminal force-clear and `recentlyClosed` tombstone this plan's `blocked` expiry relies on, and (c) widens `isWorkingState` ×2 and `getFeatureWorkingStates` onto a single age basis that this plan extends rather than forks.
- Independent of `pty-screen-state-idle-detection-headless-vt`; that plan is the fallback for agents this one cannot cover, and it extends this plan's decision path rather than adding a second one.

## Dependencies

- **Blocking:** `pty-liveness-heartbeat-gates-activity-light-sweep` — V58, the exited/tombstone force-clear, and the widened derive layer.
- Owns **V59** (`blocked_at`) and owns the `blocked` decision path that the screen-state sibling later extends.

## Resolved Assumptions

The external unknowns this plan carried were settled by web research against the Claude Code hooks/settings/CLI references (Aug 2026) and the project CHANGELOG. **Authoritative — do not re-open or re-research these.**

- **Turn-end and waiting-for-user are distinct events. RESOLVED — and it changed the design.** `Stop` fires on turn completion; pausing for the user fires `Notification`, `PermissionRequest` or `Elicitation`. The CLI distinguishes the two states itself, so the blocked state has a deterministic trigger rather than an inferred one. See the superseded callout in the Complexity Audit and in §2. Also confirmed: `StopFailure` (v2.1.78) for unrecoverable errors, which maps to blocked.
- **`--settings <PATH|JSON>` exists and accepts a path outside the project. RESOLVED — approach validated.** Introduced late 2025 / early 2026. Precedence is Enterprise Managed Policies > CLI flags > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`. The "write no user files" guarantee holds. **New consequence, now tracked as a code/probe task rather than a research question:** because `--settings` outranks the user's own config, it may replace rather than merge their hooks map — probe at implementation time and re-emit their entries if so.
- **Hook processes inherit the CLI's environment, including `PATH` and `HOME`. RESOLVED — env approach validated.** The `SWITCHBOARD_*` vars will be readable from the hook command. Do **not** set `CLAUDE_CODE_DONT_INHERIT_ENV=1`, which forces an empty base environment and would scrub them.
- **Payload schema. RESOLVED.** Stdin JSON: `{ session_id, transcript_path, cwd, hookEventName, reason, last_assistant_message }`. It carries **no terminal identity**, which confirms env injection is necessary; `cwd` is available as a secondary attribution anchor.
- **Exit-code contract. RESOLVED, and it added a safety requirement the plan was missing.** 0 = allow, **2 = block/interrupt**, 1 = non-blocking error. The generated hook command must force `exit 0` so a failed POST cannot interrupt the agent. See the Complexity Audit and §3.

Residual, and deliberately not a research question — verify against the **installed** version at implementation time, since the event surface grew from 5 to ~30 events between mid-2025 and mid-2026 and the release cadence is rapid (v2.1.200+ current): the exact spelling of each hook name and the presence of `PermissionRequest` / `Elicitation` on the user's build. Anything documented before Feb 2026 is legacy. The normalised four-event endpoint vocabulary in §2 exists precisely so this stays a one-file change.

## Adversarial Synthesis

Key risks: (1) the env injection as originally specified would have replaced rather than merged `process.env`, breaking every fleet terminal — corrected to a call-site spread; (2) the security rationale overstated what a scoped token achieves, since extension-host auth is loopback-trust with no token at all, so the token's justification is terminal-identity attestation and the 401 assertion is standalone-only; (3) the startup-command append is shell text rather than argv, so the parse gate must reject shell metacharacters, not just unknown binaries; (4) V58 collided with the sibling plan and would have been silently skipped by the migration gate — this plan is V59. Mitigations: merge-spread the env, a separate `_checkHookAuth` rather than widening `_checkAuth`, a metacharacter-and-first-token gate that fails closed, and an explicit migration-number handoff recorded in both plans and the feature file.

A fifth risk was retired rather than mitigated: the plan originally rested on `Stop` firing identically for "finished" and "stopped to ask", making the plan-file comparison the sole discriminator. Research refuted that — the CLI emits separate events for the two states — so the discriminator is now the CLI's own signal and the file comparison is a secondary guard. That is a strict reduction in risk, and it is the one place where the research made the design simpler rather than harder. Two new risks arrived in exchange, both now handled: the hook's exit code can *interrupt the agent* if a POST failure surfaces as exit 2, and `--settings` outranking the user's config may silently disable their own hooks.

The strongest standing objection: this couples Switchboard to a third-party CLI's hook API, which can change without notice. True, and mitigated rather than eliminated — the coupling is confined to one generated file and one normalised endpoint, every failure mode is a silent no-op back to mtime, and no code path depends on a hook ever arriving. The alternative couplings are worse: TUI screen-scraping couples to the CLI's *rendering*, which changes far more often than its hook contract.

Second objection: mtime already works, so this is redundant. It is not redundant for the blocked state, which mtime cannot express in principle — a blocked agent and a working agent both leave the file untouched. Even for pure completion, mtime's latency is watch-debounce plus ingestion, and it produces nothing at all for a turn that ends without a file write.

Third objection: injecting env and flags into the user's shell is invasive. Correct, and the reason the design writes no user files, mints a scoped token rather than sharing the session token, and refuses to modify a startup command it cannot confidently parse.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — V59 migration and state accessors

> **Superseded:** "New `MIGRATION_V58_SQL` … Append to the chain at `:8164`."
> **Reason:** The sibling liveness plan takes V58 for `last_liveness_at`, and it ships first. Two migrations stamped 58 do not conflict visibly — the `getMigrationVersion()` gate simply skips the second on every DB that already ran the first, so the column is never added and every read of it returns undefined. The cited append line was also off: the V57 block ends at `:8171`.
> **Replaced with:** `MIGRATION_V59_SQL`, appended after the V58 block this plan's prerequisite introduces.

- New `MIGRATION_V59_SQL`: `ALTER TABLE plans ADD COLUMN blocked_at TEXT DEFAULT NULL`. Add the column to the `CREATE TABLE plans` body (`:155` area) too, so fresh DBs have it from creation.
- Append the gate block after the V58 block. Use the same idempotency shape as its neighbours — either the `pragma_table_info` guard V51 uses (`:8063`) or the `try { exec } catch {}` V54/V56/V57 use (`:8110`, `:8155`, `:8165`). Do not touch the body of V51–V58.
- Add `blocked_at` to `PLAN_COLUMNS` (`:789` area) and to the row→record mapping (`:9747` area).
- `setBlockedState(planFile, workspaceId, blockedAt | null)`.
- Extend `clearWorkingState` (`:9588`) and `clearStaleWorkingState` (`:9603`) to null `blocked_at` alongside `dispatched_at` and `last_liveness_at`.
- Extend `getFeatureWorkingStates` (`:6180`) so a feature reports blocked when any subtask is blocked. It currently returns `Map<string, boolean>`; widen to a small record (`{ working, blocked }`) rather than adding a second parallel query — and update its three call sites (`KanbanProvider.ts:1827`, `:3453`, `:3658`; `bootstrap.ts:177`) together.

### 2. `src/services/LocalApiServer.ts` — the event endpoint

- New route in the pathname chain (`:3486+`, beside `/health` at `:3486` and `/kanban/move` at `:3526`): `POST /agent/event`, body `{ terminal, event: 'turn_end' | 'awaiting_user' | 'turn_failed' | 'session_end', planFile?, cwd? }`.

  The four normalised events are the *host's* vocabulary, not the CLI's. Map them in the generated hook file: Claude Code's `Stop` → `turn_end`; `Notification` / `PermissionRequest` / `Elicitation` → `awaiting_user`; `StopFailure` → `turn_failed`; `SessionEnd` → `session_end`. Keeping the endpoint's vocabulary independent of any one CLI's event names is what makes a CLI-side rename a one-file change, and it lets a second agent's differently-named events land on the same four without touching the server.
- Authenticate via a **new** `_checkHookAuth(req)` that accepts only per-terminal scoped tokens and is called from this route alone. Do not add a scope parameter to `_checkAuth` (`:544`) — it has a dozen callers and a single-`expected` constant-time compare.

  > **Superseded:** "Extend `_checkAuth` (`:543`) with a scope check; the scoped token must be rejected on every other route."
  > **Reason:** Two problems. (a) `_checkAuth` is called from ~12 sites and compares against exactly one `expected` token; teaching it a second token class widens the risk surface of every one of those callers for no benefit. (b) The stated guarantee is unachievable on the extension host, where `_checkAuth` returns `true` when no token is configured (`:546-547`) — which the in-code note at `:578-581` confirms is the normal state. "Rejected on every other route" is only true under standalone.
  > **Replaced with:** A separate `_checkHookAuth` on the `/agent/event` route only, with the scope guarantee asserted under standalone and the extension host's pre-existing loopback-trust posture documented as out of scope.

- Validate the body at the boundary per PRD contract #5 — this is a network-facing route taking untrusted input. Require only the fields the handler dereferences.
- Resolve terminal → plan row via `dispatched_terminal`, falling back to `cwd` when `terminal` is absent (worktree seats have a unique cwd); no live `dispatched_at` → `200 {ok:true, matched:false}` and stop.
- `awaiting_user` → set `blocked_at`, leave `dispatched_at`. This is now the **primary** blocked trigger and it is deterministic — the CLI is telling us it is waiting, not being inferred.
- `turn_failed` → set `blocked_at`, leave `dispatched_at`. A crashed or API-failed turn needs a human; it is not completion.
- `turn_end` → if the plan row's `updated_at` advanced since turn start, `clearWorkingState` and fire the existing completion broadcast. If it did not, still set `blocked_at` rather than clearing — a turn that ended with no work is at best ambiguous, and `blocked_at` expires on the stale sweep whereas a premature clear moves a card. This is now a **secondary guard**, not the mechanism separating done from blocked.

  > **Superseded:** "`stop` → … otherwise set `blocked_at` (agent stopped without producing work — that is 'waiting on you', not 'done')."
  > **Reason:** The rationale was built on the now-refuted premise that `Stop` also fires when the agent asks a question. It does not — `Notification`/`PermissionRequest`/`Elicitation` do. The branch is still worth keeping, but its justification changes from "this is how we detect a question" to "this is a conservative fallback for an ambiguous turn", and it must not be described as the primary blocked path.
  > **Replaced with:** The `turn_end`-without-file-change branch retained as a secondary guard, with `awaiting_user` as the primary blocked trigger.

- `session_end` → `clearWorkingState` unconditionally.
- Note the documented post-`Stop` flush behaviour: terminal output continues for some milliseconds *after* the hook process runs, because of PTY buffer flushing. Harmless here — this plan does not read output — but it means a `turn_end` event legitimately arrives before the terminal looks quiet, and any future code that cross-checks the two must not treat that as a contradiction.
- Return the outcome in the body per PRD contract #4 — `{ ok, matched, action }`, and `{ ok: false, error }` on every failure branch including the aggregate catch. Never a bare `{success:true}`.
- Register in `protocol-catalog.json` alongside the existing routes.

### 3. `src/standalone/ptyFleetService.ts` — generate the hook config and inject env

- Add `public setHookContext(ctx: { port: number; mintToken(terminal: string): string } | undefined)` on the service, called once by each host at construction. Do **not** add a fifth positional parameter to `create()` — its signature is already `(role, friendlyName?, cwd?, worktreePath?)` and every call site passes positionally.

  > **Superseded:** "Extend `create()` (`:75`) to accept `hookContext?: { port, mintToken(terminal): string }`, supplied by each host's construction site."
  > **Reason:** `create()` takes four positional optional parameters; a fifth would have to be threaded through every call site, and "supplied by each host's construction site" contradicts passing it to `create()` at all — the construction site constructs the *service*, not each terminal.
  > **Replaced with:** A service-level `setHookContext()` injected at construction, matching the injection style used for the engine's seams.

- In `create()`, build the env as `{ ...process.env, SWITCHBOARD_TERMINAL: name, SWITCHBOARD_API_PORT: String(port), SWITCHBOARD_HOOK_TOKEN: token }` and pass it to `backend.create` (`:84-87`), which currently receives only `{ name, cwd }`. **The spread is mandatory** — `ptyBackend.ts:89` does `options.env || process.env`, so a partial map replaces the whole environment and the shell launches with no `PATH`.
- Before `injectStartupCommand`, and only when the role's startup command passes the gate below, write `.switchboard/agent-hooks/<terminal>.json` containing the CLI's hook config. Create the `agent-hooks` directory if absent; never `mkdir` `.switchboard` itself. Requirements on the generated command:
  - Register handlers for `Stop`, `Notification`, `PermissionRequest`, `Elicitation`, `StopFailure` and `SessionEnd`, each mapping to one of the four normalised events in §2.
  - **Terminate with `exit 0` unconditionally** — e.g. `curl -fsS -m 2 ... >/dev/null 2>&1; exit 0`. Never allow a failed POST to surface as exit code 2, which is Claude Code's *block/interrupt* signal and would stop the agent mid-work on a transient localhost failure. A short `-m` timeout plus a forced `exit 0` makes hook delivery genuinely best-effort.
  - Read `SWITCHBOARD_TERMINAL` / `SWITCHBOARD_API_PORT` / `SWITCHBOARD_HOOK_TOKEN` from the environment. Hook processes inherit the CLI's environment, so this works — provided `CLAUDE_CODE_DONT_INHERIT_ENV` is **not** set (see Complexity Audit). If the implementation-time probe finds otherwise on the installed version, interpolate the literal values into the file at write time instead; the file is already per-terminal and already deleted on close, so this is a contained change.
  - Before writing, probe whether `--settings` merges with or replaces the user's existing hooks map. If it replaces, read their config and re-emit their entries alongside Switchboard's so their hooks keep firing. Read-only on their side — still no writes under `.claude/`.
- In `injectStartupCommand` (`:121-133`), append `--settings <generated path>` **only** when the user's command passes both gates: first token matches a known Claude Code invocation, **and** the string contains no shell metacharacters (`|`, `&`, `;`, backtick, `$(`, `'`, `"`, newline). Any other shape — including an empty string: inject nothing, log once, proceed unchanged. Remember the append is shell text delivered via `sendText`, not an argv element.
- Delete the generated file on terminal close (both the `onExit` path at `:103-111` and `kill()` at `:147-157`).

### 4. Host wiring

- `src/standalone/bootstrap.ts:1480` — after `new PtyFleetService(workspaceRoot, db)`, call `setHookContext({ port, mintToken })` with the live server's port and a minter backed by the standalone session.
- `src/standalone/ptyHost.ts:43` — after `new PtyFleetService(workspaceRoot)`, call `setHookContext(...)` using values received from the parent.
- `src/services/TaskViewerProvider.ts:1908` — the child is spawned with `['--workspace', effectiveRoot]`. Add the extension's API port and a minting secret (argv or the existing handshake) so the child can construct a context that reaches the *extension's* server, not its own.

  > **Superseded:** "`src/services/TaskViewerProvider.ts:1901` — same, for the forked host."
  > **Reason:** `TaskViewerProvider` does not construct a `PtyFleetService`; it spawns `dist/standalone/ptyHost.js` as a child process. The fleet under the extension is constructed at `ptyHost.ts:43`, in a different process. Wiring "the same" at the spawn site would set a context on an object that does not exist there.
  > **Replaced with:** Pass the port/secret through the child's argv or handshake at `TaskViewerProvider.ts:1908`, and call `setHookContext` at `ptyHost.ts:43`.

### 5. Board surface

- Card payload builders gain `blocked` alongside `working`: `KanbanProvider.ts:1845`, `:3474`, `:3679`, and `bootstrap.ts:196`. **All four** — this is the known duplicated-builder trap; a fix in three of four ships a state that appears on some board refreshes and not others.
- The derive itself lives in `isWorkingState` (`KanbanProvider.ts:142`, `bootstrap.ts:148`) — **two copies**, both of which the prerequisite liveness plan has already widened. Extend those same functions to return the working/blocked pair. Do not add a separate `isBlockedState` beside them; the two states share one age basis and one hard cap, and splitting them guarantees they eventually disagree at the boundary.
- `KanbanProvider._buildCardsFromDbSessionIds` (`:7369`) hardcodes `working: false`. Its disposition is decided by the prerequisite plan (wire it or delete it — it is keyed on the deprecated `session_id`). Follow whatever that plan concluded; do not add `blocked` to a builder that is being removed.
- Kanban webview: distinct treatment for blocked vs working. No new confirm gates, no modals. `kanban.html` is a self-contained webview — its handlers go in its own inline script, not a shared module.

## Verification Plan

Compilation and automated tests are out of scope for this session; the steps below are manual/observational.

0. **Enumerate the installed hook surface first.** Before writing any hook file, confirm against the installed Claude Code version which of `Stop`, `Notification`, `PermissionRequest`, `Elicitation`, `StopFailure`, `SessionEnd` exist and what each fires on. The event surface grew from 5 to ~30 events in a year; building against this document's names rather than the installed build's is the one failure mode the normalised endpoint vocabulary cannot absorb.
1. **Happy path.** Dispatch to a fleet Claude seat. Agent edits the plan file and finishes. Card clears on the `Stop` → `turn_end` event — verify via the API server log that the event arrived *before* the plan-watcher's clear, proving the hook is the fast path.
2. **Blocked path (the new capability), on the deterministic trigger.** Dispatch a prompt that makes the agent ask a clarifying question, and separately one that triggers a permission prompt. Confirm `Notification` / `PermissionRequest` fire and arrive as `awaiting_user`, and that `Stop` does **not** fire for either — this is the research finding that reshaped the design, and it must be confirmed on the installed version rather than trusted. Card shows blocked, not working, not cleared. Answer it; card returns to working.
2a. **Ambiguous-turn guard.** Force a `turn_end` with no plan-file change. Card goes blocked, not cleared. Confirm it later expires on the stale sweep rather than sticking.
2b. **Failed turn.** Induce an API failure or unrecoverable error mid-turn. `StopFailure` → `turn_failed` → card blocked, not cleared and not left lit to the timeout.
3. **Manual-chat no-op.** Type an unrelated question into a seat with no dispatched card. Hook fires; no card changes. Then repeat in a seat that *does* hold a live card for a different plan and confirm resolution is by `dispatched_terminal`, not by "most recent card".
4. **Non-Claude agent.** Configure a Codex/Aider startup command. No hook file, no `--settings`, behaviour identical to `main` apart from the three inert env vars.
5. **Environment integrity — run this before anything else.** Launch a fleet terminal and run `echo $PATH; echo $HOME; echo $SHELL; env | wc -l` in it. All populated, count comparable to a normal shell. This is the check that catches the `options.env || process.env` replacement trap; if it fails, every other step in this plan is testing a broken terminal.
5a. **The hook must never interrupt the agent.** Stop the LocalApiServer (or point the hook at a dead port) and run a full turn. The agent completes normally: no interruption, no injected stderr, no self-correction loop. Then confirm the same with a hung endpoint (a port that accepts but never responds) — the `-m` timeout fires and the agent still finishes. This is the exit-code-2 trap; a hook that blocks on a localhost failure is worse than no hook at all.
5b. **User hooks survive.** Put a trivial `Stop` hook in the workspace's `.claude/settings.json`, dispatch a Switchboard-managed turn, and confirm the user's hook still fires alongside Switchboard's. If it does not, `--settings` is replacing rather than merging and the re-emit path in §3 is required, not optional. Confirm `.claude/` is byte-unchanged afterwards either way.
6. **Hostile startup commands.** `zsh -ic 'claude'`, `my-wrapper.sh`, `claude && echo x`, `claude --dangerously-skip-permissions`, and an empty string. The first three and the empty string: no injection, terminal launches normally. The fourth: injection appended without disturbing the existing flag. Confirm by reading the first line typed into each pty, not by inference.
7. **Token scope — standalone only.** Under `npx switchboard`, with the scoped hook token: `POST /agent/event` succeeds and `POST /kanban/move` returns 401. Assert both directions — a scoped token that works everywhere is the whole risk of this plan realised.

   > **Superseded:** "With the scoped hook token, `POST /agent/event` succeeds and `POST /kanban/move` returns 401."
   > **Reason:** Unqualified, this step fails on the extension host for a reason the plan does not introduce: `_checkAuth` returns `true` when no token is configured (`LocalApiServer.ts:546-547`), which is the normal extension-host state per the note at `:578-581`. `/kanban/move` returns 200 there regardless of what token is presented.
   > **Replaced with:** The 401 assertion scoped to standalone, plus step 8 below recording the extension-host posture explicitly rather than asserting a guarantee that does not hold.

8. **Extension-host posture, recorded not asserted.** On the extension host, confirm that `POST /kanban/move` with no Authorization header returns 200 — the pre-existing loopback-trust behaviour. Record it as known and out of scope, so a later reader does not mistake it for a regression this plan caused. Confirm the scoped token still correctly identifies *which* terminal reported, which is the guarantee this plan does provide on both hosts.
9. **Migration.** Fresh DB replays V20→V59 and lands both `last_liveness_at` and `blocked_at`. An existing V58 DB migrates in place with no data loss. A V59 DB opened by an older build still functions (unknown columns ignored).
10. **Blocked expiry.** Set blocked, then (a) let the agent exit on its own and (b) close the terminal from the panel. The stale sweep clears blocked in both cases — (b) is the case that depends on the prerequisite plan's `recentlyClosed` tombstone.
11. **Blocked and working share one clock.** Set a card blocked, then let it sit past `timeoutMs` with the terminal still producing output. Blocked must survive exactly as long as working would — proving both states read the same widened age basis rather than two.
12. **Both hosts.** Full pass under `npx switchboard` and under the extension's forked host, including confirming the child received the extension's port and not its own.

## Recommendation

Send to Lead Coder (complexity 7).

Build it, but scope the first cut to Claude Code only and treat every other agent as explicitly out of scope rather than half-supported. The blocked state is the real prize — it answers the operator's actual question and nothing else in the system can.

If the work needs splitting further, the clean seam is: land §1 (V59 + accessors) and §2 (the endpoint) and §5 (board state) first — the endpoint is independently testable with `curl`, and the schema and derive-layer work is the part that must be right. §3 and §4 (hook-file generation, env injection, cross-process wiring) are the riskier half and can follow. Do not split the other way round: hook generation with no endpoint to receive events delivers nothing testable.
