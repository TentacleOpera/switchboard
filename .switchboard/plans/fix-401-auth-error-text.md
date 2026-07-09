# Fix Misleading 401 Auth Error Text (Phantom "Api Token setting")

## Goal

Correct the `LocalApiServer` 401 response text, which directs users to a **"Switchboard: Api Token setting"** that **does not exist in the shipped extension**, and centralize the duplicated 401 body into one helper so the text cannot drift again.

### Problem & root cause

Every auth-gated handler in `src/services/LocalApiServer.ts` emits its own inline 401 response. Across the file there are **34 inline `writeHead(401)` blocks** with three different bodies:
- **26×** `{ error: 'Unauthorized', detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window' }`
- **4×** `{ error: 'Unauthorized', detail: 'Configure token in VS Code' }`
- **4×** `{ error: 'Unauthorized' }` (no detail)

The `detail` in 30 of these points the user at a **"Switchboard: Api Token setting"** to configure. **No such setting exists.** Verified:
- No `contributes.configuration` property for an API token in `package.json` (the only token setters are `switchboard.setClickUpToken` / `setLinearToken` / `setNotionToken`).
- `secrets.store(...)` is only ever called for `switchboard.clickup.apiToken` / `linear.apiToken` / `notion.apiToken` / `stitch.apiKey` — **never** `switchboard.apiToken`.
- `switchboard.apiToken` is **read-only**: a single `this._context.secrets.get('switchboard.apiToken') || ''` at `TaskViewerProvider.ts:1232`. Nothing writes it.

Root cause: the token-setter UI the message assumes was either never built or was removed alongside the old MCP server (see `remove-all-mcp-server-references.md`), leaving the error text as a dangling reference. Because `getAuthToken()` always returns `''`, `_checkAuth` (`LocalApiServer.ts:352-377`) accepts any request with **no** `Authorization` header (localhost-trust) and **401s any request that *does* send a bearer header** (it compares against the empty stored token). So the 401 fires only when a client sends an `Authorization` header at all — and the correct, universally-true remedy today is *"drop the header"*, not *"configure a setting that isn't there."*

**Scope of this plan (per user):** fix the misleading *text* (and de-duplicate it). Building a token-setter command is explicitly **out of scope** here.

## Metadata
- **Tags:** bugfix, api
- **Complexity:** 3

## User Review Required
- None. The decisions (centralize into a helper; reword to reflect the localhost-trust reality) are stated in Proposed Changes and are overridable if you prefer the surgical string-only variant noted there.

## Complexity Audit

### Routine
- Single file (`src/services/LocalApiServer.ts`). No logic change to the auth decision — only the response body and its call sites.
- Add one private helper; replace 34 inline 401 blocks with calls to it. Mechanical and patterned.
- Both target strings are confirmed present only in this file — no cross-file coordination.

### Complex / Risky
- None. Purely a diagnostic-text + de-duplication change; the `_checkAuth` boolean logic and all status codes are untouched.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Stateless response formatting.

### Security
- **No change to the auth decision.** `_checkAuth` still: no header → accept (localhost trust); header present → require matching bearer. Only the human-readable `detail` string changes. Do **not** alter the accept/reject logic while editing these blocks.

### Side Effects
- The corrected wording must stay accurate to *current* reality (no token setter). It should tell a client with a bad/again unnecessary `Authorization` header to **retry without the header**, not point at a configuration path that doesn't exist. If a token-setter UI is added later (separate work), the text should be revisited — note this coupling in a code comment on the helper.
- The 4 bare `{ error: 'Unauthorized' }` sites gain a `detail` when routed through the helper — a minor, positive consistency change (all 401s now carry the same accurate detail).

### Dependencies & Conflicts
- Adjacent, **out of scope** (do not fix here, but flag so the intern isn't tempted): `_checkAuth`'s `requireAuth` parameter (`LocalApiServer.ts:352`) is declared but never referenced — dead. And the missing `switchboard.apiToken` setter is the underlying gap. Both are separate tickets.
- No dependency on the Claude-Desktop-MCP plan; that plan already documents the token-less reality and simply consumes this surface.

## Dependencies
- None. No session dependencies, no migration, no shipped-state change (error-string content only).

## Adversarial Synthesis

**Risk Summary:** Near-zero risk — this touches only 401 response *text* and collapses 34 duplicates into one helper; the auth boolean logic and status codes are untouched. The only trap is accidentally editing an accept/reject branch while swapping response blocks (mitigate by leaving `if (!await this._checkAuth(...)) { ...; return; }` control flow intact and only replacing the two response lines), and wording that re-introduces a promise the extension can't keep (mitigate by describing localhost-trust, not a nonexistent setting).

## Proposed Changes

### `src/services/LocalApiServer.ts`

- **Context:** 34 inline 401 blocks (26 + 4 + 4 variants) inside auth-gated handlers, each of the form:
  ```ts
  if (!await this._checkAuth(req, true)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', detail: 'Configure token in VS Code: Switchboard: Api Token setting, then reload window' }));
      return;
  }
  ```
- **Logic:** Introduce one private helper and route every 401 auth response through it. Reword `detail` to reflect the localhost-trust reality (no phantom setting).
- **Implementation (recommended — centralize):**
  1. Add a private method near `_checkAuth`:
     ```ts
     // NOTE: Switchboard has no API-token setter UI today, so getAuthToken() is
     // effectively always empty and auth is localhost-trust. This 401 only fires
     // when a client sends an Authorization header at all. If a token-setter is
     // ever added, revisit this wording.
     private _sendUnauthorized(res: http.ServerResponse): void {
         res.writeHead(401, { 'Content-Type': 'application/json' });
         res.end(JSON.stringify({
             error: 'Unauthorized',
             detail: 'Invalid Authorization header. Switchboard accepts unauthenticated requests over loopback (127.0.0.1) — retry without an Authorization header.'
         }));
     }
     ```
  2. Replace the two response lines in each of the 34 blocks with `this._sendUnauthorized(res);` — leaving the surrounding `if (!await this._checkAuth(...)) { ... return; }` control flow and the `return;` untouched.
  3. Confirm zero remaining occurrences of `Api Token setting` and `Configure token in VS Code` in the file.
- **Alternative (surgical — text-only):** if you prefer the smallest possible diff, leave the inline blocks in place and only replace the two `detail` string literals (the 26× long form and the 4× short form) with the corrected wording. This fixes the user-facing bug but keeps the 34-way duplication that caused it — the helper approach is preferred for that reason.
- **Edge Cases:** Do not change any `writeHead(401)` that is *not* an auth-gate response (there are none of a different kind here, but verify by grep). Keep `Content-Type: application/json`. No change to WS-hub auth (it does not use these strings).

## Verification Plan

### Manual
- With the extension running, send a request to any auth-gated endpoint **with** a bogus header (`Authorization: Bearer nope`) → 401 whose `detail` is the new wording and contains **no** "Api Token setting".
- Send the same request **without** an `Authorization` header → succeeds (localhost trust unchanged) — confirms the auth *decision* was not altered.
- `grep -c "Api Token setting" src/services/LocalApiServer.ts` → **0**; `grep -c "Configure token in VS Code" src/services/LocalApiServer.ts` → **0**.

### Automated Tests
- A lightweight guard test asserting the phantom strings (`Api Token setting`, `Configure token in VS Code`) do not appear in `src/services/LocalApiServer.ts` (prevents regression/re-paste).
- If a request-level test harness exists for `LocalApiServer`, assert that an auth-gated endpoint returns 401 with `error: 'Unauthorized'` and the corrected `detail` when a bearer header is present, and 2xx when it is absent.

---

**Recommendation:** Complexity 3 → **Send to Intern.**

---

## Completion Summary

Implemented the centralized-helper approach: added `private _sendUnauthorized(res)` near `_checkAuth` in `src/services/LocalApiServer.ts` with corrected wording describing the loopback-trust reality (no phantom "Api Token setting"), then replaced all 34 inline 401 auth-gate blocks with calls to it — leaving the `if (!await this._checkAuth(...)) { ... return; }` control flow and auth decision untouched. One file changed. Note: 7 of the long-form blocks used a trailing-space variant (`JSON.stringify({ `) requiring a second replace pass; all 34 sites are now routed through the helper. Verified zero remaining occurrences of "Api Token setting" and "Configure token in VS Code", and only one `writeHead(401)` remains (the helper itself). No issues encountered.
