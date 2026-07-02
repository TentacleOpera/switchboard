# ClickUp API v2 → v3 Migration (Version-Aware Plumbing + Selective Endpoint Migration)

**Plan ID:** cf130597-9993-46d4-87ad-fc21c768d670

## Goal

### Problem

Switchboard's ClickUp integration is hard-pinned to API v2 in three places, which blocks any use of ClickUp's newer v3 endpoints and has already caused real friction:

1. `ClickUpSyncService.httpRequest` (line 2237) hardcodes the `/api/v2` path prefix. A nearly identical copy, `httpRequestV3` (line 2311), hardcodes `/api/v3`. ~150 lines of HTTPS plumbing are duplicated, and every new API version or endpoint family risks a third copy.
2. The raw `/api/clickup` proxy (`makeApiRequest`, line 2187) funnels everything into the v2-pinned `httpRequest`, so agent skills **cannot reach any v3 endpoint at all**. This forced the ticket-move plan (`feature_plan_20260702112125`) to add a dedicated LocalApiServer route just to reach one v3 endpoint.
3. The proxy has a latent contract bug: `.agents/skills/clickup_api.md` (line 21) documents `"endpoint": "/v2/task/12345"`, but `makeApiRequest` concatenates the endpoint onto `/api/v2` without stripping the prefix, producing `/api/v2/v2/task/12345` — a 404. The documented contract and the implemented contract disagree today.

Meanwhile ClickUp is progressively rolling out v3 and has started marking v2 endpoints as legacy — the v2 task-attachment upload that `attachFile` (line 2049) uses is explicitly labeled legacy with a pointer to the v3 Attachments API.

### Background Context

**What v3 actually covers (verified against developer.clickup.com, including its llms.txt index, on 2026-07-02):** ClickUp API v3 is NOT a superset of v2. A wholesale migration is impossible today. Verified v3 coverage: Docs, Chat, Attachments (new v3 Attachments API), modern Time Tracking, Move Task (`PUT /v3/workspaces/{workspace_id}/tasks/{task_id}/home_list/{list_id}`), Audit Logs, and some Custom Field operations. Core CRUD — tasks, lists, folders, spaces, comments, tags, members, webhooks — exists **only in v2**, and ClickUp has announced no v2 deprecation or sunset date. Terminology shift: v2 "team" = v3 "workspace" (per ClickUp's own v2/v3 terminology guide at developer.clickup.com/docs/general-v2-v3-api.md). Authentication is identical: the same personal token in the `Authorization` header works for both versions (`httpRequestV3` already relies on this).

**Current v2 call-site inventory (`src/services/ClickUpSyncService.ts` unless noted):**

| Endpoint family | Call sites (line numbers) | v3 status as of 2026-07 |
| :--- | :--- | :--- |
| `GET /team` (workspaces list, health check) | 331, 2389 | No v3 equivalent — stays v2 |
| `GET /team/{id}/space` | 369, 864, 1023; ClickUpDocsAdapter 146, 250 | No v3 equivalent — stays v2 |
| `GET/POST /space/{id}/folder`, `DELETE /folder/{id}` | 398, 435, 893, 1047, 2533; ClickUpDocsAdapter 161, 382 | No v3 equivalent — stays v2 |
| `GET/POST /folder/{id}/list`, `GET /space/{id}/list`, `GET /list/{id}` | 471, 561, 673, 879, 906, 1078, 1080, 1480; ClickUpDocsAdapter 162, 210, 363, 407 | No v3 equivalent — stays v2 |
| Task CRUD (`GET/PUT/DELETE /task/{id}`, `POST /list/{id}/task`, `GET /list/{id}/task`) | 1230, 1343, 1378, 1430, 1936, 1960, 2028, 2040, 2630, 2708, 2761 | No v3 equivalent for CRUD — stays v2. Home-list move is v3-only (covered by the ticket-move plan) |
| Tasks in Multiple Lists (`POST /list/{id}/task/{taskId}`) | 2769 | No v3 equivalent — stays v2 |
| Comments (`GET/POST /task/{id}/comment`, `GET/POST /comment/{id}/reply`) | 1257, 1286, 1506, 1612, 1652, 1863, 1876, 1903, 1915, 2016 | No v3 equivalent (v3 Chat is a different product area, not task comments) — stays v2 |
| Tags, members, custom fields on lists (`GET /space/{id}/tag`, `GET /list/{id}/member`, `POST /list/{id}/field`) | 510, 1462, 1560 | No v3 equivalent confirmed — stays v2 |
| Task attachment upload (`POST /task/{id}/attachment`, bespoke multipart via `attachFile`) | 2049 (raw `https.request`, bypasses `httpRequest` entirely) | **v2 endpoint marked legacy — migrate to v3 Attachments API** |
| Docs (`/workspaces/{id}/docs...`) | httpRequestV3 call sites: 2130; ClickUpDocsAdapter 163, 225, 303, 338, 427, 461, 497, 593, 601, 617, 624 | Already v3. Note inconsistency: line 2130 uses singular `/workspace/{id}/doc/{docId}/page` while ClickUpDocsAdapter uses plural `/workspaces/{id}/docs/...` — verify and normalize |
| Raw proxy (`makeApiRequest`) | 2187; exposed via LocalApiServer `/api/clickup` (line 1023 routing, handler line 417) | v2-pinned + documented-contract bug — make version-aware |

### Root Cause Analysis

1. **Duplication instead of parameterization**: `httpRequestV3` was added for Docs support by copying `httpRequest` and editing one string. The version was baked into the transport instead of being a parameter, so every consumer (raw proxy, attachFile, future endpoints) inherited a single-version worldview.
2. **The raw proxy predates v3**: `makeApiRequest` was written when v2 was the only API, so "endpoint" implicitly meant "v2 path". When the skill docs were written, the author assumed the endpoint string included the version segment — nobody reconciled the two, and the double-prefix bug shipped because no caller exercised the documented form against the implementation.
3. **`attachFile` bypasses the transport layer entirely** (its own `https.request` with multipart body), so it was invisible to any versioning consideration and silently stayed on a now-legacy endpoint.

## Metadata

- **Tags:** refactor, backend, clickup, api, skills
- **Complexity:** 5

> **Line-number note:** references below were accurate at authoring time; the current source has drifted ~+2 lines (e.g. `httpRequest` is now line 2239, `httpRequestV3` line 2313, `makeApiRequest` line 2189, `attachFile` line 2051, `createDocPage` line 2132). Treat line numbers as anchors, not exact addresses — grep the symbol name before editing.

## Uncertain Assumptions

The following items are NOT 100% confirmed against authoritative sources and were flagged for the user to run web research before implementation (see the research prompt at the end of the chat summary):

1. **v3 Attachments API shape** — exact path, multipart field name (v2 uses `attachment`), whether task attachments need a `parent` discriminator, and the response field names for `url`/`filename`. The plan's Change #4 fallback (keep v2 if the v3 response lacks a usable `url`) depends on this.
2. **v3 docs path canonical form** — singular `/workspace/{id}/doc/{docId}/page` (current `createDocPage` call) vs plural `/workspaces/{id}/docs/...` (ClickUpDocsAdapter + published v3 reference). Whether the singular form is a tolerated alias or a latent bug determines whether Change #5 is a cosmetic normalization or a bug fix.
3. **v3 error body shape** — the plan assumes v3 error shapes differ from v2's `{ err, ECODE }` and that stringifying `result.data` into thrown messages remains version-agnostic. Not verified against a v3 error response.

## User Review Required

Yes — three scope decisions:

1. **Scope confirmation**: this plan migrates plumbing + attachments + the proxy contract only. Core CRUD call sites stay on v2 because no v3 equivalents exist (see inventory table). Confirm you don't want speculative rewrites of call sites against unreleased v3 endpoints.
2. **Proxy default version**: for `/api/clickup` payloads whose `endpoint` has no `/v2/` or `/v3/` prefix, the proposal defaults to v2 (backward compatible with the implemented behavior). The alternative — rejecting unprefixed endpoints with a 400 — is stricter but breaks any existing caller that learned the real (unprefixed) contract. Confirm default-to-v2.
3. **attachFile migration timing**: the v2 attachment endpoint still works today; it is only *labeled* legacy. Migrating now is cheap insurance against a future shutoff, but it is the only change in this plan with user-visible blast radius (attachment upload). Confirm migrate-now vs. leave-as-is-with-a-tracking-note.

## Complexity Audit

### Routine
- Extracting `httpRequestVersioned(version, ...)` and reducing `httpRequest` / `httpRequestV3` to one-line delegates — pure refactor, zero call-site churn, contract preserved exactly.
- Updating `makeApiRequest` to parse an optional `/v2/`/`/v3/` prefix — small, self-contained.
- Updating `.agents/skills/clickup_api.md` and `.claude/skills/clickup-api/SKILL.md` to document the version-prefix contract with working examples.
- Adding the endpoint inventory (the table above) as a maintained ledger comment or doc so future v3 flips are mechanical.

### Complex / Risky
- **Transport contract preservation**: both `httpRequest` and `httpRequestV3` resolve with `{ status, data }` for ANY HTTP status and reject only on network error/timeout/abort — callers check `.status` themselves (e.g. ClickUpDocsAdapter line 462 explicitly relies on resolve-on-any-status). The unified method must preserve this exactly; converting non-2xx to rejections would break dozens of call sites.
- **attachFile v3 migration**: the exact v3 Attachments API path, multipart field names, and response shape are not fully spelled out in the public docs text. Must be verified against the interactive reference (developer.clickup.com — "Create an Attachment", v3 Attachments API) or a probe call before implementation. The v3 response may not carry `url`/`filename` under the same keys the current parser reads (lines 2082–2085).
- **Docs path inconsistency**: `createDocPage` (line 2130) uses `/workspace/{id}/doc/{docId}/page` (all singular); ClickUpDocsAdapter uses `/workspaces/{id}/docs/...` (plural). Either ClickUp tolerates the singular alias or line 2130 has been broken/redirected all along. Verify which form is canonical (v3 docs reference uses plural) and normalize — but test doc-page creation before and after, since "it works today" is evidence the singular form is at least tolerated.
- **Proxy prefix parsing edge cases**: endpoints arriving as `v2/task/x` (no leading slash), `/v2` alone, or with query strings already embedded (`/task/x?page=0`) must all route sanely. The parser must only strip a version prefix when it is a whole path segment.

## Edge-Case & Dependency Audit

1. **Backward compatibility of the proxy**: three input forms must all work after the change — unprefixed `/task/{id}` (implemented contract today) → v2; `/v2/task/{id}` (documented contract today, currently broken) → v2 with prefix stripped; `/v3/workspaces/...` (new) → v3. The double-prefix bug becomes unreachable by construction.
2. **Response envelope differences**: v3 endpoints tend to use cursor pagination and different wrappers (e.g. docs listing returns `{ docs, next_cursor }`). The unified transport must NOT normalize response bodies — per-endpoint parsing stays at call sites, exactly as today.
3. **Error body differences**: v2 errors use `{ err, ECODE }`; v3 error shapes differ. Error paths that stringify `result.data` into thrown messages (existing pattern) remain version-agnostic — keep that pattern, do not parse error bodies structurally.
4. **Rate limits**: shared per token across both versions (~100 requests/min) — no change in behavior, no new call volume introduced by this plan.
5. **Coordination with the ticket-move plan** (`feature_plan_20260702112125`): that plan's `moveTask` calls `this.httpRequestV3(...)`. Because `httpRequestV3` survives as a thin delegate, both plans can land in either order with no conflict. If this plan lands first, the move plan needs zero changes; if the move plan lands first, its `httpRequestV3` call transparently starts flowing through the unified transport.
6. **`attachFile` retry/comment semantics**: the current method posts an optional comment after upload and swallows comment failures with a warning (lines 2087–2092). The v3 migration must preserve this sequencing and the `{ url, fileName }` return shape, since `LocalApiServer` (line 826) and card-attachment flows consume it.
7. **Health check** (`GET /team`, line 2389, 2s timeout): stays v2 — there is no confirmed v3 workspaces-list endpoint. Do not "modernize" it.
8. **No behavior change to sync flows**: board sync, kanban push, comment polling all ride `httpRequest` — after this plan they ride the same v2 endpoints through the unified transport. Any observed diff in sync behavior is a regression, not an intended change.
9. **Token handling**: both versions use the same `Authorization` header via `getApiToken()`. The unified method must keep the existing never-log-the-authorization-header guarantee (documented at line 2235).
10. **Skill doc duplication**: `.agents/skills/clickup_api.md` and `.claude/skills/clickup-api/SKILL.md` are parallel copies. Both must be updated in the same change, or agents on different hosts will follow divergent contracts.

## Dependencies

- `ClickUpSyncService.httpRequest` — v2 transport (line 2237), becomes delegate.
- `ClickUpSyncService.httpRequestV3` — v3 transport (line 2311), becomes delegate.
- `ClickUpSyncService.makeApiRequest` — raw proxy entry point (line 2187).
- `ClickUpSyncService.attachFile` — bespoke multipart upload (line 2049).
- `ClickUpSyncService.getApiToken` — shared token resolution.
- `LocalApiServer._handleClickUpApiProxy` — HTTP surface of the raw proxy (line 417, routed at line 1023). No changes needed here; it passes `endpoint` through verbatim.
- `ClickUpDocsAdapter` — heaviest `httpRequestV3` consumer; regression surface for the transport unification.
- `.agents/skills/clickup_api.md` + `.claude/skills/clickup-api/SKILL.md` — proxy contract documentation.
- Ticket-move plan `feature_plan_20260702112125` — concurrent consumer of `httpRequestV3` (see Edge Case 5).

## Adversarial Synthesis

Key risks: (1) the `attachFile` v3 migration and the docs-path normalization both depend on unverified v3 API shapes — shipping them without probes risks breaking attachment upload and doc-page creation for a cosmetic version bump; (2) the transport contract (resolve-on-any-status, never-log-auth-header) must be preserved exactly or dozens of call sites break silently. Mitigations: Changes #4 and #5 are now probe-gated with first-class v2-fallback branches; the transport unification (Changes #1–#3) is a pure delegate refactor with zero call-site churn and is safe to land independently.

## Proposed Changes

### 1. `src/services/ClickUpSyncService.ts` — Unify the transport

Replace the bodies of `httpRequest` (line 2237) and `httpRequestV3` (line 2311) with delegates to a single parameterized method. The shared body is today's `httpRequest` implementation with one change: the path prefix becomes `/api/${version}`.

```typescript
/**
 * Authenticated HTTPS request to the ClickUp REST API (any version).
 * Contract (preserved from the previous per-version methods, relied on by all callers):
 *  - resolves with { status, data } for ANY HTTP status code;
 *  - rejects only on network error, timeout, or abort;
 *  - never logs the Authorization header.
 */
private async httpRequestVersioned(
  version: 'v2' | 'v3',
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  apiPath: string,
  body?: Record<string, unknown>,
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<{ status: number; data: any }> {
  // Body identical to the previous httpRequest implementation,
  // with: path: `/api/${version}${apiPath}`
}

async httpRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  apiPath: string,
  body?: Record<string, unknown>,
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<{ status: number; data: any }> {
  return this.httpRequestVersioned('v2', method, apiPath, body, timeoutMs, signal);
}

async httpRequestV3(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  apiPath: string,
  body?: Record<string, unknown>,
  timeoutMs: number = 10000,
  signal?: AbortSignal
): Promise<{ status: number; data: any }> {
  return this.httpRequestVersioned('v3', method, apiPath, body, timeoutMs, signal);
}
```

No call site changes anywhere. `httpRequest` and `httpRequestV3` remain the public API of the service; the version-string duplication is gone.

### 2. `src/services/ClickUpSyncService.ts` — Version-aware raw proxy

Replace `makeApiRequest` (line 2187):

```typescript
/**
 * Raw API access for the /api/clickup proxy.
 * Endpoint contract:
 *  - "/v2/task/123"          → /api/v2/task/123
 *  - "/v3/workspaces/1/..."  → /api/v3/workspaces/1/...
 *  - "/task/123" (no prefix) → /api/v2/task/123   (backward compatible default)
 * The version prefix is only recognized as a whole leading path segment.
 */
async makeApiRequest(method: string, endpoint: string, query?: any, body?: any): Promise<any> {
  let version: 'v2' | 'v3' = 'v2';
  let path = String(endpoint || '');
  if (!path.startsWith('/')) { path = '/' + path; }
  const versionMatch = path.match(/^\/(v2|v3)(\/.*)$/);
  if (versionMatch) {
    version = versionMatch[1] as 'v2' | 'v3';
    path = versionMatch[2];
  }
  const apiPath = path + (query ? '?' + new URLSearchParams(query).toString() : '');
  const result = await this.httpRequestVersioned(version, method as any, apiPath, body);
  return result.data;
}
```

This makes the documented skill contract (`"/v2/task/12345"`) actually work, keeps the implemented contract (unprefixed) working, and opens v3 to agent skills without new LocalApiServer routes. `LocalApiServer._handleClickUpApiProxy` needs no changes.

### 3. `.agents/skills/clickup_api.md` and `.claude/skills/clickup-api/SKILL.md` — Document the version contract

Update both copies in the same change (Edge Case 10). Replace the Parameters section and add a v3 example:

```markdown
## Parameters
- method: HTTP method (GET, POST, PUT, DELETE)
- endpoint: ClickUp API endpoint path, including the version segment:
  - "/v2/task/12345" for API v2 endpoints
  - "/v3/workspaces/{workspace_id}/docs" for API v3 endpoints
  - Paths without a version prefix default to v2 for backward compatibility
- query: Optional query parameters object
- body: Optional request body object

## API v2 vs v3
ClickUp's v3 API covers Docs, Chat, Attachments, modern Time Tracking, Move Task, and
Audit Logs. Core task/list/folder/space/comment CRUD is v2-only. Note the terminology
shift: v2 "team" = v3 "workspace".

## Example — v3 move task
sb_api_call POST /api/clickup \
  -H "Content-Type: application/json" \
  -d '{
    "method": "PUT",
    "endpoint": "/v3/workspaces/WORKSPACE_ID/tasks/TASK_ID/home_list/LIST_ID",
    "query": {},
    "body": { "move_custom_fields": true }
  }'
```

### 4. `src/services/ClickUpSyncService.ts` — Migrate `attachFile` to the v3 Attachments API (PROBE-GATED)

The v2 endpoint `POST /api/v2/task/{taskId}/attachment` (line 2065) is marked legacy by ClickUp with a pointer to the v3 Attachments API. Migrate the bespoke multipart request to the v3 path while preserving the method's public contract (`{ url, fileName }` return, optional follow-up comment with swallowed failures).

**This change is PROBE-GATED. Do not implement until the probe succeeds.**

**Step 4a — Probe (do this FIRST, before any code change):**
Confirm against the interactive reference at developer.clickup.com ("Create an Attachment", v3 Attachments API) AND a live probe call against a scratch task:
- the exact v3 path,
- the multipart field name (v2 uses `attachment`),
- whether task attachments need a `parent` discriminator (v3 attachments also support File-type Custom Fields),
- the response field names for URL and filename,
- that the returned `url` is non-empty and resolves.

**Step 4b — Decision branch (first-class, not a comment):**
- **If the probe succeeds** and the v3 response exposes a usable `url` + `filename`: implement the migration below.
- **If the probe fails** OR the v3 response does not expose a usable `url`: **KEEP v2**, record the reason in the migration ledger (Change #6), and skip the rest of this change. The `{ url, fileName }` return contract outranks the version bump — a broken attachment upload is worse than a legacy endpoint that still works.

**Step 4c — Implementation (only if 4b chose migrate):**
The multipart builder stays bespoke (the JSON-body `httpRequestVersioned` signature doesn't fit multipart), but hoist the shared constants (`hostname`, `Authorization` via `getApiToken()`, the `/api/${version}` prefix) so `attachFile` is no longer invisible to versioning. Preserve the optional follow-up comment sequencing and the swallowed-comment-failure behavior (lines 2087–2092) exactly.

### 5. `src/services/ClickUpSyncService.ts` — Normalize the doc-page path (line 2130) (PROBE-GATED, DO LAST)

`createDocPage` calls `httpRequestV3('POST', '/workspace/${workspaceId}/doc/${docId}/page', ...)` — singular segments — while every ClickUpDocsAdapter call uses plural (`/workspaces/{id}/docs/...`), matching the published v3 reference.

**This change is PROBE-GATED and should be the LAST change in this plan.** Do not bundle a "maybe-bug, maybe-alias" investigation into the plumbing refactor — it muddies the regression surface.

**Step 5a — Probe:** in a scratch workspace, create a doc page via the singular path and via the plural path. Confirm which form ClickUp canonically accepts (the published v3 reference uses plural).
**Step 5b — Decision:**
- If singular works today → it is a tolerated alias. Switch to plural canonical form (cosmetic normalization), but treat as reversible.
- If singular has been silently failing → this is a latent bug fix; switch to plural and verify `clickup_create_subpage` now works.
**Step 5c — Regression gate:** add the Verification Plan step 6 check (create a doc page before and after) as a hard gate — doc-page creation is a user-facing feature. If the plural form breaks something the singular form tolerated, revert this change and record the singular-alias finding in the ledger.

### 6. Migration ledger — `docs/clickup-api-versions.md` (committed home)

Add the "Current v2 call-site inventory" table from this plan's Background Context to a new file `docs/clickup-api-versions.md` (NOT a comment block at the top of the 3000-line service file — that pollutes the source). Add a one-line reference comment at the top of `ClickUpSyncService.ts`: `// API version inventory: see docs/clickup-api-versions.md — update when flipping a family to v3.`

Rule recorded in the ledger file: when ClickUp ships a v3 equivalent for a family, flip that family's call sites through `httpRequestVersioned('v3', ...)` and update the ledger row. This is what makes future migration mechanical instead of archaeological.

### Non-Goals (explicit)

- No rewriting of core CRUD call sites against v3 — those endpoints do not exist in v3 as of 2026-07-02.
- No response-shape normalization layer between v2 and v3 — per-endpoint parsing stays at call sites.
- No changes to LinearSyncService, LocalApiServer routing, or the webview.
- No retry-policy or rate-limit changes.

## Verification Plan

1. **Transport refactor is invisible**: after Change #1, run the extension against a real workspace and exercise board sync, task create, task update, comment post, and comment poll. All flows behave identically (they ride the same v2 endpoints through the unified transport). Any diff is a regression.

2. **Proxy routing matrix**: via `sb_api_call POST /api/clickup`, send the same logical request three ways and confirm all return identical task data — `{"endpoint": "/task/TASK_ID"}`, `{"endpoint": "/v2/task/TASK_ID"}`, and confirm a v3 endpoint works: `{"endpoint": "/v3/workspaces/WS_ID/docs", "method": "GET"}`. Also confirm malformed forms degrade sanely: `"v2/task/TASK_ID"` (no leading slash) routes to v2, and `"/v2"` alone returns a ClickUp 404 rather than crashing the proxy.

3. **Double-prefix bug is dead**: with logging on the unified transport, assert no outbound path ever contains `/api/v2/v2/` or `/api/v3/v3/`.

4. **Skill docs run verbatim**: execute the updated `clickup_api.md` examples (both the v2 task fetch and the v3 example) exactly as written from a shell; both succeed.

5. **Attachment upload on v3 (only if Change #4 probe chose migrate)**: after the Step 4a probe succeeds and Step 4b chose migrate, attach a file to a test task via the `clickup_attach` skill path and via the diagram-upload path (`LocalApiServer` line 826). Verify the file appears on the task in the ClickUp web app, the returned `url` is non-empty and resolves, and the optional comment still posts after upload. **If Step 4b chose keep-v2, skip this step and confirm attachments still work on v2 unchanged.**

6. **Docs regression (Change #5, probe-gated)**: create a doc page via the `clickup_create_subpage` skill before and after the path normalization; verify the page lands in the correct doc both times. Browse the doc tree via the docs adapter (heaviest `httpRequestV3` consumer) and verify listings are unchanged. **If the plural form breaks what the singular form tolerated, revert Change #5 and record the singular-alias finding in the ledger.**

7. **Health check unchanged**: verify the `GET /team` health check (line 2389) still reports connected within its 2s timeout.

8. **No stray transports**: grep the repo for `https.request` combined with `api.clickup.com` — the only hits are the unified transport and (if kept bespoke) the multipart path inside `attachFile`, which must consume the shared host/auth/version constants.

9. **Coordination check (Edge Case 5)**: if the ticket-move plan has landed, run its move flow once after this refactor and verify `moveTask` still works through the delegated `httpRequestV3`.

---

**Recommendation:** Complexity 5 → **Send to Coder**. The transport unification (Changes #1–#3) is a clean, low-risk refactor. Changes #4 and #5 are probe-gated and can be deferred to a follow-up if the probes are inconclusive — they do not block the plumbing win.
