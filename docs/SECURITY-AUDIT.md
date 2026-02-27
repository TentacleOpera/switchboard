# Security Audit Report (Post-Implementation Re-Audit)

- Project: Switchboard VS Code extension (`ai-product-manager`)
- Date: February 25, 2026
- Auditor: Codex 5.3 High

## Executive Summary

This is a full re-audit after implementing the prior remediation plan.

Current result:

- Active findings: 2
- Severity: 2 Low
- High/Critical findings remaining: 0

Major security controls are now in place:

- Signed dispatch envelopes (`HMAC-SHA256`) for inbox dispatch messages
- Mandatory strict auth gates on the terminal execution path
- Replay protection (`nonce`) for `execute` dispatches
- Recipient path-sink hardening before supersede/archive scans
- Security-critical settings moved to application scope (no workspace override)
- Workspace MCP config scaffolding gated to explicit dev/runtime workspace mode

## Scope and Method

Reviewed surfaces:

- `src/extension.ts`
- `src/mcp-server/register-tools.js`
- `src/services/InboxWatcher.ts`
- `src/services/TaskViewerProvider.ts`
- `src/mcp-server/mcp-server.js`
- `package.json`

Validation commands run:

- `npx tsc -p . --noEmit` -> pass
- `node --check src/mcp-server/register-tools.js` -> pass
- `node --check src/mcp-server/mcp-server.js` -> pass
- `node src/test/send-message-guards.test.js` -> 13 passed, 0 failed
- `node src/test/workflow-controls.test.js` -> 8 passed, 1 failed (`Unknown workflow: switchboard`; functional regression, not direct security control failure)
- `node src/test/inbox-watcher.test.js` -> 9 passed, 0 failed
- `node src/test/resilience-fixes.test.js` -> 5 passed, 0 failed
- `node src/test/state-manager.test.js` -> 8 passed, 0 failed
- `npm audit --json` -> registry/audit endpoint unavailable in this environment

## Implemented Security Changes

### 1. Signed dispatch envelopes and strict verification

- Implemented signing in dispatch writers:
  - `src/mcp-server/register-tools.js`
  - `src/services/TaskViewerProvider.ts`
- Implemented verification in inbox execution path:
  - `src/services/InboxWatcher.ts`
- Envelope format:
  - `version`, `nonce`, `payloadHash`, `signature`
- Signature covers:
  - `id`, `action`, `sender`, `recipient`, `createdAt`, `nonce`, `payloadHash`
- Key source:
  - Extension secret storage (`ExtensionContext.secrets`), propagated via process env at runtime.

### 2. Fail-closed session token behavior for dispatch execution

- `InboxWatcher.validateSessionToken(...)` now supports strict active-session requirement.
- For strict mode + dispatch actions:
  - Missing token -> reject
  - Invalid token -> reject
  - Missing/invalid signature -> reject
  - `execute` replayed nonce -> reject
  - `execute` stale timestamp -> reject

### 3. Supersede path sink hardening

- Added recipient validation and root containment checks before inbox supersede scan:
  - `src/mcp-server/register-tools.js`
- Added early invalid-recipient guard before any supersede path work in `send_message`.

### 4. Security setting trust hardening

- `switchboard.security.strictInboxAuth` and `switchboard.runtime.workspaceMode` set to `"scope": "application"` in `package.json`.
- Extension now enforces user-level values for security-critical settings and ignores workspace-level attempts.

### 5. External MCP scaffolding risk reduction

- `.vscode/mcp.json` scaffolding to mutable workspace MCP path now occurs only in explicit dev workspace runtime mode.
- In secure mode, scaffolding is skipped.

### 6. PID command hardening in internal registration path

- Replaced PID-related shell-string execution with argumentized `execFile(...)` calls in:
  - `src/mcp-server/register-tools.js`
- Added explicit numeric PID normalization before subprocess usage.
- Result:
  - Removes residual shell interpolation concern for PID lookups, even though ingress was already low-risk/IPC-internal.

## Finding Status Update

## Resolved

### F-01: Bridge command channel

- Resolved.
- No active `bridge.json` runtime processing path.

### F-02: Mutable workspace runtime as default execution path

- Resolved for default mode.
- Immutable bundled runtime is default; mutable workspace runtime is explicit dev-only mode.

### F-03: Shell-string git command execution

- Resolved.
- Git verification path uses `execFile(...)`.

### F-04: Registration ingress/path traversal exposure

- Resolved for identified ingress and sinks in this audit cycle.
- Additional guard added before supersede scan path sinks.

### F-05: Prefix-based root containment checks

- Resolved.

### F-06: Run sheet plan path trust in open/copy flows

- Resolved.

### F-07: Workflow artifact path existence oracle

- Resolved.

### F-08: Unsigned inbox dispatch execution risk

- Resolved for terminal execution path.
- Strict signed validation + token verification + replay/timestamp checks now active.

### F-09: Supersede recipient sink traversal edge

- Resolved.
- Recipient validation now enforced before supersede and within supersede sink.

### F-10: Workspace-level silent downgrade of security settings

- Resolved.
- Security-critical settings moved to application scope and enforced accordingly.

## Residual Low-Risk Findings

### R-01: Insecure dev mode remains available by design (Low)

- Location: `switchboard.runtime.workspaceMode` behavior in `src/extension.ts`.
- Detail: Enabling dev workspace mode intentionally allows mutable workspace runtime execution.
- Risk: User-initiated trust downgrade if enabled outside intended dev contexts.
- Recommendation: Keep existing warning; optionally add stronger startup banner + telemetry/event when enabled.

### R-02: Dispatch signing key lifecycle is long-lived (Low)

- Location: extension secret storage key provisioning in `src/extension.ts`.
- Detail: Key is persistent and reused; no periodic/automatic rotation policy yet.
- Risk: Longer exposure window if host environment is compromised.
- Recommendation: Add optional key rotation (manual command + periodic rotation window) with dual-key grace handling.

## Post-Implementation Audit Conclusion

The requested implementation plan has been executed for the primary security items.  
High and critical findings from prior audits are no longer present in this re-audit.

Remaining risk is low and primarily operational/configurational, not an immediate exploit path in default secure mode.

## Limitations

- Dependency vulnerability scan (`npm audit`) could not be completed due registry endpoint/network restrictions in this environment.
- This audit used static and behavioral validation; no destructive exploitation was performed.
