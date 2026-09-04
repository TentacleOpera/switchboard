# `/switchboard` accepts any board on the shared port and adopts the wrong workspace — verify identity on both sides of the adopt call

<!-- board-collapse-08 -->
> **MERGE TARGET 2026-09-04 (Board Collapse 08).** *Orchestrator adopt call drops workspaceRoot — orchestrator scopes to the wrong workspace* has been **merged into this plan and deleted**. Both fixed the workspace scoping of the same adopt call from two different features.
> 
> Carry these from it: pass `"workspaceRoot": "$ROOT"` in the `/switchboard` workflow's adopt curl (`:93-94`); warn server-side in `_handleMissionControlAdopt` when the fallback to `this._options.workspaceRoot` fires, rather than silently scoping to the wrong board; and add the `pwd -P` pre-flight mismatch check to the orchestration skill, with its own caveat that the check runs on all orchestrator doors and may false-positive on the AUTOMATION-tab start door.
> 
> This plan's own contribution is the stronger half and stays the headline: identity by verified `health.roots` membership before any board is used, on **both** sides of the adopt call, plus the two nonexistent `/orchestration/*` endpoint names it corrects.


<!-- board-collapse-01b -->
> **PATH CORRECTION 2026-09-04 (Board Collapse 01).** This file names `.agents/skills/_lib/sb_api_call.sh`, which was **deleted** in commit `96fb16df`. All eight `kanban_operations/*.js` scripts now share `.agents/skills/_lib/cli-call.js`, and `switchboard api` is the shell-side escape hatch. Read every `sb_api_call` reference below as `cli-call.js` / `switchboard api`, and do not restore the shell helper.


## Goal

Make the `/switchboard` launcher prove that the board answering on the port belongs to **this** workspace before it uses it, and make `POST /mission-control/adopt` reject a workspace root the server does not serve instead of silently substituting its own. Adopting the orchestrator seat for a workspace the user is not in must become impossible, not merely unlikely.

### Problem Analysis

The launcher skill (`.claude/skills/switchboard/SKILL.md`) states the hazard correctly in its own preamble at lines 21-24:

> *A port file is not liveness. `.switchboard/api-server-port.txt` survives a crashed extension, and **every workspace's port file holds the same port**, so its presence proves nothing about this workspace.*

That is accurate — the standalone CLI pins the default port to 7777 (`src/standalone/cli.ts:1358-1362`, falling back to ephemeral only when 7777 is already bound), so port files across unrelated workspaces routinely carry the same number. Having named the problem, the skill then does not solve it. Three defects follow, all from the same cause.

**1. A 200 from any board is accepted as this workspace's board.** Line 31 issues `curl -o /dev/null -w "%{http_code}"` and branches on the status code alone. `GET /health` already returns `roots` (`src/services/LocalApiServer.ts`, `roots: this._allRoots`), which is exactly the fact needed, and the response body is discarded to `/dev/null`. The *previous* version of this control-plane document performed the check — *"Cross-check that `ROOT` appears in `health.roots`; if not, warn the user they are outside a registered Switchboard workspace and stop"* — so this is a guard that regressed, not one that was never conceived.

**2. The adopt call omits `workspaceRoot`, and the server fills in its own.** Line 93 posts only `terminalName`:

```bash
curl -s -X POST "$BASE/mission-control/adopt" -H "Content-Type: application/json" \
  -d "{\"terminalName\": \"${SWITCHBOARD_TERMINAL:-}\"}"
```

The handler (`src/services/LocalApiServer.ts:5735`) resolves it as:

```ts
const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
```

so an absent field falls back to **the server's own root** and is forwarded to `adoptMissionControlSeat` (`src/services/TaskViewerProvider.ts:4178-4180`) with no validation. Nothing compares the caller's location to the board's. The endpoint accepts `workspaceRoot` (`missionControlAdopt?: (workspaceRoot?, terminalName?)`, `:559`) — the skill simply never sends it.

Together these produce the failure: run `/switchboard` in workspace **B** while workspace **A**'s board is live on 7777. Health returns 200, the skill prints *"Switchboard is already running. Using the existing board"*, and the adopt seats the orchestrator on **A**. Every subsequent call in that session drives A while the user believes they are in B. There is no error, and the session log lands in A's `.switchboard/orchestrator/`.

This is strictly worse than the failure the skill's fail-safe branch (lines 38-55) is carefully written to avoid. That branch reasons that *"the cost of spawning when the board is alive is destructive (session hijack)"* and refuses to launch a second server — correctly. But the same hijack arrives through the front door whenever the live board belongs to someone else.

**3. `ROOT="$PWD"` with no upward walk** (line 26). Run `/switchboard` from any subdirectory of a Switchboard workspace and `$PWD/.switchboard/api-server-port.txt` does not exist, so the skill takes the `else` branch at line 56 and runs `npx switchboard &` — starting a **second board rooted at the subdirectory**, which is the two-server condition the fail-safe branch exists to prevent, reached by a path it does not cover. The stale `.agents/workflows/switchboard.md` had the walk; the current skill does not.

### Root Cause

The launcher identifies "my workspace's board" **by position** — a file at a path, a port that answers — rather than **by verified identity**. Position is not identity here, for a reason the skill itself documents: the port is shared by construction. Every one of the three defects is that same substitution, and the two facts needed to fix it (`health.roots`, and an accepted `workspaceRoot` parameter) already exist and are already being ignored.

The server compounds it by treating an omitted `workspaceRoot` as consent to substitute its own, which converts a client-side omission into a silent wrong-target write rather than an error.

### Non-goals

- **Changing the port-pinning strategy.** 7777 is deliberate (a predictable board URL); the fix is identity checking, not port uniqueness.
- **Preventing two servers on one workspace.** Already planned by the `storage-layer-overhaul` feature (`sidecar-owned-db-real-sqlite-binding.md`, `single-instance-enforcement-and-is-feature-clobber.md`). This plan concerns one agent talking to the wrong *existing* board.
- **Restructuring the launcher.** It is deliberately a launcher and not a console; keep it that way. This adds a condition and a field, not a section.
- **Migrations.** Control-plane content, restored from a known-good state; edit in place.

## Metadata

**Complexity:** 4
**Tags:** bugfix, reliability, api, cli

## Proposed Changes

1. **Resolve `ROOT` by walking up for the marker** rather than assuming `$PWD` (skill line 26). Walk until `.switchboard/` is found, stop at `/`, and if none is found treat it as "not a Switchboard workspace" — a distinct outcome from "no board running", and one that must **not** launch a server. This closes defect 3 and prevents a board being created in a subdirectory.

2. **Capture the health body and require `$ROOT` in `roots`** (skill lines 31 and 62). Stop discarding the response to `/dev/null`; read status and body together. A 200 whose `roots` does not contain `$ROOT` is **not this workspace's board** — report which workspace the board is actually serving and stop, rather than adopting. Handle a `/health` response with no `roots` field (older build) as *unknown*, not as *pass* — warn and stop, matching the fail-safe posture the skill already takes elsewhere.

3. **Send `workspaceRoot` explicitly in the adopt call** (skill line 93), alongside the existing `terminalName`. This makes the caller's intent explicit rather than inferred from server state.

4. **Validate `workspaceRoot` server-side against `_allRoots`** in `_handleMissionControlAdopt` (`src/services/LocalApiServer.ts:5720-5750`). Reject an unserved root with a 400 naming the roots this board does serve. **This is the durable half of the fix** — change 3 alone is a client-side convention, and the next caller that forgets it lands on the wrong board exactly as today. Keep the `this._options.workspaceRoot` fallback for an omitted field (it preserves existing callers), but validate whatever is resolved.

5. **Apply the same validation to the sibling mission-control endpoints** that take a `workspaceRoot` — `/mission-control/start`, `/mission-control/confirm`, `/mission-control/handoff`. They share the resolution pattern and therefore share the bug; fixing only `adopt` leaves the wrong-workspace write reachable one endpoint over. Audit each and record the list in the completion report.

6. **Edit the source, not the mirror — resolved, not an open question.** `.agents/workflows/switchboard.md` (121 lines, 5088 bytes at `5cd7935`) is authoritative: `src/services/ClaudeCodeMirrorService.ts:52` declares `source: 'workflows/switchboard.md', name: 'switchboard', invocation: 'default'`. `.claude/skills/switchboard/SKILL.md` (5151 bytes — the 63-byte delta is rewritten frontmatter) is **generated** and tracked in `.claude/.switchboard-generated.json`; anything written there is overwritten on the next mirror run. All line numbers in this plan refer to the source file. (`.agents/skills/switchboard/SKILL.md` has never existed in any commit — an earlier draft of this plan claimed it was present-but-empty, which was a bad check, not a fact.) After editing, run the mirror and confirm the `.claude/` copy regenerates to match.

7. **Fix the two nonexistent endpoints the launcher names — higher severity than the identity bug.** Source line 103 instructs the agent to call `POST /orchestration/confirm` as *"the only call that arms"*, and line 109 warns against `POST /orchestration/start`. **Neither route exists.** No `/orchestration/*` match anywhere in `src/`, no such prefix route in `LocalApiServer.ts`, and the generated `protocol-catalog.json` lists only `/mission-control/*`. The real names are `POST /mission-control/confirm` (`LocalApiServer.ts:7495`) and `POST /mission-control/start` (`:7493`). An agent following the skill verbatim therefore completes adopt and pre-flight, then 404s on the arming call — **arming silently never happens**, which breaks the primary path rather than a multi-workspace edge case. Fix both names and add them to the endpoint-name audit in change 5.

8. **Reconcile the extension's dispatch prompt with the restored skill.** `src/services/TaskViewerProvider.ts:28408` builds a prompt telling the agent to read `.agents/workflows/switchboard.md` and *"follow its entry protocol exactly: concise one-line board snapshot, then present the skill's two-tier entry menu (Plan / Code / Board / Automate, plus a one-line More: design & artifacts, external PM, setup & tour)"*. That describes the **previous** 605-line console document, not the restored 121-line launcher, which has no board snapshot and no menu. The prompt and the file it points at now contradict each other.

   Note what that prompt gets *right*, because it is the fix this plan proposes, already implemented on one path: it passes `${workspaceRoot}` and instructs *"use it as $ROOT directly (this is the board's selected workspace; do not derive the root from your terminal's working directory)"*. So the **dispatched** path is already immune to the wrong-workspace bug. The defect bites only on **direct user invocation** of `/switchboard`, where no prompt supplies a root and `ROOT="$PWD"` applies. Scope the severity accordingly, and reuse this prompt's wording as the model for the skill's own root resolution.

9. **Update the preamble to describe what the code now does.** Lines 21-24 correctly state that the port file proves nothing; extend that to say what does prove it (`$ROOT` in `health.roots`), so the reasoning and the implementation stop disagreeing.

## Edge-Case & Dependency Audit

- **Path comparison is the whole risk, and a false negative is worse than the bug.** A naive string compare between `$PWD` and a `roots` entry will disagree over: symlinked paths (`/tmp` → `/private/tmp` on macOS), trailing slashes, case-insensitive filesystems (macOS, Windows), `~` expansion, and Windows separators. Blocking a legitimate launch is a worse outcome than the wrong-workspace adopt, because it hits every user rather than the multi-workspace case. Normalise both sides — resolve symlinks, strip trailing separators, compare case-insensitively where the platform is case-insensitive — and cover each in tests.
- **Mapped child workspaces legitimately resolve elsewhere.** `resolveEffectiveWorkspaceRootFromMappings` and `_filterMappedRoots` mean the effective root can differ from the folder the user is standing in. A child mapped to a parent DB must still pass. Test a mapped configuration explicitly, or the fix breaks multi-repo setups.
- **A subdirectory of a served root must pass, not fail.** After change 1 the walk lands on the workspace root, so this works — but only because of the walk. Verify it directly; it is the most common way a real user invokes the skill.
- **The extension serves multiple roots.** `_allRoots` is a list. Membership, never equality against a single value.
- **`/health` is unauthenticated, so the check works before any credential exists.** It must stay that way — the identity check has to run in the same call that establishes liveness, and the port-discovery probes in `sb_api_call.sh` and `cli.ts` depend on `/health` being reachable without auth.
- **Do not reintroduce a launch path in the mismatch branch.** When the board belongs to another workspace, the correct action is to stop and explain — never to start a second server, which is the destructive outcome the existing fail-safe reasoning already rules out.
- **`SWITCHBOARD_TERMINAL` stays as-is.** The existing `${SWITCHBOARD_TERMINAL:-}` empty-rather-than-guess behavior is deliberate and unrelated; do not "improve" it while editing the adopt call.

## Dependencies

None. Independent of the four API-auth plans and of the storage-layer feature.

## Verification Plan

1. **The bug, reproduced then fixed.** Start a board in workspace A. `cd` to unrelated workspace B and run `/switchboard`. *Before:* it reports the board is running and adopts A — confirm by checking which workspace's `.switchboard/orchestrator/` receives the session. *After:* it stops, names A as the workspace the board serves, and adopts nothing.
2. **The happy path, which must not regress.** Single workspace, board running, invoked from the workspace root: adopts normally with no extra prompts or warnings.
3. **Subdirectory invocation.** From `<root>/src/services`, the skill finds the root by walking up, accepts the running board, and does **not** launch a second server.
4. **No board at all.** In a Switchboard workspace with no server, it launches exactly one and adopts it.
5. **Not a Switchboard workspace.** In a directory with no `.switchboard/` at any level, it reports that and launches nothing.
6. **Server-side rejection independent of the client.** `curl -X POST /mission-control/adopt -d '{"workspaceRoot":"/nonexistent"}'` returns 400 naming the served roots — proving change 4 holds even for a caller that never read the skill.
7. **Omitted `workspaceRoot` still works** for existing callers, resolving to the server root and passing validation.
8. **Path-normalisation matrix:** symlinked root, trailing slash, differing case on a case-insensitive filesystem, and a mapped child workspace — each must be accepted, not rejected. This is the false-negative guard and the most important test in the list.
9. **Older-build health response** with no `roots` field: warns and stops, never silently passes.
10. Repeat 1-3 against the standalone host as well as the extension host, since both serve `/health` and both answer `adopt`.
11. Confirm the fix landed in `.agents/workflows/switchboard.md`, then run the mirror and confirm `.claude/skills/switchboard/SKILL.md` regenerates to match (change 6). A fix present only in the mirror is not a fix.
12. **Arming works end to end** (change 7): adopt, run the pre-flight, confirm, and verify `POST /mission-control/confirm` returns success and the engine is actually armed — not merely that the skill text changed. Grep the whole control plane for `/orchestration/` and confirm no reference survives.
13. **Dispatch path unchanged** (change 8): launch `/switchboard` from the board's own dispatch and confirm it still works, now against a skill whose text matches the prompt. Confirm the dispatched path still passes `workspaceRoot` and never derives the root from the terminal's cwd.

## Outstanding Questions

- Should a mismatch **offer** to launch a second board on another port for this workspace, or only stop? Stopping is safer and matches the existing fail-safe posture; offering is friendlier for genuine multi-workspace users. Recommend stopping until the single-writer work in the storage feature lands, since a second board is exactly what that work is making safe.
