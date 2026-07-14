# Crashlytics Crash-Health Digest → Git Repo (`app-crash-reports`, local, code-grounded)

**Date:** 2026-06-24
**Repos affected:**
- `viaapp` (read-only — the routine reads source to *ground* its cause reads; no app code changes).
- `app-crash-reports` (**write target — new dedicated GitLab repo**) — holds the dated digest files. Created once; the routine commits one file per day.
**Runs:** on the user's own machine (Crashlytics MCP connected, Firebase CLI logged in, both `viaapp` and `app-crash-reports` checked out), triggered **manually or on a schedule** — never a detached cloud sandbox.
**Effort estimate:** 1–2 days
**Supersedes (as the v1 starting point):** the three-phase Crashlytics Automation plans (alert triage / per-crash investigation / BigQuery slow-burn). Those remain on the shelf; this is the smaller, oversight-first first step the user actually wants now.

> **Storage decision (revised 2026-06-24):** digests are stored as **version-controlled markdown files in a dedicated GitLab repo `app-crash-reports`**, not in ClickUp. Rationale: the primary value is an agent **cross-checking reports against the code**, so the archive should live where code-grounded tooling already operates — git-native diffing *is* the time-series, files are greppable beside the source, and reports can be **anchored to the app version** they cover so an old report is checkable against the matching `viaapp` tag. ClickUp is retained as a considered alternative (see end of doc). *(The plan filename still says "clickup" — the path is the stable source of truth; only the storage mechanism changed.)*

---

## Goal

Produce a standing, once-a-day, durable answer to **"how many crash/error events in the last 24 hours, on which platform, and what are the likely causes?"** — written to a **dated markdown file in the `app-crash-reports` git repo** so crash-health trend ("is this getting worse?") is answerable by diffing the archive (`git log`/`git diff`). The differentiator over the live Crashlytics dashboard is twofold: (a) a **dated time-series of interpreted snapshots** that Crashlytics itself does not retain, and (b) **code-grounded cause reads** — because the routine runs locally with the `viaapp` repo present, it reads the implicated source rather than relaying the MCP's generic root-cause guess.

The core problem this solves is *oversight*, not remediation. There is deliberately no suspect-commit hunting, owner identification, or ticket-per-crash machinery (see **Deliberately out of scope**). The `## Why` and `## Risk` sections below preserve the full original rationale and must not be narrowed.

**Clarification (grounding mechanism, derived from code, not new scope):** every named code in the plan (`UPLOAD_PHOTO_FAILED`, `VIDEO_TOKEN_EXPIRED_ANDROID`, …) is emitted through a single helper, `crashlyticsError(message, error)` at [fire.ts:37](viaapp/src/library/api/fire.ts#L37), which has **118 call sites** across `src`. That helper is the spine of the code-grounding step: `grep -rn "'<CODE>'" src` resolves any named code to its exact call site in one hop.

---

## Metadata

**Tags:** reliability, mobile, devops, infrastructure

**Complexity:** 3

**Repo:** viaapp (read-only grounding source). **Write target:** the new `app-crash-reports` repo — not one of the existing workspace sub-repos; it is created as part of this work.

**Nature of work:** this is **not a software-engineering task** — no application code is written or changed. The deliverable is (a) a **natural-language routine** (a saved slash-command prompt / `/schedule` job) that, at runtime, calls the Crashlytics MCP, greps/reads `viaapp` source, and writes + commits a markdown file; (b) a **new reports repo** with a `README.md` schema; (c) **read-only** grounding of `viaapp`. The only "writing" is a prompt and a README. (Re-scored from 4 → 3: the code-centric rubric overstated this. The genuine care points — MCP auth gotchas, issue→named-code mapping, no-PII-in-git, version-anchoring — are handled by writing a careful prompt, not code. Treated as low-complexity config/automation authoring with a few must-not-miss gotchas, all captured in Research Findings + User Review Required.)

---

## Research Findings (Firebase Crashlytics MCP — verified 2026-06-24)

External research (`docs/firebase_crashlytics_mcp_tool_surface_technical_analysis.md`) confirmed the MCP tool surface and resolved the one open assumption. Key results, folded into the plan below:

- **Tool names confirmed.** `crashlytics_get_report`, `crashlytics_get_issue`, `crashlytics_list_events` exist verbatim; also `crashlytics_batch_get_events` (up to 100 events by name). There is **no** `crashlytics_list_top_issues` — top issues are `crashlytics_get_report` with `report: "topIssues"` (single consolidated report tool; other reports: `topVersions`, `topAppleDevices`, `topAndroidDevices`).
- **Fatal/non-fatal is a first-class filter — resolves the biggest risk.** Every report/issue/event carries an `errorType` enum: `FATAL` | `NON_FATAL` | `ANR` (ANR = Android-only). It is both a `filter.issue.errorType` input and present in payloads. So the digest can request fatal and non-fatal totals as **separate, explicit queries** rather than inferring — no guessing.
- **App-version capture (enables version-anchoring).** `crashlytics_get_report` with `report: "topVersions"` returns the app versions present in the window — record these in each digest so cross-analysis can check the report against the matching `viaapp` release/tag, and `filter.version.displayNames` can scope queries to specific builds.
- **Trailing 24h window:** set `filter.interval.startTime`/`endTime` (RFC 3339). **You must set it** — omitting `interval` defaults to the previous **7 days**, not 24h. `startTime` cannot be older than **90 days** (backend retention).
- **Per-platform = per-appId, strictly.** No cross-platform call; every tool requires an explicit platform-specific `appId`. Confirms the plan's iOS/Android split-by-app-id approach.
- **Code grounding is supported as designed.** `crashlytics_list_events` (or `batch_get_events`) with `readMask: 'logs,threads,exceptions'` returns `logs[]` (the `crashlytics().log()` breadcrumb lines — where our named code lives, as the first token) and `threads[]` (stack frames with a `blamed` boolean marking the fault frame — follow this for fatals). Default `pageSize`: report 25, events 10 — fine for top-5.
- **⚠️ Auth gotchas (must configure correctly):** Service-Account / ADC auth is **broken** for all Crashlytics endpoints — returns `HTTP 404 Method not found` (firebase-tools #10004/#10310), while non-Crashlytics tools keep working (so a 404 here is the SA-routing bug, not a permission error). **Use interactive user OAuth** (`firebase login`) — which the plan already assumes — or `firebase login:ci` → `FIREBASE_TOKEN` for any headless/scheduled run. Also: if `GOOGLE_CLOUD_QUOTA_PROJECT` is set, the MCP injects `x-goog-user-project` and the call 404s — **unset it**.
- **Init robustness:** on large projects `tools/list` can hang / exhaust the Node heap. Launch the MCP scoped: `npx -y firebase-tools@latest mcp --only crashlytics` (and `--dir` to the `viaapp` app root if discovery hides the tools in this multi-repo workspace).
- **Trade-off noted (scope unchanged):** research rates BigQuery export as the robust path for *fully automated* digests and MCP as best for *interactive/human-in-the-loop* runs. BigQuery is deliberately out of scope here; this reinforces keeping **v1 manual** and treating scheduling as optional-with-caveats (needs `FIREBASE_TOKEN`).

No further research required.

---

## User Review Required

The author of the routine must confirm the following before/while building it — these are decisions the code cannot make:

1. **Fatal vs non-fatal scope.** `crashlyticsError` calls `crashlytics().recordError(error)`, which produces **non-fatal** issues, *not* app crashes. Research confirms `errorType` (`FATAL`/`NON_FATAL`/`ANR`) is a real filter, so this is now a reporting choice rather than a technical risk: report **both, segmented** (recommended) — e.g. fatal crashes, non-fatal errors, and ANRs as distinct totals per platform. Note the named-code grounding path applies to the **non-fatal** subset; fatals/ANRs ground via the `blamed` stack frame.
2. **Prod Firebase app ids.** These are **not in the repo** — the committed `android/app/google-services.json` is templated (`YOUR_APP_ID`/`YOUR_PROJECT_ID`, injected at build time) and `ios/ViaApp/GoogleService-Info.plist` points at the **dev** project `viaapp-1c6e4`. The real prod ids (project `viaapp-prod` per `.firebaserc`) must be fetched from the Firebase console or `firebase apps:list --project viaapp-prod`. Confirm the iOS + Android prod app ids before first run.
3. **MCP auth/launch configuration (confirmed by research).** Run under **interactive user OAuth** (`firebase login`), **not** a service account / ADC (those 404 on Crashlytics). **Unset `GOOGLE_CLOUD_QUOTA_PROJECT`.** Launch scoped: `firebase-tools mcp --only crashlytics` (add `--dir <viaapp root>` if the tools don't appear). For any future scheduled run, supply `FIREBASE_TOKEN` via `firebase login:ci`.
4. **`app-crash-reports` repo setup.** Create the dedicated GitLab repo `app-crash-reports` and clone it into the workspace (a sibling of `viaapp`, per the worktree-sibling convention). Confirm the file/path layout (recommended: `reports/YYYY/YYYY-MM-DD.md`). **Decided:** the routine **commits and pushes the day's file** on each run (commit message `crash-health: <date>`, push to the repo's default branch). Note: *this planning session's* git policy forbids me from running state-mutating git here; the routine, run by the user, performs the commit/push itself.
5. **Trigger mode for v1:** saved slash command (manual) vs `/schedule` job. Manual is sufficient and recommended for v1 (MCP auth is fragile for unattended runs — see Research Findings).

---

## Complexity Audit

> **Framing:** the unit of work is a **prompt + repo setup**, not code. "Routine" below means the steps the authored prompt will perform at runtime; none of it is committed software. The risk items are things the prompt author must get right, not code defects.

### Routine
- Calling the Crashlytics MCP in a fixed read sequence, then writing a local markdown file and committing it — standard local file + git work.
- `grep`-ing a unique string in `viaapp/src` and reading the resulting file — standard local code reading.
- Per-platform split = the same report query parameterized by app id; no new pattern.
- No `viaapp` source files change; no build, deploy, or migration. The only writes are digest files in `app-crash-reports`.

### Complex / Risky
- **MCP auth configuration is the live risk (research-confirmed).** Service-Account/ADC auth 404s on all Crashlytics endpoints (#10004/#10310); `GOOGLE_CLOUD_QUOTA_PROJECT` set → 404. Must run under interactive user OAuth with that env var unset; scheduled runs need `FIREBASE_TOKEN`. Misconfiguration produces a confusing 404-only-on-Crashlytics failure.
- **Fatal vs non-fatal handling (risk downgraded — now a reporting choice).** `crashlyticsError` → `recordError` is a non-fatal; genuine fatal crashes carry **no** named code and group by stack trace. Research confirms `errorType` is a real filter/field, so the routine queries each category explicitly and branches grounding (named-code grep for non-fatals; `blamed` stack frame for fatals/ANRs). No inference required.
- **Issue → named-code mapping is not by title.** The named code is written via `crashlytics().log(...)` as a session **log line** (confirmed: returned in `logs[]` via `readMask`), not the issue title (title/grouping comes from the `error` stack). Mapping an issue back to its code requires reading a **sample event's `logs[]`** (`crashlytics_list_events`/`batch_get_events`), then grep — not matching the issue title string. The named code is the first token of the log line.
- **Version drift in cross-analysis.** Code evolves; a report from weeks ago must be checked against the `viaapp` version that was live then, not today's `develop`. Mitigated by recording the covered app version(s) (from `topVersions`) in each digest's frontmatter so the cross-checking agent can anchor to the right tag.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- None of consequence — single-writer, once-a-day, one new file per day. If run twice in one day, the same dated filename is **overwritten** (idempotent) rather than duplicated; the prior content is recoverable from git history.

**Security**
- Cause reads must be clearly labelled **hypotheses**, never asserted as fact — important because the file is durable, committed, and reviewable by others.
- Crashlytics events can contain user ids (`crashlyticsError` calls `setUserId(uid)`) and stack frames with paths. **Do not write raw user ids / PII into the committed files** — this matters more in git than in ClickUp because git history is permanent and hard to scrub. Report aggregate counts (events, impacted users) and issue titles only.
- Keep `app-crash-reports` private. No secrets enter the files; app ids are not secret but need not be published in file bodies.

**Side Effects**
- Creates/updates one markdown file per day in `app-crash-reports` and commits/pushes it to the default branch — this is the routine's only write. The one-time sanity check writes a **throwaway** file — delete it / don't commit it.
- Reads `viaapp` source only; no writes to `viaapp`.

**Dependencies & Conflicts**
- Requires the Crashlytics MCP connected **and** both `viaapp` and `app-crash-reports` checked out in the run environment (the code-grounding step is impossible without `viaapp`; the write target is impossible without `app-crash-reports`).
- Requires Firebase CLI logged in with **interactive user OAuth** (not SA/ADC) and access to `viaapp-prod`. **`GOOGLE_CLOUD_QUOTA_PROJECT` must be unset** (set → 404). Launch the MCP scoped: `firebase-tools mcp --only crashlytics` (avoids `tools/list` heap/timeout on large projects; add `--dir <viaapp root>` if Crashlytics tools don't appear in this multi-repo workspace).
- A single app id returning `404`/empty must be diagnosed correctly: a 404 on **all** Crashlytics calls but not other tools = the SA/ADC routing bug (#10004/#10310), not a missing-data condition. A genuine per-app empty/404 must **degrade gracefully** — report the platform that succeeded, note the failure for the other, never abort the whole digest.
- First run has no "yesterday" file — the vs-yesterday line must no-op cleanly.

---

## Dependencies

- None blocking (no upstream session work required).
- **New repo prerequisite:** the `app-crash-reports` GitLab repo must exist and be cloned before the first real run (a one-time setup, not an engineering dependency).
- **Conceptually supersedes** the shelved three-phase Crashlytics Automation plans (alert triage / per-crash investigation / BigQuery slow-burn). This routine is the v1 oversight-first slice; those remain on the shelf and are not prerequisites.
- `sess_XXXXXXXXXXXXX — <link the originating Crashlytics-automation planning session here if one is tracked>`

---

## Adversarial Synthesis

**Risk summary:** Research confirmed the MCP tool surface and de-risked the headline concern — `errorType` (`FATAL`/`NON_FATAL`/`ANR`) is a real filter, so fatal vs non-fatal becomes an explicit reporting split rather than inference (named-code grep grounds non-fatals; the `blamed` stack frame grounds fatals/ANRs; the named code is recovered from event `logs[]`, not the issue title). The remaining live risk is **MCP auth**: Service-Account/ADC 404s on Crashlytics and a set `GOOGLE_CLOUD_QUOTA_PROJECT` also 404s — so it must run under interactive user OAuth with that env var unset (`FIREBASE_TOKEN` for any scheduled run). Secondary: prod app ids aren't in the repo (`firebase apps:list --project viaapp-prod`); the 24h `interval` must be set explicitly (default is 7 days); reports must record the covered app version so old reports stay checkable against the matching `viaapp` tag; and **no PII may be written into the committed files** (git history is permanent).

---

## Proposed Changes

> No `viaapp` source files change. The deliverables are (a) a **routine artifact** (a saved slash-command prompt and/or `/schedule` job), (b) the **`app-crash-reports` repo** with a file-format convention, plus the documented code-grounding map. "Target files" below are the artifact to author, the report-file format, and the read-only grounding anchors in `viaapp`.

### Routine artifact — saved prompt / slash command (or `/schedule` job)

- **Context:** Runs locally on the user's authenticated machine. Orchestrates Crashlytics MCP reads → local `viaapp` source grep/read → write a dated markdown file into `app-crash-reports` → commit/push. Manual for v1; optionally scheduled later.
- **Logic (once per day):**
  1. **24h totals** via `crashlytics_get_report` (`report: "topIssues"`), per prod app id (iOS + Android). **Set `filter.interval.startTime`/`endTime`** to the trailing 24h (RFC 3339) — omitting it defaults to 7 days. Query **per `errorType`** (`FATAL`, `NON_FATAL`, and `ANR` for Android) so each category is a separate, explicit total (events + impacted users). Also pull `report: "topVersions"` to record the covered app version(s).
  2. **Per-platform split** = same report parameterized by `appId` (no cross-platform call exists); report overall + per platform. iOS vs Android segmentation is mandatory (standing analytics requirement). ANR is Android-only.
  3. **Top-N issues (≈5 by impacted users)** → for each, fetch `crashlytics_get_issue` + `crashlytics_list_events` with `readMask: 'logs,threads,exceptions'`. Determine grounding path by `errorType`:
     - **NON_FATAL carrying a named code:** read a sample event's `logs[]` to recover the `<CODE>` (first token of the log line), then `grep -rn "'<CODE>'" src` in `viaapp` → the exact `crashlyticsError(...)` call site → read surrounding source → write a one-line **hypothesis** cause.
     - **FATAL / ANR (no named code):** follow the `blamed` frame in `threads[]` (file:line) into `viaapp/src` → read → write a one-line **hypothesis** cause.
  4. **vs-yesterday (git-native):** read the previous dated file's frontmatter totals (or `git diff` the latest two report files); emit total up/down, new issues entering top-N, issues dropping off. No-op cleanly on first run.
  5. **Write** `reports/<YYYY>/<YYYY-MM-DD>.md` in `app-crash-reports`, then `git add` + commit (`crash-health: <date>`) + push to the default branch. Overwrite (not duplicate) if the same-day file exists — a same-day re-run is a second commit amending the day's numbers, and git history preserves the earlier version.
- **Report file format:** YAML **frontmatter** as the machine-readable block (so vs-yesterday and any cross-analysis parse it reliably) + a human-readable markdown body. Frontmatter keys: `date`, `window_start`/`window_end`, `app_versions` (per platform), and per-platform per-`errorType` totals (`fatal`, `nonfatal`, `anr`: events + users). Body: the top-N issue table (title, platform, errorType, events, users, likely-cause hypothesis, grounded file ref) and the vs-yesterday line.
- **Implementation:** Launch the MCP scoped (`firebase-tools mcp --only crashlytics`, user-OAuth, `GOOGLE_CLOUD_QUOTA_PROJECT` unset). Author the routine as a saved prompt; reads via the Crashlytics MCP; writes via local file Write into the `app-crash-reports` checkout, then `git add`/commit/push; history/diff via git. No ClickUp MCP needed.
- **Edge cases:** single-app `404`/empty → report the working platform, note the gap, don't abort; first run → skip vs-yesterday; double-run same day → overwrite the file (git keeps the prior version); never write user ids/PII into the file.

### Report-file convention — `app-crash-reports/reports/YYYY/YYYY-MM-DD.md` (new)

- **Context:** The durable artifact and time-series. One file per day; git history is the trend record.
- **Logic:** Frontmatter is the source of truth for diffing/cross-analysis; the body is for humans. `app_versions` anchors the report to the `viaapp` build it describes.
- **Implementation / Edge Cases:** Keep the schema stable across days (the vs-yesterday parser depends on it). Add a top-level `README.md` in the repo documenting the schema so future tooling (and future agents) can rely on it.

### Grounding anchor — [src/library/api/fire.ts:37](viaapp/src/library/api/fire.ts#L37) (`crashlyticsError`, read-only)

- **Context:** Single helper through which all 118 named-code call sites flow. `crashlytics().log('<message> <error.code> <error.message>')` + `crashlytics().recordError(error)`. Confirms: named code = log breadcrumb on a **non-fatal**, grouping is by the `error` stack.
- **Logic:** Defines the grep target (`'<CODE>'` string literal) and explains why issue→code mapping reads event logs, not titles.
- **Implementation / Edge Cases:** No change — read-only reference. The routine's code-grounding step relies on this contract; if the helper changes (e.g. starts logging the code as the issue title), the mapping step simplifies and should be revisited.

### Read-only config anchors

- `.firebaserc` → prod project is `viaapp-prod`. `android/app/google-services.json` (templated) and `ios/ViaApp/GoogleService-Info.plist` (dev project) confirm prod app ids must come from `firebase apps:list --project viaapp-prod`, not the repo.

---

## Verification Plan

> Per session directives: **skip compilation and skip the automated test suite** (the user runs tests separately). There are no `viaapp` source changes to compile or unit-test; verification is operational dry-run validation of the routine.

### Automated Tests
- None applicable — no `viaapp` source code changes. (If the routine is later extracted into a script with parsing logic, the vs-yesterday frontmatter parser would warrant a focused unit test; out of scope for the saved-prompt v1.)

### Manual / operational validation (the real verification for this plan)
1. **One-time sanity check:** confirm the Crashlytics MCP is reachable; `crashlytics_get_report` returns data for one prod app id; write one throwaway file into `app-crash-reports` (don't commit it / delete after).
2. **App-id confirmation:** `firebase apps:list --project viaapp-prod` returns the iOS + Android app ids; each yields a non-empty report.
3. **Dry-run a full day:** generate one `reports/<YYYY>/<date>.md` and **eyeball it against the live Crashlytics dashboard** for the same 24h window — totals (fatal / non-fatal / ANR separately), per-platform split, and top-N must line up.
4. **Grounding spot-check:** for at least one non-fatal top issue, confirm the recovered `<CODE>` greps to a real `crashlyticsError` call site and the cause line points at the right file; for at least one fatal issue, confirm the `blamed` frame's file resolves in `viaapp/src`.
5. **Version-anchor check:** confirm the recorded `app_versions` matches a real `viaapp` release/tag, so the report is checkable against that code revision.
6. **Degradation check:** simulate one platform returning no data — confirm the digest still writes with the working platform and a noted gap.
7. **Diff check:** generate two consecutive days (or hand-edit a prior file) and confirm the vs-yesterday line derives correctly from the frontmatter / `git diff`.
8. (Optional) Schedule daily only after a manual run reads correctly.

---

## Why

The goal is **constant oversight of crash health**, not fixing any one crash. Specifically: a standing, once-a-day answer to "how many crashes in the last 24 hours, on which platform, and what are the likely causes?" — written somewhere durable and reviewable.

Crashlytics already holds the raw data and a live dashboard, so this does **not** mirror crash events anywhere (that would just recreate Crashlytics). What it produces is something Crashlytics does *not* retain: a **dated time-series of interpreted snapshots** — each day's totals plus a cause read on the top issues — so "is this trending worse?" is answerable by diffing the archive.

This is feasible because the **Crashlytics MCP** (`crashlytics_get_report`, `crashlytics_get_issue`, `crashlytics_list_events`) gives programmatic read access to counts, top issues, and stack traces, and a **dedicated git repo (`app-crash-reports`)** gives a durable, version-controlled write surface — no new server infrastructure, no Slack webhook, no BigQuery. *(Storage note: the original plan used the ClickUp MCP here; it was switched to a git repo so the archive lives where code-grounded cross-analysis already operates — git diffing is the time-series and files are greppable beside the source. ClickUp is kept as a considered alternative below.)*

**The real value is code-grounded cause reads.** Because this runs on the user's own machine with the `viaapp` repo present, Claude doesn't just relay the MCP's generic root-cause guess — it can **read the implicated source** (mapped from the crash's named error code or stack frame) and write a cause line grounded in the actual code. That is the distinction the user drew: not "fix one crash" (no suspect-commit / owner / ticket machinery — see Out of scope), but "compare the crash against the app code well enough to say *probably this*." Storing the digests in git makes that comparison repeatable: the archive sits beside the source, diffs over time, and each report is anchored to the app version it covers.

---

## Risk — much smaller, given it runs locally

The earlier concern (Crashlytics MCP returning `404` under service-account/ADC creds, firebase-tools #10004/#10310, and interactively-authenticated MCPs being absent in headless/cron runs) was about a **detached cloud sandbox**. This routine runs in the user's **own authenticated environment** — Crashlytics MCP connected, Firebase CLI logged in (interactive user OAuth), repos checked out — so those failure modes don't apply to manual runs. (They *do* re-emerge for any unattended/scheduled run, which is why scheduling needs `FIREBASE_TOKEN` — see Research Findings.)

**It collapses to a one-time sanity check:** on the first run, confirm the MCP is reachable and `crashlytics_get_report` returns data (one Crashlytics read + one throwaway file in `app-crash-reports`). Once that passes, there's no standing auth risk for manual runs.

---

## What the routine does (once per day)

1. **Pull 24h totals via the Crashlytics MCP.** `crashlytics_get_report` (`topIssues`) over the trailing 24-hour window for the prod app(s): total crash events + distinct impacted users. Also pull `topVersions` to record the covered app version(s).

2. **Split by platform.** viaapp is registered as separate iOS and Android apps in Firebase, so platform segmentation = query each app id (or filter) and report totals **overall and per platform** — iOS vs Android segmentation is a standing requirement for all analytics here, so it is not optional.

3. **Top-N issues with code-grounded likely causes.** For the top ~5 issues by affected users, call `crashlytics_get_issue` + `crashlytics_list_events` for the stack trace/sample events, then **map the issue into the local `viaapp` source** — grep the named error code (`UPLOAD_PHOTO_FAILED`, `VIDEO_TOKEN_EXPIRED_ANDROID`, etc.; these are unique strings) or follow the top app frame to its file — and **read that source** to write a one-line likely-cause line grounded in the actual code (clearly labelled as a hypothesis, not fact). This source-reading step is the whole reason it runs locally; without the repo it would only be relaying the MCP's generic guess.

   > **Clarification (from code):** the named code is logged via `crashlytics().log(...)` as a session breadcrumb on a **non-fatal** `recordError`, not as the issue title. To go *from a Crashlytics issue to its named code*, read a sample event's logs (`crashlytics_list_events`), then grep. For **fatal** crashes (which carry no named code), follow the `blamed` stack frame into source instead. See Complexity Audit.

4. **Note day-over-day change (git-native, recommended).** Read the previous day's file from `app-crash-reports` (or `git diff` the latest two report files) and add a short "vs yesterday" line — total up/down, any new issue in the top-N, any issue that dropped off. This is what turns a daily report into actual *oversight*.

5. **Write a new dated file to the `app-crash-reports` repo.** One file per day (`reports/<YYYY>/<YYYY-MM-DD>.md`). YAML frontmatter holds the machine-readable totals + `app_versions`; the body holds the top-N issue table and the vs-yesterday line. Then commit (`crash-health: <date>`) and push to the default branch. Overwrite (not duplicate) on a same-day re-run.

**Trigger:** runs on the user's own machine — **manually (a saved prompt / slash command run on demand) or on a schedule**, whichever fits. Manual is enough for v1 since the code-grounded comparison is the value, not the cron. **Always-write** when it runs: the digest is produced regardless of count. A "🔴 over-threshold" flag line can be layered on later, but is out of scope for v1.

---

## Repository structure (`app-crash-reports`)

- A single **dedicated GitLab repo `app-crash-reports`**, **one dated markdown file per day** under `reports/YYYY/YYYY-MM-DD.md`. Reads like a logbook; history is `git log`; day-over-day comparison is `git diff`.
- Each file = YAML **frontmatter** (machine-readable totals, window, `app_versions`) + markdown body (top-N table + vs-yesterday). A repo `README.md` documents the frontmatter schema so future tooling/agents can rely on it.
- Cloned as a **sibling of `viaapp`** (per the worktree-sibling convention) so the routine has both the source and the archive in one workspace, and so cross-analysis can grep reports and code side by side.
- Keep the repo **private** (crash data and grounded source references).
- Chosen over ClickUp because the primary value is an **agent cross-checking reports against the code** — git co-locates the archive with the source, makes the time-series diffable, and lets each report anchor to the app version it covers. (ClickUp considered alternative below.)

### Considered alternative — ClickUp doc (original v1 storage)
- A single "Crash Health" ClickUp Doc, one dated page per day in a chosen folder. **Pros:** human-glanceable, shareable without repo access, zero new repo. **Cons (why rejected):** the archive lives away from the code, so an agent can't grep reports beside source; no native diff/version-anchoring; requires the ClickUp MCP as a write dependency. Retained here in case human-facing shareability later outweighs code-grounded cross-analysis (e.g. a future mirror or export step).

---

## Deliberately out of scope (for now)

- **Firebase alert → Cloud Function pipeline** (the old Phase 1) — that's real-time *push* incident response; this is periodic *pull* oversight.
- **The formal investigation apparatus** (the old Phase 2): suspect-commit hunting, `git blame`, version→commit anchoring *for remediation*, owner identification, assignee setting. Reading source to *ground a cause read* (step 3 above) and recording the covered app version for *checkability* are in scope; chasing down *which commit introduced it and who owns it* is not — "fixing one individual crash is too much."
- **Ticket-per-crash, auto-assign, priority mapping.**
- **BigQuery export.** Not needed — the MCP serves 24h aggregates directly, and Crashlytics' own retention covers the lookback.
- **Slack.** Replaced by the `app-crash-reports` git repo (no webhook setup).

Each of these can be added later as a separate step; none is a prerequisite for this.

---

## Getting started

1. **One-time sanity check** (locally): confirm the Crashlytics MCP is reachable and `crashlytics_get_report` returns data — one Crashlytics read + one throwaway file in `app-crash-reports` (delete / don't commit).
2. Identify the prod Firebase **app ids** (iOS + Android) and confirm `topIssues` reports return per-app data. **Note:** these are not in the repo — the committed `google-services.json` is templated and the iOS plist points at the dev project `viaapp-1c6e4`. Use `firebase apps:list --project viaapp-prod` (prod project per `.firebaserc`).
3. **Create the `app-crash-reports` GitLab repo** (private), clone it as a sibling of `viaapp`, and add a `README.md` documenting the report frontmatter schema. Confirm both `viaapp` and `app-crash-reports` are checked out where the routine runs.
4. Author the routine prompt (saved as a slash command for manual runs, or a `/schedule` job): pull totals (+ `topVersions`) → split by platform/errorType → top-N → read implicated `viaapp` source → code-grounded cause reads → git-native vs-yesterday → write + commit + push dated file.
5. Dry-run once manually; eyeball the file against the Crashlytics dashboard for the same window to confirm the numbers line up, the cause reads point at the right files, and the `app_versions` anchor is correct.
6. (Optional) Schedule it daily once you're happy with the manual output (supply `FIREBASE_TOKEN` for unattended auth).

---

## Effort breakdown

| Work item | Estimate |
|---|---|
| One-time local sanity check (MCP reachable) + create/clone `app-crash-reports` repo | 0.25 day |
| Routine: 24h totals + per-platform/errorType split (+ `topVersions` anchor) | 0.25 day |
| Top-N issues + **source-grounded** cause reads (MCP + event-log code recovery + grep/read viaapp source) | 0.5–0.75 day |
| File write + frontmatter schema + commit/push (idempotent same-day overwrite) | 0.25 day |
| Git-native vs-yesterday diff + dry-run validation | 0.25–0.5 day |
| **Total** | **1–2 days** |

---

## Recommendation

Complexity **3** → **Send to Intern.**

This is prompt-authoring + ops setup, not coding — well within reach for a lighter-weight implementer. **Caveat:** the few things that *will* break it if missed are non-obvious, so whoever builds it must read **Research Findings** and **User Review Required** first — specifically the MCP auth configuration (interactive OAuth, `GOOGLE_CLOUD_QUOTA_PROJECT` unset, `--only crashlytics`), the explicit 24h `interval`, the issue→named-code mapping via event `logs[]`, the no-PII-in-git rule, and the `app_versions` anchor. Get those right and the rest is routine.
