# Phone-a-Friend Terminal — Automatic Second-Pass Coder

**Plan ID:** 8a2c4e17-9b3d-4f2a-8c1e-6d5b7a9f0123

## Metadata
**Complexity:** 5
**Tags:** feature, ui, backend, api
**Project:** switchboard

## Goal

Add a **Phone-a-Friend terminal** — a dedicated agent terminal that receives automatic dispatch when a coding agent finishes a plan batch. The coder's prompt includes instructions to POST a notification to the LocalApiServer, which triggers the extension to send a lightweight "check the implementation and fix any bugs" prompt to the phone-a-friend terminal. This is a **second-pass coder**, not a formal reviewer — it reads the same plan file(s) and assumes there are hidden bugs to find and fix.

### Problem
When running batch coding sessions, users often have excess compute capacity sitting idle. There's currently no way to automatically leverage a second agent to double-check freshly coded work without manually dispatching a review. This leads to either wasted compute or undiscovered bugs.

### Solution
Add a **Phone-a-Friend terminal** — a dedicated agent terminal that receives automatic dispatch when a coding agent finishes a plan. The coder's prompt includes instructions to POST a notification to the LocalApiServer, which triggers the extension to send a lightweight "check the implementation and fix any bugs" prompt to the phone-a-friend terminal. This is a **second-pass coder**, not a formal reviewer — it reads the same plan file and assumes there are hidden bugs to find and fix.

### Key Design Decisions
- **Signal mechanism**: The coder agent `curl`s a new `POST /phone-a-friend` endpoint on the LocalApiServer (same pattern as `/comment`, `/kanban/move`). No file-drop inbox needed.
- **Prompt addon, not Stage Complete detection**: The coder's prompt gets an addon paragraph telling it to POST when done. This follows the same pattern as the accuracy workflow — agent self-reports, extension reacts.
- **One terminal**: Only one phone-a-friend terminal per workspace. Users wanting per-project terminals can use worktrees.
- **Silent drop on missing terminal**: If the phone-a-friend terminal isn't running, the POST returns 200 (acknowledged) but the dispatch is silently skipped. The coder's prompt addon includes a bracket note: *(requires the Phone-a-Friend agent configured)*.
- **Second-pass coder, not reviewer**: The dispatched prompt tells the phone-a-friend agent to read the plan, check the implementation, and fix any bugs it finds. It acts as a continuation of the coder, not a formal code review.
- **`/clear` before dispatch**: The extension sends `/clear` to the phone-a-friend terminal before each dispatch, same as normal agent dispatch flow.

## User Review Required
Review the corrected wiring location (callback belongs in `TaskViewerProvider`, NOT `extension.ts`) and the two contract changes from the original draft:
1. The POST body now carries `originRole` (so the host can resolve the originating coder's addons) — the directive's `curl` payload must include it.
2. The phone-a-friend prompt must NOT append a `Stage Complete` marker (it is a continuation, not a stage transition — a second marker risks a double stage-advance).
3. The directive tells the coder to POST **once per batch** (with the last completed plan file), not once per plan — this prevents interleaved dispatch storms into a single terminal.

## Complexity Audit

### Routine
- New `POST /phone-a-friend` endpoint handler in `LocalApiServer.ts` — follows the exact `_handleKanbanMove` / `_handlePostComment` pattern (parse body, validate, invoke callback, return status).
- Router `else if` branch in `_handleRequest` — one-line addition to the existing chain.
- `ROLE_ADDONS` checkbox entries for `lead` / `coder` / `intern` — copy an existing addon object literal.
- `CustomAgentAddons.phoneAFriend` field + `parseCustomAgentAddons` line — copy the `useWorktreesPerPlan` pattern.
- Agents-tab startup row in `kanban.html` — copy the `researcher`/`tester` row pattern.
- `BUILT_IN_AGENT_LABELS` / `DEFAULT_VISIBLE_AGENTS` / `DEFAULT_ROLE_CONFIG` additions — one-line entries each.

### Complex / Risky
- **Dispatch serialization**: rapid batch-end POSTs must not interleave `/clear` + prompt sequences in one terminal — requires a single in-flight guard (promise-chain) keyed on the phone-a-friend terminal.
- **Worktree port-file pitfall**: `cat .switchboard/api-server-port.txt` from inside a worktree CWD reads the worktree's `.switchboard/`, which does NOT contain the port file (it is written to the main workspace root only). Mitigated by plumbing `apiPort` into the prompt at build time (Option A) rather than reading the file at runtime (Option B).
- **Terminal-close cleanup**: the new registered terminal must hook `handleTerminalClosed` or its `_registeredTerminals` / `state.terminals` entries go stale and `_isTerminalLive` lies.
- **Addon inheritance without a role signal**: the POST body must carry `originRole` or the host cannot resolve which role's addons to inherit.

## Edge-Case & Dependency Audit

**Race Conditions**
- Rapid multi-POST at batch end → interleaved `/clear` + `sendRobustText` in one terminal. Mitigation: serialize all phone-a-friend dispatches behind a single in-flight promise (`this._phoneAFriendInFlight`) and/or change the contract to one POST per batch.
- `pasteTextViaClipboard` is serialized by `_clipboardLock` (terminalUtils.ts) across all terminals — phone-a-friend `/clear` paste contends with concurrent card dispatches. Acceptable (existing invariant) but means phone-a-friend dispatch latency includes clipboard-queue wait.
- The coder POSTs from a terminal that may itself be mid-`/clear` from a card dispatch. The HTTP POST is independent of terminal state, so no cross-corruption — but the coder must POST *after* it has finished coding, not during.

**Security**
- Endpoint is localhost-only (enforced by `_handleRequest` remote-address check at the top of the router). `_checkAuth` currently returns `true` unconditionally (same as `/comment`, `/kanban/move`) — no token required in the `curl`, consistent with existing endpoints.
- `planFile` must be validated as a non-empty string and treated as an opaque relative path; do NOT resolve/traverse it server-side (the host only forwards it into the prompt text). Reject absolute paths and `..` traversal in the body to keep it a relative reference.

**Side Effects**
- Phone-a-friend terminal writes code into the same workspace/worktree as the coder. Two agents editing concurrently can conflict. The second-pass coder should operate after the coder is done — the one-POST-per-batch contract makes this sequential, but the user should be aware the phone-a-friend commits on top of the coder's commits.
- Silent drops MUST be logged to `_apiServerDiagnosticsChannel` ("phone-a-friend POST received, no terminal running, dropped") so a misconfigured workspace (addon on, no terminal) is diagnosable, not invisible.

**Dependencies & Conflicts**
- Depends on the existing `LocalApiServer` options-callback pattern (`moveCard`, `createFeature`, …) — extend, do not refactor.
- Depends on `agentPromptBuilder`'s `PromptBuilderOptions` named-flag plumbing (each addon is a named boolean field, not a generic map). A new `phoneAFriendEnabled?: boolean` field must be added to `PromptBuilderOptions` AND set at every call site that builds options from saved role addons.
- Depends on `_getAgentNameForRole` / `_isTerminalLive` / `_registeredTerminals` in `TaskViewerProvider` for terminal discovery.
- No conflict with the `terminal.clearBeforePrompt` config — the phone-a-friend dispatch should respect the same config gate as card dispatch.

## Dependencies
- None — this plan is self-contained. (No `sess_XXXXXXXXXXXXX` plan dependencies.)

## Adversarial Synthesis
Key risks: (1) the callback was drafted in the wrong file (`extension.ts` instead of `TaskViewerProvider`, the actual `LocalApiServer` owner and terminal-dispatch authority); (2) per-plan POSTs interleave `/clear`+prompt sequences in one terminal; (3) Option B port discovery breaks inside worktrees because the port file lives only in the main workspace root's `.switchboard/`; (4) a second `Stage Complete` marker risks a double stage-advance. Mitigations: wire the callback in `TaskViewerProvider`, pass `apiPort` + `originRole` through `PromptBuilderOptions` and the POST body, serialize dispatches behind a single in-flight guard, change the contract to one POST per batch, drop the Stage Complete marker from the phone-a-friend prompt, and hook `handleTerminalClosed`.

## Proposed Changes

### 1. LocalApiServer — New `POST /phone-a-friend` endpoint

#### [MODIFY] [LocalApiServer.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalApiServer.ts)

**Correction (file location):** The `LocalApiServer` is constructed in `TaskViewerProvider._startLocalApiServer()` (~line 964), NOT in `extension.ts`. The options callback is wired there (see §2). This section covers only the server-side handler and router.

Add a new endpoint handler and wire it into `_handleRequest`:

**New endpoint**: `POST /phone-a-friend`
- **Body**: `{ planFile: string, originRole?: string }` — the relative path to the plan `.md` file the coder just finished, and the originating role (defaults to `'coder'` if absent) so the host can resolve that role's saved addons.
- **Handler** (`_handlePhoneAFriend`):
  1. Call `_checkAuth(req, true)` for consistency with sibling handlers (currently a no-op; localhost boundary is the gate).
  2. Parse the JSON body. Validate `planFile` is a non-empty string and is a **relative** path (reject absolute paths and `..` traversal — the host only forwards it into prompt text, never resolves it server-side).
  3. Call the new callback `onPhoneAFriend` from `LocalApiServerOptions`, passing `planFile` and `originRole`.
  4. Return `200 { success: true }` if the callback is present (the callback handles the silent drop internally and MUST NOT throw on "no terminal").
  5. Return `503` if the callback is absent (headless/test harness), mirroring `_handleKanbanMove`'s 503-when-`moveCard`-absent pattern.

**Options interface change**: Add to `LocalApiServerOptions` (alongside `moveCard`, `createFeature`, …):
```typescript
onPhoneAFriend?: (planFile: string, originRole?: string) => Promise<void>;
```

**Router change**: Add to `_handleRequest` (insert near the `/comment` branch, ~line 1292):
```typescript
} else if (pathname === '/phone-a-friend' && req.method === 'POST') {
    await this._handlePhoneAFriend(req, res);
}
```

---

### 2. Extension wiring — Connect the endpoint to terminal dispatch

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

**Correction (file location):** This callback belongs in `TaskViewerProvider._startLocalApiServer()` (~line 964), inside the `new LocalApiServer({ … })` options object, alongside `moveCard` / `createFeature` / `assignToFeature` / etc. It does NOT belong in `extension.ts`. `TaskViewerProvider` is the only component that owns `_registeredTerminals`, `_getAgentNameForRole`, `_isTerminalLive`, `sendPromptToAgentTerminal`, and the `/clear`-before-prompt flow.

Add the `onPhoneAFriend` callback to the options object:
```typescript
onPhoneAFriend: async (planFile: string, originRole?: string) => {
    await this._dispatchPhoneAFriend(planFile, originRole || 'coder');
},
```

**New private method** `_dispatchPhoneAFriend(planFile: string, originRole: string)`:
1. **Serialize**: await `this._phoneAFriendInFlight` if set (a single in-flight promise guard — prevents interleaved `/clear`+prompt sequences when multiple POSTs arrive near-simultaneously). Set `this._phoneAFriendInFlight` to the current dispatch promise and clear it in a `finally`.
2. **Find the phone-a-friend terminal**: resolve the agent name via `_getAgentNameForRole('phone_a_friend', resolvedWorkspaceRoot)`, then look it up in `_registeredTerminals` (exact key + `_suffixedName` key, same fallback pattern as `_isTerminalLive` at ~line 6263). If not found in `_registeredTerminals`, fall back to scanning `vscode.window.terminals` by normalized name.
3. **Silent drop on missing/dead terminal**: if no live terminal (exitStatus !== undefined), log to `_apiServerDiagnosticsChannel` (`phone-a-friend POST received for <planFile>, no terminal running, dropped`) and return. Do NOT throw (a throw becomes a 500).
4. **`/clear`**: respect the `terminal.clearBeforePrompt` config (default `true`), same as the card-dispatch flow at ~line 16411 — paste `/clear` via `pasteTextViaClipboard`, submit, wait `clearDelay`.
5. **Resolve the originating role's saved addons** from `state.json` via the host's existing role-config loader (NOT the webview `roleConfigs` variable — that lives in `kanban.html` and is unreachable from the host). Default to the coder addon set if `originRole` is unknown.
6. **Build the phone-a-friend prompt**: coder's addons + a phone-a-friend preamble. **Do NOT include a `Stage Complete` marker** (the phone-a-friend is a continuation, not a stage transition — a second marker risks a double stage-advance):
   ```
   Read <planFile> — this plan was just coded by another agent. Assume the implementation contains hidden bugs. Check the code against the plan, find and fix any issues you discover. Do NOT append a Stage Complete marker — you are a second-pass continuation, not a stage transition. When done, summarize the bugs you found and the fixes you applied.
   ```
7. **Send** via `sendRobustText(terminal, normalizeNewlines(prompt), true)` wrapped in `withTerminalSendLock(sendLockKey, …)` (same pattern as `sendPromptToAgentTerminal` at ~line 2907).

**Terminal-close cleanup**: ensure `handleTerminalClosed` (~line 16033) also deletes the phone-a-friend terminal's `_registeredTerminals` entry and `state.terminals[key]` entry when it closes, matching the recent `a687666` fix for non-MCP terminals.

---

### 3. Agents Tab — Phone-a-Friend terminal row

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

**Clarification (insertion point):** Insert inside the "Agent Visibility & CLI Commands" `db-subsection` (~line 2758), after the `claude_artifacts` row (~line 2794) and before the subsection's closing `</div>` (~line 2802). Do NOT put it in the "Custom Agents" subsection.

Add a new startup row (default UNCHECKED, like `tester`/`researcher`):
```html
<div class="startup-row"><input type="checkbox" class="agents-tab-visible-toggle" data-role="phone_a_friend" style="width:auto;margin:0;flex-shrink:0;"><label style="min-width:70px;">Phone-a-Friend</label><input type="text" data-role="phone_a_friend" id="agents-tab-cmd-phone-a-friend" placeholder="e.g. agy --model flash" style="flex:1;"></div>
<div class="agent-description">Automatic second-pass coder — receives a dispatch when a coder finishes a plan batch (requires the Phone-a-Friend addon enabled on the coding role).</div>
```

This follows the exact same pattern as the existing Planner/Lead/Coder/Intern/Reviewer rows. The checkbox controls visibility, the text input sets the startup command.

#### [MODIFY] [sharedDefaults.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/sharedDefaults.js)

**Role registry additions (required — a row alone does not register a role):**
- `DEFAULT_VISIBLE_AGENTS` (~line 1): add `phone_a_friend: false`.
- `BUILT_IN_AGENT_LABELS` (~line 35): add `{ key: 'phone_a_friend', label: 'Phone-a-Friend' }`.
- `DEFAULT_ROLE_CONFIG` (~line 18): add a `phone_a_friend` entry with a minimal addon set (it receives prompts from the host, not the prompts tab):
  ```javascript
  phone_a_friend: { prompt: '', addons: { switchboardSafeguards: true, gitProhibition: true, clearAntigravityContext: false, cavemanOutput: true, skipCompilation: true, skipTests: true, subagentPolicy: 'default', customSubagentName: '', workflowFilePathEnabled: false, workflowFilePath: '' } },
  ```

No `ROLE_ADDONS` entry needed for `phone_a_friend` itself — it doesn't get prompt addons of its own (it receives prompts from the extension, not from the prompts tab).

---

### 4. Prompts Tab — Phone-a-Friend addon checkbox for coder roles

#### [MODIFY] [sharedDefaults.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/sharedDefaults.js)

Add a new addon entry to the `lead`, `coder`, and `intern` arrays in `ROLE_ADDONS`:
```javascript
{ id: 'phoneAFriend', label: 'Phone-a-Friend', tooltip: 'When done coding the batch, notify the Phone-a-Friend terminal to do a second pass (requires Phone-a-Friend agent configured)', default: false }
```

**Also add** `phoneAFriend: false` to the `.addons` objects for `lead`, `coder`, and `intern` in `DEFAULT_ROLE_CONFIG` (~lines 23, 24, 27) so the key exists for fresh installs and the checkbox state round-trips stably through the webview merge (`roleConfigs[role]?.addons?.[addon.id] ?? addon.default`).

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

Add `phoneAFriend` to the custom-agent fallback addons array in `renderRoleAddons` (~line 3364):
```javascript
{ id: 'phoneAFriend', label: 'Phone-a-Friend', tooltip: 'When done coding the batch, notify the Phone-a-Friend terminal to do a second pass (requires Phone-a-Friend agent configured)', default: false }
```

---

### 5. Prompt Builder — Phone-a-Friend directive

#### [MODIFY] [agentPromptBuilder.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentPromptBuilder.ts)

**Correction (port discovery — Option A, not B):** Use Option A (plumb the port into the prompt at build time), NOT Option B (read `.switchboard/api-server-port.txt` at runtime). The port file is written only to the **main workspace root's** `.switchboard/` (TaskViewerProvider ~line 1074); in worktree-per-plan mode the coder's CWD is the worktree, whose `.switchboard/` does NOT contain the port file — Option B produces an empty `PORT` and a malformed `curl` URL.

Add `apiPort?: number` and `phoneAFriendEnabled?: boolean` to `PromptBuilderOptions` (~line 148).

Add a new directive constant (uses the plumbed port, no file read):
```typescript
const PHONE_A_FRIEND_DIRECTIVE = (port: number) =>
  `PHONE-A-FRIEND (OPTIONAL): When you have finished coding ALL plans in this batch, notify the Phone-a-Friend agent ONCE by running:\ncurl -s -X POST http://127.0.0.1:${port}/phone-a-friend -H "Content-Type: application/json" -d '{"planFile":"<PLAN_FILE_PATH>","originRole":"coder"}'\nReplace <PLAN_FILE_PATH> with the relative path of the LAST plan file you completed. Send exactly one request per batch (not one per plan). This is a best-effort signal — if the Phone-a-Friend agent is not running, the request will succeed silently. (Requires the Phone-a-Friend agent configured in the Agents tab.)`;
```

Wire it into the `coder`, `lead`, and `intern` branches of `buildKanbanBatchPrompt`. Append to the `promptParts` arrays (both the feature-mode coder branch ~line 1160 and the non-feature coder branch ~line 1199; and the lead ~line 1108 and intern ~line 1214 branches):
```typescript
const phoneAFriendBlock = (options?.phoneAFriendEnabled && options?.apiPort) ? PHONE_A_FRIEND_DIRECTIVE(options.apiPort) : '';
```
…then add `phoneAFriendBlock` to the `promptParts` array (filtered for falsy).

**Call-site plumbing**: every dispatch path that builds `PromptBuilderOptions` from saved role addons (the card-dispatch / autoban / copy-prompt entry points in `TaskViewerProvider`) must set:
```typescript
phoneAFriendEnabled: !!roleAddons.phoneAFriend,
apiPort: this._localApiServer?.getPort(),
```
`this._localApiServer.getPort()` is already available on the provider (the server is started in `_startLocalApiServer`).

#### [MODIFY] [agentConfig.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts)

Add to `CustomAgentAddons` (~line 3):
```typescript
phoneAFriend?: boolean;
```

---

### 6. Agent Config Parsing

#### [MODIFY] [agentConfig.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts)

In `parseCustomAgentAddons` (~line 167), add:
```typescript
if (typeof obj.phoneAFriend === 'boolean') a.phoneAFriend = obj.phoneAFriend;
```

---

### 7. Port Discovery for the Directive

**Resolved: Option A (plumb the port).** See §5. The `PromptBuilderOptions.apiPort` field is set from `this._localApiServer.getPort()` at the dispatch call site and interpolated into `PHONE_A_FRIEND_DIRECTIVE(port)` at build time. This avoids the worktree port-file pitfall entirely — the agent never reads a file, it just runs the `curl` with a literal port already embedded in its prompt.

(Original Option B — `PORT=$(cat .switchboard/api-server-port.txt)` — is rejected because the port file is absent from worktree CWDs, producing a malformed URL and a silent no-op.)

---

## Open Questions

> [!NOTE]
> **Terminal name convention**: The phone-a-friend terminal name needs to be discoverable by the extension. Proposed: `Switchboard: Phone-a-Friend` (following the existing `Switchboard: Lead Coder`, `Switchboard: Coder` naming). This is set by the terminal creation code based on the agents tab role. Resolved by registering `phone_a_friend` in `BUILT_IN_AGENT_LABELS` (sharedDefaults.js + agentConfig.ts) so `_getAgentNameForRole('phone_a_friend', wsRoot)` resolves it.

> [!NOTE]
> **One POST per batch vs per plan**: The original draft said "one request per plan file." Changed to **one request per batch** (with the last completed plan file path) to prevent interleaved `/clear`+prompt dispatch storms into a single terminal, and to match "Phone-a-Friend checks the batch's work" semantics.

## Verification Plan

### Automated Tests
- Unit test for `_handlePhoneAFriend` endpoint: valid body → 200, missing/empty `planFile` → 400, absolute-path/`..`-traversal `planFile` → 400, no callback → 503, callback throws → 500 (regression guard so a future "silent drop" refactor doesn't accidentally throw past the 200 contract).
- Unit test for `parseCustomAgentAddons`: verify `phoneAFriend` boolean is parsed.
- Unit test for `buildKanbanBatchPrompt` coder branch: with `phoneAFriendEnabled + apiPort` set, the prompt contains the `curl http://127.0.0.1:<port>/phone-a-friend` directive; with either unset, it does not.
- Regression test: existing endpoint routing unaffected (the new `else if` branch does not shadow `/comment` or `/kanban/*`).

### Manual Verification
1. Enable Phone-a-Friend in the agents tab, set a startup command.
2. Enable the Phone-a-Friend addon on the Coder role in the prompts tab.
3. Dispatch a plan to the Coder.
4. Verify the coder's prompt contains the `curl` directive with a literal port (not a `cat` command).
5. When the coder finishes and runs the `curl`, verify the phone-a-friend terminal receives `/clear` followed by the review prompt (no `Stage Complete` marker in the prompt).
6. With the phone-a-friend terminal disabled, verify the coder's `curl` returns 200 and no dispatch occurs, AND a "dropped" line appears in the API server diagnostics channel.
7. In worktree-per-plan mode, verify the coder's `curl` still uses the correct port (Option A — the port is literal in the prompt, not read from the worktree's `.switchboard/`).
8. Close the phone-a-friend terminal mid-dispatch and verify `_registeredTerminals` + `state.terminals` entries are cleaned (no stale "live" report from `_isTerminalLive`).
9. Dispatch a 5-plan batch with the addon on and verify only ONE phone-a-friend dispatch fires (one POST per batch), not five interleaved ones.

---

**Recommendation:** Complexity 5 → **Send to Coder**.
