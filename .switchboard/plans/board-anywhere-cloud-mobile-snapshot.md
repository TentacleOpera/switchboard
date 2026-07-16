# Cloud/Mobile Board: Self-Contained board.html in the Board-State Export

## Goal

Give users a visual board anywhere — phone, tablet, cloud agent chat — with zero dependency on the local machine being reachable, by publishing a rendered, self-contained `board.html` alongside `board.json`/`board.md` on the `switchboard/board` orphan branch, plus an agent recipe for rendering the board as an HTML artifact in Claude (web/desktop/mobile).

**Problem & background.** Away from the local machine there is no board visibility at all. The LocalApiServer is loopback-only, and a live remote board cannot be faked through artifacts: Claude artifacts run under a strict CSP that blocks all network requests, so an artifact can never poll `localhost` or any API. What *does* travel is the board-state branch — `BoardSnapshotPublisher` already debounces, hash-dedupes, and force-pushes `board.json` + `board.md` to the orphan branch `switchboard/board` on every board mutation. Cloud agents with repo access can read that branch today, but the payload is data, not a visual.

**Why this is potentially more powerful than the browser board.** The browser board requires the local machine on and reachable. This path requires only a git remote: a pre-rendered `board.html` on the branch is viewable via any static hosting of that branch (GitHub Pages, GitLab Pages, raw-file HTML preview services) on a phone, and a cloud agent can alternatively fetch `board.json` and render an on-demand artifact. It is the missing visual half of the Remote Control story.

## Implementation Steps

1. **Renderer.** Add a `renderBoardHtml(snapshot)` step to `BoardSnapshotPublisher` that produces a fully self-contained `board.html` from the same serialized snapshot used for `board.json`: inline CSS, no external fonts/scripts/images, no JS required to read it. Mobile-responsive layout (columns stack or horizontally scroll on narrow viewports). Include: columns with card counts, cards with topic/complexity/feature badge/project, feature groupings, and the snapshot timestamp prominently ("as of …") since it is by definition stale data.
2. **Publish.** Write `board.html` in the same worktree commit as `board.json`/`board.md` (`BoardSnapshotPublisher.ts` around the existing `writeFile` + `git add` block). The existing hash-dedupe/single-flight/debounce logic needs no change — one more file in the same commit.
3. **Keep it read-only and honest.** No action buttons, no fake interactivity. Every card can carry a plain-text plan filename so a cloud agent (or human) can cross-reference the plan file in the repo.
4. **Artifact recipe.** Add a documented prompt pattern (Remote Control docs on switchboard-site, plus a short section in the `switchboard-remote` skill if appropriate): "read `board.json` from the `switchboard/board` branch and render it as an HTML artifact" — for Claude web/desktop/mobile sessions with repo access. This is a docs deliverable, not code; the artifact must be generated self-contained because CSP blocks all fetches.
5. **Hosting note in docs.** Document the two consumption paths on the Remote Control landing page: (a) static view of `board.html` straight off the branch (including a GitHub Pages / raw-preview walkthrough), (b) on-demand artifact from `board.json` via a cloud agent. Cross-link from Cloud Coding Agents (the branch is already documented there as the board-state mechanism).

## User Review

- Confirm scope: `board.html` renders the same single-board snapshot the publisher already serializes (active project filter state as published) — no multi-view or filter UI inside the static page for v1.

## Acceptance Criteria

- Every publish to `switchboard/board` includes a `board.html` that opens correctly from a plain file:// path or raw static host with no network access, and renders legibly on a phone-width viewport.
- `board.html` shows columns, cards (topic, complexity, feature, project), and the snapshot timestamp; content matches `board.json` from the same commit.
- Publisher behavior (debounce, hash-dedupe, single-flight, force-push, orphan-worktree isolation) is unchanged; existing consumers of `board.json`/`board.md` are unaffected.
- Remote Control docs describe both consumption paths, and the artifact recipe produces a working board artifact in a Claude session with repo access.

## Metadata

- **Complexity:** 5
- **Tags:** board-snapshot, remote-control, mobile, artifacts
