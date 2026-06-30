# Rewrite Confusing MCP Monitor Help Text in Automation Tab

## Goal

The MCP Monitor section of the **Automation** tab in `kanban.html` contains help text that is incomprehensible jargon. It does not describe what the feature actually does. The current text reads:

> "On this interval, Switchboard asks your monitor terminal to check the selected sources via your claude.ai MCP servers. Checks run unattended using flat subscription interactive terminal sessions (saving programmatic token billing costs)."

This is meaningless to a user. Terms like "flat subscription interactive terminal sessions" and "programmatic token billing costs" are internal implementation details that obscure the actual purpose.

**What the MCP Monitor actually does:** On a set interval, Switchboard pings a dedicated terminal running a Claude session. That terminal checks the user's claude.ai MCP servers for new communications from Slack, Gmail, or Google Calendar, and reports anything noteworthy in the terminal pane. The user doesn't have to open those external apps manually.

### Problem Analysis & Root Cause

The confusing text appears in **two places** in `renderAutobanPanel()` within `src/webview/kanban.html`:

1. **Line 7742** — inside the collapsible config panel (`mcpHelp`), visible only when the panel is expanded:
   ```js
   mcpHelp.textContent = 'On this interval, Switchboard asks your monitor terminal to check the selected sources via your claude.ai MCP servers. Checks run unattended using flat subscription interactive terminal sessions (saving programmatic token billing costs).';
   ```

2. **Line 7788** — always visible below the dropdown (`mcpDesc`):
   ```js
   mcpDesc.textContent = 'On this interval, Switchboard asks your monitor terminal to check the selected sources via your claude.ai MCP servers. Checks run unattended using flat subscription interactive terminal sessions (saving programmatic token billing costs).';
   ```

**Root cause:** The text was written from an implementation perspective (describing the session architecture and billing model) rather than from a user perspective (describing what the user gets and what happens). Phrases like "flat subscription interactive terminal sessions" and "programmatic token billing costs" are internal implementation details that mean nothing to the user and obscure the actual purpose.

The text also fails to mention the three concrete data sources (Slack, Gmail, Google Calendar) that the monitor checks, even though those are the exact sources the user selects in the checkboxes directly above the help text. The preset keys (`slack`, `gmail`, `gcal`, `custom`) are confirmed in the source at lines 7680-7685, so the rewrite text accurately reflects the real sources.

## Metadata

**Tags:** ui, ux, docs, bugfix
**Complexity:** 2

## User Review Required

Yes — the replacement wording is a product/copy decision. The implementer should use the proposed strings below unless the reviewer wants different phrasing. No code-structure decisions need approval; only the final user-facing prose.

## Complexity Audit

### Routine
- Replace two string literals in `src/webview/kanban.html` with plain-language descriptions.
- No logic changes, no new dependencies, no state changes.
- Both targets use `textContent` assignment (not `innerHTML`), so the rewrite introduces zero HTML-injection surface.
- Apostrophes inside the new strings are escaped (`\'`) for single-quoted JS string literals — already correct in the proposed code below.

### Complex / Risky
- None. This is a pure text replacement in a webview HTML file.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The help text is static display-only content set once during `renderAutobanPanel()`. It has no event handlers, no async updates, and no interaction with the monitor loop or config persistence.
- **Security:** None. Both elements are assigned via `textContent`, which treats the value as plain text — no markup parsing, no script execution, no injection vector.
- **Side Effects:** None. Changing the string has no effect on monitor behavior, config save/load, dropdown state, or any other panel component. The two elements are leaf display nodes appended to the panel container.
- **Dependencies & Conflicts:** No dependency on other plans. The existing plan `feature_plan_20260625120003_mcp-monitor-dropdown-reverts-and-misplaced.md` addresses dropdown positioning and config echo bugs — it does not touch the help text wording. This plan is independent and can be executed in any order relative to that one.
- **Two copies must both be updated:** The text exists in both `mcpHelp` (collapsible panel, line 7742) and `mcpDesc` (always visible, line 7788). Updating only one leaves the other stale.
- **Line length / layout:** The automation panel uses `font-size:9px` with `line-height:1.3-1.4`. The replacement text should be concise enough to fit without excessive wrapping but detailed enough to be useful.
- **Deliberate summary/detail split:** The two rewrites are intentionally different. `mcpDesc` (always visible) is a short user-facing summary; `mcpHelp` (expanded panel) is a longer "how it works" explanation. A future reviewer must not "normalize" them to identical text — that would collapse the information hierarchy.

## Dependencies

None. This plan is self-contained and touches only two string literals in a single file.

## Adversarial Synthesis

Key risks: (1) stale line numbers could send the implementer to the wrong code — corrected to 7742 and 7788; (2) updating only one of the two identical strings leaves stale jargon visible; (3) a future reviewer might collapse the deliberately-different summary/detail rewrites into identical text. Mitigations: line numbers verified against current source, both locations explicitly enumerated, and the summary/detail intent is documented in the Edge-Case audit. Complexity remains 2 — pure copy change, no logic/state impact.

## Proposed Changes

### File: `src/webview/kanban.html`

**Change 1 — Rewrite the always-visible description (line 7788, `mcpDesc`)**

This is the short summary shown under the dropdown at all times.

Replace:
```js
mcpDesc.textContent = 'On this interval, Switchboard asks your monitor terminal to check the selected sources via your claude.ai MCP servers. Checks run unattended using flat subscription interactive terminal sessions (saving programmatic token billing costs).';
```

With:
```js
mcpDesc.textContent = 'The MCP Monitor periodically pings a dedicated Claude terminal to check your Slack, Gmail, and Google Calendar for new messages and events — so you don\'t have to open those apps manually. Results appear in the monitor terminal pane.';
```

**Change 2 — Rewrite the collapsible-panel help text (line 7742, `mcpHelp`)**

This is the longer "how it works" explanation shown only when the config panel is expanded.

Replace:
```js
mcpHelp.textContent = 'On this interval, Switchboard asks your monitor terminal to check the selected sources via your claude.ai MCP servers. Checks run unattended using flat subscription interactive terminal sessions (saving programmatic token billing costs).';
```

With:
```js
mcpHelp.textContent = 'How it works: every selected interval, Switchboard sends a prompt to your monitor terminal asking it to check the selected sources (Slack, Gmail, Google Calendar, or a custom instruction) via your claude.ai MCP servers. The terminal reports what\'s new in its pane.';
```

## Verification Plan

### Automated Tests

No automated tests required or applicable. This change alters only display-only string literals with no logic, state, or behavioral impact. There is no unit-testable surface — the strings are not consumed by any function, compared, or persisted.

### Manual Verification

1. Open the Switchboard kanban board in VS Code.
2. Click the **Automation** tab.
3. Verify the always-visible text under the MCP Monitor dropdown now reads clearly: mentions Slack, Gmail, Google Calendar, and that results appear in the monitor terminal.
4. Set the MCP Monitor dropdown to **On** to expand the config panel.
5. Verify the help text inside the expanded panel explains the interval-based check mechanism and mentions the selected sources and where results appear.
6. Confirm no jargon terms ("flat subscription interactive terminal sessions", "programmatic token billing costs") appear anywhere.
7. Confirm the text does not overflow or break the panel layout at the default 9px font size.

---

**Recommendation:** Complexity 2 → **Send to Intern**. Pure copy change, two string literals, no logic or state impact. Line numbers verified against current source.
