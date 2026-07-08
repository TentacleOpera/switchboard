---
description: "Feature A (Remote Control), subtask A1: build the machine-readable protocol catalog of the full webview↔host message contract and expose it over HTTP as GET /catalog — the foundational fixture every later remote-control subtask (and the CI parity gate) burns down against."
---

# Feature A · A1 — Protocol Catalog + Discovery Endpoint

## Goal

Produce a **machine-readable catalog** of the entire webview↔host message contract, and serve it over HTTP as **`GET /catalog`** so external clients (the `/switchboard-manage` skill, custom UIs) can self-discover the surface without reading skill docs. This is the foundational fixture the transport-migration subtask (A2) burns down against and the CI parity gate checks.

**Context:** Split 2026-07-08 from the original `extract-standalone-npx-01-protocol-core.md`, which bundled this catalog (Phase 0) with the standalone-service bootstrap (Phase 1). The bootstrap is now a **post-release** plan, `standalone-headless-core-service-bootstrap.md` (Feature B, B1). This subtask is the near-term, foundational half. Parent hard constraint still applies: **do not regress the shipped VS Code extension (~4,000 installs)** — catalog generation is read-only tooling; the only runtime change is an additive `GET /catalog` route.

## Metadata
- **Plan ID:** eb75281d-d8f3-4e50-b396-f7626abed020
- **Tags:** refactor, backend, api
- **Complexity:** 5
- **Release phase:** Near-term / foundational (Feature A — Switchboard Remote-Control API). Everything in Feature A depends on this.

## User Review Required
- None — decisions inherited from the reviewed parent plan.

## Scope

### ✅ IN SCOPE
- **Protocol catalog:** enumerate the full contract — measured 2026-07-07: **432 distinct message `type:` values**, **706 handler `case` arms** across the five Providers (TaskViewer 191, Kanban 168, Planning 168, Setup 117, Design 62), **988 host→webview push sites**, **575 `postMessage` call sites**. Output: a checked-in `protocol-catalog.json` mapping verb → direction (request/response vs fire-and-forget vs broadcast) → payload shape → owning provider → target service method. This is A2's burn-down checklist AND its CI parity-test fixture.
- **`GET /catalog` endpoint** on `LocalApiServer` — serves the catalog JSON so any client discovers every verb/endpoint/payload at runtime (the MCP-free discoverability layer). Auto-tracks the surface as A2 fills endpoints in. Follows the existing route pattern; `127.0.0.1` bind + auth unchanged.
- Regenerable: a scanner script emits the catalog; CI diffs regenerated vs checked-in to catch drift.

### ⚙️ OUT OF SCOPE
- Standalone bootstrap / keyring / config-file / Memento→config / single-instance guard → **B1** (`standalone-headless-core-service-bootstrap.md`, post-release).
- Handler extraction + endpoints + wsHub + parity gate → **A2**. Transport shim → **B2**. Terminal fleet → **B3**. npx → **B4**.
- Any UI/webview change.

## Implementation Steps
1. **Catalog scanner** — scan `src/webview/*` for `postMessage({type: ...})` and the five Providers for `case '...'` arms; emit `protocol-catalog.json` (verb, direction, payload keys, provider, proposed service module). Manual pass to classify request/response pairs vs fire-and-forget and to flag dynamically-constructed `type:` strings (template literals) as explicit entries rather than silently missing them.
2. **`GET /catalog`** — add the route to `LocalApiServer` (interim: current route table; canonical: serve `protocol-catalog.json`).
3. **CI drift check** — regenerated catalog must equal the checked-in catalog.

## Complexity Audit
### Routine
- Grep-shaped catalog scan (counts already verified).
- The `GET /catalog` route (additive, follows existing pattern).
### Complex / Risky
- **Dynamic `type:` strings** — template-literal message types won't be caught by a naive scan; they must be hand-added to the catalog or A2's parity gate will have blind spots. Flag them explicitly.

## Edge-Case & Dependency Audit
- **Race conditions:** Catalog regeneration is a build-time script (not runtime) — no concurrent-write risk. The `GET /catalog` route serves a static file; no race.
- **Security:** `GET /catalog` is read-only and localhost-bound (`127.0.0.1`). The current `_checkAuth` (`LocalApiServer.ts:255-258`) is a no-op that trusts the localhost boundary check at `_handleRequest` line 1862 — acceptable for a read-only route, but A2 must build real auth before any write/WS endpoint rides the same server.
- **Side effects:** The scanner script is read-only (grep/AST over `src/`). The `GET /catalog` route is additive — one new `else if` arm in `_handleRequest` (lines 1889-1980). No existing route is modified.
- **Dependencies & conflicts:** No new npm dependencies. The scanner may use the TypeScript compiler API (already in devDependencies) for AST-based extraction, or a regex approach for the initial pass. No conflict with existing tooling — the scout confirmed no existing scanner/catalog tool exists in `scripts/` or `.agents/skills/`.

## Dependencies
- **Session dependencies:** None (first subtask of Feature A).
- Consumed by: A2 (fixture + gate), `/switchboard-manage` (Manage, via `GET /catalog`).

## Adversarial Synthesis

Key risks: (1) dynamic `type:` template literals missed by a naive grep scanner create parity-gate blind spots — a manual review pass is required even though the scout found no dynamic types in an initial scan. (2) The catalog file path was unspecified — must be a checked-in repo artifact (repo root `protocol-catalog.json`), NOT `.switchboard/` runtime state. (3) The `GET /catalog` route must follow the `_handleReadEndpoint` helper pattern (lines 843-866), not inline the response logic. Mitigations: scanner includes a manual-review step for template-literal types; catalog path pinned to repo root; route uses the existing read-endpoint helper.

## Proposed Changes

### `scripts/generate-protocol-catalog.js` (new file)
- **Context:** No existing scanner/catalog tool exists in the repo. The catalog must enumerate 432 verbs, 706 handler arms, 988 push sites, and 575 `postMessage` call sites across the five providers and `src/webview/*`.
- **Logic:** Scan `src/services/{TaskViewer,Kanban,Planning,Setup,Design}Provider.ts` for `case '...'` arms in `switch(message.type)` blocks. Scan `src/webview/*` for `postMessage({type: '...'})` (webview→host) and `webview.postMessage({type: '...'})` (host→webview push sites). Classify each verb: direction (request/response vs fire-and-forget vs broadcast), payload keys (best-effort from handler body), owning provider, proposed service module.
- **Implementation:** Initial pass with regex (`/case\s+'([^']+)'/g` for arms, `/postMessage\(\s*\{\s*type:\s*['"]([^'"]+)['"]/g` for call sites). Optionally upgrade to TypeScript AST (compiler API already in devDependencies) for payload-shape extraction. Output: `protocol-catalog.json` at **repo root** (checked in, NOT `.switchboard/` which is runtime state). Include `version`, `generatedAt`, per-provider message arrays, and an `apiEndpoints` section enumerating existing LocalApiServer routes.
- **Edge cases:** Template-literal `type:` strings (e.g. `` type: `foo_${x}` ``) won't be caught by regex — the scout's initial scan found none, but `planning.js` is large and the scan may not be exhaustive. The scanner must emit a "manual review" warning for any `switch`/`postMessage` block where the `type` field is not a string literal. Flag unclassified entries explicitly so A2's parity gate has no silent gaps.

### `src/services/LocalApiServer.ts`
- **Context:** Routes are registered as a sequential `if/else if` chain in `_handleRequest` (lines 1889-1980), not a route table. GET read endpoints use the `_handleReadEndpoint` helper (lines 843-866) which wraps auth check, error handling, and `{ success: true, data }` JSON response.
- **Logic:** Add a `catalogProvider?: () => Promise<any>` optional callback to `LocalApiServerOptions` (lines 11-136). Add `_handleGetCatalog` private method using `_handleReadEndpoint` — loads `protocol-catalog.json` from the workspace root and returns it. Add route arm: `else if (pathname === '/catalog' && req.method === 'GET') { await this._handleGetCatalog(req, res); }` in the `_handleRequest` chain.
- **Implementation:** Interim (before scanner lands): `catalogProvider` returns a hardcoded enumeration of the current route arms (the if-else chain at lines 1889-1980). Canonical (after scanner lands): serves the checked-in `protocol-catalog.json`. The callback is wired in `TaskViewerProvider` where the LocalApiServer is constructed (lines 1039-1167), alongside the existing `orchestrationDispatch` callback at line 1164.
- **Edge cases:** Catalog file missing → return 404 with a clear message ("catalog not generated; run `node scripts/generate-protocol-catalog.js`"). Catalog stale (drift from code) → the CI drift check catches this at build time, not at serve time; the served catalog is always the checked-in version.

### `.github/workflows/integration-tests.yml`
- **Context:** CI runs `npm ci` → `npm run compile-tests` → `npm run compile` → `npm run test:integration:all`. No catalog/parity test step exists.
- **Logic:** Add a "Protocol catalog drift check" step after compile: run `node scripts/generate-protocol-catalog.js --check` which regenerates the catalog to a temp file and diffs against the checked-in `protocol-catalog.json`. Exit non-zero on drift.
- **Implementation:** Add a new step in the `integration-tests` job. The `--check` flag is a scanner option (write to stdout/temp, compare, exit code). This is A1's drift gate; A2's parity gate (catalogued verbs ⊆ live endpoints) builds on top of this.
- **Edge cases:** First run after scanner creation — the checked-in catalog must be generated by the scanner itself (not hand-written) so the drift check has a valid baseline.

### `package.json`
- **Context:** No `generate:catalog` script exists.
- **Logic:** Add `"generate:catalog": "node scripts/generate-protocol-catalog.js"` to the `scripts` section.
- **Implementation:** Single line addition. No new dependencies (TypeScript compiler API is already in devDependencies if AST approach is used).
- **Edge cases:** None.

## Verification Plan
### Automated Tests
- Skipped per session directive — no automated test run required. The CI drift check (`--check` mode) serves as the automated gate when implemented.
### Manual Verification
- Regenerated catalog matches the checked-in `protocol-catalog.json` (run `node scripts/generate-protocol-catalog.js --check` → exit 0).
- `GET /catalog` returns the catalog JSON; a client can enumerate every verb/endpoint/payload from it (curl `http://127.0.0.1:<port>/catalog` with auth header).
- No dynamic `type:` template literals missed — review the scanner's "manual review" warnings and confirm each is either classified or explicitly flagged.
- Existing extension behavior unchanged — only an additive route was added.

**Stage Complete:** PLAN REVIEWED

## Review Findings (2026-07-08, in-place reviewer pass)
Two CRITICALs fixed: the CI drift gate was **red on the committed tree** because the comparator stripped only `generatedAt`, not `line:` numbers (line churn = false drift) — fixed in `scripts/generate-protocol-catalog.js` (drift comparator now ignores `line`); and the per-line `postMessage` scan silently dropped ~572 multi-line calls (112 push verbs) — fixed by scanning full file content (`extractWebviewSites` rewritten). Two MAJORs fixed: `GET /catalog` now returns a real 404 when the catalog is absent (`LocalApiServer._handleGetCatalog`) instead of `200 {data:null}`, and the catalog is served from the extension install dir first (`TaskViewerProvider` catalogProvider) so `/catalog` works for the ~4,000 installs, not just the dev checkout. Validation: regenerated catalog now reports **606 arms / 518 verbs / 969 push sites / 575 request sites** and `node scripts/generate-protocol-catalog.js` (drift check) exits **0**; scanner ran end-to-end (stronger than syntax-check). Remaining risk (NIT, deferred): brace-depth counter tallies raw braces incl. inside strings/comments (no current trigger) and npm-script naming differs from the plan text (`catalog:generate` vs `generate:catalog`) — cosmetic.
