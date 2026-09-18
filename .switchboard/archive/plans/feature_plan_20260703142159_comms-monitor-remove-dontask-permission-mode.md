# Comms Monitor: Remove dontAsk Permission Mode from Startup Command

## Goal

Remove `--permission-mode dontAsk` from the Comms Monitor's fallback startup command. Some MCP servers (notably Google Calendar) require interactive permission prompts — the user needs to approve access the first time, or re-authorize when OAuth tokens expire. With `dontAsk`, Claude silently skips or fails these permission-gated tool calls, so Calendar checks never work even when the MCP server is correctly configured.

### Problem Analysis & Root Cause

**Symptom:** The user configures the Google Calendar MCP server, enables the gcal source, and starts polling. Calendar events are never reported — Claude silently fails the calendar tool calls because `dontAsk` prevents it from asking the user to grant access.

**Root cause (confirmed by code reading):** The fallback startup command at `TaskViewerProvider.ts:3901` (inside `getAgentStartupCommand`, method starts at line 3889) is:

```
claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"
```

`--permission-mode dontAsk` tells Claude to never prompt the user for permission. This is appropriate for headless automation where no human is watching, but the Comms Monitor runs in a **visible terminal that the user is actively managing**. When an MCP server needs permission (first-time OAuth, token refresh, scope escalation), Claude needs to ask — and the user is right there to answer.

With `dontAsk`, Claude either:
- Silently skips the tool call (Calendar check returns nothing, user thinks nothing is happening)
- Or fails with a permission error that the polling loop ignores (it just sends the next prompt)

Either way, the user never gets Calendar data and has no clear path to fix it.

## Metadata

- **Tags:** bugfix, backend, auth, cli
- **Complexity:** 2
- **Project:** switchboard
- **Repo:** (root workspace — no sub-repo)
- **Files touched:** `src/services/TaskViewerProvider.ts`
- **Domain labels (informational, not schema tags):** comms-monitor, mcp-monitor, startup-command, permissions, calendar

> Clarification: the original tag set (`comms-monitor, mcp-monitor, startup-command, permissions, calendar, bugfix`) mixed free-form domain labels with the controlled tag vocabulary. Per the improve-plan tag schema, the `## Metadata` **Tags:** line now carries only allowed-vocabulary tags (`bugfix, backend, auth, cli`); the domain labels are preserved above as an informational line so no context is lost.

## User Review Required

- **Behavioral shift is user-visible and intentional:** After this change, the Comms Monitor terminal may display interactive permission prompts (first-time MCP access, OAuth grant, token refresh). Confirm this is acceptable — it is the whole point of the fix, but the user should know the monitor is no longer fully "fire and forget" on first run.
- **Fallback-only scope:** Confirm the intent is to change *only* the built-in fallback command. Users who already set a custom `mcp_monitor` startup command (possibly copied from docs that include `--permission-mode dontAsk`) keep their existing behavior and are unaffected. There is no migration to strip `dontAsk` from user-configured commands (see Adversarial Synthesis).
- **Cross-plan coordination:** Confirm awareness that the sibling plan `comms-monitor-claude-dependency-haiku-highlight` reads and displays this exact fallback string in the UI and asserts its literal contents in its verification steps. See `## Dependencies` and the Edge-Case audit's Dependencies & Conflicts subsection.

## Complexity Audit

**Routine.** This is a one-line change to the fallback command string. No schema changes, no UI changes, no migrations. The only consideration is the behavioral implication: without `dontAsk`, the terminal may show permission prompts that the user must respond to. This is the intended behavior — the user is managing the terminal and can respond.

### Routine
- Single-line edit to a hard-coded string literal in one method (`getAgentStartupCommand`, `TaskViewerProvider.ts:3901`).
- Updating the adjacent comment (line 3899 currently reads "defaults to claude command with permission bypass flags") to explain why `dontAsk` is now omitted.
- No new code paths, no branching logic, no new dependencies.

### Complex / Risky
- **Minor, not architectural:** removing `dontAsk` changes runtime behavior (prompts can now block the terminal). This is intended, but it is the one behavioral consideration that lifts this above a pure cosmetic change.
- **Shared string with sibling plan:** the same literal is surfaced by the `haiku-highlight` sibling; a stale literal assertion there will break if that plan lands without updating its expected string (see Dependencies & Conflicts).

## Edge-Case & Dependency Audit

- **Permission prompt blocks the terminal:** When Claude asks for permission, the terminal shows a prompt (y/n) and waits. The polling loop's in-flight guard (`_mcpMonitorInFlight`; field declared at `TaskViewerProvider.ts:361`, guard check at line 20530, set true at 20540, reset in the `finally` at 20548) prevents the next tick from sending a new prompt while one is in-flight. So the polling loop naturally pauses while the user responds to the permission prompt. Once the user answers, Claude proceeds, the in-flight tick completes, and the next tick can fire. No race condition. (Line-anchor corrected: earlier draft cited line 20438, which is stale.)
- **User doesn't notice the prompt:** If the user isn't watching the terminal, a permission prompt will block indefinitely. This is inherent to interactive permission — there's no way around it without `dontAsk` (which is the broken behavior we're fixing). The companion plan's "Check Authentication" button helps here — the user can run the auth check, see the permission prompt, respond to it, and then start polling with permissions already granted.
- **First-run vs. subsequent runs:** The first time Claude accesses an MCP server, it may ask for permission. On subsequent runs (same session), the permission is already granted. So the permission prompt is primarily a first-run experience — after the user approves once, polling runs unattended.
- **OAuth token expiry:** If an OAuth token expires mid-polling, the next tool call may trigger a re-auth prompt. The user sees it in the terminal, re-authorizes, and polling resumes. This is the correct behavior — the alternative (`dontAsk`) silently fails.
- **`--allowedTools "mcp__*"` unchanged:** The allowed tools restriction stays. Claude can only use MCP tools (not bash, edit, etc.). Removing `dontAsk` doesn't expand what tools Claude can use — it just means Claude will ask before using a tool that requires permission, rather than silently skipping it.
- **Custom startup command override:** If the user has configured a custom startup command (overriding the fallback), this change doesn't affect them — their custom command is used as-is. The change only affects the fallback when no custom command is configured.
- **Companion plan — comms log file:** The companion plan to have Claude write findings to a comms log file would add `write` to `--allowedTools`. Without `dontAsk`, Claude may ask permission before writing the file. This is fine — the user approves once and subsequent writes are silent.
- **Companion plan — three-step flow:** The "Check Authentication" button becomes more valuable with this change. The user runs the auth check, responds to any permission prompts, and then starts polling with everything pre-authorized. This is the recommended flow.
- **No `confirm()` dialogs.** No UI changes.

### Race Conditions
- The only concurrency touchpoint is the polling loop's in-flight guard (`_mcpMonitorInFlight`, guard at line 20530). A blocked permission prompt holds the in-flight flag true until the current send resolves, so no overlapping tick fires. Removing `dontAsk` does not introduce any new shared state. No new race.

### Security
- Removing `dontAsk` does **not** widen Claude's authority. `--allowedTools "mcp__*"` is unchanged, so Claude is still restricted to MCP tools (no bash/edit/write). The effect is strictly that Claude will *ask* before a permission-gated MCP call instead of silently skipping it — a strict improvement in the direction of least surprise, not privilege escalation.
- Interactive prompts run in a terminal the user owns; grants persist only for the session. No credentials are stored or logged by this change.

### Side Effects
- Terminal may now block on an interactive y/n prompt on first MCP access, OAuth grant, or token refresh (intended). Unattended first-run without a human watching will stall until answered — this is inherent to interactive permission and is the accepted tradeoff. The companion "Check Authentication" flow mitigates it.
- No effect on `jules_monitor` or `claude_artifacts` fallbacks (separate branches in the same method).

### Dependencies & Conflicts
- **Direct shared-string conflict with sibling `comms-monitor-claude-dependency-haiku-highlight`:** that plan reads the resolved fallback via `getAgentStartupCommand('mcp_monitor')`, pushes it to the webview as `resolvedStartupCommand`, and its Verification Plan step 3 asserts the resolved command equals the literal `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`. Once THIS plan removes `--permission-mode dontAsk`, that literal assertion is stale. **Reconciliation (recommendation only — do not edit the sibling in this pass):** whichever plan lands second must update the expected string; if `haiku-highlight` lands after this plan, its step-3 expected command and its Symptom-2 quote (which also cites the now-corrected line 3892 → 3901) must drop `--permission-mode dontAsk`. The sibling's `haiku` substring model-detection is unaffected — only the exact-literal expectations are.
- **No functional coupling otherwise:** the two plans edit different concerns (this one edits the string; the sibling only reads/displays it). They can ship in either order provided the sibling's literal expectation is kept in sync.

## Dependencies

- `sess_haiku_highlight — comms-monitor-claude-dependency-haiku-highlight` — sibling plan that reads and displays this same fallback command string (`resolvedStartupCommand`) in the AUTOMATION-tab model indicator and asserts its literal value in verification. Soft dependency: whichever ships second must keep the expected literal in sync (drop `--permission-mode dontAsk`). No code-merge dependency.
- No other sibling in the epic touches `getAgentStartupCommand` or the `mcp_monitor` fallback string. `separate-terminal-auth-polling` and `stuck-running-status-and-stop-control` are behaviorally adjacent (they touch the monitor terminal/polling lifecycle) but do not edit this string.

## Adversarial Synthesis

Key risks: (1) the change is user-visible — the monitor terminal can now block on an interactive permission prompt, so an unattended first run stalls until answered; (2) the identical fallback literal is asserted verbatim by the `haiku-highlight` sibling, so an uncoordinated landing order leaves a stale verification expectation; (3) scope is fallback-only — users with a custom command that includes `dontAsk` are intentionally not migrated. Mitigations: the in-flight guard (line 20530) already prevents prompt-storms; the companion "Check Authentication" flow pre-clears prompts before unattended polling; the shared-string conflict is documented for the second-landing plan; and leaving custom commands untouched is the correct, non-destructive default (no forced rewrite of user config).

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — remove `--permission-mode dontAsk` from the fallback command

**Line 3901** (inside `getAgentStartupCommand`). The current source (verified) is:

```ts
        // Fallback: mcp_monitor defaults to claude command with permission bypass flags when configured command is missing/blank
        if (role === 'mcp_monitor' && (!cmd || cmd.trim() === '')) {
            cmd = 'claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"';
            console.log(`[TaskViewerProvider] Applied mcp_monitor fallback command: ${cmd}`);
        }
```

Change it to:

```ts
        // Fallback: mcp_monitor defaults to claude command with haiku model and MCP-only tools.
        // dontAsk is intentionally omitted — some MCP servers (e.g. Google Calendar) require
        // interactive permission prompts for first-time access or OAuth token refresh. The
        // monitor runs in a visible terminal the user is managing, so Claude can ask.
        if (role === 'mcp_monitor' && (!cmd || cmd.trim() === '')) {
            cmd = 'claude --model claude-haiku-4-5 --allowedTools "mcp__*"';
            console.log(`[TaskViewerProvider] Applied mcp_monitor fallback command: ${cmd}`);
        }
```

The only functional change is removing `--permission-mode dontAsk` from the command string. The comment on line 3899 (currently "defaults to claude command with **permission bypass flags**") is rewritten to explain why `dontAsk` is intentionally omitted, so the code doesn't read as an accidental deletion.

> Line-anchor note: an earlier draft cited line **3892** for this fallback; the verified location is **3901** (the method `getAgentStartupCommand` begins at 3889; the `jules_monitor` fallback occupies 3894-3897; the `mcp_monitor` block is 3899-3903).

## Verification Plan

1. **Build:** `npm run compile` succeeds with no type errors.
2. **Manual — Calendar permission prompt appears:**
   - Configure the Google Calendar MCP server in Claude's MCP config (if not already done).
   - Clear any custom startup command for `mcp_monitor` (so the fallback is used).
   - Launch the monitor terminal. Confirm the startup command is `claude --model claude-haiku-4-5 --allowedTools "mcp__*"` (no `dontAsk`).
   - Send a check prompt that includes Calendar. Confirm Claude asks for permission to access the Calendar MCP server (the prompt appears in the terminal).
   - Approve the permission. Confirm Claude proceeds to check Calendar and reports events.
3. **Manual — subsequent ticks don't re-prompt:**
   - After approving Calendar access once, let the polling loop run. Confirm subsequent Calendar checks do NOT re-prompt for permission (the grant persists within the session).
4. **Manual — Slack/Gmail unaffected:**
   - If Slack and Gmail MCP servers don't require interactive permission (they use pre-configured OAuth tokens), confirm their checks proceed without prompts. The removal of `dontAsk` doesn't add prompts where none are needed — it only allows prompts where the MCP server requires them.
5. **Manual — polling pauses during permission prompt:**
   - While a permission prompt is shown in the terminal, confirm the polling loop doesn't send a new prompt (the in-flight guard blocks it). After the user responds, confirm the next tick fires normally.
6. **Manual — custom command override unaffected:**
   - Configure a custom startup command for `mcp_monitor` (e.g. `claude --model claude-haiku-4-5 --permission-mode dontAsk --allowedTools "mcp__*"`). Confirm the custom command is used, not the fallback. The user can still opt into `dontAsk` if they want it.
7. **Regression:** Other agent roles (`jules_monitor`, `claude_artifacts`) are unaffected — their fallback commands are separate (`jules_monitor` at 3894-3897, `claude_artifacts` at 3905-3909).

### Automated Tests

- No unit test currently exercises `getAgentStartupCommand`. The one meaningful automatable assertion is a string check: given `role === 'mcp_monitor'` and an empty configured command, the resolved fallback equals `claude --model claude-haiku-4-5 --allowedTools "mcp__*"` and does **not** contain `--permission-mode dontAsk`. If a lightweight unit test is added, assert both the positive (`--allowedTools "mcp__*"` present, `--model claude-haiku-4-5` present) and negative (`dontAsk` absent) conditions so a future re-introduction of the flag is caught.
- If the `haiku-highlight` sibling adds a test asserting the resolved-command literal, that test must be updated in lockstep with this change (see Dependencies & Conflicts).
- Primary verification remains the manual terminal checks above; `npm run compile` type-check is the automated gate.

## Recommendation

**Complexity 2 → Send to Intern.** A single-line string edit with an accompanying comment update, no schema/UI/migration impact, and one well-documented cross-plan literal to keep in sync. The behavioral implication (interactive prompts) is intended and covered by the existing in-flight guard.

## Review Findings

**Files changed:** none (implementation verified correct as-is). **Validation:** fallback command at `TaskViewerProvider.ts:3906` is `claude --model claude-haiku-4-5 --allowedTools "mcp__*"` — no `dontAsk`; comment at 3901-3904 explains the rationale; `jules_monitor` (3896) and `claude_artifacts` (3911) fallbacks unchanged; sibling haiku-highlight plan's `detectModel` still correctly identifies "Haiku" from the updated command. **No fixes needed.** **Remaining risks:** Users with a custom `mcp_monitor` startup command that includes `dontAsk` are intentionally not migrated — their custom command is used as-is.
