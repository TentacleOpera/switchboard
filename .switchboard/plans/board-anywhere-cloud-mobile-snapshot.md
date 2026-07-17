# Cloud/Mobile Board: Self-Contained board.html in the Board-State Export

## Goal

Give users a visual board anywhere — phone, tablet, cloud agent chat — with zero dependency on the local machine being reachable, by publishing a rendered, self-contained `board.html` alongside `board.json`/`board.md` on the `switchboard/board` orphan branch, plus an agent recipe for rendering the board as an HTML artifact in Claude (web/desktop/mobile).

**Problem & background.** Away from the local machine there is no board visibility at all. The LocalApiServer is loopback-only (`listen(0, '127.0.0.1')`, `LocalApiServer.ts:328`), and a live remote board cannot be faked through artifacts: Claude artifacts run under a strict CSP that blocks all network requests, so an artifact can never poll `localhost` or any API. What *does* travel is the board-state branch — `BoardSnapshotPublisher` already debounces (500 ms), hash-dedupes, single-flights, and force-pushes `board.json` + `board.md` to the orphan branch `switchboard/board` on every board mutation. Cloud agents with repo access can read that branch today, but the payload is data, not a visual.

**Why this is potentially more powerful than the browser board.** The browser board requires the local machine on and reachable. This path requires only a git remote: a pre-rendered `board.html` on the branch is viewable via static hosting of that branch on a phone, and a cloud agent can alternatively fetch `board.json` and render an on-demand artifact. It is the missing visual half of the Remote Control story.

**Root-cause note — the current snapshot is too lean to render the wanted card.** The publisher's `_serialize()` (`BoardSnapshotPublisher.ts:119-156`) emits only five fields per card:

```ts
interface BoardCardEntry {   // BoardSnapshotPublisher.ts:20-26
    plan_id: string;
    topic: string;
    column: string;
    feature: string | null;   // this is the feature's plan_id (a UUID), NOT a title/badge
    project: string | null;
}
```

with a top-level envelope `{ schema: 1, ordering: 'updated_at DESC', cards: [...] }` (`:128-136`). It carries **no complexity, no feature title, no plan filename, and no timestamp**, and it does **not** group cards by column (flat array; each card carries a `column` string). The richer fields the acceptance criteria assume (complexity, a human-readable feature label, `planFile`) do exist on the source record `KanbanPlanRecord` (`KanbanDatabase.ts:43-74`, selected by `getBoard`) but are dropped during serialization. So this feature is *both* a renderer **and** a targeted extension of `_serialize`, not a renderer alone.

## Implementation Steps

1. **Extend the snapshot payload (`_serialize`).** In `BoardSnapshotPublisher.ts:119-156`, widen `BoardCardEntry` and the source mapping (`:120-126`) to carry the fields the card must show: `complexity`, `planFile` (plain filename for cross-reference), and a resolvable feature **label** (see step 2). Bump the envelope `schema` to `2` and keep all existing keys so current consumers of `board.json`/`board.md` are unaffected (additive change). Do **not** add a wall-clock timestamp to the hashed JSON — see step 4 for why.
2. **Resolve the feature label.** The card's `feature` is a feature plan_id (UUID), not a name. Features are themselves plans, so their `topic` is available in the same `plans` list `_serialize` already receives. Emit a top-level `features` lookup (`{ [plan_id]: topic }`) — or denormalize a `feature_label` onto each card — so the renderer (and any board.json consumer) can show a human feature badge/grouping instead of a raw UUID.
3. **Renderer (`renderBoardHtml`).** Add a `renderBoardHtml(snapshot)` step to `BoardSnapshotPublisher`, producing a fully self-contained `board.html` from the *same* serialized snapshot object used for `board.json`: inline CSS, no external fonts/scripts/images, no JS required to read it. Mobile-responsive layout (columns stack or horizontally scroll on narrow viewports). Render, per card: topic, complexity, feature badge (label from step 2), project, and the plain-text plan filename. Group cards by `column` (the flat array is not pre-grouped). Show the "as of" timestamp prominently — see step 4 for its source.
4. **Timestamp without breaking dedupe.** The dedupe hash is computed over the JSON string only (`crypto.createHash('sha256').update(json)`, `BoardSnapshotPublisher.ts:154`), and a publish is skipped when the hash matches `_lastPublishedHash` (`:92-95`). A fresh wall-clock timestamp placed **inside the hashed JSON would change the hash on every publish, defeating dedupe and force-pushing on every persist.** Therefore the "as of" timestamp must NOT enter the hashed JSON. Two safe sources: (a) embed the timestamp in the HTML only (HTML is generated from the same data but is not part of the hash), or (b) derive it from the max card `updated_at` (already the ordering key, `KanbanDatabase.ts:3304-3312`) — which is honest ("as of last board change") and deterministic. Prefer (b) for a stable, reproducible snapshot; (a) is acceptable if wall-clock publish time is preferred. Either way, keep the hash over `board.json` content alone.
5. **Publish in the same commit.** Write `board.html` into the orphan worktree immediately after the existing `board.json`/`board.md` writes (`BoardSnapshotPublisher.ts:202-203`) and add `'board.html'` to the `git add` arg list (`:207`). Because staging and committing both run against the isolated temp worktree (`cwd = worktreePath`, `:167-199`), the file lands in the **same commit** as `board.json`/`board.md` automatically — no extra commit, and the user's working tree/HEAD are never touched. Thread the produced `html` string through `_serialize`'s return and `_pushSnapshot`'s signature (`:158`) / the `publish()` call site (`:92`, `:97`), matching how `json`/`md`/`hash` already flow.
6. **Keep it read-only and honest.** No action buttons, no fake interactivity. Every card carries the plain-text plan filename so a cloud agent (or human) can cross-reference the plan file in the repo.
7. **Artifact recipe (docs).** Add a documented prompt pattern (Remote Control docs on switchboard-site, plus a short section in the `switchboard-remote` skill if appropriate): "read `board.json` from the `switchboard/board` branch and render it as an HTML artifact" — for Claude web/desktop/mobile sessions with repo access. This is a docs deliverable, not code; the artifact must be generated self-contained because CSP blocks all fetches.
8. **Hosting note (docs).** Document the consumption paths on the Remote Control landing page, using only the research-confirmed paths (see Research Findings):
   - **(a) GitHub Pages / GitLab Pages from the orphan branch** — the correct "view HTML on a phone" path. On GitHub, configure Settings → Pages to publish from the `switchboard/board` branch; Pages requires an `index.html` at the branch root, so `board.html` must be named (or aliased/redirected from) `index.html`, and add a `.nojekyll` file if any asset filename starts with an underscore. Orphan branches are supported — this is **not** restricted to `gh-pages`. On GitLab, a `.gitlab-ci.yml` `pages` job scoped to the branch does the same.
   - **(b) Download + open `file://` on the phone** — zero-dependency fallback; works precisely because the page is self-contained with no network/JS.
   - **(c) On-demand artifact from `board.json`** via a cloud agent (step 7).
   - **(d) `board.md` table** rendered in the GitHub/GitLab branch UI — zero-effort text fallback.
   - **Do NOT document raw-file URLs or third-party preview proxies.** `raw.githubusercontent.com` serves HTML as `text/plain` (with `X-Content-Type-Options: nosniff`), so a raw link shows source, not a rendered page — it is not a viable path. Third-party raw-HTML proxies (e.g. `htmlpreview.github.io`) route assets through a shared public CORS proxy the maintainers themselves flag as a security risk, and add nothing for a self-contained no-network file — do not recommend them.
   - Cross-link from Cloud Coding Agents (the branch is already documented there as the board-state mechanism).

## Metadata

- **Tags:** feature, ui, docs, mobile
- **Complexity:** 5

## User Review Required

- **Scope confirmation:** `board.html` renders the same single-board snapshot the publisher already serializes (active project filter state as published) — no multi-view or filter UI inside the static page for v1. *(Decision: confirmed as the v1 scope; the static page mirrors exactly one published snapshot.)*
- **Timestamp source:** step 4 recommends deriving "as of" from the max card `updated_at` (deterministic, dedupe-safe) over wall-clock publish time. *(Decision: recommend the `updated_at`-derived timestamp unless the user prefers literal publish time; both are dedupe-safe as long as the value stays out of the hashed JSON.)*

## Complexity Audit

### Routine
- Adding fields to `BoardCardEntry` and the `_serialize` mapping (existing pattern, single file).
- Threading one more `html` string alongside the existing `json`/`md`/`hash` return values.
- One extra `writeFile` + one extra `git add` arg in the existing commit path.
- Static HTML/CSS string generation with no runtime dependencies.
- Docs additions (artifact recipe, hosting note).

### Complex / Risky
- **Dedupe/timestamp interaction** — a naive wall-clock timestamp in the hashed JSON silently breaks the hash-dedupe and turns every persist into a force-push. Must be handled per step 4.
- **Schema bump (1 → 2)** — must remain additive; existing consumers of `board.json`/`board.md` (documented cloud-agent readers) must not break.
- **Feature-label resolution** — depends on the feature's own plan record being present in the `plans` list passed to `_serialize`; verify features are included (not filtered out) before rendering labels, else fall back to the UUID.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new. The renderer runs synchronously inside `_serialize`; publishing keeps its existing debounce (`:58-66`), single-flight (`_inFlight`/`_pending`, `:75-79`, `:105-111`), and trailing-run guarantees. Adding a third file to one commit introduces no new concurrency.
- **Security:** `board.html` is force-pushed to a public-if-the-repo-is-public branch. It must contain only board metadata already present in `board.json`/`board.md` — no tokens, no absolute local paths, no secrets. Use the plain plan **filename**, never an absolute path (mirrors the imported-docs absolute-path hazard seen elsewhere in the codebase). Being static with no JS, the HTML has no XSS execution surface for its viewer, but topic/feature/project strings must still be HTML-escaped when interpolated into markup (the existing `board.md` path escapes `|` for tables at `:143`; HTML needs `<`, `>`, `&`, `"` escaping).
- **Side Effects:** One additional file in the `switchboard/board` commit. Slightly larger commits/pushes; negligible. No change to `board.json`/`board.md` semantics beyond additive fields.
- **Dependencies & Conflicts:** Gated by the existing opt-in — publishing only runs when `switchboard.boardStateExport === 'read-only-snapshot'` (`_isBoardSnapshotEnabled`, `KanbanDatabase.ts:8056-8063`; default `'none'`). `board.html` inherits this gate for free (no new setting). No conflict with the sibling **Browser Board** subtask — that one renders live from `GET /kanban/board` + the WebSocket hub and does **not** consume `board.json`, so the schema bump here does not affect it (see the feature's reconciliation notes).

## Dependencies

- None on other sessions. Sibling subtask *Browser Board: Serve the Kanban Webview from LocalApiServer* is independent — different code path (LocalApiServer + webview shim), does not read `board.json`. Can ship in either order.

## Adversarial Synthesis

Key risks: (1) a wall-clock timestamp in the hashed JSON silently breaks dedupe and force-pushes on every persist; (2) the current snapshot lacks complexity/feature-title/planFile, so a naive renderer shows UUIDs and blank fields; (3) the docs promise "view HTML straight off the branch" but raw git-file hosting typically serves HTML as `text/plain`, so the exact static-hosting path must be verified before it is documented. Mitigations: keep the timestamp out of the hash (derive from `updated_at`); extend `_serialize` and add a feature-label lookup before writing the renderer; verify the hosting walkthrough (see Uncertain Assumptions) before committing docs to a specific service.

## Proposed Changes

### `src/services/BoardSnapshotPublisher.ts`
- **Context:** `_serialize()` (`:119-156`) builds `json`/`md`/`hash`; `_pushSnapshot()` (`:158-268`) writes files into an isolated worktree (`:202-203`), stages (`:207`), commits (`:214`), and force-pushes (`:246`); `publish()` (`:74-112`) orchestrates dedupe (`:92-95`) and single-flight (`:75-79`).
- **Logic:** (a) Widen `BoardCardEntry` (`:20-26`) with `complexity`, `planFile`, and a feature label (or add a top-level `features` map). (b) Bump envelope `schema` to `2` (`:128`). (c) Add `renderBoardHtml(snapshot)` producing self-contained HTML; return it from `_serialize` alongside `json`/`md`/`hash`. (d) Add `writeFile(path.join(worktreePath, 'board.html'), html, 'utf8')` after `:203` and `'board.html'` in the `git add` list at `:207`. (e) Extend `_pushSnapshot`'s signature and the `publish()` call sites (`:92`, `:97`) to carry `html`.
- **Edge Cases:** Keep the dedupe hash over `json` only (`:154`) — do not fold in wall-clock time. HTML-escape all interpolated strings. Fall back to the feature UUID if the feature record is absent from `plans`.

### `KanbanDatabase.ts` (read-only reference)
- **Context:** `getBoard`/`PLAN_COLUMNS` already select `complexity`, `planFile`, `status` (`:43-74`); the ordering is `updated_at DESC` (`:3304-3312`). No behavioral change here — the fields simply need to flow into `_serialize` (verify the `plans` array passed to the publisher includes them; extend the projection if it is a narrower shape).

### switchboard-site docs + `switchboard-remote` skill (docs)
- **Context:** Remote Control / Cloud Coding Agents pages already document the `switchboard/board` branch as the board-state mechanism.
- **Logic:** Add (a) the artifact recipe prompt, (b) the two/three consumption paths, cross-linked. **Do not** write the exact static-hosting steps until the Uncertain Assumptions below are confirmed.

## Verification Plan

*(Session directives: SKIP COMPILATION, SKIP TESTS — no automated tests are to be authored or run for this dispatch. The steps below are the manual acceptance checks to run when implementing.)*

### Automated Tests
- None to be written or run this pass per session directive. (If tests are later added: a unit test asserting `_serialize` output for a fixed `plans` fixture is stable across two calls, i.e. identical hash — guarding the dedupe/timestamp invariant.)

### Manual Acceptance
- With `switchboard.boardStateExport = 'read-only-snapshot'`, mutate the board; confirm the `switchboard/board` commit now contains `board.html` in the **same** commit as `board.json`/`board.md`.
- Open `board.html` from a plain `file://` path with no network: it renders legibly, columns grouped, cards show topic/complexity/feature label/project/plan filename, and an "as of" timestamp. Content matches `board.json` from that commit.
- Narrow the viewport to phone width: layout stacks or horizontally scrolls, remains readable.
- Mutate nothing that changes board content (e.g. re-trigger persist with identical state): confirm **no** new publish/commit (dedupe intact — proves the timestamp did not enter the hash).
- Confirm existing `board.json`/`board.md` consumers still parse (additive schema).

## Research Findings (resolved)

The docs hosting paths (step 8) were flagged as external-domain uncertainties and confirmed by web research:

- **Orphan-branch HTML via Pages — works, with config.** GitHub Pages can publish from any branch (including the `switchboard/board` orphan branch), not just `gh-pages`; it requires an `index.html` at the branch root and Settings → Pages configuration. GitLab Pages is branch-agnostic, driven by a `.gitlab-ci.yml` `pages` job. Both serve real `text/html`.
- **Raw endpoints do NOT render.** `raw.githubusercontent.com` deliberately serves files as `text/plain` with `X-Content-Type-Options: nosniff` — a raw link shows source, not a page. Ruled out.
- **Third-party preview proxies — not recommended.** `htmlpreview.github.io`-style tools route assets through a shared public CORS proxy the maintainers flag as a security risk, and add nothing for a self-contained no-network file.
- **`file://` on the phone** is the confirmed zero-dependency fallback (works because the page is self-contained).

No open research items remain. The code deliverable (steps 1–6) was already grounded in verified in-repo facts.

---

**Recommendation:** Complexity **5** → **Send to Coder**. Ready to execute; the only open product call is the timestamp source (step 4 recommendation stands). The hosting-behavior research is resolved (see Research Findings) and folded into step 8 — no open research items remain.
