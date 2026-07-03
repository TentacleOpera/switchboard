# Remote-Sync Health & Error Surfacing

**Plan ID:** 767944d0-b8ba-4922-957e-6c26d639275a

## Goal

Make remote-sync health **visible to the user**. With full bidirectional sync (pull + high-fidelity push) running on the primary user surface across ~4,000 installs and **no feature flag** gating rollout, silent failures are unacceptable. Today remote poll/push failures land in `console.log`, which no user ever sees.

### Problem & background

`RemoteControlService` and the push pipeline catch errors and log them to the console. In a shipped extension with no staged rollout, a broken token, a rate-limit storm, or a repeatedly-failing poll/push is invisible until the user notices their board silently diverging from the tracker. This is the one production-hardening concern no other epic owns.

## What gets built

Surface sync health in the **Remote tab** (relocated into `project.html` per `project-html-dev-docs-tab-and-ia.md`):

1. **Last poll status** — timestamp, success/failure, and error summary for the most recent inbound poll.
2. **Last push status** — timestamp, success/failure, and error summary for the most recent outbound push (status/content/archive/project-context).
3. **Rate-limit / backoff state** — when the provider returns 429/529 and the existing `Retry-After` backoff engages, show that the sync is throttled rather than broken.
4. **Persistent failure indicator** — a visible (non-modal, no confirm dialog) indicator when N consecutive poll/push attempts fail, so a bad token or revoked connection is obvious.

## Scope & non-goals

- **No feature flag / rollout mechanism** (explicit program decision) — this plan is *observability*, not gating.
- No new telemetry backend; surface state in-UI from data the services already produce (extend their error handling to record last-status instead of only logging).
- Notion ≈ 3 req/s remains the binding rate constraint; `NotionFetchService.httpRequest` already retries on `Retry-After` — this plan makes that state *visible*, it does not re-implement backoff.

## Dependencies

- Remote tab living in `project.html` (`project-html-dev-docs-tab-and-ia.md`).
- Reads status from `RemoteControlService` (poll) and the unified push dispatch (Remote Sync Refactor 1/3).

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, reliability, backend
**Repo:** switchboard

## Review Findings

**Files changed:** `src/services/RemoteControlService.ts` (health state + `getHealth()` + `recordPushResult()`), `src/services/KanbanProvider.ts` (`remoteGetHealthPayload`), `src/services/PlanningPanelProvider.ts` (`getRemoteHealth` message handler), `src/webview/project.html` (health section UI), `src/webview/project.js` (`renderRemoteSyncHealth` + 15s health polling timer). The `RemoteSyncHealth` interface tracks lastPollAt/Ok/Error, consecutiveFailures, throttled/throttleUntil, lastPushAt/Ok/Error. The poll loop records success/failure and detects 429/529 rate-limit indicators via string matching. `recordPushResult` is called by both the auto-archive sweep and the project-context sync path. The UI shows/hides based on remote control active state and polls health every 15 seconds while active.

**Validation:** TypeScript compilation skipped per session directives. Static verification: all health fields in `RemoteSyncHealth` are consumed by `renderRemoteSyncHealth` in project.js. The health section in project.html (lines 1957-1963) has matching element IDs for poll/push/throttle/failure divs. `recordPushResult` wiring confirmed in both `_getAutoArchive` (line 1711) and project-context sync (line 2101). The `getHealth()` method correctly clears the throttled flag when the backoff window expires.

**Remaining risks:** (1) **NIT** — the persistent-failure threshold is hardcoded at `consecutiveFailures >= 3`; the plan says "N consecutive" without specifying N, so 3 is a reasonable default. (2) **NIT** — throttle detection uses string matching on error messages (`'429'`, `'529'`, `'rate limit'`, `'retry-after'`) rather than structured HTTP status codes; fragile but acceptable given the provider-agnostic design where errors surface as strings. (3) **NIT** — the 15-second health polling timer in project.js runs independently of the RemoteControlService poll cadence; if the poll frequency is 30s, health updates may show stale "last poll" timestamps between polls.
