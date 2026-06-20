# Remove Stitch OAuth Auth Mode (Keep API Key Only)

## Metadata

- **Complexity:** 4
- **Tags:** frontend, backend, refactor, ui

## Goal

### Problem

The Stitch auth panel in `design.html` exposes an "OAuth Token" radio option that is effectively dead weight:

- It is **not a real OAuth flow.** There is no authorization-code redirect, no token exchange, no client secret, no refresh token anywhere in the codebase (verified: zero matches for `refresh_token`, `authorization_code`, `redirect_uri`, `client_secret`, `oauth2` in `DesignPanelProvider.ts`).
- It is a **manual paste of a short-lived bearer token** (`ya29.a0...`). Google OAuth access tokens expire in ~1 hour, there is no refresh mechanism, and no UI guidance on how to obtain the token. So even when configured, it stops working within an hour.
- The **backend plumbing exists but leads nowhere useful**: `loadStitch` branches on `authMode === 'oauth'` to construct `new StitchToolClient({ accessToken })`, and `_setupStitchAuth` reads `switchboard.stitch.accessToken` from secret storage — but nothing keeps that token fresh.

### Background / Root Cause

The OAuth option was scaffolded as a future capability (the `@google/stitch-sdk` `StitchToolClient` does accept an `accessToken` and injects `Authorization: Bearer` + `X-Goog-User-Project` headers) but the surrounding OAuth *lifecycle* (PKCE redirect, token exchange, refresh-token storage, auto-refresh, GCP project selection) was never built. Shipping a real OAuth flow for a published extension (~4,000 installs) would additionally require a Google OAuth Client ID, consent-screen verification for a likely-restricted Gemini scope, and per-user GCP project selection — a disproportionately large effort for a feature with no demonstrated user demand.

### Desired Outcome

Remove the OAuth auth mode entirely — UI, frontend JS, backend branching, config schema, and stored secrets/config — so that **API Key is the only Stitch authentication mode**. The `⚙️ Auth` panel remains, but it only shows the API Key field. Existing users who somehow selected `oauth` mode are migrated back to `apiKey` silently, and their dead `accessToken` secret is deleted.

## User Review Required

No user review required. The scope is well-defined: remove a dead feature, migrate stale state, keep the API-key path unchanged. The user has already explicitly rejected building a real OAuth flow.

## Complexity Audit

### Routine
- Deleting HTML elements (radio group, token input group) and updating panel copy text.
- Removing JS event-handler wiring for the radio group and token input.
- Removing `mode`/`accessToken` fields from message payloads (`stitchAuthStatus` posts).
- Deleting the `switchboard.stitch.authMode` config schema entry in `package.json`.
- Removing the `switchboard.stitch.authMode` config-change listener branch in `extension.ts`.
- Removing `switchboard.stitch.accessToken` from the secret-change listener check in `extension.ts`.
- Adding a one-time idempotent migration in `extension.ts` activation.
- Simplifying `_setupStitchAuth` to always take the API-key path.

### Complex / Risky
- **15 `loadStitch(...)` call sites** must be audited and updated. 5 pass `auth.accessToken || ''` (which will be `undefined` after the return-type change), and 10 read `switchboard.stitch.accessToken` directly from secret storage (dead reads after migration). Missing any of these could send `undefined` into a message field or leave dead secret reads.
- **6 `stitchAuthStatus` post sites** in `DesignPanelProvider.ts` plus 1 in `extension.ts` must all have `mode`/`accessToken` fields stripped. The plan's original enumeration missed 2 of these (the initial panel-restore post at line 1104 and the `stitchSaveApiKey` handler at line 1391).
- **Batch-download dedicated client** (lines 1593-1603) has its own `StitchToolClient` construction with an `oauth` branch that must be collapsed to always use `new StitchToolClient()`.

## Edge-Case & Dependency Audit

### Race Conditions
- **`loadStitch` SDK cache + migration:** `loadStitch` caches the SDK instance in `_stitchSdkPromise`. If the migration runs after the first `loadStitch` call (unlikely since migration runs at activation, before any panel interaction), a stale oauth-based instance could be cached. Mitigation: migration runs at activation before any Stitch operation; `invalidateStitchSdkCache()` is called on save/secret-change. No realistic race.
- **Concurrent panel open + migration:** If the Design panel is already open during an extension reload, the migration runs before the panel's restore logic sends the initial `stitchAuthStatus`. The initial post will already reflect the post-migration state (no `mode`/`accessToken`). No race.

### Security
- **Secret deletion:** The migration deletes `switchboard.stitch.accessToken` from VS Code secret storage. This is a dead bearer token that expired within an hour of being pasted. Deletion is the correct action — no data loss of functional credentials.
- **No new secret exposure:** The API-key path is unchanged; no new secrets are introduced or logged.

### Side Effects
- **Stale `oauth` users:** Any user who selected OAuth and pasted a token will be silently flipped to API-key mode. If they had no API key configured, they will see the "not configured" banner. This is correct — their OAuth token was non-functional within an hour anyway.
- **`loadStitch` cache:** After removing the oauth branch, the cached instance is always `m.stitch` (the API-key singleton). Existing `invalidateStitchSdkCache()` calls still reset it correctly. No behavior change for API-key users.
- **Orphaned `authMode` config value:** After removing the schema entry, an orphaned `'oauth'` value in the user's settings.json is harmless (VS Code ignores unknown settings). The migration resets it to `'apiKey'` for cleanliness, but even if the migration is skipped, no breakage occurs.

### Dependencies & Conflicts
- No external dependency changes. `@google/stitch-sdk` remains; only the `StitchToolClient({ accessToken })` construction is removed (one site). The `StitchToolClient` import in the batch-download path is still needed for `new StitchToolClient()` (no-arg API-key path).
- No conflict with other features. The Stitch auth panel is self-contained.

## Dependencies

None. This plan is self-contained and does not depend on any other plan or session.

## Adversarial Synthesis

Key risks: (1) 15 `loadStitch` call sites and 7 `stitchAuthStatus` post sites must all be updated — the original plan missed 10 call sites and 2 post sites with wrong line numbers; (2) the `stitchSaveApiKey` handler (line 1391) and initial panel-restore post (line 1104) were overlooked and would send `undefined` after the return-type change; (3) the migration insertion point was unspecified. Mitigations: corrected line numbers from a full grep audit, complete enumeration of all call/post sites, migration placed after `designPanelProvider` construction at `extension.ts` line 808, and the `loadStitch` parameter is retained as a no-op to minimize call-site churn.

## Scope

### In scope
- `src/webview/design.html` — remove OAuth radio + access-token input group; simplify the auth panel copy.
- `src/webview/design.js` — remove auth-mode radio wiring, `accessToken` handling in save, and `updateStitchAuthUI` oauth branches.
- `src/services/DesignPanelProvider.ts` — remove the `oauth` branch in `loadStitch` and `_setupStitchAuth`; remove `accessToken` from the `stitchSaveAuthConfig` handler and `stitchAuthStatus` payloads; remove the dedicated oauth `StitchToolClient({ accessToken })` construction at the batch-download site (lines 1593-1603).
- `src/extension.ts` — remove `stitch.authMode` change-listener branching and the `switchboard.stitch.accessToken` secret-change listener entry.
- `package.json` — remove the `switchboard.stitch.authMode` configuration schema entry.
- **Migration** (shipped state — required per project policy): on activation, if `stitch.authMode === 'oauth'`, reset it to `apiKey` and delete the `switchboard.stitch.accessToken` secret.

### Out of scope
- Building a real OAuth/PKCE flow (explicitly rejected by user).
- Changing the API Key auth path behavior.
- Touching the `StitchToolClient` import usage on the pure API-key path (`new StitchToolClient()` with no args, which reads `STITCH_API_KEY` from env — unchanged).

## Affected Files

| File | Change |
|------|--------|
| `src/webview/design.html` | Remove OAuth radio + token group (lines 3805-3820); update panel description text (line 3804). |
| `src/webview/design.js` | Remove radio wiring (lines 3453-3467), `accessToken` save field (lines 3471, 3473, 3477-3479), `updateStitchAuthUI` oauth branch (lines 3621-3638, 3644-3645), `stitchAuthMode` state (line 2847). |
| `src/services/DesignPanelProvider.ts` | Remove oauth branches in `loadStitch` (lines 18-31), `_setupStitchAuth` (lines 859-878), save/validate handlers (lines 1398-1468), batch-download client construction (lines 1593-1603); strip `mode`/`accessToken` from all 6 `stitchAuthStatus` posts (lines 1104-1111, 1391, 1417-1424, 1435-1443, 1449-1456, 1459-1467); clean up 10 dead secret-read `loadStitch` call sites (lines 1674-1675, 1719-1720, 1789-1790, 1836-1837, 1912-1913, 1946-1947, 1962-1963, 2026-2027, 2391-2392, 2431-2432); update 5 `loadStitch(auth.accessToken || '')` call sites (lines 1447, 1484, 1517, 1552, 1623). |
| `src/extension.ts` | Remove `stitch.authMode` config-change branching (lines 1992-2014) and `accessToken` from secret listener (line 2019); add migration after `designPanelProvider` construction (after line 808). |
| `package.json` | Delete `switchboard.stitch.authMode` config schema entry (lines 178-187). |

## Implementation Plan

> **Line-number audit note (2026-06-20):** All line numbers below have been verified against the current source via grep. The original plan's line numbers were drifted by ~30-40 lines across all files. The corrected numbers reflect the actual source as of commit `f84aaf2`.

### 1. Backend: `DesignPanelProvider.ts`

**1a. `loadStitch` (lines 18-31).** Remove the `authMode` read (line 21) and the `oauth` branch (lines 23-24). The function no longer needs the `accessToken` parameter for branching, but ~15 call sites pass `auth.accessToken || ''` or a direct secret read. To minimize churn and risk, **keep the parameter but ignore it** — the function always resolves to `m.stitch` (the API-key singleton). Add a brief comment noting the param is retained for call-site stability and is unused. The simplified body:
```typescript
function loadStitch(_accessToken: string): Promise<any> {
    if (!_stitchSdkPromise) {
        _stitchSdkPromise = import(/* webpackMode: "eager" */ '@google/stitch-sdk').then(m => m.stitch);
    }
    return _stitchSdkPromise;
}
```

**1b. `_setupStitchAuth` (lines 859-878).** Remove the `mode` read (line 861), the `oauth` branch (lines 864-869), and the `accessToken` secret read (line 863). The method now always performs the API-key path: read `switchboard.stitch.apiKey`, fall back to `process.env.STITCH_API_KEY`, set the env var, and return. Simplify the return type to `{ valid: boolean; apiKey: string }` — drop `mode` and `accessToken`. This ripples to call sites that destructure `auth.mode` / `auth.accessToken`; update them (see 1c-1f). The simplified body:
```typescript
private async _setupStitchAuth(): Promise<{ valid: boolean; apiKey: string }> {
    const apiKey = (await this._context.secrets.get('switchboard.stitch.apiKey')) || '';
    const finalKey = apiKey || process.env.STITCH_API_KEY || '';
    if (finalKey) {
        process.env.STITCH_API_KEY = finalKey;
        return { valid: true, apiKey: finalKey };
    }
    return { valid: false, apiKey: finalKey };
}
```

**1c. Initial `stitchAuthStatus` post — panel restore (lines 1104-1111).** *(MISSING FROM ORIGINAL PLAN)* Remove `mode: authInfo.mode` (line 1106) and `accessToken: authInfo.accessToken` (line 1110) from the initial status payload. Keep `configured`, `valid`, `apiKey`. This requires finding where `authInfo` is obtained — it comes from `_setupStitchAuth()` called earlier in the restore logic. After the return-type change, `authInfo.mode` and `authInfo.accessToken` will be `undefined`, so these fields must be removed to avoid sending `undefined` to the webview.

**1d. `stitchSaveApiKey` handler (lines 1380-1396).** *(MISSING FROM ORIGINAL PLAN)* At line 1391, the `stitchAuthStatus` post sends `mode: auth.mode`. After the return-type change, `auth.mode` will be `undefined`. Remove `mode: auth.mode` from this post. Keep `configured: auth.valid, valid: auth.valid`.

**1e. `stitchSaveAuthConfig` handler (lines 1398-1429).** Remove `config.update('stitch.authMode', ...)` (line 1401) and the `message.accessToken` store/delete block (lines 1407-1411). Stop sending `mode`/`accessToken` in the `stitchAuthStatus` payload (lines 1419, 1423). Send only `configured`, `valid`, `apiKey`. Keep `invalidateStitchSdkCache()` + re-setup + status posts.

**1f. `stitchValidateAuth` handler (lines 1431-1468).** Remove `mode`/`accessToken` from all 3 `stitchAuthStatus` payloads in this handler (lines 1437, 1442, 1451, 1455, 1461, 1466). Keep the `stitch.projects()` validation call. Update `loadStitch(auth.accessToken || '')` at line 1447 to `loadStitch('')`.

**1g. Batch-download dedicated client (lines 1593-1603).** Remove the `mode` read (line 1595), the `accessToken` read (line 1596), and the `if (mode === 'oauth')` branch (lines 1599-1600); always use `new StitchToolClient()` (API-key path, line 1602). The `StitchToolClient` import (line 1593) is still needed for the no-arg construction.

**1h. All `loadStitch(...)` call sites — COMPLETE AUDIT (15 sites).** The original plan only enumerated 5 of these. The full list:

**Pattern A — `loadStitch(auth.accessToken || '')` (5 sites):**
- Line 1447 (`stitchValidateAuth` handler) → change to `loadStitch('')`
- Line 1484 (`stitchListDesignSystems` handler) → change to `loadStitch('')`
- Line 1517 (`stitchCreateDesignSystem` handler) → change to `loadStitch('')`
- Line 1552 (`stitchUpdateDesignSystem` handler) → change to `loadStitch('')`
- Line 1623 (`stitchApplyDesignSystem` handler) → change to `loadStitch('')`

**Pattern B — direct secret read + `loadStitch(accessToken)` (10 sites — MISSED BY ORIGINAL PLAN):**
- Lines 1674-1675 (`stitchListProjects` handler) → remove secret read, change to `loadStitch('')`
- Lines 1719-1720 (`stitchListScreens` handler, Phase 2 fetch) → remove secret read, change to `loadStitch('')`
- Lines 1789-1790 (`stitchGenerateScreen` handler) → remove secret read, change to `loadStitch('')`
- Lines 1836-1837 (`stitchGetScreenHtml` handler) → remove secret read, change to `loadStitch('')`
- Lines 1912-1913 (`stitchDownloadScreen` handler) → remove secret read, change to `loadStitch('')`
- Lines 1946-1947 (`stitchRefreshProjects` handler) → remove secret read, change to `loadStitch('')`
- Lines 1962-1963 (`stitchRefreshProjects` handler, cache-bypass path) → remove secret read, change to `loadStitch('')`
- Lines 2026-2027 (`stitchGetDesignTokens` handler) → remove secret read, change to `loadStitch('')`
- Lines 2391-2392 (`stitchDownloadBatch` handler) → remove secret read, change to `loadStitch('')`
- Lines 2431-2432 (`stitchDownloadBatch` handler, second call) → remove secret read, change to `loadStitch('')`

For Pattern B sites: remove the `const accessToken = (await this._context.secrets.get('switchboard.stitch.accessToken')) || '';` line entirely and replace `loadStitch(accessToken)` with `loadStitch('')`. These are dead reads after the migration deletes the secret.

### 2. Frontend: `design.html`

**2a. Auth panel radio + token group (lines 3805-3820).** Delete the auth-mode radio group div (lines 3805-3812) and the entire `#stitch-access-token-group` div (lines 3817-3820). Keep `#stitch-api-key-group` (lines 3813-3816), the Save/Validate/Close buttons (lines 3821-3825), and the error msg div (line 3826).

**2b. Panel copy (line 3804).** Update the description paragraph: remove "Choose authentication mode." phrasing; state that the API key is stored in VS Code secret storage and used only to call Google Stitch directly. Suggested text: "Your API key is stored in VS Code's encrypted secret storage (your OS keychain) and is used only to call Google Stitch directly — it's never sent to any Switchboard server or logged."

### 3. Frontend: `design.js`

**3a. `initStitchDesignSystemControls` (lines 3439-3496).** Remove the `getElementsByName('stitch-auth-mode')` change-handler block (lines 3453-3467). In the `btn-save-stitch-auth` handler (lines 3470-3481), remove the `mode` query (line 3471) and the `accessToken` read (line 3473); send `stitchSaveAuthConfig` with only `apiKey` (remove `mode` and `accessToken` from the message at lines 3477, 3479).

**3b. `updateStitchAuthUI` (lines 3620-3654).** Remove the `mode` read (line 3621), the `accessToken` read (line 3623), the radio-update block (lines 3625-3638), and the `#stitch-access-token-input` update (lines 3644-3645). Keep the API-key input update (lines 3641-3642) and the status-indicator logic (lines 3647+).

**3c. `stitchAuthStatus` case (lines 2846-2854).** Remove `state.stitchAuthMode = msg.mode` (line 2847). Keep `state.stitchApiKeyConfigured` / `state.stitchAuthValid` and the banner toggle. Keep the `updateStitchAuthUI(msg)` call (line 2853).

### 4. `extension.ts`

**4a. Config-change listener (lines 1992-2014).** Remove the entire `if (e.affectsConfiguration('switchboard.stitch.authMode'))` block (lines 1992-2014). The `stitch.authMode` setting is being deleted from the schema, so this listener branch is dead. The API-key path already self-heals via `_setupStitchAuth` + `invalidateStitchSdkCache` on secret change (4b), so no replacement branch is required.

**4b. Secret-change listener (lines 2017-2022).** Remove `switchboard.stitch.accessToken` from the `e.key` check (line 2019); keep only `switchboard.stitch.apiKey`. The simplified check: `if (e.key === 'switchboard.stitch.apiKey')`.

**4c. Migration (insert after line 808, after `designPanelProvider` construction).** Add a one-time idempotent migration:
```typescript
// Migration: Remove dead Stitch OAuth auth mode (shipped in prior releases).
// Reset any stale 'oauth' authMode to 'apiKey' and delete the dead accessToken secret.
{
    const stitchConfig = vscode.workspace.getConfiguration('switchboard');
    const staleAuthMode = stitchConfig.get<string>('stitch.authMode');
    if (staleAuthMode === 'oauth') {
        await stitchConfig.update('stitch.authMode', 'apiKey', vscode.ConfigurationTarget.Global);
    }
    await context.secrets.delete('switchboard.stitch.accessToken');
}
```
This migration is idempotent and safe to run on every activation. The `authMode` reset is for cleanliness (the schema entry is being removed, so an orphaned `'oauth'` value is harmless but confusing if the schema is ever reintroduced). The `accessToken` deletion removes a dead bearer token that expired within an hour of being pasted.

### 5. `package.json`

**5a.** Delete the `switchboard.stitch.authMode` configuration schema entry (lines 178-187). This removes the setting from the VS Code Settings UI. Existing values in users' `settings.json` become orphaned but harmless (VS Code ignores unknown settings).

### 6. Migration (activation)

Covered in step 4c above. The migration:
- Reads `switchboard.stitch.authMode` from config.
- If it equals `'oauth'`, resets it to `'apiKey'` (Global target) — clears stale state so it doesn't linger if the schema entry is reintroduced later.
- Deletes the `switchboard.stitch.accessToken` secret if present (dead data; a secret cannot be "archived" like a file, so deletion is the correct action per project policy for non-file state).

This migration is idempotent and safe to run on every activation.

## Edge Cases & Risks

- **Stale `oauth` users.** Any user who selected OAuth and pasted a token will, after this change, be silently flipped to API-key mode. If they had no API key configured, they will see the "not configured" banner and must paste an API key. This is correct behavior — their OAuth token was non-functional within an hour of being pasted anyway.
- **`loadStitch` cache.** `loadStitch` caches the SDK instance in `_stitchSdkPromise`. After removing the oauth branch, the cached instance is always the `m.stitch` singleton. Existing `invalidateStitchSdkCache()` calls on save/secret-change still reset it correctly. No behavior change for API-key users.
- **Call-site audit risk.** 15 `loadStitch(...)` call sites (5 `auth.accessToken || ''` + 10 direct secret reads) and 7 `stitchAuthStatus` posts (6 in `DesignPanelProvider.ts` + 1 in `extension.ts`) must be updated. Missing one could send `undefined` into a message field. Mitigation: the full grep-driven audit is now enumerated above with correct line numbers. A compile pass will catch any missed destructuring of `auth.mode` / `auth.accessToken`.
- **`StitchToolClient({ accessToken })` removal.** Only one site (batch download, lines 1599-1600) constructs the client with an access token. After removal it becomes `new StitchToolClient()` — identical to the existing API-key path. Verify no other site passes `accessToken` (confirmed: grep shows only this one site).
- **No real-user data loss.** The only deleted state is the dead `accessToken` secret and the `authMode` config value — neither of which provides working auth today.
- **`stitchSaveApiKey` handler (line 1391).** *(Added during plan improvement)* This handler sends `mode: auth.mode` in its `stitchAuthStatus` post. After the `_setupStitchAuth` return-type change, `auth.mode` will be `undefined`. Must be updated alongside the other status posts.
- **Initial panel-restore `stitchAuthStatus` post (lines 1104-1111).** *(Added during plan improvement)* This post sends `mode` and `accessToken` during panel restore. Must be updated to avoid sending `undefined` to the webview on first panel open.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`
- **Context:** Core backend for the Stitch Design panel. Contains `loadStitch` (SDK cache), `_setupStitchAuth` (credential setup), and all message handlers.
- **Logic:** Remove the `oauth` branch from `loadStitch` (always return `m.stitch`). Simplify `_setupStitchAuth` to always take the API-key path with return type `{ valid: boolean; apiKey: string }`. Strip `mode`/`accessToken` from all 6 `stitchAuthStatus` posts (lines 1104-1111, 1391, 1417-1424, 1435-1443, 1449-1456, 1459-1467). Remove the `stitch.authMode` config update and `accessToken` secret store/delete in `stitchSaveAuthConfig` (lines 1401, 1407-1411). Collapse the batch-download `StitchToolClient` construction to always use no-arg (lines 1593-1603). Update all 15 `loadStitch(...)` call sites to pass `''` and remove the 10 dead `switchboard.stitch.accessToken` secret reads.
- **Implementation:** See steps 1a-1h above for line-by-line changes.
- **Edge Cases:** The `loadStitch` parameter is retained as `_accessToken` (unused) to avoid touching 15 call-site signatures. A compile pass will catch any missed `auth.mode` / `auth.accessToken` destructuring.

### `src/webview/design.html`
- **Context:** The Stitch tab's auth configuration panel.
- **Logic:** Delete the radio group (lines 3805-3812) and the `#stitch-access-token-group` div (lines 3817-3820). Update the description paragraph (line 3804) to remove "Choose authentication mode." phrasing.
- **Implementation:** See step 2a-2b above.
- **Edge Cases:** The `#stitch-api-key-group`, Save/Validate/Close buttons, and error msg div are preserved unchanged.

### `src/webview/design.js`
- **Context:** Frontend JS for the Stitch tab, including auth panel wiring and `stitchAuthStatus` message handling.
- **Logic:** Remove the radio change-handler block (lines 3453-3467), the `mode`/`accessToken` reads in the save handler (lines 3471, 3473, 3477, 3479), the `mode`/`accessToken` reads and radio-update block in `updateStitchAuthUI` (lines 3621, 3623, 3625-3638, 3644-3645), and `state.stitchAuthMode = msg.mode` (line 2847).
- **Implementation:** See steps 3a-3c above.
- **Edge Cases:** The `updateStitchAuthUI` function still updates the API-key input and status indicator — those code paths are preserved.

### `src/extension.ts`
- **Context:** Extension activation and config/secret change listeners.
- **Logic:** Remove the `switchboard.stitch.authMode` config-change listener block (lines 1992-2014). Remove `switchboard.stitch.accessToken` from the secret-change listener check (line 2019). Add the idempotent migration after `designPanelProvider` construction (after line 808).
- **Implementation:** See steps 4a-4c above.
- **Edge Cases:** The migration runs on every activation but is idempotent (resetting `'apiKey'` to `'apiKey'` is a no-op; deleting an absent secret is a no-op).

### `package.json`
- **Context:** VS Code extension manifest with configuration schema.
- **Logic:** Delete the `switchboard.stitch.authMode` schema entry (lines 178-187).
- **Implementation:** See step 5a above.
- **Edge Cases:** Orphaned `'oauth'` values in users' `settings.json` are harmless (VS Code ignores unknown settings). The migration resets them for cleanliness.

## Verification Plan

### Automated Tests

> **Note:** Per session directives, compilation and automated tests are skipped in this session. The following verification steps are for the implementer to run after applying the changes.

1. **Compile pass** (`npm run compile`) — webpack build must succeed with no type errors. This catches:
   - Missed `auth.mode` / `auth.accessToken` destructuring (TypeScript will error on accessing properties that no longer exist on the return type).
   - Missed `message.accessToken` / `message.mode` references in handlers where the webview no longer sends those fields.
2. **Grep sweep** — confirm no remaining references to `stitch-auth-mode`, `stitch-access-token`, `stitch.authMode`, `switchboard.stitch.accessToken`, or `authMode === 'oauth'` in `src/`:
   ```
   rg "stitch-auth-mode|stitch-access-token|stitch\.authMode|switchboard\.stitch\.accessToken|authMode.*oauth" src/
   ```
   Expected: zero matches.
3. **Manual: Auth panel UI** — open the Design panel → Stitch tab → click `⚙️ Auth`. Confirm the panel shows **only** the API Key field, no radio, no OAuth token field.
4. **Manual: API key flow** — paste a valid Stitch API key → Save → confirm `stitchAuthStatus` returns `configured: true`, the status indicator shows VALID, and project list loads.
5. **Manual: Stitch operations** — confirm Generate Screen / Refresh Projects / Download Design Tokens still work on the API-key path.
6. **Manual: Migration check** — set `switchboard.stitch.authMode` to `"oauth"` and store a dummy `switchboard.stitch.accessToken` secret before launching; after activation confirm `authMode` is reset and the secret is deleted (check via a temporary log or the Secrets API).

## Recommendation

Complexity is 4 (multi-file changes with moderate logic, but all changes are removals/simplifications of existing patterns — no new architecture). **Send to Coder.**

---

## Reviewer Pass (2026-06-20)

### Stage 1: Grumpy Principal Engineer Review

**CRITICAL — `extension.ts:2005` — You deleted the closing `}));` along with the authMode block, you absolute walnut.**

The `onDidChangeConfiguration` listener at line 1982 opens `context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {`. The original code had the `}));` that closed this listener *after* the `stitch.authMode` if-block. When the implementer deleted the authMode block, they also deleted the `}));` that closed the entire config-change listener. The result: the `onDidChangeSecrets` listener registration (and every command registration after it) was swallowed into the `onDidChangeConfiguration` callback body. This is a **syntax error** — the `activate` function's closing brace gets consumed by the arrow function, leaving `push(` and `onDidChangeConfiguration(` unclosed. The extension would not compile, and if it somehow did, nothing after line 2005 would execute at activation time. This is the kind of bug that makes me question whether anyone even looked at the diff before committing.

**NIT — `package.json:178` — Orphaned blank line.**

Deleting the `switchboard.stitch.authMode` schema entry left a blank line between the `defaultMode` entry and the `defaultProjectId` entry. Valid JSON, but untidy.

### Stage 2: Balanced Synthesis

| Finding | Severity | Verdict |
|---------|----------|---------|
| Missing `}));` closing `onDidChangeConfiguration` listener | CRITICAL | **Fix now** — extension cannot compile/run without it |
| Orphaned blank line in `package.json` | NIT | **Fix now** — trivial, one-line edit |

Everything else in the implementation is correct and matches the plan:
- `loadStitch` simplified, `_accessToken` param retained as unused (call-site stability). ✓
- `_setupStitchAuth` return type narrowed to `{ valid: boolean; apiKey: string }`. ✓
- All 6 `stitchAuthStatus` posts in `DesignPanelProvider.ts` stripped of `mode`/`accessToken`. ✓
- All 15 `loadStitch(...)` call sites updated to `loadStitch('')`, 10 dead secret reads removed. ✓
- Batch-download `StitchToolClient` collapsed to no-arg. ✓
- `design.html` radio group + token group removed, copy updated. ✓
- `design.js` radio wiring, `accessToken` save field, `updateStitchAuthUI` oauth branch, `stitchAuthMode` state all removed. ✓
- `extension.ts` config-change `authMode` branch removed, secret listener narrowed to `apiKey` only. ✓
- Migration block placed correctly after `designPanelProvider` construction. ✓
- `package.json` schema entry removed. ✓

### Fixes Applied

1. **`src/extension.ts:2006`** — Added back `}));` to close the `onDidChangeConfiguration` listener. Without this, the entire `activate` function is structurally broken.
2. **`package.json:178`** — Removed orphaned blank line left by schema entry deletion.

### Validation Results

- **Grep sweep**: `rg "stitch-auth-mode|stitch-access-token|stitch\.authMode|switchboard\.stitch\.accessToken|authMode.*oauth" src/` — zero matches outside the migration block in `extension.ts` (lines 817, 819, 821), which is correct (the migration must read/update these to clean them up). ✓
- **`loadStitch` call-site audit**: 15 call sites all pass `''`, plus the function definition. ✓
- **`stitchAuthStatus` post audit**: 6 posts in `DesignPanelProvider.ts`, all send only `configured`/`valid`/`apiKey`/`error`. No `mode`/`accessToken`. ✓
- **`_setupStitchAuth` return type**: `{ valid: boolean; apiKey: string }` — no `auth.mode`/`auth.accessToken` destructuring remains. ✓
- **Compilation/tests**: Skipped per session directives. **The CRITICAL fix (missing `}));`) must be verified by a compile pass before shipping.**

### Remaining Risks

1. **Compile pass required.** The CRITICAL `}));` fix was applied but not compile-verified (per session directives). A `npm run compile` must be run before shipping to confirm no other syntax issues lurk.
2. **`dist/` rebuild required.** The webview files (`design.html`, `design.js`) were edited but `dist/` has not been rebuilt. The extension serves webviews from `dist/webview/` — a rebuild is needed for the UI changes to take effect.
3. **No functional risks** beyond the above. The OAuth removal is complete and clean across all 5 files.
