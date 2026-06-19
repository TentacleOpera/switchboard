# Secure Stitch Key Storage Migration & Integration Privacy Notes

## Goal

Migrate the Stitch API key and OAuth access token from plaintext VS Code `settings.json` into encrypted `context.secrets` (OS keychain), and reword the privacy notes for all four integrations (ClickUp, Linear, Notion, Stitch) to one accurate, consistent message.

## Metadata
**Tags:** security, backend, UI
**Complexity:** 6

> Tag note: the original `refactor`/`ui` tags were normalized to the allowed list — `refactor` is not an allowed tag (dropped; the work is captured by `backend`+`security`), and `ui` → `UI`.

## User Review Required

Confirm the following decisions before implementation — each is an assumption baked into the plan:

1. **No migration code (assumption to confirm).** The feature is unreleased with exactly one user (the author). No activation-time migration and no info message will be written. The author re-enters the Stitch key once into the now-secure input and manually deletes the stale `stitch.apiKey`/`stitch.accessToken` lines from their own `settings.json`. *If a second user could ever install this build with a plaintext key in synced settings, that user is silently stranded — revisit this decision before any wider distribution.*
2. **Secret key naming divergence (Clarification, intentional).** The three existing vendors use `switchboard.<vendor>.apiToken` (one secret each). Stitch genuinely has **two** distinct secrets, so the plan uses `switchboard.stitch.apiKey` and `switchboard.stitch.accessToken` — purpose-descriptive names rather than forcing the single-secret `.apiToken` convention. Confirm this naming is acceptable.
3. **Cache-coherence authoritative path.** Save handlers (A3) are the single path that posts status + invalidates the SDK cache. `secrets.onDidChange` (A5) is optional and, if added, must not also post status. Confirm this resolution (see Adversarial Synthesis).

## Complexity Audit

### Routine
- **B1/B2 — privacy-note rewording** (`setup.html`, `design.html`): static string edits, no logic. Lowest risk, quickest win.
- **A7 — remove two `package.json` settings**: declarative deletion; verified no source references outside `DesignPanelProvider.ts`/`extension.ts`.
- **A3 — save handlers to secrets**: localized swap of `config.update(...)` → `secrets.store/delete` in two `_handleMessage` cases.

### Complex / Risky
- **A1/A2 — `_setupStitchAuth()` sync → async + 9 call sites**: a single missed `await` yields a `Promise` where a value object is expected, silently breaking auth validation. All 9 sites are inside the async `_handleMessage`, which lowers (but does not remove) the risk.
- **A4/A5 — SDK cache coherence across `loadStitch()` (14 call sites) + config watcher + optional `secrets.onDidChange`**: the cached `_stitchSdkPromise` reads `accessToken` once; re-read happens only on `invalidateStitchSdkCache()`. Removing the config-watcher trigger for the two keys means a mutation path could be missed. This is the architectural heart of the change.

## Edge-Case & Dependency Audit

- **Race Conditions:** `_stitchSdkPromise` is a module-level cache read once at first `loadStitch()`. Concurrent save + SDK-call could read a stale token if invalidation races the next `loadStitch()`; mitigated because save handlers `await secrets.store(...)` then `invalidateStitchSdkCache()` before posting status, so the next `await loadStitch()` reconstructs with the new token.
- **Security:** The entire point — keys leave plaintext `settings.json` (picked up by Settings Sync, dotfile backups, committed config, other extensions; Google auto-deactivates leaked Stitch/Gemini keys) and move to OS-keychain-backed `context.secrets`. No key is ever sent to a Switchboard server (there is none) — keys go only to the vendor endpoint, which is what makes the new privacy wording truthful.
- **Side Effects:** `process.env.STITCH_API_KEY` is still set/deleted by `_setupStitchAuth` (the `m.stitch` SDK reads it in apiKey mode) — must be preserved. Removing the two `package.json` settings means they no longer appear in the Settings UI; intended.
- **Dependencies & Conflicts:** No internal session dependencies. External: `@google/stitch-sdk` (`m.stitch` env-key path + `m.Stitch`/`m.StitchToolClient` oauth path) unchanged. `SecretStorageMock` (`src/test/integrations/shared/secret-storage-mock.js`) is the test seam, already used by ~18 integration tests.

## Dependencies

- None. (No `sess_XXXXXXXXXXXXX` upstream sessions block this work.)

## Adversarial Synthesis

**Risk Summary:** Key risks are (1) the sync→async conversion of `_setupStitchAuth()` rippling through 9 call sites where a missed `await` silently breaks auth, and (2) SDK cache coherence — the cached `_stitchSdkPromise` reads the oauth token once, so every mutation path must reliably call `invalidateStitchSdkCache()` now that the config watcher no longer fires for the secret-backed keys. Mitigations: audit all 9 `_setupStitchAuth` callers and all 14 `loadStitch()` callers; designate the **save handlers (A3) as the single authoritative status+invalidate path** and make `secrets.onDidChange` optional and status-silent to prevent double-posting. A corrected discrepancy: `loadStitch()` lives in `DesignPanelProvider.ts:17-31` (module-scoped), **not** `extension.ts` — it has no `this._context`, so threading the resolved token in as a parameter is required, not merely preferred.

---

## Problem & Why

The API-key entry sections for the four integrations don't give a consistent, accurate privacy assurance, and one of them stores its key insecurely:

- **ClickUp, Linear, Notion** (`src/webview/setup.html`) each already carry a note — *"Keys are stored via the VS Code API and are not visible to the Switchboard extension."* This wording is **inaccurate**: the extension is exactly the component that reads the key from SecretStorage and makes the vendor API call. It needs rewording to something true.
- **Stitch** (`src/webview/design.html`) only says *"Saved locally in settings."* — and that is literally true in the worst way: the Stitch API key and OAuth access token are written to **plaintext VS Code settings (`settings.json`)** via `config.update(..., ConfigurationTarget.Global)`, unlike the other three which use encrypted `context.secrets` (OS keychain).

**Why this is now a priority, not hygiene:** Google automatically deactivates Stitch/Gemini API keys it detects in publicly accessible locations. A key sitting in plaintext `settings.json` can be picked up by Settings Sync, dotfile backups, committed config, or other extensions reading the settings file — meaning users' keys get silently killed and the integration breaks. Securing storage is the fix.

### Verified architecture (key flow)

| Integration | Stored via | Location | Vendor endpoint |
|---|---|---|---|
| ClickUp | `context.secrets.store('switchboard.clickup.apiToken')` (`TaskViewerProvider.ts:4134`) | OS keychain (encrypted) | `api.clickup.com` direct |
| Linear | `context.secrets.store('switchboard.linear.apiToken')` (`TaskViewerProvider.ts:4314`) | OS keychain (encrypted) | `api.linear.app` direct |
| Notion | `context.secrets.store('switchboard.notion.apiToken')` (`TaskViewerProvider.ts:4851`; restore-on-failure at `:4859`) | OS keychain (encrypted) | `api.notion.com` direct |
| Stitch | `config.update('stitch.apiKey', Global)` (`DesignPanelProvider.ts:1340`, `1356`) | **`settings.json` plaintext** | Google Stitch/Gemini |

There is **no Switchboard backend** — keys go only to the respective vendor. This is what makes the new wording truthful.

## Scope

1. Migrate Stitch `apiKey` and `accessToken` from plaintext settings to encrypted `context.secrets` (the priority security fix).
2. Reword the privacy note for all four integrations to an accurate, consistent message.

Out of scope: changing how ClickUp/Linear/Notion store keys (already correct); changing Stitch OAuth flow logic beyond where the token is read/written; redesigning the Stitch auth UI.

---

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

**Context:** Houses the Stitch auth helper `_setupStitchAuth()` (sync, `817-836`), the message-handler `_handleMessage()` (async; all auth-related cases live here), the save handlers, and — at module scope — the cached SDK loader `loadStitch()` (`17-31`), the cache variable `_stitchSdkPromise` (`16`), and `invalidateStitchSdkCache()` (`33-35`).

**Secret keys** — introduce two secrets (Clarification: purpose-named because Stitch has two distinct secrets, vs. the single `.apiToken` the other vendors use):
- `switchboard.stitch.apiKey`
- `switchboard.stitch.accessToken`

`stitch.authMode` (the `apiKey | oauth` enum) is **not** a secret — it stays in settings.

#### A1. `_setupStitchAuth()` → async, secret-backed — `DesignPanelProvider.ts:817-836`
- **Logic:** Change signature from sync to `async` returning `Promise<{ mode, valid, apiKey?, accessToken? }>`.
- **Implementation:**
  - Read `apiKey`/`accessToken` from `this._context.secrets.get('switchboard.stitch.apiKey' | 'switchboard.stitch.accessToken')` instead of `config.get(...)` (current reads at `:820`, `:821`).
  - Keep `mode` read from `config.get('stitch.authMode')` (`:819`).
  - **Preserve the `STITCH_API_KEY` env fallback:** in apiKey mode, `finalKey = secretApiKey || process.env.STITCH_API_KEY`, and still set `process.env.STITCH_API_KEY = finalKey` (currently `:831`) so the `m.stitch` SDK picks it up. Keep the `delete process.env.STITCH_API_KEY` branch for oauth mode (currently `:824`).
- **Edge Cases:** empty secret → `finalKey` falls through to env var, then to "not configured"; oauth mode with no accessToken stays `valid:false`.

#### A2. Await all 9 callers of `_setupStitchAuth()` — `DesignPanelProvider.ts`
- **Implementation:** convert to `await this._setupStitchAuth()` at the **verified** call sites — `1042` (`ready`), `1343` (`stitchSaveApiKey`), `1360` (`stitchSaveAuthConfig`), `1379` (`stitchValidateAuth`), `1404` (`stitchValidateAuth` catch), `1420` (`stitchListDesignSystems`), `1455` (`stitchCreateDesignSystem`), `1489` (`stitchUpdateDesignSystem`), `1525` (`stitchApplyDesignSystem`).
- **Edge Cases:** all 9 are inside `private async _handleMessage(message: any): Promise<void>` (confirmed), so `await` is legal at every site. A missed `await` is the single highest-risk defect — it returns a `Promise` where a value object is expected and silently breaks `valid`/`mode` checks.

#### A3. Save handlers → write to secrets (AUTHORITATIVE invalidate + status path)
- **`stitchSaveApiKey`** (case `:1337`): replace `config.update('stitch.apiKey', message.apiKey, Global)` (`:1340`) with `this._context.secrets.store('switchboard.stitch.apiKey', message.apiKey)`. If `message.apiKey` is empty, `secrets.delete(...)` instead (delete is cleaner and matches "not configured").
- **`stitchSaveAuthConfig`** (case `:1352`): keep `config.update('stitch.authMode', ...)` (`:1355`) in settings; move the `apiKey` write (`:1356`) and `accessToken` write (`:1357`) to `secrets.store` / `secrets.delete`.
- **After a successful save (both handlers):** this is the **single authoritative path** — `await secrets.store/delete(...)`, then call `invalidateStitchSdkCache()`, then **push the status message directly** (`stitchApiKeyStatus` / `stitchAuthStatus`). Do NOT rely on the config-change watcher (it no longer fires for these keys — see A5). If A5's optional `secrets.onDidChange` is added, it must NOT also post status, to avoid double-posting.

#### A4. Module-level `loadStitch()` — `DesignPanelProvider.ts:17-31`  *(corrected: NOT `extension.ts`)*
- **Context:** `loadStitch()` is **module-scoped** in `DesignPanelProvider.ts` (lines `17-31`), not a class method — it has **no `this._context`**. It reads `stitch.authMode` (`:20`) and `stitch.accessToken` (`:21`) from config at SDK-construction time, then constructs `new m.Stitch(new m.StitchToolClient({ accessToken }))` for oauth mode or returns `m.stitch` for apiKey mode. It is cached via `_stitchSdkPromise` and has **14 call sites** (all `await loadStitch()`): `1393, 1430, 1463, 1498, 1569, 1620, 1664, 1733, 1779, 1822, 1852, 1867, 1930, 2261`.
- **Logic (required, not merely preferred):** Because `loadStitch()` is module-scoped, it cannot reach `this._context.secrets`. Change its signature to `loadStitch(accessToken: string)` (or pass a secrets accessor) and have callers resolve the token from secrets first, then pass it in. This keeps the function pure.
- **Implementation:** Only **oauth mode** needs the threaded token (apiKey mode relies on `process.env.STITCH_API_KEY` set by `_setupStitchAuth`). At each of the 14 call sites, resolve `accessToken` from `this._context.secrets.get('switchboard.stitch.accessToken')` (the calling methods are class methods with `this._context`) before calling `await loadStitch(accessToken)`.
- **Edge Cases:** the cache means `accessToken` is captured only at first construction; re-read happens on `invalidateStitchSdkCache()` (driven by A3). An empty/undefined token in oauth mode yields a non-functional `StitchToolClient` — same behavior as today with an empty config value.

### `src/extension.ts`

#### A5. Config-change watcher — `extension.ts:1931-1952`  *(corrected span)*
- **Context:** the `onDidChangeConfiguration` handler spans `1931-1952`: `affectsConfiguration` checks for `switchboard.stitch.apiKey`/`authMode`/`accessToken` at `1932-1934`; `invalidateStitchSdkCache()` at `1936`; design-panel status posts at `1944-1950`.
- **Logic:** `affectsConfiguration('switchboard.stitch.apiKey')` and `...accessToken` will **no longer fire** once these are secrets. Remove those two from the `if` condition (`1932`, `1934`); **keep** `affectsConfiguration('switchboard.stitch.authMode')` (`1933`) — mode is still settings, and a mode flip must still invalidate the SDK cache + repost status.
- **Implementation:** the status-recompute block (`1936-1951`) must resolve `apiKey`/`accessToken` from secrets (async) rather than `config.get`.
- **Optional (status-silent):** a `this._context.secrets.onDidChange` subscription (in `DesignPanelProvider` or `extension.ts`) that, for keys `switchboard.stitch.apiKey`/`accessToken`, calls `invalidateStitchSdkCache()` **only** when the design panel is open. There is currently no `secrets.onDidChange` subscription in the codebase. This is for external/out-of-band secret edits; the save handlers (A3) remain the authoritative status path — this watcher must NOT post status (avoids double-posting).

### `package.json`

#### A7. Remove the two setting contributions — `package.json`
- **Remove** `switchboard.stitch.apiKey` (`174-179`) and `switchboard.stitch.accessToken` (`190-195`) outright. No `deprecationMessage`/follow-up-release dance — there's no installed base to break (verified: no source references outside `DesignPanelProvider.ts`/`extension.ts`).
- **Keep** `switchboard.stitch.authMode` (`180-189`, enum `apiKey|oauth`, default `apiKey`) as-is.

### A6. No migration (unreleased, single user)
The feature is unreleased and has exactly one user (the author). There is no installed base to migrate. The only stale plaintext value is the author's own current `stitch.apiKey`/`stitch.accessToken` in their `settings.json`, which is re-entered once into the now-secure input (and the old lines deleted by hand). **No activation-time migration code, no info message.** (See User Review Required #1.)

### `src/webview/setup.html` — B1. Privacy note rewording

**Approved wording (encrypted-storage integrations):**
> "Your key is stored in VS Code's encrypted secret storage (your OS keychain) and is used only to call [ClickUp/Linear/Notion/Google Stitch] directly — it's never sent to any Switchboard server or logged."

- ClickUp note `:680-682` (text at `:681`) → approved wording, vendor "ClickUp".
- Linear note `:834-836` (text at `:835`) → approved wording, vendor "Linear".
- Notion note `:964-966` (text at `:965`) → approved wording, vendor "Notion".
- Existing style is `font-size:9px; color:var(--text-secondary); margin-top:4px; line-height:1.3` — preserve it.

### `src/webview/design.html` — B2. Privacy note rewording (Stitch)

Once Part A lands, **Stitch qualifies for the same wording** (it will be in SecretStorage too), so all four get one consistent, truthful message with only the vendor name swapped.

- Replace the weak `:3744` line — `<p style="margin: 0; font-size: 11px; color: var(--text-secondary);">Choose authentication mode. Saved locally in settings.</p>` — and/or add a note directly under the API-key input (`#stitch-api-key-input` at `:3755`) / access-token input (`#stitch-access-token-input` at `:3759`), using the approved wording with vendor "Google Stitch".
- **Styling (corrected):** match **design.html's own** note style — `font-size: 11px; color: var(--text-secondary)` (the `:3744` paragraph) or `font-size: 10px` (the input labels at `:3754`/`:3758`). **Do NOT** copy setup.html's `9px` — that string does not exist in design.html and would render visibly smaller than every other label on the Stitch panel.

---

## Risks & edge cases

- **Sync→async ripple (highest risk):** `_setupStitchAuth()` going async touches 9 call sites (enumerated in A2); a missed `await` yields a `Promise` where a value object is expected, silently breaking auth validation. Audit every caller.
- **SDK cache coherence:** `_stitchSdkPromise` is cached (`DesignPanelProvider.ts:16`); auth changes must reliably trigger `invalidateStitchSdkCache()`. With the config watcher no longer firing for the keys, the **save handlers (A3) are the authoritative path**; `secrets.onDidChange` (A5) is optional and status-silent. This avoids both missed-invalidation and double-posting.
- **OAuth token path:** `loadStitch()` (`DesignPanelProvider.ts:17-31`, 14 call sites) constructs `StitchToolClient({ accessToken })` at module scope — the token must be resolved from secrets by the caller and threaded in (A4), and re-resolved on cache invalidation.
- **Tests:** no existing test asserts the old note strings, `config.get('stitch.apiKey')`, or the Stitch save handlers (verified — zero matches in `src/test`). If implementation adds new tests, use `SecretStorageMock` (`src/test/integrations/shared/secret-storage-mock.js`; API: `constructor(seed={})`, async `get/store/delete`, `snapshot()`), the pattern used by ~18 existing integration tests.
- **Webview rebuild:** changes are in `src/webview/*`; confirm the build copies/bundles to `dist/webview/*` so the installed panel reflects the new notes (per project convention, edit source not dist).

## Acceptance criteria

1. Saving a Stitch API key or OAuth token writes to `context.secrets`, never to `settings.json`; inspecting `settings.json` after save shows no `stitch.apiKey`/`stitch.accessToken` value.
2. Stitch auth validation, SDK calls (apiKey and oauth modes), and the `STITCH_API_KEY` env fallback all still work after re-entering the key once.
3. All four integration sections display the new, accurate privacy note with the correct vendor name and the integration's own existing note styling.
4. No regression in ClickUp/Linear/Notion key handling (untouched) and existing test suite passes.

## Verification Plan

> Per session directive, compilation and automated test execution are deferred to the user. The steps below define what *should* be run/checked, not commands to execute now.

### Automated Tests
- **No existing tests break** — verified zero references in `src/test` to the old note strings, `config.get('stitch.apiKey')`, `_setupStitchAuth`, `stitchSaveApiKey`, or `stitchSaveAuthConfig`.
- **New (optional) coverage** — if added, exercise the two save handlers against `SecretStorageMock`: assert `secrets.store('switchboard.stitch.apiKey', ...)` / `secrets.delete(...)` is called and `config.update('stitch.apiKey', ...)` is NOT; assert `invalidateStitchSdkCache()` runs and status is posted exactly once. Mirror the ClickUp/Linear/Notion integration-test pattern that already uses `SecretStorageMock`.
- **Manual sanity (author):** re-enter the Stitch key once into the secure input; confirm apiKey-mode and oauth-mode SDK calls succeed; confirm `settings.json` contains no `stitch.apiKey`/`stitch.accessToken` afterward.

## Suggested implementation order

1. A1–A2 (async `_setupStitchAuth` + 9 callers) — the structural core.
2. A3 (save handlers to secrets; authoritative invalidate+status path).
3. A4–A5 (`loadStitch(accessToken)` threading across 14 call sites + config watcher; optional status-silent `secrets.onDidChange`).
4. A7 (remove the two `package.json` settings).
5. B1–B2 (wording) — independent, can land anytime; quickest win.
6. Update/add any Stitch tests; run full suite. Re-enter the Stitch key once into the secure input.

---

**Recommendation: Send to Coder.** (Complexity 6 ≤ 6. The plan is now precise — corrected `loadStitch` location, enumerated call sites, and a decided cache-coherence path — and carries no strategic ambiguity, only well-scoped implementation steps.)
