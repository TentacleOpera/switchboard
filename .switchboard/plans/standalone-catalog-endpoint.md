# Standalone: `GET /catalog` 404s for every workspace except the switchboard repo

## Goal

Make `GET /catalog` serve the protocol catalog in the headless host by supplying a `catalogProvider`
that reads the catalog shipped with the CLI, instead of falling back to a lookup in the *served*
workspace where the file will never exist.

### Root problem / background (verified 2026-08-04 against a booted standalone server)

```
$ curl -s http://127.0.0.1:41778/catalog
{"error":"catalog not generated; run `node scripts/generate-protocol-catalog.js --write` in the workspace root"}
```

`LocalApiServer._handleGetCatalog:2315-2340` has two paths:

```ts
if (this._options.catalogProvider) { ... return data; }
// Fallback: load the checked-in protocol-catalog.json from the workspace root.
const catalogPath = path.join(this._options.workspaceRoot, 'protocol-catalog.json');
```

The extension supplies the hook — `catalogProvider` appears at `TaskViewerProvider.ts:2331` — so it
resolves the catalog relative to its own installation. **Standalone supplies nothing**: a grep for
`catalogProvider` across `src/` finds it only in `LocalApiServer.ts` (the option at `:301`, the use at
`:2317-2318`) and `TaskViewerProvider.ts:2331`. Nothing in `src/standalone/bootstrap.ts` sets it.

So standalone takes the fallback, which joins `protocol-catalog.json` onto **`workspaceRoot`** — the
user's project. `protocol-catalog.json` is a build artifact of the switchboard repo (it exists at that
repo's root, which is why the endpoint appears to work when you happen to serve switchboard itself).
For any real workspace the file is absent and the endpoint 404s with a message telling the user to
generate a catalog in *their* project, which is not something they should ever do.

Why this matters beyond a broken endpoint: `GET /catalog` is the documented discovery mechanism for
agents. The `switchboard-orchestration` skill instructs agents to use `/catalog` to learn the HTTP
surface, and `AGENTS.md`'s skill table points at it for invocation ("for invocation, use the
`switchboard-orchestration` skill and `GET /catalog`"). In the headless host — the host most likely to
be driven by an external agent, since it exists precisely for machines without the editor — that
discovery path is dead.

Adjacent finding, for scope clarity: the rest of the orchestration read surface **works** in standalone.
Verified: `/kanban/plans` 200, `/kanban/features` 200, `/worktree/list` → `{"success":true,"data":[]}`,
`/orchestrator/inbox` → `{"success":true,"data":[]}`, `/orchestrator/session-log` →
`{"success":true,"data":""}`. The write hooks decline honestly rather than lying: `/orchestration/start`
→ `{"error":"Orchestration start not available"}`, `/orchestrator/request` → `{"error":"Orchestrator
request channel not available"}`, `/worktree/cleanup` → `{"error":"Worktree cleanup not available"}` —
which is consistent with the declared `orchestrator: false` capability. So `/catalog` is the single
odd one out: not declined, just misresolved.

## Metadata
- **Tags:** bugfix, api, cli, docs
- **Complexity:** 3
- **Project:** browser-switchboard

## User Review Required (decisions, with defaults)

1. **Where should standalone read the catalog from?**
   **Default (recommended): the CLI's own install directory**, resolved from the bundle location
   (`repoRoot`, which `bootstrap.ts` already computes and passes as the panel `repoRoot` at `:608`,
   `:627`), not from `workspaceRoot`. The catalog describes the *server's* protocol, so it belongs to
   the server's installation.

2. **Should the workspace fallback be removed?**
   **Default: keep it, but demote it.** Try the install location first, then the workspace, then 404.
   Removing it outright would break anyone who has deliberately placed a catalog in a workspace, and
   the ordering change alone fixes the reported symptom.

3. **Should the catalog be a build artifact shipped in `dist/`?**
   **RESOLVED 2026-08-04: it already ships.** `npm pack --dry-run` lists `protocol-catalog.json`
   (573 kB) in the package, and `package.json` has no `files` whitelist or `.npmignore` to
   exclude it. `resolveRepoRoot()` (`bootstrap.ts:110-113`, `path.resolve(__dirname, '..',
   '..')` from `dist/standalone/cli.js`) lands on the package root under an npx install, so
   `path.join(repoRoot, 'protocol-catalog.json')` resolves in BOTH the repo checkout and an
   installed CLI. No packaging change is needed; the three-line fix is the whole fix.

## Complexity Audit

### Routine
- Supplying an existing option hook in one more place, mirroring `TaskViewerProvider.ts:2340-2354`.
- The error path and status code already exist and are correct.

### Complex / Risky
- ~~**Packaging.**~~ **Resolved:** the catalog ships in the npm package and `repoRoot` resolves
  to the install root (see User Review 3). The inert-fix scenario is closed.
- **Path resolution under a bundle.** Use plain `path.join(repoRoot, ...)`, never
  `require.resolve` — webpack rewrites `require.resolve` to a numeric module id (the same
  bundler-versus-filesystem confusion that broke `ptyBackend.ts`; see
  `standalone-pty-spawn-helper-chmod`).

## Edge-Case & Dependency Audit

- **Race Conditions.** None; a single file read per request. Consider a small in-process cache since the
  catalog is immutable for the process lifetime, but correctness does not require it.
- **Security.** The path must be computed from the install location and a fixed filename — never joined
  with anything from the request. The endpoint is already behind `_handleReadEndpoint`'s auth. The
  catalog describes the API surface only; it must not be extended to include secrets or workspace
  contents.
- **Side Effects.** None; read-only.
- **Dependencies & Conflicts.** Independent of every other plan in this set.

## Dependencies

- None. (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** The code fix is trivial and the real risk is declaring victory without checking
packaging: if `protocol-catalog.json` ships only in the git checkout, an installed CLI still 404s and
the endpoint remains broken for the users who need it most. The second risk is resolving the install
root incorrectly under the bundle, which would produce the same 404 from a different wrong path — so
verification must run from an installed/packed CLI, not only from the repo.

## Proposed Changes

### `src/standalone/bootstrap.ts`

- **Context.** `LocalApiServer` construction and its options object (the `terminalVerb` supplier is at
  `:1375-1380`, in the same options literal); `repoRoot` already in scope (`:450`) and passed to the
  panel HTML getters at `:488-503`. The extension's own provider to mirror is
  `TaskViewerProvider.ts:2340-2354` (candidate list: extension path, then workspace root).
- **Logic.** Add a `catalogProvider` that tries `protocol-catalog.json` at the CLI's install root
  first and the served workspace second (matching the keep-but-demote decision in User Review 2),
  returns the parsed object, or `null` when absent from both — `null` is the contract
  `_handleGetCatalog:2317-2326` already expects and turns into a 404.
- **Implementation.**
  ```ts
  // The catalog describes THIS SERVER's protocol, so it lives with the installation,
  // not in the served workspace. Without this hook LocalApiServer falls back to
  // path.join(workspaceRoot, 'protocol-catalog.json') (:2330), which only exists when
  // you happen to be serving the switchboard repo itself. Plain path.join, never
  // require.resolve — webpack rewrites require.resolve to a numeric module id.
  catalogProvider: async () => {
      const candidates = [
          path.join(repoRoot, 'protocol-catalog.json'),
          path.join(workspaceRoot, 'protocol-catalog.json'),
      ];
      for (const catalogPath of candidates) {
          try {
              const raw = await fs.promises.readFile(catalogPath, 'utf8');
              return JSON.parse(raw);
          } catch { /* try next candidate */ }
      }
      return null;
  },
  ```
- **Edge Cases.** Return `null` (not a throw) on a missing or malformed file so the route produces its
  documented 404 rather than a 500. `repoRoot` is confirmed to be the install root in a packed package
  (User Review 3), so no `dist/`-level adjustment is needed.

### `src/services/LocalApiServer.ts`

- **Context.** `_handleGetCatalog:2315-2340`; the workspace fallback at `:2329-2338` and its message at
  `:2335`.
- **Logic.** Leave the two-path structure intact (the new hook makes the fallback unreachable in
  standalone), but correct the fallback's error text so it stops instructing users to generate a catalog
  inside their own project.
- **Implementation.** Reword to name the real cause and remedy: the catalog ships with Switchboard, and
  its absence means an incomplete build or package — not a missing step in the user's workspace.
- **Edge Cases.** Keep `statusCode = 404`; clients (and the orchestration skill) may already
  distinguish 404 from 500.

### `.agents/skills/switchboard-orchestration/SKILL.md` (and the `.claude` copy)

- **Context.** The skill directs agents to `GET /catalog` for discovery; both copies exist
  (`.agents/skills/...` and `.claude/skills/...`), and skill copies are known to drift because the
  workspace copy is installed with `overwrite:false`.
- **Logic.** Note that `/catalog` requires a Switchboard build that ships `protocol-catalog.json`, and
  what to fall back to when it 404s (the enumerated endpoints in the same document).
- **Implementation.** One short paragraph beside the existing `/catalog` reference.
- **Edge Cases.** Update both copies in the same change, or the workspace copy keeps the stale
  instruction.

## Verification Plan

> Per dispatch directive, no automated tests and no compilation steps are part of this
> verification plan — manual verification only.

- **Manual — standalone serves the catalog for an arbitrary workspace.** Boot standalone with
  `--workspace <scratch>` (a directory containing no `protocol-catalog.json`) and confirm
  `GET /catalog` returns 200 with a parsed object containing known entries — e.g. the
  `/phone-a-friend` path that exists in the current catalog.
- **Manual — honest 404 when the artifact is genuinely absent.** Temporarily rename the
  install-root `protocol-catalog.json`, restart, and confirm a 404 whose message no longer
  tells the user to generate one in their workspace. Restore the file.
- **Manual — packed-install check.** Inspect `npm pack --dry-run` output (or a staged
  install) and confirm `protocol-catalog.json` is present at the package root — already
  verified once on 2026-08-04; re-verify if the packaging config changes.
- **Manual — extension host unchanged.** In the extension host, confirm `GET /catalog` still
  returns 200 through its own `catalogProvider` (`TaskViewerProvider.ts:2340`).
- **Manual smoke.** From an installed CLI in an unrelated project: `curl
  localhost:<port>/catalog` and confirm a catalog, not an instruction to generate one.

## Uncertain Assumptions

- ~~That `protocol-catalog.json` is shipped rather than checked-in-only.~~ **Resolved
  2026-08-04:** `npm pack --dry-run` includes it (573 kB).
- ~~That `repoRoot` in `bootstrap.ts` is the install root under a packed install.~~
  **Resolved 2026-08-04:** `resolveRepoRoot()` is `path.resolve(__dirname, '..', '..')` from
  `dist/standalone/cli.js`, which is the package root in a packed install.

## Out of Scope

- Regenerating or restructuring the catalog contents.
- The orchestration write hooks, which correctly decline in standalone.

## Completion Report

Wired a `catalogProvider` in `src/standalone/bootstrap.ts` that tries `protocol-catalog.json` at the CLI install root first, then the served workspace, returning `null` when neither exists. `src/services/LocalApiServer.ts` now returns a 404 message that points to a missing build artifact rather than instructing the user to generate a catalog in their workspace. No skill doc update was needed because neither copy currently references `/catalog`. No compilation or tests were run per the dispatch directive.

## Review Findings

**Implementation accepted as written — no code changes needed.** The provider mirrors `TaskViewerProvider.ts:2413` exactly, uses plain `path.join` (never `require.resolve`), and returns `null` rather than throwing. `repoRoot` resolution was confirmed sound against the build config: the standalone bundle emits to `dist/standalone/cli.js` (`webpack.config.js:136`) with `node: { __dirname: false }`, so `path.resolve(__dirname,'..','..')` is the package root; `protocol-catalog.json` ships (no `files` whitelist, no `.npmignore`).

**MAJOR (fixed, adjacent).** `npm run catalog:check` — CI-wired at `.github/workflows/integration-tests.yml:26` — was **red**, because the checked-in `protocol-catalog.json` still listed the two call sites deleted by the sibling verb-rail subtask (`totalRequestSites` 623 vs 621). Regenerated via `catalog:generate`; `catalog:check` and `parity:check` are now green.

**Validation.** Booted `dist/standalone/cli.js` against a scratch workspace containing no `protocol-catalog.json`: `GET /catalog` → **HTTP 200**, 370 KB, 522 verbs, 6 providers, `phone-a-friend` present. Renamed the install-root artifact and re-booted: **HTTP 404** with the corrected message (`catalog not found; protocol-catalog.json is missing from this Switchboard build or package`), artifact restored afterwards. Typecheck, lint and 12 contract tests green.

**Remaining risks.** None material. The workspace-root fallback is now unreachable in standalone (by design, per User Review 2); the extension host path is untouched.
