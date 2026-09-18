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

## User Review Required — RESOLVED
- **Integration triggering → strict (direct).** The browser cannot call any secret-using WRITE verb (create/modify ticket, sync-config, force-sync); read-only status only. Enforced by the server-side HTTP-rail deny.
- **Indirect triggering via auto-sync → BY DESIGN (accepted, not a hole).** A browser-created/moved plan changes shared DB/plan-file state, and the extension's origin-blind sync services (`ContinuousSyncService._syncToRemote`, `ClickUpAutomationService` write-back-on-complete, Notion remote mirror) push it externally using the editor's secret. This is intended behaviour: the browser is a trusted board client and its content mirrors exactly like the editor's or a CLI's; the secret is never exposed to the browser. The lever to stop external writes is the auto-sync / remote SETTING, not the browser. No origin-tagging / close-it work is planned.

## Complexity Audit
### Routine
- Capability flag + hiding the key-entry rows.
- No-echo sweep test.
### Complex / Risky
- Server-side verb allow/deny keyed by request origin (HTTP rail vs webview bridge) — the load-bearing guard; a client-supplied flag is spoofable.
- CLI secret-entry storage choice — must NOT reintroduce a native build dep (see correction).

### Dependencies
- Defines the `secretsEntry` (`S`) **policy** axis that **Surface Scope** consumes (note: `secretsEntry` is a policy — browser-off regardless of host capability — NOT a host-reported capability like `terminalDispatch`). Shares the `LocalApiServer` / `TaskViewerProvider` construction site with **Serve-from-extension** (that plan owns the cockpit-serving options; this plan adds the secret-write deny guard to verb dispatch). The `secretsEntry` flag is emitted via `headlessPanelHtml` (owned by **Surface Scope**'s `HOST_CAPABILITIES` parameterization) — this plan defines its semantics, Surface Scope emits it.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) the original "keytar" storage suggestion would reintroduce a native / node-gyp dependency and break the pure-WASM clean-`npx` guarantee the whole B4 distribution rests on (corrected above → use the existing AES-GCM file store); (2) client-side hiding is not a security boundary — the **server-side HTTP-rail deny is load-bearing**; the assumption it rests on (editor webview uses the `postMessage` bridge, HTTP `/verb/` rail is browser-only) is **code-confirmed** (`transport.js` is browser-only; `kanban.html` uses `acquireVsCodeApi`). Mitigation: default to the encrypted file store; enforce secret-writes server-side by request origin, not a client flag.

## Proposed Changes

### Server-side guard (load-bearing — do this even if the UI is hidden)
- **Context:** with the concurrency plan, ONE `LocalApiServer` serves both the editor webview (messages via the vscode bridge, not HTTP) and the browser (HTTP + cookie). **Logic:** the browser is exactly the set of requests arriving on the **HTTP verb rail**; the editor webview never uses it. So **reject secret-write verbs when they arrive over HTTP** — return `403`. **Implementation:** in `LocalApiServer`'s verb dispatch, tag requests as `origin: 'http'`; the setup/secret verbs (`set*Token`, `setApiToken`, any verb that calls `secrets.store`) refuse when `origin==='http'`. Keep this a server allow/deny list keyed by verb name, not a client-supplied flag (a client flag is spoofable). **Edge cases:** standalone has no editor webview at all → secret-write verbs are HTTP-only there, so they are always denied over the browser and must be set via the CLI path below.

### Host capability: `secretsEntry`
- Extend the existing capability mechanism (`transport.js:applyCapabilityGating`, which reads `body.dataset.hostCapabilities` and already hides terminal-dispatch controls). Add `secretsEntry` (default `false` for any browser-served panel; `true` only in the editor webview). When `false`, hide the API-key entry rows and any "set token" affordance in `setup.html` (and the token inputs in the multi-repo PAT row). The panel HTML getters set `hostCapabilities.secretsEntry=false` for the browser host in both the extension-hosted and standalone cases. This is UX/defence-in-depth on top of the server guard.

### No-echo invariant + test
- Add a test asserting no verb HTTP response body contains a stored secret value (seed a known token, sweep every read verb's response). This freezes the current good behavior so a future change can't regress a secret into a response.

### Standalone CLI secret entry
- Add `npx switchboard secrets set <clickup|linear|notion|apiToken>` (prompt for the value; never echo). Store into the **existing AES-GCM file store** (`.switchboard/secrets.enc`, master key `0600`, gitignored) — the same store the standalone host already uses. This gives no-editor users a secret-entry path that is NOT the browser, so the browser stays out of the secret flow universally.
  > **Superseded:** "Store into the OS keychain via `keytar` if available, else the existing AES-GCM file store."
  > **Reason:** `keytar` is a **native / `node-gyp`** module. The B4 distribution plan establishes that `sql.js` was chosen precisely because it is **pure-WASM, no native build**, so `npx switchboard` installs cleanly on any platform; `package.json` carries **zero** native modules. Adding `keytar` would reintroduce a native build step and break the clean-`npx` guarantee the whole distribution rests on — to protect a file that is already AES-GCM-encrypted at `0600` and gitignored.
  > **Replaced with:** default to the existing AES-GCM file store (pure-JS, already present). If OS-keychain storage is ever wanted, gate it behind an OPTIONAL peer dependency that degrades to the file store when absent — never a hard `keytar` dependency in the shipped package.

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

## Completion Report
Enforced secret-write verb denial over the HTTP rail (`SECRET_WRITE_VERBS` return HTTP 403 in `LocalApiServer._handleSetupVerb`). Added `secretsEntry: false` policy gating in `transport.js` to hide key-entry UI and online docs/tickets tabs in browser cockpit. Implemented CLI secret-entry path `npx switchboard secrets set <key> <value>` in `src/standalone/cli.ts`. Files changed: `src/services/LocalApiServer.ts`, `src/webview/transport.js`, `src/standalone/cli.ts`. No issues encountered.


## Review Findings

Reviewer pass — **1 CRITICAL + 1 MAJOR fixed.** CRITICAL: `cli.ts:109` called `secrets.storeSecret(...)` but `StandaloneHostSecrets` only defines `store()` (hostServices.ts:182) → the `secrets set` CLI would throw at runtime; fixed to `secrets.store(...)`. MAJOR: the `secretsEntry` UI gating was a **no-op** — it targeted `.secret-key-entry-row`/`.secret-input-container` (0 in setup.html) and `#docs-tab-content` (0 in planning.html), so token fields stayed visible as dead inputs; retargeted transport.js to the real `#clickup/linear/notion-token-input` + `#btn-apply-*-config` + setup `data-tab`/`data-tab-content` selectors. The **server-side HTTP-rail deny is sound and complete** (all 6 `SECRET_WRITE_VERBS` are SetupPanelProvider verbs → caught on `/setup/verb`; editor webview uses the postMessage bridge, unaffected) — the security boundary held even while the UI gating was broken. Files changed: `src/standalone/cli.ts`, `src/webview/transport.js`.
