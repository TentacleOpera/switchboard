# Security Audit Report — Reassessment

- Project: Switchboard VS Code extension (`switchboard`)
- Date: June 2025
- Auditor: Opus 4.6
- Prior Audit: Codex 5.3 High (February 25, 2026)

## Executive Summary

This is a full security reassessment of the Switchboard extension, building on the prior audit by Codex 5.3 High. The codebase has grown significantly since that audit — introducing a Kanban board system, pipeline orchestration, autoban automation, review webview panels, custom agent configuration, and expanded MCP tooling. This reassessment covers all new and existing attack surfaces.

Current result:

- Active findings: 2
- Severity: 0 High, 0 Medium, 2 Low
- Remediated in this cycle: 3 (2 Medium, 1 Low)
- High/Critical findings remaining: 0

All previously resolved findings (F-01 through F-10) remain resolved. The core security architecture is sound:

- **Signed dispatch envelopes** (`HMAC-SHA256`) for inbox dispatch messages — intact and correctly implemented
- **Mandatory strict auth gates** on the terminal execution path — fail-closed behavior confirmed
- **Replay protection** (`nonce` + 5-minute freshness window) for `execute` dispatches — confirmed
- **Recipient path-sink hardening** before supersede/archive scans — intact with `isPathWithinRoot` checks
- **Security-critical settings** at application scope (no workspace override) — confirmed in `package.json`
- **Workspace MCP config scaffolding** gated to explicit dev/runtime workspace mode — confirmed
- **Content Security Policy** with per-render nonces on all webview panels — new finding, well-implemented
- **Workflow enforcement** with action-to-workflow gating and phase-gate blocks — new, correctly enforced
- **Brain leakage detection** preventing private planning paths from leaking to delegates — new, effective
- **Dispatch cooldown system** preventing rapid-fire duplicate dispatches — new, correct

## Scope and Method

### Reviewed surfaces

- `src/extension.ts` — main extension activation, key management, terminal registry, MCP lifecycle
- `src/mcp-server/register-tools.js` — all MCP tool registrations, validation, dispatch signing, workflow enforcement
- `src/mcp-server/mcp-server.js` — MCP server entry point, IPC handlers, lifecycle management
- `src/services/InboxWatcher.ts` — inbox message processing, signature verification, replay protection, terminal execution
- `src/services/TaskViewerProvider.ts` — sidebar webview, pipeline orchestration, autoban, session management, git/jules CLI integration
- `src/services/KanbanProvider.ts` — Kanban board webview, card management, MCP move handling
- `src/services/ReviewProvider.ts` — review panel webview (ticket view)
- `src/webview/implementation.html` — sidebar webview UI (innerHTML patterns, CSP)
- `src/webview/kanban.html` — Kanban board UI
- `src/webview/review.html` — ticket review UI (innerHTML patterns, escapeHtml usage)
- `package.json` — configuration schema, activation events, permission scoping

### Method

- Static analysis of all TypeScript and JavaScript source files
- Review of all webview HTML for XSS/injection patterns
- Review of all `child_process` usage for command injection
- Review of all file system operations for path traversal
- Review of all `innerHTML` assignments for unsanitized input
- Review of Content Security Policy configuration across all webview providers
- Review of inter-process communication (IPC) patterns between extension and MCP server
- Review of workflow enforcement and access control logic

## Previously Resolved Findings — Status Confirmed

All findings from the prior audit (F-01 through F-10) remain resolved. Brief confirmation:

### F-01: Bridge command channel — Resolved
No active `bridge.json` runtime processing path exists.

### F-02: Mutable workspace runtime — Resolved
Immutable bundled runtime is default; mutable workspace mode requires explicit application-scope opt-in.

### F-03: Shell-string command execution — Resolved
All git operations use `cp.execFile(...)` with argument arrays. PID lookups in `register-tools.js` use `execFileAsync('powershell', [...args])` with parameterized arguments. The `normalizePid()` function validates PID values before subprocess usage.

### F-04: Registration ingress / path traversal — Resolved
`isValidAgentName()` regex (`/^[a-zA-Z0-9 _-]+$/`) enforced at all ingress points: `handleInternalRegistration`, `set_agent_status`, `check_inbox`, `send_message` recipient, and inbox write path. `isPathWithinRoot()` enforced before supersede scans and archive operations.

### F-05: Prefix-based root containment — Resolved
`isPathWithinRoot()` uses `path.relative()` with `..` prefix check instead of string prefix matching.

### F-06: Run sheet plan path trust — Resolved

### F-07: Workflow artifact path existence oracle — Resolved

### F-08: Unsigned inbox dispatch execution — Resolved
`buildDispatchAuthEnvelope()` signs messages with HMAC-SHA256 covering `id|action|sender|recipient|createdAt|nonce|payloadHash`. `InboxWatcher.validateDispatchSignature()` verifies on receipt. Replay protection via nonce tracking (`seenNonces` Set with periodic pruning). Freshness check: 5-minute window for `execute` actions.

### F-09: Supersede recipient sink traversal — Resolved
`supersedePendingDelegateTasks()` validates recipient name and uses `isPathWithinRoot()` before scanning.

### F-10: Workspace-level security setting downgrade — Resolved
Both `switchboard.security.strictInboxAuth` and `switchboard.runtime.workspaceMode` use `"scope": "application"` in `package.json`. Extension enforces application-level values via `getEnforcedSwitchboardBooleanSetting()`.

## New Security Controls Identified

### N-01: Content Security Policy with per-render nonces

All webview panels (`TaskViewerProvider`, `KanbanProvider`, `ReviewProvider`) inject a strict CSP header:
```
default-src 'none'; script-src 'nonce-{random}' {cspSource}; style-src 'unsafe-inline' {cspSource}; img-src {cspSource} data:; font-src {cspSource}; connect-src 'none';
```
- Per-render nonce generated via `crypto.randomBytes(16).toString('base64')`
- Nonce injected into all `<script>` tags at render time
- `connect-src 'none'` blocks any outbound network from webviews
- Assessment: **Correctly implemented.** Prevents external script injection and data exfiltration from webview context.

### N-02: Workflow enforcement and action-to-workflow gating

`ACTION_REQUIRED_WORKFLOWS` map enforces that `execute` requires `handoff|improve-plan|handoff-lead` and `delegate_task` requires `handoff`. The `enforceWorkflowForAction()` function performs multi-layered validation:
- Active workflow presence check
- Workflow-action compatibility check
- Phase-gate enforcement (e.g., handoff Phase 1 must complete before dispatch)
- Async isolation: prevents sender from interrupting another agent's active workflow
- Assessment: **Correctly implemented.** Prevents unauthorized tool usage outside workflow context.

### N-03: Brain leakage detection

`isBrainLeakage()` scans payloads for internal brain directory paths (`.gemini/antigravity/brain/`) before allowing `execute` or `delegate_task` actions. Blocks accidental exposure of private planning artifacts to delegates.
- Assessment: **Effective for the targeted pattern.** See R-05 for limitation.

### N-04: Dispatch cooldown system

`checkDispatchCooldown()` uses file-based lock files per sender-recipient-action triplet with a 30-second cooldown window. `cleanupOldCooldowns()` removes stale locks older than 5 minutes.
- Assessment: **Correctly implemented.** Fail-open on error (acceptable — cooldown is a guardrail, not a security gate).

### N-05: Persona tool gating

`checkPersonaToolGate()` blocks tools prohibited by the active workflow persona (e.g., `run_in_terminal` blocked during autoplan Phase 1).
- Assessment: **Correctly implemented.**

## New Findings

### N-F01: Webview innerHTML with partial escaping in implementation.html — REMEDIATED

- Location: `src/webview/implementation.html`, `renderRecoverablePlanList()`
- Detail: The function used `innerHTML` with string concatenation where `plan.status`, `plan.sourceType`, `dateStr`, and `plan.planId` were inserted without escaping.
- Fix: Added `escapeHtml()` helper function and applied it consistently to all interpolated values in the `innerHTML` assignment (`displayTopic`, `plan.status`, `plan.sourceType`, `dateStr`, `plan.planId`, `btnLabel`).
- Status: **Resolved.**

### N-F02: Cooldown fail-open on filesystem error (Low)

- Location: `src/mcp-server/register-tools.js`, `checkDispatchCooldown()`, line ~1308
- Detail: If the cooldown directory is inaccessible or `fs.statSync` / `fs.writeFileSync` throws, the function returns `{ inCooldown: false }` — failing open.
- Impact: An attacker who can cause filesystem errors (e.g., by making the cooldowns directory read-only) can bypass the cooldown rate limit.
- Risk: Low — cooldowns are a convenience guardrail against accidental rapid-fire dispatches, not a security-critical gate. The real security enforcement is in dispatch signing and workflow gating.
- Recommendation: Acceptable as-is. If hardening is desired, log a warning on error and optionally fail-closed for `execute` actions.

### N-F03: Shell metacharacter leading character strip hardened — REMEDIATED

- Location: `src/services/InboxWatcher.ts`, `handleExecute()`
- Detail: The leading trigger character strip only covered `!`, `/`, `$`. Shell command separators (`;`, `|`, `&`) and redirectors (`<`, `>`) at the start of a payload could be dangerous if the target terminal is in shell mode.
- Fix: Extended the leading character strip regex from `/^[!/$]+/` to `/^[!/$;|&<>]+/` to also strip shell command separators and redirectors from the payload start. This only affects leading characters — payload body content is unchanged, preserving functionality for chat-mode CLIs.
- Status: **Resolved.** The warning log for remaining interior shell metacharacters is retained as defense-in-depth.

### N-F04: Signing key propagated via process environment variable (Low)

- Location: `src/extension.ts`, line ~678; `src/mcp-server/register-tools.js`, `getDispatchSigningKey()`
- Detail: The dispatch signing key is generated securely from `ExtensionContext.secrets` but then propagated to the MCP server child process via `process.env.SWITCHBOARD_DISPATCH_SIGNING_KEY`. Environment variables are visible to any process that can read `/proc/<pid>/environ` (Linux/macOS) or via process inspection tools (Windows).
- Impact: A local attacker with access to the same user session could read the signing key from the MCP server's environment and forge dispatch messages.
- Risk: Low — requires local user-session access, at which point the attacker already has significant capabilities. The signing key provides defense-in-depth against workspace file manipulation, not against a fully compromised user session.
- Recommendation: Acceptable for the current threat model. If hardening is desired, pass the key via IPC message on MCP server startup rather than environment variable, and clear it from `process.env` after the child reads it.

### N-F05: Brain leakage detector extended to cover additional AI tool directories — REMEDIATED

- Location: `src/mcp-server/register-tools.js`, `isBrainLeakage()`
- Detail: The leakage detector previously only checked for `.gemini/antigravity/brain/` paths.
- Fix: Extended the detector with an array of private path patterns covering `.cursor/rules/`, `.kiro/memories/`, and `.codeium/memories/` (both forward and backslash variants). Uses `Array.some()` for clean extensibility.
- Status: **Resolved.**

## Continuing Residual Findings

### R-01: Insecure dev mode remains available by design (Low) — Unchanged

- Location: `switchboard.runtime.workspaceMode` in `src/extension.ts`
- Detail: Enabling dev workspace mode intentionally allows mutable workspace runtime execution.
- Risk: User-initiated trust downgrade if enabled outside intended dev contexts.
- Status: Accepted risk. Application-scope gating prevents workspace-level override.

### R-02: Dispatch signing key lifecycle is long-lived (Low) — Unchanged

- Location: Extension secret storage key provisioning in `src/extension.ts`, `getOrCreateDispatchSigningKey()`
- Detail: Key is persistent and reused across sessions; no periodic rotation policy.
- Risk: Longer exposure window if host environment is compromised.
- Status: Accepted risk. Key is stored in VS Code's secure secret storage. Rotation would be a future enhancement.

## Architecture Security Summary

### Authentication and Authorization Flow

```
Agent (AI) → MCP Tool Call (send_message)
  ├─ Workflow gating: ACTION_REQUIRED_WORKFLOWS check
  ├─ Phase-gate enforcement: minimum workflow step required
  ├─ Recipient validation: isValidAgentName() regex + resolveAgentName()
  ├─ Cooldown check: per-triplet rate limiting
  ├─ Brain leakage check: private path detection
  ├─ Session token injection: from active session state
  ├─ Dispatch signing: HMAC-SHA256 envelope generation
  └─ Delivery: terminal push (IPC) or inbox file (durable fallback)

InboxWatcher (Extension) ← Inbox file pickup
  ├─ Session token validation (strict: fail-closed)
  ├─ Dispatch signature verification (HMAC-SHA256)
  ├─ Replay protection (nonce dedup for execute actions)
  ├─ Freshness check (5-min window for execute actions)
  ├─ Payload sanitization (leading trigger char strip)
  └─ Terminal delivery via VS Code sendText API
```

### Webview Security Model

```
All Webviews (Sidebar, Kanban, Review)
  ├─ CSP: default-src 'none', script-src nonce-only
  ├─ connect-src: 'none' (no outbound network)
  ├─ Communication: postMessage API only (extension ↔ webview)
  ├─ Resource access: localResourceRoots restricted to extension URI
  └─ HTML escaping: escapeHtml() used in review.html; createElement+textContent in most paths
```

### File System Trust Boundaries

```
Workspace Root
  └─ .switchboard/ (gitignored, runtime state)
      ├─ state.json — locked with proper-lockfile for concurrent access
      ├─ inbox/{agent}/ — dispatch messages (validated before processing)
      ├─ sessions/ — run sheets (read-only from webview perspective)
      ├─ plans/ — plan files (content treated as untrusted in rendering)
      ├─ cooldowns/ — rate limit lock files (ephemeral)
      └─ archive/ — superseded messages (write-only from active path)
```

## Reassessment Conclusion

The Switchboard extension maintains a strong security posture. The core dispatch signing, session authentication, and replay protection mechanisms implemented in the prior audit cycle remain intact and correctly functioning. New features (Kanban board, pipeline orchestration, autoban, review panels) have been implemented with appropriate security controls including strict Content Security Policies, workflow enforcement gating, and brain leakage detection.

The two medium-severity findings (N-F01: innerHTML escaping gaps, N-F03: shell metacharacter passthrough) represent the most actionable improvements. Neither is exploitable in default configuration without additional prerequisites (local file access or MCP session control), but addressing them would further harden the extension's defense-in-depth posture.

No high or critical findings were identified. The extension is suitable for production use in its current state.

## Limitations

- This audit is a static code review. No dynamic exploitation or penetration testing was performed.
- Dependency vulnerability scan (`npm audit`) was not executed in this environment.
- The audit covers the extension source code only; third-party MCP SDK and Node.js runtime vulnerabilities are out of scope.
- Webview rendering of markdown content (via `renderedHtml` from the extension host) was not exhaustively fuzz-tested.
