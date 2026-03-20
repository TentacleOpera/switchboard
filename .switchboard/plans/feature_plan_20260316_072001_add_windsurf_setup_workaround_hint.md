# Add windsurf setup workaround hint

## Notebook Plan

if the person selets windsurf configure, or configure all, show a hint that says that to get windsurf to recognise mcp servers you may have to install an official windsurf marketplace mcp server as well - we recommend github. Alternatively, disable then enable an official windsurf server in the windsurf mcp marketplace to get non-official servers to activate.

This is a windsurf bug. There is no way for me to fix this in a plugin, so don't get on my case about hacks.

## Goal
- After the user selects "Configure Windsurf" or "Configure All" in the setup flow, display an **informational hint message** explaining the Windsurf MCP recognition workaround.
- The hint should be non-blocking (not a modal that requires dismissal to proceed) — an information message or inline banner is appropriate.
- This is a known Windsurf bug workaround, not a hack in our code.

## Dependencies
- **Setup flow**: The configure actions are triggered from the sidebar webview in `TaskViewerProvider.ts`. Need to locate the exact message handler for Windsurf configuration.
- **No other plan dependencies.**

## Proposed Changes

### Step 1 — Locate the Windsurf configure handler (Routine)
- **File**: `src/services/TaskViewerProvider.ts`
- Search for the message handler that processes Windsurf MCP configuration. Look for cases like `'connectMcp'` (line 1275-1276), or a setup-specific handler that writes Windsurf MCP config.
- The handler likely calls `switchboard.connectMcp` or a similar command that writes to Windsurf's MCP config file.
- Identify the exact point **after** the configure action completes where the hint should be shown.

### Step 2 — Add the hint display after Windsurf configure (Routine)
- **File**: `src/services/TaskViewerProvider.ts` (or the command handler file for `switchboard.connectMcp`)
- After the Windsurf configuration is written, show an information message:
  ```ts
  vscode.window.showInformationMessage(
      '💡 Windsurf MCP Tip: To get Windsurf to recognise new MCP servers, you may need to install an official Windsurf Marketplace MCP server (we recommend GitHub MCP). Alternatively, disable then re-enable any official Windsurf MCP server in the Marketplace to trigger activation of non-official servers.',
      'Got it'
  );
  ```
- This should trigger when:
  1. The user selects "Configure Windsurf" specifically, OR
  2. The user selects "Configure All" (which includes Windsurf).
- Do **not** show the hint for non-Windsurf IDE configurations (Cursor, VS Code, etc.).

### Step 3 — Detect whether we're in Windsurf (Routine)
- Check if the current IDE is Windsurf. The extension can detect this via:
  - `vscode.env.appName` — Windsurf typically reports a distinct app name.
  - Or check if the configure action specifically targets Windsurf config paths.
- If "Configure All" is selected, only show the hint if Windsurf is one of the configured IDEs.

### Step 4 — Optional: Add hint to setup webview (Routine)
- As an alternative or supplement, add a small teal-colored hint banner in the sidebar setup tab beneath the "Configure Windsurf" button:
  ```html
  <div class="setup-hint">💡 Windsurf may need an official Marketplace MCP server installed to recognise non-official servers.</div>
  ```
- This provides persistent visibility without relying on a transient notification.

## Verification Plan
1. `npm run compile` — no build errors.
2. Open Switchboard sidebar → go to Setup tab → click "Configure Windsurf" → verify the information message appears with the workaround text.
3. Click "Configure All" (with Windsurf included) → verify the hint appears.
4. Click "Configure Cursor" or another non-Windsurf option → verify the hint does **not** appear.
5. Verify the hint is non-blocking — user can dismiss it and setup continues normally.

## Complexity Audit

### Band A — Routine
- Add a `vscode.window.showInformationMessage` call after the Windsurf configure handler
- Optional inline hint in setup webview HTML

### Band B — Complex / Risky
- None

**Recommendation**: Send it to the **Coder agent** — single information message addition with simple conditional logic.
