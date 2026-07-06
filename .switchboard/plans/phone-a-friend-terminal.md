# Phone-a-Friend Terminal — Automatic Second-Pass Coder

## Metadata
**Complexity:** 5
**Tags:** feature, ui, backend, api
**Project:** switchboard

## Goal

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

## Proposed Changes

### 1. LocalApiServer — New `POST /phone-a-friend` endpoint

#### [MODIFY] [LocalApiServer.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalApiServer.ts)

Add a new endpoint handler and wire it into `_handleRequest`:

**New endpoint**: `POST /phone-a-friend`
- **Body**: `{ planFile: string }` — the relative path to the plan `.md` file the coder just finished.
- **Handler** (`_handlePhoneAFriend`):
  1. Parse `planFile` from the JSON body. Validate it's a non-empty string.
  2. Call a new callback `onPhoneAFriend` from `LocalApiServerOptions`.
  3. Return `200 { success: true }` if the callback is present (regardless of whether a terminal is running — the callback handles the silent drop internally).
  4. Return `503` if the callback is absent (headless/test harness).

**Options interface change**: Add to `LocalApiServerOptions`:
```typescript
onPhoneAFriend?: (planFile: string) => Promise<void>;
```

**Router change**: Add to `_handleRequest`:
```typescript
} else if (pathname === '/phone-a-friend' && req.method === 'POST') {
    await this._handlePhoneAFriend(req, res);
}
```

---

### 2. Extension wiring — Connect the endpoint to terminal dispatch

#### [MODIFY] [extension.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts)

Where the `LocalApiServer` is instantiated with its options object, add the `onPhoneAFriend` callback. This callback:

1. Finds the phone-a-friend terminal by name (e.g. `Switchboard: Phone-a-Friend` or a user-configured name from the agents tab).
2. If no terminal found → return silently (silent drop).
3. Sends `/clear` to the terminal.
4. Reads the **originating coder role's saved addons** from `roleConfigs` (the same config the prompts tab persists). The phone-a-friend prompt inherits these addons (git safety, caveman output, switchboard safeguards, skip compilation, skip tests, etc.) so its behaviour matches the coder's constraints.
5. Builds the prompt using the coder's addons plus a phone-a-friend preamble: `"Read <planFile> — this plan was just coded by another agent. Assume the implementation contains hidden bugs. Check the code against the plan, find and fix any issues you discover. When done, append **Stage Complete: <column>** to the plan file."`
6. Sends the prompt to the terminal via `sendRobustText`.

---

### 3. Agents Tab — Phone-a-Friend terminal row

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

Add a new startup row in the agents tab (between the existing roles and the custom agents section):

```html
<div class="startup-row">
  <input type="checkbox" class="agents-tab-visible-toggle" data-role="phone_a_friend" style="width:auto;margin:0;flex-shrink:0;">
  <label style="min-width:70px;">Phone-a-Friend</label>
  <input type="text" data-role="phone_a_friend" id="agents-tab-cmd-phone-a-friend"
         placeholder="e.g. agy --model flash" style="flex:1;">
</div>
```

This follows the exact same pattern as the existing Planner/Lead/Coder/Intern/Reviewer rows. The checkbox controls visibility, the text input sets the startup command.

#### [MODIFY] [sharedDefaults.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/sharedDefaults.js)

No ROLE_ADDONS entry needed for `phone_a_friend` — it doesn't get prompt addons of its own (it receives prompts from the extension, not from the prompts tab).

---

### 4. Prompts Tab — Phone-a-Friend addon checkbox for coder roles

#### [MODIFY] [sharedDefaults.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/sharedDefaults.js)

Add a new addon entry to the `lead`, `coder`, and `intern` arrays in `ROLE_ADDONS`:

```javascript
{ id: 'phoneAFriend', label: 'Phone-a-Friend', tooltip: 'When done coding, notify the Phone-a-Friend terminal to do a second pass (requires Phone-a-Friend agent configured)', default: false }
```

Also add to custom agent fallback addons in `renderRoleAddons` if desired.

---

### 5. Prompt Builder — Phone-a-Friend directive

#### [MODIFY] [agentPromptBuilder.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentPromptBuilder.ts)

Add a new directive constant:

```typescript
const PHONE_A_FRIEND_DIRECTIVE = (port: number) =>
  `PHONE-A-FRIEND (OPTIONAL): When you have finished coding ALL plans in this batch, notify the Phone-a-Friend agent by running:\ncurl -s -X POST http://127.0.0.1:${port}/phone-a-friend -H "Content-Type: application/json" -d '{"planFile":"<PLAN_FILE_PATH>"}'\nReplace <PLAN_FILE_PATH> with the relative path of each plan file you completed. Send one request per plan file. This is a best-effort signal — if the Phone-a-Friend agent is not running, the request will succeed silently. (Requires the Phone-a-Friend agent configured in the Agents tab.)`;
```

Wire it into `buildCoderPrompt` (or the shared addon appender):

```typescript
if (addons?.phoneAFriend) prompt += '\n\n' + PHONE_A_FRIEND_DIRECTIVE(apiPort);
```

#### [MODIFY] [agentConfig.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts)

Add to `CustomAgentAddons`:
```typescript
phoneAFriend?: boolean;
```

---

### 6. Agent Config Parsing

#### [MODIFY] [agentConfig.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts)

In `parseCustomAgentAddons`, add:
```typescript
if (typeof obj.phoneAFriend === 'boolean') a.phoneAFriend = obj.phoneAFriend;
```

---

### 7. Port Discovery for the Directive

The prompt builder needs the API server port to emit the `curl` command. The port is already written to `.switchboard/api-server-port.txt`. Two options:

- **Option A**: Pass the port as a parameter to the prompt builder when building coder prompts (the extension has it in memory).
- **Option B**: Have the directive reference the port file: `PORT=$(cat .switchboard/api-server-port.txt)` and use `$PORT` in the curl.

**Recommendation**: Option B is simpler and doesn't require plumbing the port through all the prompt builder call sites. The agent can read the file at runtime.

Revised directive:
```
PORT=$(cat .switchboard/api-server-port.txt) && curl -s -X POST http://127.0.0.1:$PORT/phone-a-friend ...
```

---

## Open Questions

> [!NOTE]
> **Terminal name convention**: The phone-a-friend terminal name needs to be discoverable by the extension. Proposed: `Switchboard: Phone-a-Friend` (following the existing `Switchboard: Lead Coder`, `Switchboard: Coder` naming). This is set by the terminal creation code based on the agents tab role.

## Verification Plan

### Automated Tests
- Unit test for `_handlePhoneAFriend` endpoint: valid body → 200, missing planFile → 400, no callback → 503.
- Unit test for `parseCustomAgentAddons`: verify `phoneAFriend` boolean is parsed.
- Regression test: existing endpoint routing unaffected.

### Manual Verification
1. Enable Phone-a-Friend in the agents tab, set a startup command.
2. Enable the Phone-a-Friend addon on the Coder role in the prompts tab.
3. Dispatch a plan to the Coder.
4. Verify the coder's prompt contains the `curl` directive.
5. When the coder finishes and runs the `curl`, verify the phone-a-friend terminal receives `/clear` followed by the review prompt.
6. With the phone-a-friend terminal disabled, verify the coder's `curl` returns 200 and no dispatch occurs.
