# Hand Off Planner Research Prompts to an Active Researcher Agent

## Goal

When the planner's **"advise research if unsure"** add-on identifies uncertain assumptions, it
should — *if a Researcher agent is currently active* — send the ready-to-run research prompt
**directly to that agent over the LocalApiServer HTTP surface**, and instruct it to save the
findings to the **configured (or default) research-docs folder**. When no researcher is live it
must fall back to today's behavior: paste the prompt into the chat summary for the user to run
manually.

### Problem & root-cause analysis

Today `ADVISE_RESEARCH_DIRECTIVE` (`src/services/agentPromptBuilder.ts`) makes the planner end its
turn by pasting a research prompt into chat and asking the *user* to run it and feed findings back.
That stalls the pipeline on a human round-trip even when the workspace already has an idle
Researcher agent that could do the work immediately.

- **The planner is a CLI agent with a shell**, so it can reach the localhost API — but it **cannot
  read VS Code settings.** The "configured research-docs folder" is the extension setting
  `switchboard.research.localFolderPaths[0]` (fallback `.switchboard/docs/`). Any design that asks
  the planner to name the save folder itself is wrong by construction — the folder must be resolved
  **server-side** in the extension.
- **"Active" has a precise meaning.** A researcher counts as active only when a `researcher`-role
  terminal is both *registered* and *live* (`vscode.Terminal.exitStatus === undefined`).
  Registration is in-memory extension state surfaced on `GET /health.terminals`; **no file on disk
  reflects it.** Deciding "active or not" therefore also belongs server-side.
- **Existing primitives are too low-level for the planner to orchestrate reliably.** A raw hand-off
  would force the planner to read the port file → `GET /health` → parse the terminal list → guess
  which name is the researcher → `POST /taskViewer/verb/sendToTerminal` with exact webview field
  names → and separately resolve the docs folder (which it can't). That is fragile shell
  choreography with a silent-no-op failure mode (the verb rail answers `{success:true}` even when
  the arm no-ops on wrong field names).
- **Root cause:** there is no single, intent-level operation for "delegate this research to the
  researcher if one is available." The fix is to add one — a first-class endpoint that encapsulates
  the liveness check + folder resolution + dispatch — and make the directive call it and branch on
  the result.

## Metadata

**Tags:** backend, api, feature
**Complexity:** 5

## User Review Required

Yes — review required before dispatch. Three issues need a human sign-off; the first is a **P0
runtime bug observed in production**:

1. **P0 — agents ignore researcher config and ram prompts through (observed bug).** The shipped
   endpoint wraps every response in `{ success: true, ...result }` with HTTP 200, even when
   `dispatched:false` ("no researcher agent configured"). Agents see `success:true` + 200, conclude
   the hand-off worked, announce "handed to the Researcher," and skip the fallback — exactly the
   "port found → ram it through without a target agent" behavior reported. The directive also gates
   the POST on port-file existence only, never on researcher config. Fix requires **both** a
   server-side response-shape change (drop `success:true` from the `dispatched:false` path; use a
   non-200 status for "no researcher configured") and a directive change (gate on the `dispatched`
   field + HTTP status, not on `success`). See Proposed Changes → `LocalApiServer.ts` and
   `agentPromptBuilder.ts`. Confirm the desired status-code semantics before changing shipped code.
2. **Spawn-race fix (see Proposed Changes → `TaskViewerProvider.ts`).** The shipped code
   re-delegates the final send to `sendPromptToAgentTerminal`, which can spawn a fresh researcher
   terminal if the live one exits in the window between the liveness check and the send — violating
   Design Decision #3 ("never spawn"). The recommended fix sends to the already-resolved terminal
   via `sendRobustText` + `withTerminalSendLock` directly. Confirm this is the desired behavior
   before changing shipped code.
3. **Success-path wording.** `dispatched:true` means "prompt reached a live terminal," not
   "research will be delivered." Confirm the directive/skill should say "handed to the Researcher
   agent; it will attempt to save findings to X" rather than implying guaranteed delivery.

## Complexity Audit

### Routine
- Adding a new route arm to the `if/else if` chain in `LocalApiServer._handleRequest` (mirrors
  `/phone-a-friend`).
- Adding an optional callback to `LocalApiServerOptions` and wiring it in `TaskViewerProvider`.
- Resolving the save folder from an existing setting (`research.localFolderPaths[0]`).
- Appending a save-to-docs instruction string to the prompt.
- Updating `ADVISE_RESEARCH_DIRECTIVE` text and both skill mirrors.

### Complex / Risky
- **P0 — `success:true` wrapper defeats the `dispatched` signal (observed bug).** The endpoint
  returns `{ success:true, dispatched:false, reason }` with HTTP 200 when no researcher is
  configured. Agents key on `success:true` + 200 and treat the hand-off as done, skipping the
  fallback. This is the root cause of the reported "agents ram prompts through without a target
  agent" behavior. Fix is server-side (response shape + status code) AND client-side (directive
  gating).
- **Liveness-gated dispatch that must never spawn.** The terminal-resolution logic (registered map
  → suffixed key → open-terminals fallback → `exitStatus` check) is duplicated between
  `_dispatchResearchToResearcher` and `sendPromptToAgentTerminal`; the latter's spawn fallback
  creates a TOCTOU gap (see Edge-Case & Dependency Audit → Race Conditions).
- **Honest success semantics.** `dispatched:true` is a delivery-to-terminal-buffer signal, not a
  completion signal; the planner tells the user findings "will save" on faith.
- **Cross-platform JSON build in the directive.** `jq -Rs` / `python3` are not guaranteed on a
  Windows planner shell; failure silently falls through to chat-paste.
- **Skill mirror byte-identity.** Both `advise_research` and `advise-research` bodies must stay
  byte-identical below the YAML frontmatter; `npm run mirror:check` gates drift.

## Edge-Case & Dependency Audit

**Race Conditions**
- *Spawn race (top finding).* `_dispatchResearchToResearcher` confirms `terminal.exitStatus ===
  undefined`, then calls `sendPromptToAgentTerminal('researcher', fullPrompt, resolvedRoot)`, which
  resolves the terminal *again* and **spawns a new one if the live terminal has since exited**. This
  breaks Design Decision #3 ("never spawn a researcher"). Mitigation: send to the already-resolved
  terminal directly using the same send block `sendPromptToAgentTerminal` uses
  (`withTerminalSendLock` + `sendRobustText`), bypassing the spawn fallback. **Code change
  required** — see Proposed Changes → `TaskViewerProvider.ts`.
- *Stale registration.* `_registeredTerminals` may retain a `vscode.Terminal` whose process has
  exited but whose `exitStatus` has not yet fired. The `exitStatus !== undefined` guard catches the
  common case but not the in-between window. Acceptable for best-effort; the spawn-race fix above
  also removes the worse failure mode.

**Security**
- `POST /research/dispatch` is localhost-only and **unauthenticated** (mirrors `/phone-a-friend`).
  Any process on the machine can POST an arbitrary `prompt` string that is forwarded verbatim into
  the researcher terminal via `sendRobustText`. A hostile local process could inject terminal
  text. Mitigation: the server binds to `127.0.0.1` only (inherited from `LocalApiServer`); the
  prompt is sent as text, not a shell command, so it is not directly executed by a shell. This is
  the same threat model as the existing `/phone-a-friend` and `sendToTerminal` endpoints — no new
  exposure is introduced. No code change needed; documented as inherited.

**Side Effects**
- **P0 — false-success announcement (observed).** Because the endpoint returns `success:true` +
  HTTP 200 even when `dispatched:false`, the planner announces a hand-off that never happened and
  suppresses the chat-paste fallback. The user is told "research handed to the Researcher agent,
  findings will save to X" when no researcher is configured or live. The research never runs and
  the user never sees the prompt to run manually. This is the worst side effect: a silent no-op
  dressed as success. Fix: see Proposed Changes → `LocalApiServer.ts`.
- On a genuine successful dispatch, text is appended to the researcher terminal while it may be
  mid-task. The researcher agent receives an unsolicited prompt interleaved with whatever it was
  doing. This is inherent to a shared-terminal hand-off and matches how card dispatch already
  behaves.
- The endpoint never spawns, never writes files, and never mutates kanban state. The only side
  effect is terminal text + the returned `savePath` (which the planner echoes to the user).

**Dependencies & Conflicts**
- Depends on the existing `researcher` role (`agentConfig.ts` `BuiltInAgentRole`), the
  `RESEARCHER` kanban column → role mapping, and the existing researcher prompt's
  `saveToLocalDocs` / `localDocsPath` plumbing.
- Depends on `LocalApiServer` running (port file `.switchboard/api-server-port.txt` present). If
  the extension is not running, the port file is absent and the planner falls back to chat-paste —
  no error path.
- **Catalog drift (out of scope here).** `GET /catalog` and `src/generated/verbAllowlist.ts` will
  not list `/research/dispatch` until the protocol catalog is regenerated. The catalog is already
  badly stale at branch HEAD (a no-edit regen produces a ~3,900-line diff), so regen belongs in a
  separate maintenance pass. The only intended caller is the planner directive (which hardcodes the
  endpoint), not orchestration agents that discover via `/catalog` — so this is non-blocking.

## Dependencies

- None (no prior plan sessions). The change is self-contained across three source files and two
  skill mirrors.

## Adversarial Synthesis

Key risks: (1) **P0 — the `success:true` response wrapper + directive gating on port-file
existence make agents announce a hand-off that never happened when no researcher is configured**,
silently suppressing the chat-paste fallback (observed in production); (2) a TOCTOU spawn race
that violates the "never spawn" guarantee, because the dispatch re-delegates the final send through
`sendPromptToAgentTerminal`'s spawn-fallback path; (3) `dispatched:true` over-promises — it
signals delivery to a terminal buffer, not research completion, yet the planner tells the user
findings "will save"; (4) cross-platform JSON-build in the directive (`jq`/`python3`) silently
falls through to chat-paste on Windows. Mitigations: drop `success:true` and use HTTP status
(404 for "not configured", 200 `dispatched:false` for "offline") so the signal is unambiguous;
rewrite the directive to gate on `dispatched:true` + status, not on `success` or port-file
existence; send to the already-resolved terminal directly (bypass the spawn fallback); soften the
directive/skill wording to "will attempt to save"; document the Windows fallback as acceptable.

## Proposed Changes

> **Note — code already shipped.** This plan was implemented in commit `59e4f1b` alongside the
> plan authoring. The sections below describe the intended change **and** flag where the shipped
> code diverges from the plan or needs follow-up. Per the `improve-plan` contract, no source files
> are modified in this pass; code-change recommendations are flagged for a follow-up coder pass.

### `src/services/LocalApiServer.ts`
- **Context:** Hand-written `if/else if` route chain in `_handleRequest`; command endpoints delegate
  to injected callbacks on `LocalApiServerOptions`, wired in `TaskViewerProvider.ts`. Closest
  precedent is `POST /phone-a-friend` → `onPhoneAFriend` (localhost-only, no auth, best-effort,
  callback must not throw on "no terminal").
- **Logic:** Add `onDispatchResearch?` to `LocalApiServerOptions`:
  `(workspaceRoot: string, prompt: string) => Promise<{ dispatched: boolean; researcher?: string; savePath?: string; reason?: string }>`.
  Add route arm `POST /research/dispatch → _handleResearchDispatch`.
- **Implementation:** `_handleResearchDispatch` returns 503 if the callback is unwired; parses body
  (`prompt` required → 400 if missing; `workspaceRoot` defaults to `this._options.workspaceRoot`);
  calls the callback; responds with the result; 500 only on an unexpected throw. No `_checkAuth`
  call (mirrors `/phone-a-friend`).
- **P0 FIX — response shape (code change required).** The shipped code at line 1352 wraps every
  response in `{ success: true, ...result }` with HTTP 200. When `result = { dispatched:false,
  reason:"no researcher agent configured" }`, the wire response is `{ success:true,
  dispatched:false, reason }` with status 200. Agents key on `success:true` + 200 and treat the
  hand-off as successful, suppressing the fallback — the observed "ram it through without a target
  agent" bug. Recommended fix, in priority order:
  1. **Drop the `success:true` wrapper.** Respond with the bare result object: `{ dispatched,
     researcher?, savePath?, reason? }`. Make `dispatched` the single top-level outcome signal —
     do not contradict it with a `success:true` sibling.
  2. **Use the HTTP status code as the unambiguous signal** (agents already understand non-200 =
     failure):
       - `200` + `{ dispatched:true, researcher, savePath }` — dispatched.
       - `200` + `{ dispatched:false, reason:"researcher not live" }` — configured but offline
         (soft failure → planner falls back to chat-paste).
       - `404` + `{ dispatched:false, reason:"no researcher agent configured" }` — **no target
         configured at all** (hard failure → planner falls back; the 404 makes "no target" visually
         distinct from "target offline" in agent logs).
       - `503` — callback unwired (extension not running the host hook).
       - `400` — missing `prompt`.
       - `500` — unexpected throw.
     The 404-vs-200 distinction lets the directive branch cleanly: any non-200 OR `dispatched`
     not `true` → fall back. Confirm the 404-for-"not configured" semantics before shipping.
- **Edge Cases:** Missing port file / extension not running → planner never reaches the endpoint
  (falls back client-side). Callback returns `dispatched:false` (never throws) for "no researcher
  active" so the planner branches cleanly — but only if the response shape no longer lies with
  `success:true` (hence the P0 fix above).
- **Shipped status:** Route + callback wired correctly. **Response shape is buggy — code change
  required (P0).**

### `src/services/TaskViewerProvider.ts`
- **Context:** Wires `LocalApiServerOptions` callbacks; owns `_registeredTerminals`,
  `_getAgentNameForRole`, `_resolveWorkspaceRoot`, `_suffixedName`, `_normalizeAgentKey`,
  `_stripIdeSuffix`, and `sendPromptToAgentTerminal` (which **spawns** a terminal if none is found).
- **Logic:** Wire `onDispatchResearch` to a new `_dispatchResearchToResearcher(workspaceRoot,
  prompt)`: resolve root (bail `dispatched:false` if unresolvable); resolve researcher agent name
  (bail if none configured); resolve the live `vscode.Terminal` the same way
  `sendPromptToAgentTerminal` does (registered map by name/suffixed key, then open-terminals
  fallback) **but never spawn** (bail `dispatched:false` if not found or `exitStatus !==
  undefined`); resolve `savePath = research.localFolderPaths[0] || '.switchboard/docs/'`; append a
  save-to-docs instruction; send; return `{ dispatched:true, researcher, savePath }`.
- **Implementation:** Resolve the save folder with
  `vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(resolvedRoot))` — pass a **Uri**
  for the configuration scope, not a bare string root (the plan's pseudocode wrote
  `getConfiguration('switchboard', root)`; the shipped code correctly uses a Uri).
- **Edge Cases:**
  - **Spawn race — code change required.** The shipped code calls
    `sendPromptToAgentTerminal('researcher', fullPrompt, resolvedRoot)` for the final send. That
    method re-resolves the terminal and **spawns a new one if the live terminal has exited** in the
    window since the liveness check, violating Design Decision #3. Recommended fix: after
    confirming liveness, send to the already-resolved `terminal` directly using the same send block
    `sendPromptToAgentTerminal` uses (`withTerminalSendLock(sendLockKey, () =>
    sendRobustText(terminal, fullPrompt, true))`), bypassing the spawn fallback entirely. This is
    the single material code change this review recommends.
  - **Save-instruction wording.** The appended instruction says `using the write_to_file tool`.
    This matches the existing researcher prompt convention (line 1537) for consistency, but a
    host-agnostic natural-language phrasing ("save the research as a file to <path>") would be more
    robust across researcher hosts since each agent knows its own file-writing tool. Low priority —
    the current wording works because agents interpret intent; soften only if touching the string
    for another reason.
- **Shipped status:** Functionally correct except for the spawn race. One code change recommended
  (above).

### `src/services/agentPromptBuilder.ts` — `ADVISE_RESEARCH_DIRECTIVE`
- **Context:** `ADVISE_RESEARCH_DIRECTIVE` is appended to the planner base when
  `options.adviseResearchIfUnsure` is true (default true; populated in `KanbanProvider.ts` from
  `plannerConfig?.addons?.adviseResearch ?? true`). The researcher prompt branch already supports a
  save-to-docs instruction gated by `options.saveToLocalDocs` / `options.localDocsPath`.
- **Logic:** Extend the directive with a "researcher hand-off" step that runs *before* showing the
  prompt to the user: build the research prompt, read the port from
  `.switchboard/api-server-port.txt`, `POST` to `/research/dispatch` with `{ workspaceRoot, prompt }`
  (build JSON safely with `jq -Rs` / `python3 json.dumps`, never hand-escape newlines). On
  `dispatched:true` → tell the user it was handed to the Researcher agent and where findings will
  save; **do not** paste the prompt. On `dispatched:false` / missing port file / request failure →
  fall back to the current end-of-summary prompt. The `## Uncertain Assumptions` plan-file section
  is unchanged.
- **Implementation:** The directive text is a single template string injected into the planner
  prompt; the hand-off instructions are appended to the existing `RESEARCH WHEN UNSURE` body.
- **Edge Cases:**
  - **P0 FIX — directive gating (code change required).** The shipped directive gates the POST on
    port-file existence only: "Read the port from .switchboard/api-server-port.txt... then POST."
    It never tells the agent to verify a researcher is configured first, and its fallback condition
    ("if dispatched is false... fall back") is defeated by the `success:true` wrapper (agents read
    `success:true` as the outcome). Recommended directive rewrite:
    1. Make the gating condition explicit and unambiguous: "Only announce a hand-off if the JSON
       response contains `"dispatched": true`. If the HTTP status is not 200, OR the response does
       not contain `"dispatched": true`, OR the port file is missing, OR the request fails — fall
       back to pasting the research prompt at the end of your chat summary. Do NOT key on a
       `success` field."
    2. Add a pre-POST sanity note: "If you have no reason to believe a Researcher agent is
       configured for this workspace, skip the POST and go straight to the chat-paste fallback —
       the endpoint will return a non-200 status when no researcher is configured, but avoiding the
       round-trip is cheaper." (The planner cannot read VS Code settings to know for sure, so this
       is advisory; the server-side 404 is the authoritative gate.)
    3. Drop any wording that implies the hand-off always works when the port file exists.
  - **Wording — recommended softening.** The directive tells the planner to say findings "will
    save" to `savePath`. Since `dispatched:true` only confirms delivery to a terminal buffer, soften
    to "handed to the Researcher agent; it will attempt to save findings to X" so the planner does
    not over-promise. Small wording change in the directive string + both skill mirrors.
  - **Cross-platform JSON build.** `jq -Rs` / `python3` are not guaranteed on a Windows planner
    shell. If both are absent the POST fails and the planner falls back to chat-paste — acceptable,
    but the directive should acknowledge the fallback rather than implying the hand-off always
    works. Document only; no structural change.
- **Shipped status:** Directive text shipped, but gating is buggy — agents key on `success:true`
  and ignore `dispatched`. **Directive rewrite required (P0).**

### `.agents/skills/advise_research/SKILL.md` + `.claude/skills/advise-research/SKILL.md`
- **Context:** `.agents/skills/advise_research/SKILL.md` is the source of truth;
  `.claude/skills/advise-research/SKILL.md` is generated by `generateClaudeMirror` and differs only
  by a prepended YAML frontmatter block. `npm run mirror:check` gates drift, so both bodies must
  stay byte-identical below the frontmatter.
- **Logic:** Add a "Researcher Hand-Off" section describing the port-read → POST → branch flow, and
  renumber the existing steps so the hand-off is attempted before the chat-summary fallback. Mark
  the "After Generating" section as fallback-path-only.
- **Edge Cases:** Any edit must be reproduced identically in both files; `npm run mirror:check` must
  pass.
- **Shipped status:** Matches plan structurally. If the directive wording is softened (see above),
  the same wording change must be reflected here in both mirrors. **The P0 directive-gating rewrite
  (gate on `dispatched:true` + HTTP status, not `success` or port-file existence) must also be
  mirrored into both skill files** — the skill is the canonical source the planner reads.

## Verification Plan

> **Session directives:** compilation (`tsc`) and automated tests are NOT run in this improve-plan
> pass. The steps below are the verification a coder should run in the follow-up pass; they are
> documented here per the plan schema, not executed now.

### Automated Tests
- `tsc -p tsconfig.test.json` — the three changed source files must compile with zero new errors.
- `npm run mirror:check` — the `advise_research` → `advise-research` mirror must be consistent (no
  drift introduced by any skill-doc edit).
- Runtime smoke (needs the extension running):
  - With a live Researcher terminal: `curl -s -X POST $BASE/research/dispatch -d
    '{"workspaceRoot":"…","prompt":"…"}'` → HTTP 200 with `{dispatched:true,researcher,savePath}`
    (no `success` field) and the prompt lands in the researcher terminal carrying the save
    instruction.
  - With a researcher configured but no live terminal: HTTP 200 with
    `{dispatched:false,reason:"researcher not live"}` — planner falls back to chat-paste.
  - **P0 regression check — with NO researcher configured at all:** `curl -s -o /dev/null -w
    "%{http_code}" -X POST $BASE/research/dispatch -d '{"workspaceRoot":"…","prompt":"…"}'` →
    **404** (not 200), body `{dispatched:false,reason:"no researcher agent configured"}`. The
    planner, run with the add-on on and no researcher configured, must paste the research prompt
    into its chat summary — it must NOT announce a hand-off. This is the bug that was reported;
    this check must pass before the fix is considered done.
- **Spawn-race regression check (after the recommended fix):** close the researcher terminal in the
  window between dispatch and send, then POST — confirm no new researcher terminal is spawned and
  the response is `dispatched:false` (or the send fails closed), never a spawn.

## Uncertain Assumptions

None. All facts verified directly in code (response shape at `LocalApiServer.ts:1352`, directive
gating at `agentPromptBuilder.ts:580`, terminal resolution at `TaskViewerProvider.ts:3682-3737`,
`_resolveWorkspaceRoot` at line 2062, save-folder resolution, skill mirror structure). The
save-to-docs instruction's `write_to_file` tool name is a non-issue — natural-language phrasing
("save the research as a file to <path>") works across all researcher hosts since each agent knows
its own file-writing tool; no host-specific tool name is needed.

## Out of scope / follow-ups

- **Protocol catalog / verb-allowlist regeneration** (`protocol-catalog.json`,
  `src/generated/verbAllowlist.ts`) is already badly stale at branch HEAD (a no-edit regen still
  produces a ~3,900-line diff), so regenerating it belongs in a separate maintenance pass rather
  than this change. `GET /catalog` will list `/research/dispatch` once the catalog is next
  regenerated (routes are auto-discovered from the if-else chain). The only intended caller today
  is the planner directive, which hardcodes the endpoint — so this is non-blocking.
- **No dedicated test** — consistent with the analogous `phone-a-friend` callback endpoint, which
  has none; a contract test would need VS Code terminal-registry mocks. The spawn-race regression
  check above is a manual smoke step for now.
- **Possible refinement** — return `dispatched:false` (rather than a 500) if the terminal send
  itself throws after liveness was confirmed, for an even cleaner caller branch.
- **Completion-confirmation (not in scope).** A research-results inbox that lets the researcher
  report back when findings are actually saved would close the goal-vs-appearance gap noted in the
  architecture review. That is a separate feature; this plan is deliberately fire-and-forget.

## Recommendation

Complexity 5 → **Send to Coder.** The change is already shipped but has a **P0 runtime bug**: agents
ignore researcher config and announce phantom hand-offs because the endpoint wraps
`dispatched:false` in `success:true` + HTTP 200, and the directive gates on port-file existence
rather than the `dispatched` field. The coder pass must, in order: (1) **P0 — fix the response
shape** in `LocalApiServer._handleResearchDispatch` (drop `success:true`; return 404 for "no
researcher configured", 200 `dispatched:false` for "offline", 200 `dispatched:true` for
dispatched); (2) **P0 — rewrite the directive** in `agentPromptBuilder.ts` + both skill mirrors to
gate on `dispatched:true` + HTTP status, never on `success` or port-file existence; (3) apply the
spawn-race fix in `TaskViewerProvider._dispatchResearchToResearcher` (send to the resolved terminal
directly, bypass `sendPromptToAgentTerminal`'s spawn fallback); (4) optional wording-softening.
Then run the verification steps above — the P0 regression check (no researcher configured → 404 →
planner pastes prompt into chat) must pass before the fix is considered done.

## Implementation Notes

Implemented the coder pass for the P0 research-handoff bug. (1) `LocalApiServer._handleResearchDispatch` — dropped the `{ success:true, ...result }` wrapper; now responds with the bare result object and uses HTTP status as the unambiguous gate (404 for "no researcher agent configured", 200 for both dispatched:true and soft "offline" dispatched:false). (2) `TaskViewerProvider._dispatchResearchToResearcher` — spawn-race fix: sends to the already-resolved live terminal directly via `withTerminalSendLock` + `sendRobustText`, bypassing `sendPromptToAgentTerminal`'s spawn fallback; a send failure now returns `dispatched:false` instead of spawning. (3) `agentPromptBuilder.ts` `ADVISE_RESEARCH_DIRECTIVE` — rewrote the RESEARCHER HAND-OFF paragraph to gate on `dispatched:true` + HTTP status (never on a `success` field or port-file existence alone), added the pre-POST skip advisory, and softened wording to "will attempt to save". (4) Mirrored the same gating/wording rewrite into both `.agents/skills/advise_research/SKILL.md` and `.claude/skills/advise-research/SKILL.md` (bodies verified byte-identical below the YAML frontmatter). Files changed: `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/services/agentPromptBuilder.ts`, `.agents/skills/advise_research/SKILL.md`, `.claude/skills/advise-research/SKILL.md`. No issues encountered; `npm run mirror:check` reports pre-existing drift in unrelated skills (accuracy, improve-plan, etc.) but advise-research is in sync. Compilation and automated tests skipped per session directives.
