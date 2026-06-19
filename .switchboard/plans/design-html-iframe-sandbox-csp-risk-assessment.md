# Assess Real Security Risks of iframe Sandbox & CSP in design.html

## Metadata
**Complexity:** 5
**Tags:** security, frontend, refactor

## Goal

### Problem
The HTML preview feature in `design.html` uses `sandbox="allow-scripts allow-same-origin"` on the preview iframe and the CSP includes `'unsafe-inline'`, `'unsafe-eval'`, and `http:` in `frame-src`. On paper these are security anti-patterns, but they may be necessary tradeoffs for the HTML preview feature to function (executing JS inside previewed HTML files, loading local resources, etc.). The actual risk depends on the threat model: what HTML content gets previewed, where it comes from, and what the parent webview has access to.

### Root Cause
The CSP and sandbox attributes were likely set permissively to make HTML previews work without encountering blocked scripts, cross-origin issues, or resource loading failures. No formal risk assessment was done.

### Background
Three specific concerns were flagged:

1. **`sandbox="allow-scripts allow-same-origin"`** (`:3670`) — Combining these two effectively disables sandboxing. The iframe can access the parent's origin (DOM, cookies, storage). Risk depends on whether previewed HTML is trusted (user's own files) or untrusted (downloaded from external sources).

2. **`'unsafe-inline'` + `'unsafe-eval'` in CSP** (`:6`) — These make the nonce (`'nonce-{{NONCE}}'`) useless for script-src. Any inline script can execute. `'unsafe-eval'` enables `eval()` and `Function()`. Risk depends on whether untrusted content can inject scripts into the webview.

3. **`frame-src` allows `http:`** (`:6`) — Allows loading insecure HTTP content in frames. Risk depends on whether users preview HTTP URLs or only local files.

## Approach

### Phase 1: Threat Model Assessment
1. **Identify what content gets previewed** — Trace the JS to determine: does the iframe only load local HTML files from the user's workspace? Or can it load arbitrary URLs? Can it load HTML from remote sources (e.g., synced docs, downloaded content)?
2. **Identify what the parent webview has access to** — VS Code webviews run in a restricted context. Determine what secrets, tokens, or APIs are accessible from the webview's origin. If the webview has access to sensitive data (e.g., API keys for Stitch), the risk of `allow-same-origin` is higher.
3. **Identify attack vectors** — Can an attacker control what HTML gets previewed? E.g., could a malicious workspace contain an HTML file that, when previewed, exfiltrates data from the webview?

### Phase 2: Real Risk Evaluation
4. **For `allow-same-origin`**: If previewed HTML is always local user files, the risk is low (the user already trusts their own files). If previewed HTML can come from external sources, the risk is high.
5. **For `'unsafe-eval'`**: Check if any legitimate code in the webview uses `eval()` or `Function()`. If not, removing `'unsafe-eval'` is a free win. If yes, document what uses it.
6. **For `'unsafe-inline'`**: The HTML body has extensive inline styles and inline event handlers. Removing `'unsafe-inline'` would require moving all inline styles to CSS classes — assess feasibility.
7. **For `frame-src http:`**: Check if any preview feature loads HTTP URLs. If only local file:// or vscode-webview-resource: URIs are used, `http:` can be removed.

### Phase 3: Recommendations
8. Based on findings, recommend one of:
   - **Keep as-is** with documented justification (if risks are acceptable given the threat model)
   - **Tighten incrementally** (e.g., remove `'unsafe-eval'` if unused, remove `http:` from frame-src if unused)
   - **Restructure** (e.g., use a separate sandboxed origin for previews, or use a web worker for untrusted content)

## Files Changed
- Potentially `src/webview/design.html` (CSP and/or sandbox attributes) — only if recommendations call for changes
- Possibly the companion JS file if `'unsafe-eval'` removal requires code changes

## Risks
- Tightening CSP/sandbox could break HTML preview functionality if legitimate features depend on the permissive settings
- Assessment requires understanding the companion JS file's behavior, which is not in this file

## Verification
- If CSP is tightened: test HTML preview with files that use inline scripts, external resources, and various JS features
- If sandbox is changed: verify preview still renders and executes JS correctly
- Check VS Code webview console for CSP violation reports
