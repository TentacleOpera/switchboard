# A Card Shows the Commit Its Work Produced, Read-Only, From Anywhere

## Goal

From a card, see the diff its agent produced — in the project panel, read-only, legible on a phone. Bounded to one commit resolved from that card. **Not a file browser, not a repo explorer, and never an editor.**

### Problem analysis

**The board asks for a decision it gives you no evidence for.** Completion is asserted by the seat and never inferred, which is correct — but the assertion is all you get. `composeCompletionEvidence` carries topic, column, feature id and duration. No SHA, no file list, no diff. You are asked to accept or reject work whose content is not on the board.

> **Superseded:** `composeCompletionEvidence` (`PlanIngestionEngine.ts:2378`).
> **Reason:** The function moved with file growth; the line number drifted. The SSH plan already corrected it to `:3060`, and it has moved again since.
> **Replaced with:** `composeCompletionEvidence` (`src/services/PlanIngestionEngine.ts:3119`) carries `topic`, `kanbanColumn`, `featureId`, and `dispatchedAt` — and no SHA, diff, or file list. The no-SHA observation stands; only the citation was stale.

**Today's answer is "open your editor", and it fails in exactly the case this product is for.** At a desk with the repo checked out, opening an editor is fine and this plan would be unnecessary. The case that matters is the one the remote story is built on: a headless always-on box, reached from a browser, often from a phone, with no editor and frequently no checkout on the device you are holding. There the evidence is unreachable, so the card is accepted on trust or left alone.

**The asymmetry is about to get sharper.** *A Team Commits Once, And The Reviewer Reviews That Commit* (`75a2d809`) gives the head's commit stage-and-plan-id **git trailers**, and *The Reviewer Is Never Told What To Review* resolves them to name the commit in the reviewer's prompt. So the reviewer is handed a review unit while the human doing the accepting still gets prose. This plan gives the operator the object the reviewer already has.

**Verified absent.** No diff or code surface exists anywhere in the product and none is planned — a repo-wide search for a diff view, code viewer, file tree or file browser returns nothing but incidental matches (`Date.now() - mtime`).

### Why this is not a file browser, and must not become one

This distinction is the whole plan, and it will be under pressure from the first review onward.

A **file browser** answers *"what is in this repository"*. That is an editor's job, it is unbounded, and it is the first brick of the IDE this product deliberately does not have: a tree wants search, search wants preview, preview wants highlighting, and then someone reasonably asks to edit. The comparison that prompts this — Warp — is a *terminal* product, where a filesystem viewer answers a question its users genuinely have. LABCOM is a board. Copying the feature imports a solution to a problem it does not have.

A **card's diff** answers *"what did this agent just do"*. It is bounded by the card, it is the evidence for a decision the board already asks you to make, and it terminates: there is nothing to navigate to next.

Build the second. Refuse the first.

## Metadata

- **Complexity:** 5
- **Tags:** ui, frontend, backend, api, feature

> **Superseded:** **Tags:** ui, board, git, remote, both-hosts
> **Reason:** `board`, `git`, `remote`, and `both-hosts` are not in the allowed tag set (`[frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library]`). A coder transcribing the plan would write metadata the importer rejects or silently drops.
> **Replaced with:** **Tags:** ui, frontend, backend, api, feature — the panel surface is `ui`/`frontend`, the shared endpoint is `backend`/`api`, and the work is a net-new `feature`. `both-hosts` is a wiring constraint, not a tag.

## User Review Required

None.

## Complexity Audit

### Routine

- One read-only `GET` endpoint on `LocalApiServer`, following the established `db.getPlanByPlanId(planId)` + `execFileAsync('git', …)` pattern already used by `/kanban/dispatch/state` and `_resolveCodedCommitsForPlans`.
- A file-list-first, expand-for-hunks diff renderer in `project.html` / `project.js`, reusing the panel's existing markdown/CSS scaffolding (no new dependency, no syntax engine).
- Added/removed-line highlighting only (CSS classes on `+`/`-` prefixed lines) — no grammar, no tokenizer.
- Stated-absence UI for the no-commit / non-git cases — plain text, no new component.

### Complex / Risky

- **Which stage's commit to show is a product decision, not a mechanic.** A plan accumulates `planned`, `coded`, and `reviewed` commits through its lifecycle, all carrying the same `Switchboard-Plan` trailer. "The commit its work produced" is a different object at each column, and a silent "most recent" rule can show a reviewer's one-line fix where the operator wanted the coder's body of work. The resolution rule must be stated, and the `source` field must name the stage so the operator knows which commit they are looking at.
- **Reusing the existing trailer resolver, not reinventing it.** `KanbanProvider._resolveCodedCommitsForPlans` (`KanbanProvider.ts:6044`) already does trailer→sha resolution. A second hand-rolled `git log --grep=Switchboard-Plan` is how the two drift — one learns about worktree git dirs, the other doesn't. The resolution must be extracted to a shared helper or the endpoint must call the existing one.
- **The worktree path is not on the DB record.** `KanbanPlanRecord` carries `worktreeId`/`worktreeStatus`, not `worktreePath`. The endpoint must resolve the path via `matchWorktreePath(db.getWorktrees(), record)` (the shared resolver both hosts already import) before it can `cwd` a `git log` into the worktree — audit item 3 is unverifiable without this step.
- **This serves source code over HTTP.** On a tailnet-exposed board that is real, though not new (the same surface already serves live terminals). The endpoint must stay read-only, single-commit, no path/ref parameter, and inherit the board's existing auth — never a bypass.
- **Caps must be concrete and visible.** A generated-file or lockfile commit is megabytes. "Cap per-file and in total" without numbers is a TODO disguised as a spec; a silently truncated diff is a wrong diff, and this feature exists to support a judgement.

## Edge-Case & Dependency Audit

**Race Conditions**

- The head could commit between the endpoint's `git log` (resolve sha) and `git show` (render diff). Bounded: both run against the same clone in one request, and `git show <sha>` is immutable once the sha is fixed. The only drift is if the sha resolves to a commit that is then garbage-collected mid-request — a window too small to design for; treat a `git show` failure after a successful `git log` as "commit unavailable" and name it.
- The board's local clone may not have fetched the head's commit yet (remote seat, unpushed or unfetched). Under trailer-only resolution this surfaces as "no commit resolved" (the trailer is absent from the local `git log`), not as a dangling sha — see *Dependencies & Conflicts* for why the "resolved-but-unreachable" distinction collapses.

**Security**

- The endpoint serves source code over HTTP. It must not widen beyond the existing terminal surface: read-only, one resolved commit, no `?path=` / `?ref=` parameter (those are the file browser arriving through the back door and turn a bounded board feature into unbounded read access to the repository). It must be subject to whatever auth the board already applies (`_checkAuth`), never a bypass.
- The `planId` is interpolated into a `git log --grep` argument. It comes from the DB (a UUID), and goes into the `execFile` **argument array**, never a shell string — same quoting-free pattern as `_resolveCodedCommitsForPlans` and `/kanban/dispatch/state`. No new injection surface.

**Side Effects**

- One `git log -n 1` (resolve) + one `git show` (render) per panel open per card. Read-only, bounded, off any hot path (panel open, not every poll). Give each a short timeout in the style of the existing `execFileAsync` call sites (`_resolveCodedCommitsForPlans` uses 5000ms) and treat a timeout as "no commit / unavailable".
- No DB writes, no card movement, no prompt text. The panel is purely a read surface.

**Dependencies & Conflicts**

1. **Depends on `75a2d809`.** Without trailers there is no reliable card→commit answer, and change 1 refuses to guess — so before that lands, this feature is a working panel that almost always says "no commit resolved". Sequence it after, or accept that it ships mostly inert.
2. **The "resolved-but-unreachable" case collapses under trailer-only resolution.** The endpoint resolves the sha by running `git log --grep=Switchboard-Plan` against the board's own clone. If `git log` finds the trailer, the commit object is present in that clone, so `git show` succeeds by construction. There is no path under this design where a sha is *known* yet *unshowable* on the board host. The distinct "unreachable, name the host" case belongs to the **reviewer-on-a-remote-machine** context (SSH plan, change 5), where the reviewer's clone is a different machine that may never have received the commit — not to this board-host endpoint. Reconciled below: the board endpoint reports "no commit resolved" (trailer absent) or "worktree branch gone" (worktree cleaned up), never "resolved-but-unreachable".
3. **Worktrees.** A card worked in a worktree has its commit on that branch, possibly not merged and possibly on a branch that has since been cleaned up. The DB record carries `worktreeId`/`worktreeStatus` but not the path; the endpoint must resolve the path via `matchWorktreePath(db.getWorktrees(), record)` (the shared resolver both hosts import from `src/services/worktreeResolver`) and `cwd` the `git log` into it. When the worktree directory is gone or the branch has been cleaned up, report that distinctly — not as an error.
4. **Large diffs must be capped, and the cap must be visible.** A generated-file or lockfile commit is megabytes. Cap per-file and in total, and state what was withheld — a silently truncated diff is a wrong diff, and this feature exists to support a judgement.
5. **Binary files are named, never rendered.**
6. **Non-git workspaces exist.** The panel degrades to a stated absence, not an error.
7. **Shares `LocalApiServer.ts` and `project.html`/`project.js` with the rest of the panel surface.** The new endpoint is one more `else if` in the existing route switch (`LocalApiServer.ts:12320` region); the diff renderer is one more section in the plan preview. Serialise under one-stream-per-file with any sibling touching the same files.

## Dependencies

- `sess_75a2d809 — A Team Commits Once, And The Reviewer Reviews That Commit (stage+plan git trailers; hard prerequisite — without trailers there is no reliable card→commit resolution)`
- `sess_reviewer_review_unit — The Reviewer Is Never Told What To Review (built _resolveCodedCommitsForPlans at KanbanProvider.ts:6044, the trailer→sha resolver this endpoint must reuse, not reinvent)`
- `sess_ssh_remote_seat — An Agent Seat Can Run Its CLI On Another Machine Over SSH (change 5: remote commit reachability; the "unreachable" case originates there, on the reviewer's machine, not the board host)`

## Adversarial Synthesis

Key risks: the resolution rule is underspecified (which stage's commit — a plan accumulates `planned`/`coded`/`reviewed`), inviting a silent "most recent" that shows the wrong stage's work; the plan reinvents a trailer resolver that already exists (`_resolveCodedCommitsForPlans`) and will drift from it; and the "resolved-but-unreachable" verification case is unachievable under the plan's own trailer-only, request-time resolution (a sha `git log` finds is showable by construction on the same clone). Mitigations: state the resolution rule explicitly (most recent commit carrying this plan id, any stage, with `source` naming the stage), extract/reuse the existing resolver, resolve the worktree path via `matchWorktreePath` (not a `worktreePath` field absent from the DB record), and replace the unreachable case with the achievable "no commit resolved" / "worktree branch gone" distinctions.

## Proposed Changes

### 1. Resolve a card's commit, or say plainly that there isn't one

A resolver taking a planId and returning `{ sha, source, stage }` or a stated absence. `source` is required, not decoration: the answer differs in kind depending on where it came from, and a wrong commit shown against a card is worse than no commit. `stage` names which stage's commit was resolved (`planned` | `coded` | `reviewed`) so the operator knows what they are looking at.

> **Superseded:** "Order, most to least authoritative: 1. A stage trailer naming this plan id … 2. Nothing else." — stated the source but not the selection rule when a plan carries trailers for several stages.
> **Reason:** A plan accumulates `planned`, `coded`, and `reviewed` commits through its lifecycle, all carrying the same `Switchboard-Plan` trailer. "A stage trailer naming this plan id" does not say *which* one. A silent "most recent" can show a reviewer's one-line fix where the operator wanted the coder's body of work — the plan passes its own "a commit resolved" check while the goal (the diff its *agent* produced, for the decision at hand) is unmet.
> **Replaced with:** Resolve the **most recent commit carrying this plan id, across all stages** (`git log -n 1 --format='%H %s' --grep=Switchboard-Plan: <planId>`, no `--grep=Switchboard-Stage` filter, newest-first). Return its stage (read from the same commit's `Switchboard-Stage` trailer) in `source`/`stage` so the operator sees which stage's work the diff represents. This is the defensible default because the card's column does not map cleanly to a stage (cards move on coding *start*, not completion — per `stage-markers-in-commit-trailers.md`), so the column is not a reliable stage selector. The operator deciding whether to accept a card wants the latest statement of the work, whatever stage produced it; the `stage` field makes that visible rather than inferred.

**Reuse, do not reinvent.** `KanbanProvider._resolveCodedCommitsForPlans` (`KanbanProvider.ts:6044`) already runs `git log -n 1 --all-match --grep=Switchboard-Plan: <id> --grep=Switchboard-Stage: coded` per plan. Extract the trailer→sha query into a shared helper (e.g. `resolveCommitForPlan(planId, { cwd, stage? })` in a module both `KanbanProvider` and the endpoint import) so the reviewer path (stage-filtered) and this endpoint (any-stage) call the same code with a different `stage` argument. Two hand-rolled `git log --grep=Switchboard-Plan` queries are how the worktree-cwd, timeout, and `--all-match` semantics drift between them.

**Nothing else.** Do not fall back to "the most recent commit touching files the plan mentions", to `HEAD`, or to a time window around `dispatched_at`. Each is plausible, each is wrong often enough to matter, and each fails silently — a card would show a confident diff of somebody else's work. Absence is the correct answer when no trailer resolves.

When nothing resolves, the panel says which case it is: no commit yet, the seat has not committed, the worktree branch is gone, or the workspace is not a git repository. Not a spinner and not an empty pane.

### 2. A read-only diff endpoint on the shared API

`GET /kanban/plan/commit?planId=…&workspaceRoot=…` returning the resolved sha, the stage, the subject, the author date, the file list with per-file added/removed counts, and the patch — capped (see below). It lives in `LocalApiServer`, which both hosts already serve, so the endpoint reaches the extension and the standalone host without a second implementation.

No path parameter, no ref parameter, no arbitrary-revision access. The endpoint takes a **planId** and resolves the commit itself. A `?path=` or `?ref=` argument is the file browser arriving through the back door, and it turns a bounded board feature into unbounded read access to the repository over HTTP.

**Resolve the worktree path before running git.** The endpoint must:
1. `db.getPlanByPlanId(planId)` to fetch the plan record (same precedent as `/kanban/dispatch/state` at `LocalApiServer.ts:3192`). The record carries `worktreeId`/`worktreeStatus`, **not** `worktreePath`.
2. Resolve the worktree path via `matchWorktreePath(await db.getWorktrees(), record)` — the shared resolver both hosts import from `src/services/worktreeResolver` (standalone `bootstrap.ts:55`; extension via `TaskViewerProvider.resolveWorktreePathForPlan` at `:13096`, which delegates to the same `matchWorktreePath`). Fall back to `workspaceRoot` when no worktree matches.
3. `cwd` the `git log` (resolve) and `git show` (render) into that path.

Without step 2, audit item 3 (worktrees) is unverifiable — the commit sits on a branch checked out in a worktree the board's main checkout does not see.

**Caps — concrete and visible.** Clarification of the audit's "cap per-file and in total":
- Per-file patch: **64 KB**. Beyond that, render the file's stat line (path, +N/-M) and a "patch withheld (N bytes)" notice — do not stream a megabyte hunk to a phone.
- Total patch payload: **1 MB**. Beyond that, render the full file list with per-file counts and a "full patch withheld — N files, M bytes total" notice. The file list is the decision-making surface; the patch is the detail.
- State what was withheld in every case. A silently truncated diff is a wrong diff.

**Reconciled: no "resolved-but-unreachable" case on the board host.** Under trailer-only, request-time resolution, the sha comes from `git log` against the board's own clone; if `git log` found it, `git show` can render it. The endpoint therefore reports:
- *no commit resolved* — no `Switchboard-Plan` trailer for this id in the queried ref space;
- *worktree branch gone* — the worktree directory is absent or the branch was cleaned up (detected at step 2);
- *not a git repository* — `workspaceRoot`/worktreePath is not a git repo;
- *commit unavailable* — `git show` failed after `git log` succeeded (object gone mid-request; treat as transient, name it).

The "unreachable, name the host" distinction belongs to the reviewer-on-a-remote-machine context (SSH plan, change 5), where the reviewer's clone is a different machine — not to this board-host endpoint.

### 3. The diff renders in the project panel, beside the plan

`src/webview/project.html` / `project.js` is the plan reading surface, so the commit belongs next to the plan it closed rather than on the board card, where it would not fit and would not be readable.

- A file list first, collapsed. Most decisions are made on *which files changed*, and on a phone that list is often the whole answer.
- Expand a file for its hunks. Unified, not side-by-side — side-by-side is unreadable at phone width and doubles the work.
- Highlighting is added/removed lines only. No language grammars, no syntax highlighting engine, no new dependency.
- **No editing affordance of any kind**, including one that is disabled. A greyed-out control is a promise.
- When the cap fires, the withheld notice (change 2) renders inline where the patch would have been — the operator sees that detail was elided, not that the file was empty.

### 4. Both composition roots, checked by hand

The endpoint is shared, but the panel is served separately by each host and the wiring is where these diverge. Diff `src/extension.ts` / `TaskViewerProvider` against `src/standalone/bootstrap.ts` for the panel's route and its message plumbing, and confirm the seam each host wires rather than the verb each answers. Both hosts instantiate `TaskViewerProvider` (extension `extension.ts:1005`; standalone `bootstrap.ts:1463`) and both import `matchWorktreePath` (`worktreeResolver`), so the worktree-path resolution in change 2 reaches both — verify the endpoint's `getKanbanDatabase` and `getWorktrees` plumbing is wired on each, not just the extension.

## Verification Plan

1. A card whose commit carries a matching trailer shows that commit's file list and patch, with the resolved `stage` labelled.
2. A card with no resolvable commit states which case applies, and shows no diff. Assert specifically that it does **not** fall back to `HEAD` or to a recent commit touching related files.
3. A card whose work was done in a worktree resolves against the worktree's git dir (via `matchWorktreePath`); a worktree whose branch has been cleaned up reports "worktree branch gone" rather than erroring.
4. A diff over the cap renders the file list in full and states what was withheld (per-file 64 KB, total 1 MB). A binary file is named and not rendered.
5. **The scope boundary holds:** no file tree, no repository search, no path or ref parameter on the endpoint, and no editing control — enabled or disabled — exists anywhere in the surface. This is a review checklist item, not an implementation detail.
6. Readable at 390&nbsp;px wide: the file list is usable and the patch scrolls in its own container without the page scrolling sideways.
7. Both hosts serve the panel and the endpoint, verified by diffing the two composition roots by hand rather than by calling the verb on each.
8. The endpoint reuses the shared trailer resolver (or a thin shared helper wrapping it) — assert no second `git log --grep=Switchboard-Plan` is hand-rolled in the endpoint; the reviewer path and this endpoint share one resolution code path.

### Automated Tests

- Endpoint contract: `planId` with a matching trailer → `{ sha, stage, subject, files[], patch }` with per-file `+`/`-` counts; `planId` with no trailer → a stated-absence shape (assert it does **not** include a sha and does **not** fall back to `HEAD`).
- Cap behaviour: a file whose patch exceeds 64 KB returns the stat line + a "withheld" notice, not the patch; a payload over 1 MB returns the full file list + a total-withheld notice.
- Worktree resolution: a plan record with a `worktreeId` resolves the path via `matchWorktreePath` and `cwd`s the git call into it; a missing worktree directory returns "worktree branch gone".
- Scope boundary: the endpoint rejects `?path=` and `?ref=` (400), and the rendered HTML contains no `contenteditable`, no `<input>`/`<textarea>` in the diff section, and no disabled edit control.
- Resolver reuse: a source-text assertion that the endpoint imports the shared resolver (or its helper) rather than containing a literal `--grep=Switchboard-Plan` query string of its own.

### Goal Invariants

- `GET /kanban/plan/commit?planId=<id-with-trailer>` returns an object with a non-empty `sha` and a `stage` in `{planned, coded, reviewed}`.
- `GET /kanban/plan/commit?planId=<id-with-no-trailer>` returns no `sha` field and a `reason` in `{no-commit, worktree-branch-gone, not-a-git-repo}` — never a synthesized `HEAD` sha.
- The endpoint handler in `LocalApiServer.ts` contains no `?path` / `?ref` query-param read; the diff section of `project.html` contains zero `contenteditable` attributes and zero enabled-or-disabled edit controls.
- The endpoint and `KanbanProvider._resolveCodedCommitsForPlans` share one resolution code path (one import of the shared helper; zero hand-rolled `--grep=Switchboard-Plan` literals in the endpoint).

## Outstanding Questions

- **[user]** Which commit should the panel show when a plan has trailers for multiple stages (`planned`, `coded`, `reviewed`)? — proceeding on the assumption that **the most recent commit carrying this plan id (any stage)** is the right default, with `stage` labelled so the operator knows which stage's work they are seeing. If the operator should instead see a stage-specific commit (e.g. always `coded`, or the stage matching the card's current column), the resolution rule and the `stage` filter change accordingly — confirm before implementation.

---

**Recommendation:** Complexity 5 → **Send to Coder.**
