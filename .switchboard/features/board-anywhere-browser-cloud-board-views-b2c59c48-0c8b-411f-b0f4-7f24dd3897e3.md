# Board Anywhere: Browser & Cloud Board Views

**Complexity:** 7

## Goal

Make the Kanban board visible outside the VS Code webview. Two complementary views: a live browser board served by LocalApiServer for agentic coding app users on the local machine, and a pre-rendered self-contained board.html published to the switchboard/board orphan branch for phone/cloud access with no dependency on the local machine. The browser board is the first second host enabled by the Host-Agnostic Verb Engine; the cloud snapshot is the missing visual half of the Remote Control story.

## How the Subtasks Achieve This

- **Browser Board: Serve the Kanban Webview from LocalApiServer**: adds a `GET /ui/board` route serving the existing `kanban.html` with a two-channel transport shim (commands: postMessage → verb-rail fetch; renders: subscribe to the existing WebSocket hub, which already broadcasts the `updateBoard`/`moveCards` vocabulary the page consumes), read-only first then interactive, gated by a Host-header allowlist + API token since a browser client makes unauthenticated loopback unacceptable. Covers the "local machine, no VS Code" case for agentic coding app users.
- **Cloud/Mobile Board: Self-Contained board.html in the Board-State Export**: extends BoardSnapshotPublisher to render a fully self-contained, mobile-responsive `board.html` into the same `switchboard/board` commit as `board.json`/`board.md`, plus a documented artifact recipe (cloud agent reads `board.json` from the branch, renders an HTML artifact). Covers the "away from the machine entirely" case — viewable from static hosting or a Claude session on a phone.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Browser Board: Serve the Kanban Webview from LocalApiServer](../plans/board-anywhere-browser-board-host.md) — **PLAN REVIEWED**
- [ ] [Cloud/Mobile Board: Self-Contained board.html in the Board-State Export](../plans/board-anywhere-cloud-mobile-snapshot.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints — the two subtasks touch different code (LocalApiServer + webview shim vs. BoardSnapshotPublisher) and can be executed in parallel or in either order. The cloud/mobile snapshot is the smaller, self-contained win (complexity 5) and does not depend on the verb engine; the browser board (complexity 7) builds on the completed Verb Engine dispatch contract for kanban verbs and reuses the existing WebSocket hub for live refresh. The two subtasks share no code surface: the browser board renders live from `GET /kanban/board` + the WS hub and does not read `board.json`, so the cloud snapshot's `board.json` schema changes cannot affect it.
