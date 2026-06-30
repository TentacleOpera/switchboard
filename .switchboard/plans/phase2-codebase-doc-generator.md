# Phase 2 (1/4): Codebase Doc Generator — Repo → Structured Markdown Doc Set

## Goal

Produce a service that walks the workspace repo and emits a **structured set of markdown documents** (one per source file, grouped under per-directory module pages, plus a repo-root overview), each tagged with a stable slug and a content hash. This is the input stage for syncing codebase documentation into Notion (plan 2/4) so a remote claude.ai + Notion session can understand the codebase and author a plan **without any repo access**.

### Problem & Background

The Remote Planning Infrastructure epic's Phase 2 goal is: *"User opens claude.ai, attaches Notion, asks Claude to write a plan. Claude reads live codebase docs from Notion, authors a plan, writes it back to Notion with the trigger status. Zero git."* Today that is impossible because **remote agents have zero repo access** — `.agents/skills/switchboard_remote_notion.md` (lines 33–39) states the plan text in the Notion page body is the *sole* source of truth; the remote agent cannot read code. The PRD (`.switchboard/projects/<slug>/prd.md`) and constitution are local-only — `prdUtils.ts:33-36` (`getProjectPrdPath`) only constructs a local filesystem path, and no push adapter was found in the codebase to mirror it remotely.

### Root Cause

There is no machine-readable codebase documentation that lives outside the repo. The only repo-summarizing code that exists — `ContextBundler.bundleWorkspaceContext()` (`src/services/ContextBundler.ts:64-218`) — produces **DOCX bundles for manual upload to Google NotebookLM** (a standalone product with no sync API). It chunks raw source into 500KB DOCX parts (`CHUNK_LIMIT_BYTES = 500 * 1024` at line 7; chunking at 177-181); it is not page-structured, not markdown, not hashed, and not syncable. We need the same repo-walk, re-targeted to emit per-file markdown docs with stable identity so plan 2/4 can push only what changed.

This plan deliberately **reuses** the `ContextBundler` walker rather than re-implementing file discovery.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, docs
**Depends on:** none (foundation for plans 2–4 of Phase 2)
**Parent epic:** `epic-remote-planning-infrastructure-7421946e-dea1-4d2b-985d-5de52d088f4d.md`

## User Review Required

None. Granularity and format decisions are made below and are reversible (regenerating docs is idempotent). Doc generation writes no remote state and creates no board cards — it is pure local computation.

## Decisions (made, not deferred)

1. **Granularity = per-file pages, grouped under per-directory module parents, plus one repo-root overview.** This matches `ContextBundler`'s existing per-file model and the `imported_docs` slug/parent model (`doc_name` + `parent_doc_name`, `KanbanDatabase.ts:64-77`). Not per-symbol (too many Notion pages, blows the 3 req/s budget) and not one-giant-doc (defeats targeted retrieval by the remote agent).
2. **Output format = markdown**, not DOCX. DOCX is exclusively for Google NotebookLM's manual upload flow and stays untouched. Notion page bodies are written from markdown (plan 2/4 maps markdown → Notion blocks).
3. **Per-file doc content = a generated summary header + a fenced source body.** The summary header reuses `ContextBundler`'s existing file-header-comment extraction (`ContextBundler.ts:164-172` — a regex match on the first 1000 chars, capped at 150 chars). The full source is included in a code fence so the remote agent can read actual implementation, not just a summary. A per-file size cap (default 60 KB, configurable) truncates oversized files on a line boundary with an explicit `[... truncated N lines ...]` marker, mirroring the 50,000-char heading-boundary truncation already in `NotionFetchService.fetchAndCache()` (lines 589-598: `lastIndexOf('\n#')` cut with fallback to the char limit).
4. **Identity = a stable slug derived from the repo-relative path** (e.g. `src/services/KanbanDatabase.ts` → `src__services__KanbanDatabase-ts`), plus a SHA-256 `content_hash` of the generated doc content. Slug sanitization reuses the same `[a-z0-9_-]` rule as `prdUtils.ts:16-26` (path-traversal safe).
5. **Binary/excluded files** follow `ContextBundler`'s existing exclusion list (binaries, `.git`, `node_modules`, `.switchboard/`). No doc page is generated for excluded files; they are listed in the overview's "excluded" appendix exactly as the existing manifest does.

## What Gets Built

### New service: `src/services/CodebaseDocService.ts`

A single exported function plus a small result type:

```ts
export interface CodebaseDoc {
  slug: string;          // stable, path-derived, sanitized
  filePath: string;      // repo-relative
  moduleSlug: string;    // parent (directory) slug
  moduleName: string;    // human-readable directory path
  title: string;         // e.g. "src/services/KanbanDatabase.ts"
  markdown: string;      // summary header + fenced source (truncated per cap)
  contentHash: string;   // sha256(markdown)
}

export interface CodebaseDocSet {
  generatedAt: string;             // ISO (caller stamps; no Date.now() in walker)
  repoName: string;
  overview: CodebaseDoc;           // repo-root index page
  modules: CodebaseDoc[];          // per-directory parent pages
  files: CodebaseDoc[];            // per-file leaf pages
  excludedPaths: string[];
}

export async function generateCodebaseDocs(
  workspaceRoot: string,
  opts?: { perFileByteCap?: number }
): Promise<CodebaseDocSet>;
```

**Logic:**
1. **File discovery — reuse `ContextBundler`.** Extract the file-listing portion of `bundleWorkspaceContext` (`ContextBundler.ts:64-115`: `git ls-files` with recursive-scan fallback + the binary/dir exclusion filter at lines 89–91) into an exported helper `listRepoFiles(workspaceRoot): Promise<string[]>` so both `ContextBundler` and `CodebaseDocService` call the same discovery code. **Do not fork the walker.** **Sort ownership:** `listRepoFiles` must return its result **lexically sorted** — `git ls-files` output order is not guaranteed across platforms/versions, and plan 2/4's "push only changed" logic depends on identical ordering across runs. The sort lives at the helper boundary so both consumers get deterministic order without re-sorting.
2. **Per-file doc:** read each file; extract the leading header-comment block (reuse `ContextBundler`'s existing extraction logic — factor it into an exported `extractFileSummary(source, path): string`); build `markdown` = summary header + repo-relative path + a fenced code block of the source, truncated at `perFileByteCap` on a newline boundary with a truncation marker. Compute `contentHash = sha256(markdown)`.
3. **Per-module doc:** group files by their immediate directory. Each module doc lists its files (titles + slugs + one-line summaries) so the overview→module→file hierarchy is navigable. Hash it.
4. **Overview doc:** repo name, generated-at (stamped by caller — the walker must not call `Date.now()`/`new Date()` so plan 3/4 can schedule deterministically), a tree of modules with counts, and the excluded-paths appendix. Hash it.
5. Return the `CodebaseDocSet`. **This service performs no network I/O and writes no files** — it is a pure transform from repo → in-memory doc set. Plan 2/4 consumes it.

### Refactor `src/services/ContextBundler.ts`

Extract (do not duplicate) two helpers and re-export them, leaving `bundleWorkspaceContext` behavior unchanged:
- `listRepoFiles(workspaceRoot)` — the git-ls-files + fallback + exclusion filter (currently inline at lines 64–115).
- `extractFileSummary(source, path)` — the header-comment extraction.

`bundleWorkspaceContext` calls these helpers; the DOCX/NotebookLM path is otherwise untouched. A regression check confirms the DOCX bundle output is byte-stable after the refactor (see Verification).

## Key Reuse (do not reinvent)

| Reuse | Source |
|------|--------|
| Repo file discovery (git ls-files + fallback + exclusions) | `ContextBundler.ts:64-115`, exclusions `89-91` |
| File-header summary extraction (regex on first 1000 chars, 150-char cap) | `ContextBundler.ts:164-172` |
| Slug sanitization (`[a-z0-9_-]`, traversal-safe) | `prdUtils.ts:16-26` |
| Truncation-on-boundary pattern (heading-boundary cut + char-limit fallback) | `NotionFetchService.fetchAndCache()` lines 589-598 |
| Parent/child doc model (`doc_name`/`parent_doc_name`) | `ImportedDocEntry`, `KanbanDatabase.ts:64-77` |

## Complexity Audit

### Routine
- Extracting two helpers (`listRepoFiles`, `extractFileSummary`) from already-proven `ContextBundler` code — mechanical refactor, byte-stable regression check.
- Slug derivation via the existing `sanitizeProjectSlug` regex (`prdUtils.ts:16-26`).
- SHA-256 content hashing of generated markdown.
- Grouping files by immediate directory into module docs.
- Overview doc assembly (repo name + module tree + excluded appendix).

### Complex / Risky
- **Determinism guarantee across platforms:** `git ls-files` ordering is not guaranteed; the sort-at-helper-boundary rule (added above) is the mitigation. If a consumer bypasses the helper, hashes drift and plan 2/4 re-pushes everything every cycle.
- **Refactor without behavior drift:** extracting `listRepoFiles`/`extractFileSummary` must leave `bundleWorkspaceContext` byte-stable. The regression test (Verification #4) is the guard, but a subtle reordering or dropped exclusion would silently change DOCX output.

## Dependencies

- `sess_phase2-notion-codebase-docs-sync` — Notion Codebase-Docs Database + Incremental Push Pipeline (consumes this plan's `CodebaseDocSet`).
- `sess_phase2-codebase-docs-sync-triggers-and-ui` — Continuous Sync Triggers + Remote-Tab Config (calls `generateCodebaseDocs` and stamps `generatedAt`).
- `sess_phase2-remote-plan-from-notion-docs` — Remote Agent Orientation (soft-depends; the docs DB must be populated for the orientation to be true).

## Adversarial Synthesis

Key risks: (1) non-deterministic `git ls-files` ordering breaks the hash-stability contract plan 2/4 relies on — mitigated by sorting at the `listRepoFiles` helper boundary; (2) the refactor could silently drift DOCX output — mitigated by the byte-stable regression test; (3) the 150-char summary cap and the per-file 60KB truncation are undocumented boundaries an implementer might drop. Mitigations are in place; the plan is sound after the citation corrections above.

## Edge-Case & Dependency Audit

- **Huge repos / page-count blowup:** per-file granularity on a large repo can mean thousands of Notion pages. This service just *generates* the set; plan 2/4 owns the throttle and the "which files to include" filter (e.g. exclude tests, lockfiles, generated dirs). This service accepts the same exclusion list `ContextBundler` uses, so generated-dir noise is already filtered.
- **Binary misclassification:** rely on `ContextBundler`'s existing binary detection. A misdetected binary produces a garbage fence — acceptable; the exclusion list is the guard and is already battle-tested by the DOCX path.
- **Empty/whitespace files:** emit a doc with the summary header and an empty fence rather than skipping, so the file's existence is still discoverable by the remote agent.
- **Determinism:** the walker must not read the clock or randomize ordering — sort files lexically so the same repo state produces an identical `CodebaseDocSet` (and identical hashes), which is what plan 2/4's "push only changed" logic depends on. The caller passes `generatedAt`.
- **No DB / no Notion coupling:** this plan adds zero DB columns and zero network calls. Storage and sync-state are plan 2/4's responsibility.

## Proposed Changes

### `src/services/ContextBundler.ts`
- **Context:** `bundleWorkspaceContext()` (lines 64-218) currently inlines file discovery (64-115) and per-file summary extraction (164-172). Both are reused verbatim by the new service.
- **Logic:** Extract `listRepoFiles(workspaceRoot): Promise<string[]>` (git-ls-files + recursive fallback + exclusion filter at 89-91, **returning lexically sorted output**) and `extractFileSummary(source, path): string` (the regex + 150-char cap at 164-172) as exported helpers. `bundleWorkspaceContext` calls them; its DOCX/NotebookLM output is otherwise untouched.
- **Implementation:** Pure extraction — no logic change. Re-export from the module.
- **Edge Cases:** A consumer that bypasses `listRepoFiles` and calls `git ls-files` directly loses the sort + exclusions. Document the helper as the single discovery entry point.

### `src/services/CodebaseDocService.ts` (new)
- **Context:** No codebase-doc generator exists today; this is the foundation for plans 2-4.
- **Logic:** `generateCodebaseDocs(workspaceRoot, opts?)` calls `listRepoFiles`, builds per-file docs (summary header via `extractFileSummary` + fenced source truncated at `perFileByteCap` on a newline boundary), groups into per-module docs, assembles the overview, and computes SHA-256 `contentHash` for each. No `Date.now()`/`new Date()` in the walker — the caller stamps `generatedAt`.
- **Implementation:** Types `CodebaseDoc` / `CodebaseDocSet` + the single exported async function (signatures in "What Gets Built" above). Slug derivation reuses `sanitizeProjectSlug`-style `[a-z0-9_-]` sanitization on the repo-relative path.
- **Edge Cases:** Empty/whitespace files emit a doc with an empty fence (discoverable, not skipped). Binary misclassification produces a garbage fence — acceptable, the exclusion list is the guard. Oversized files truncate with an explicit marker.

## Verification Plan

### Automated Tests

> Per session directives, the suite is run separately by the user. This documents what to verify.

1. **Unit — discovery parity:** `listRepoFiles()` returns the same set the old inline code did (snapshot test against a fixture repo); exclusions at `ContextBundler.ts:89-91` still apply.
2. **Unit — determinism:** `generateCodebaseDocs()` called twice on an unchanged fixture returns identical slugs and `contentHash` values for every doc.
3. **Unit — truncation:** a file larger than `perFileByteCap` truncates on a newline boundary and carries the truncation marker; hash is stable across runs.
4. **Regression — DOCX unchanged:** `bundleWorkspaceContext()` output (DOCX part count + manifest) is byte-stable after the helper extraction (extend `src/test/context-bundler.test.ts`).
5. **Manual:** generate docs for this repo; eyeball the overview tree, a module page, and a leaf page for a known file (e.g. `src/services/KanbanDatabase.ts`).

## Out of Scope

- Pushing anything to Notion (plan 2/4).
- Sync-state persistence / change detection across runs (plan 2/4).
- Scheduling, commit hooks, UI (plan 3/4).
- Linear/ClickUp doc targets — Phase 2 is Notion-only per the epic's stated outcome.
- Touching the DOCX/NotebookLM flow's behavior.

## Recommendation

Complexity 5 → **Send to Coder.** The novel work is the doc emitter + hashing; everything else is a careful extraction of proven `ContextBundler` code.
