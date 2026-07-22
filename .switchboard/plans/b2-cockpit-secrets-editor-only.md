---
description: "Secrets (integration API keys + the agent apiToken) must live and be used ONLY inside the editor's trust boundary — the browser cockpit can never read a secret (already true) and, with this change, can never SET one either. Enforced two ways: hide key-entry UI in the browser via a host capability, AND reject secret-write verbs over the HTTP rail server-side (the load-bearing guard). Standalone npx gets a CLI secret-entry path so the browser stays out of the secret flow even with no editor."
---

# B2 · Browser Cockpit — Secrets Are Editor-Only (Capability Gating + Server Guard)

## Metadata
- **Project:** browser-switchboard
- **Tags:** security, api, ui, architecture
- **Complexity:** 6
- **Release phase:** B2 (browser cockpit). Security foundation — scopes what the surface-scoping plan is allowed to expose.
- **Dependencies:** Pairs with `b2-cockpit-serve-from-extension-server-concurrent` (the shared-server model makes the HTTP-vs-webview caller distinction the enforcement point) and gates `b2-cockpit-browser-surface-scope` (which drops the surfaces this makes pointless).

## Goal

Keep every secret (ClickUp/Linear/Notion API tokens, `switchboard.apiToken`) confined to the editor's trust boundary and used only server-side. The browser can neither read nor set a secret; secret-dependent features are absent from the browser, not merely hidden.

### Problem / root-cause analysis — current posture (verified)

Most of the "keys leak to the browser" fear is already handled, confirmed in code:
- **Write-only + masked UI:** the Setup key fields are `type="password"` ("Enter ClickUp/Linear/Notion API token", `setup.html:824,1030,1234`) and status is shown as "Not configured"/"configured" only. No verb echoes a raw secret in an HTTP body — `secrets.get(...)` is used server-side for the outbound call, never returned.
- **Storage:** extension → VS Code SecretStorage (OS keychain); standalone → `.switchboard/secrets.enc` (AES-GCM), master key `0600`, and both files are **gitignored** (`.gitignore:52` `.switchboard/*` with an allow-list that excludes them).
- **Surface:** localhost-bind + Origin check + one-time-token→cookie.

**Residual risk this plan closes:** the browser can still (a) **enter** a key (the password fields POST over the browser) and (b) **trigger** key-using operations. A browser is a broader attack surface than the editor (other tabs, extensions, devtools, XSS), and the standalone file store is weaker than a keychain (master key sits beside the ciphertext). So the fix is: no secret **entry** from the browser, and no browser path that manages/uses the keychain secrets beyond what we deliberately allow.

## Proposed Changes

### Server-side guard (load-bearing — do this even if the UI is hidden)
- **Context:** with the concurrency plan, ONE `LocalApiServer` serves both the editor webview (messages via the vscode bridge, not HTTP) and the browser (HTTP + cookie). **Logic:** the browser is exactly the set of requests arriving on the **HTTP verb rail**; the editor webview never uses it. So **reject secret-write verbs when they arrive over HTTP** — return `403`. **Implementation:** in `LocalApiServer`'s verb dispatch, tag requests as `origin: 'http'`; the setup/secret verbs (`set*Token`, `setApiToken`, any verb that calls `secrets.store`) refuse when `origin==='http'`. Keep this a server allow/deny list keyed by verb name, not a client-supplied flag (a client flag is spoofable). **Edge cases:** standalone has no editor webview at all → secret-write verbs are HTTP-only there, so they are always denied over the browser and must be set via the CLI path below.

### Host capability: `secretsEntry`
- Extend the existing capability mechanism (`transport.js:applyCapabilityGating`, which reads `body.dataset.hostCapabilities` and already hides terminal-dispatch controls). Add `secretsEntry` (default `false` for any browser-served panel; `true` only in the editor webview). When `false`, hide the API-key entry rows and any "set token" affordance in `setup.html` (and the token inputs in the multi-repo PAT row). The panel HTML getters set `hostCapabilities.secretsEntry=false` for the browser host in both the extension-hosted and standalone cases. This is UX/defence-in-depth on top of the server guard.

### No-echo invariant + test
- Add a test asserting no verb HTTP response body contains a stored secret value (seed a known token, sweep every read verb's response). This freezes the current good behavior so a future change can't regress a secret into a response.

### Standalone CLI secret entry
- Add `npx switchboard secrets set <clickup|linear|notion|apiToken>` (prompt for the value; never echo). Store into the OS keychain via `keytar` if available, else the existing AES-GCM file store. This gives no-editor users a secret-entry path that is NOT the browser, so the browser stays out of the secret flow universally.

## Edge-Case & Dependency Audit
- **Shared server:** the HTTP-rail = browser assumption holds only if the editor webview truly never posts to the verb HTTP endpoints — confirm the extension webview messaging does not round-trip through HTTP before relying on it; if it can, add an explicit editor-session marker the browser cannot forge (e.g. a per-webview nonce injected at HTML generation, not a cookie).
- **Triggering vs entry:** entry is always denied in the browser. For *triggering* secret-using ops (sync, create/modify ticket) decide per blast-radius — default **deny write ops** over HTTP (create/modify tickets), allow read-only status. This is enforced by the same verb allow/deny list.
- **Rotation UX:** because entry is editor-only, document that key rotation happens in the editor (or CLI for npx) — the browser Setup shows status only.

## Verification Plan
### Manual (the real DoD)
- Browser Setup shows integration **status** but **no key-entry fields**.
- `POST /setup/verb/setClickupToken` (or any secret-write verb) over the browser HTTP rail → **403**; the same action from the editor webview succeeds.
- `npx switchboard secrets set clickup` stores a key the server then uses for an outbound call; the key never appears in any HTTP response.
### Automated
- No-echo sweep test (above).
- Unit-test the verb allow/deny list: secret-write verbs denied on `origin:'http'`, allowed on `origin:'webview'`.
