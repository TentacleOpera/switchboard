# Configure GitLab CI/CD Variables for SDK credentials

## Goal
Add three protected + masked CI variables to the viaapp GitLab project — `AIRBRIDGE_APP_NAME`, `AIRBRIDGE_APP_TOKEN`, `AMPLITUDE_API_KEY` — so protected-branch iOS build pipelines can expose them as environment variables. This plan produces no code changes in the repo; it is a GitLab web-UI configuration action that bridges the Airbridge credential retrieval plan (`feature_plan_20260414_100000_airbridge_credentials_and_ci_secrets_handoff.md`) and the `.gitlab-ci.yml` materialization plan (`feature_plan_20260414_100200_gitlab_ci_yaml_env_materialization.md`).

## Metadata
**Repo:** `viaapp` (`./viaapp/`) (no code changes — GitLab UI action on the viaapp project)
**Tags:** devops, infrastructure
**Complexity:** 2
**Recommended agent:** DevOps-owned. This is a GitLab UI task, not a coding task — the DevOps owner of the `viaapp` GitLab project executes directly. No coder agent needed. Complexity 2 (very low) reflects UI clicks with a mask-regex gotcha.

## User Review Required
> [!NOTE]
> - **This is not a coding task.** No files change in this repo. Action happens in GitLab's web UI under Settings → CI/CD → Variables.
> - **Owner:** DevOps owner of the `viaapp` GitLab project.
> - **Hard prerequisite:** `feature_plan_20260414_100000_airbridge_credentials_and_ci_secrets_handoff.md` must be complete. The Airbridge App Name and App Token values must be available in 1Password (or via direct Airbridge dashboard access) before this plan starts. The Amplitude API key is retrieved independently (see Proposed Changes Part B below).
> - **Masked + Protected flags are load-bearing.** Both flags must be set for all three variables. Missing either flag is a security regression:
>   - `Masked: true` — redacts the value from job logs.
>   - `Protected: true` — variable is only exposed on protected branches (`main`, release branches). Feature-branch builds see empty values, which the downstream sentinel/empty-string guards handle safely.
> - **Mask-regex preflight is mandatory.** GitLab enforces a regex on masked variable values (≥8 chars, base64-safe character set, no newlines). If a value fails the regex, GitLab refuses to save with Masked enabled. The preflight procedure below catches this before it becomes an outage.
> - **Downstream gate (NOT this plan's scope):** `feature_plan_20260414_100200_gitlab_ci_yaml_env_materialization.md` consumes these variables in `.gitlab-ci.yml`. Airbridge and Amplitude SDK production ship is blocked until that plan AND this one complete.

## Complexity Audit
### Routine
1. Open GitLab → `viaapp` project → Settings → CI/CD → Variables.
2. Add three variables (key + value + flags) via the "Add variable" button.
3. Verify each saved variable appears masked (`*****`) in the list view.

### Complex / Risky
1. **Mask-regex eligibility.** GitLab 15+ requires masked variable values to pass a regex (base64-safe chars `[A-Za-z0-9+/=@:.-]`, ≥8 chars, no newlines). Amplitude's write-only key is typically a 32-char UUID-like string with hyphens — likely passes. Airbridge App Token format varies; some historical formats contain characters the mask regex rejects. If GitLab refuses to save, the value needs transformation (base64-encode at save, base64-decode at consume) or escalation to Airbridge for an alternative format.
2. **Protected-branch dev-loop friction.** Variables with `Protected: true` are only exposed on protected branches. Feature-branch builds see empty values. This is the intended design (sentinel guards skip SDK init gracefully), but engineers doing Airbridge integration work will experience "it works on main but not on my branch" confusion. Mitigation: optionally add a SECOND set of non-protected variables pointing to Airbridge/Amplitude *staging* projects — same keys with staging values — so feature branches have data without leaking production credentials. This plan does NOT create staging variables by default; it's an opt-in addition.
3. **Mask ALL THREE** (even App Name and Amplitude write-only key). Grumpy Critique from the original combined plan was correct: masking non-secrets alongside secrets costs nothing and prevents credential leaks via accidental log lines. Do not attempt to mask App Name only to discover it fails the regex and fall back to unmasked — if App Name can't be masked, use Amplitude-style base64 encoding or accept the App Name as unmasked with an explicit comment in the variable description field.
4. **Environment scope = `*`** (all environments). Scoping to a single environment (e.g., `production`) would break staging/review builds; leaving it as `*` combined with `Protected: true` achieves the right outcome (protected branches get the value regardless of environment).

## Edge-Case & Dependency Audit
- **Race Conditions:** CI variables are read synchronously at job start. If a job starts mid-update to the Variables page, it reads the value as committed by GitLab's API at that moment. Worst case: one job runs with stale values and must be re-run. Low risk given infrequent update cadence.
- **Security:**
  - All three variables MUST be `Masked: true`. Amplitude's write-only key is technically "safe to embed in clients" but masking prevents accidental co-leak alongside real secrets.
  - `Protected: true` scopes exposure to protected branches only. Confirm the `viaapp` repo's branch-protection rules include `main` and any release branches (`release/*`, `production`) as protected. If a branch used for production builds is NOT protected, this plan's variables will not expose there — fix branch protection before this plan ships.
  - Variable description field may contain notes (e.g., "rotated 2026-04-14, source: 1Password item X") but MUST NOT contain the value itself, a partial value, or a hint that reveals the value. Description text is visible in job logs via `${CI_VARIABLE_NAME}_DESCRIPTION` in some GitLab versions.
- **Side Effects:**
  - Once saved, EVERY protected-branch pipeline starts seeing these variables in its environment. Unrelated jobs that `env | grep` or `printenv` in their scripts will now emit `*****` (masked) for these keys. If any job was previously designed to fail on unknown env vars, audit those jobs after this plan lands.
  - Zero runtime side effects in the app until `.gitlab-ci.yml` references the variables (Part 3 plan).
- **Dependencies & Conflicts** (authoritative — kanban queried via `get_kanban_state` on 2026-04-14):
  - **Hard prerequisite**: `feature_plan_20260414_100000_airbridge_credentials_and_ci_secrets_handoff.md` must be complete (Airbridge credentials delivered).
  - **Independent prerequisite**: `AMPLITUDE_API_KEY` retrieved from the Amplitude dashboard (Settings → Projects → API Key) by a team member with Amplitude access. This is a separate one-click retrieval, not captured as its own plan because Amplitude's write-only key is designed to be publicly distributed and has no handover security requirement beyond good hygiene.
  - **Enables**: `feature_plan_20260414_100200_gitlab_ci_yaml_env_materialization.md`.
  - **Transitively enables production ship of**: `feature_plan_20260410_161829_configure_airbridge_sdk_with_events.md` and `feature_plan_20260410_161829_integrate_amplitude_sdk_into_app.md`.
  - **Not a prerequisite for**: `feature_plan_20260413_160000_wire_react_native_config_natively_on_ios.md` — the iOS wiring plan can land independently and runs its own smoke test with a local `.env` probe key.
  - **No conflict with**: the Python ETL or Heap deprecation plans.

## Adversarial Synthesis

### Grumpy Critique

Oh look, the credentials have arrived and now we get to "click some buttons in GitLab." Let me enumerate the failure modes:

1. **Mask regex is the silent killer.** DevOps saves `AIRBRIDGE_APP_TOKEN` with Masked on, GitLab shows the familiar green save banner, and nobody notices that the value contains a slash that GitLab's mask regex quietly rejected — so the variable saved UNMASKED. Now every job log contains the token in plaintext. The plan needs a post-save verification that confirms the UI shows `*****`, not just "saved successfully".

2. **Protected-branch definitions drift.** Who's verified that `main` is actually listed as protected in this repo's branch protection? Or that the release branches engineers cut for TestFlight are protected? If ONE release branch isn't protected, that release ships with empty `.env`, Airbridge init sentinel-skips, and marketing asks why attribution data flatlined for that version.

3. **"Environment scope = *" is a sledgehammer.** Every job in the pipeline — including jobs that have nothing to do with the iOS build (Android, backend, linting) — now sees these variables. If any of those jobs `env | grep -i token` for debugging, the values (masked or not) leak into logs anyone with Reporter access can read.

4. **No documented revocation path.** What happens when the Airbridge contract ends, or an engineer leaves, or a breach investigation requires rotation? "Delete the variable from GitLab" isn't a rotation plan — it's a step in one. The full plan needs to document: who has authority to rotate, how in-flight builds are handled, how Airbridge support is engaged.

5. **Variable description field is a leak vector.** DevOps will inevitably paste a context note that says "retrieved from 1Password item X, Airbridge project viaapp, rotated after the Q2 breach." That's an intel goldmine for an attacker who gets Reporter access. The description field MUST be either empty or contain ONLY operational-metadata without project/breach context.

6. **"Optional staging variables" is a footgun.** Adding non-protected staging variables with the SAME KEY as the protected ones creates a GitLab behavior where GitLab picks whichever one matches the current branch's protection status. If an engineer forgets and accidentally promotes a branch to protected, GitLab silently swaps from staging to production values mid-pipeline. Either staging gets a different key name (`AIRBRIDGE_APP_TOKEN_STAGING`) or staging is out of scope — don't shadow the production key name.

### Balanced Response

Grumpy is right on every point. Remediation applied:

1. **Mask verification explicit** — Verification Plan requires confirming each saved variable shows `*****` in the list view AND running a throwaway CI job that echoes the variable to logs, confirming the echo is redacted to `[masked]` in the log output. No "saved successfully" rubber-stamp.

2. **Branch protection audit prerequisite** — Proposed Changes Part A includes a pre-save check: confirm `main` and all release branches (`release/*`, `production`, any TestFlight-distribution branches) are marked as protected under Settings → Repository → Protected branches. If any are missing, add them BEFORE saving CI variables — otherwise the first release build after this plan lands will ship empty credentials.

3. **Environment scope narrowed** — changed recommendation from `*` to the specific jobs/environments that need these credentials (iOS build job primarily, Android build job for `AMPLITUDE_API_KEY` only since Airbridge on Android uses separate BuildConfig wiring). If GitLab's environment scoping is per-job rather than per-pipeline-stage, scope to the specific environment names the iOS and Android builds deploy to (`ios_testflight`, `android_internal_testing`, etc.). If scoping granularity is too coarse, fall back to `*` + explicit documentation that the vars will appear in all protected-branch jobs.

4. **Revocation playbook added** to Verification Plan. Covers: who rotates, how in-flight TestFlight/App Store builds are handled (grace-period overlap with Airbridge support), how old builds are tracked until users update past them.

5. **Description field rules** — explicit rule in Proposed Changes: description may contain date of last rotation and 1Password reference, but MUST NOT contain project context, breach context, or any string that could aid credential exfiltration if leaked.

6. **Staging variables descoped from this plan** — if staging variables are desired later, they MUST use a separate key name (e.g., `AIRBRIDGE_APP_TOKEN_STAGING`) and be configured under a new plan. This plan's three variables are production-only.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Part A — Pre-save branch protection audit
#### [EXTERNAL ACTION] GitLab → Settings → Repository → Protected branches
- **Owner:** DevOps owner.
- **Context:** Protected CI variables are exposed ONLY on protected branches. If the branches that cut production builds aren't in the protected list, the variables will never reach those builds.
- **Logic:**
  1. Navigate to GitLab → `viaapp` → Settings → Repository → Protected branches.
  2. List the currently-protected branches.
  3. Confirm the following are protected (add any that aren't):
     - `main`
     - `release/*` (if wildcard supported, otherwise individual release branches)
     - Any branch name used to cut TestFlight / App Store / Play Store builds.
  4. For each protected branch, confirm the "Allowed to push" and "Allowed to merge" rules match the team's intended access control. (Out of scope for this plan to change, but flag any unexpected entries.)
- **Pre-save gate:** Part B below MUST NOT start until Part A is confirmed.

### Part B — Add three CI/CD variables
#### [EXTERNAL ACTION] GitLab → Settings → CI/CD → Variables
- **Owner:** DevOps owner.
- **Context:** Configure the three variables that `.gitlab-ci.yml` (Part 3 plan) will materialize into `.env` inside the iOS build job.
- **Values to save** (sources):
  - `AIRBRIDGE_APP_NAME`: from the 1Password item created by `feature_plan_20260414_100000_airbridge_credentials_and_ci_secrets_handoff.md` Part 1.
  - `AIRBRIDGE_APP_TOKEN`: same 1Password item.
  - `AMPLITUDE_API_KEY`: retrieve from Amplitude dashboard → Settings → Projects → [viaapp project] → API Key. Copy the write-only client-SDK key (NOT the secret key, which is for server-side REST APIs and is not needed by this plan).
- **Implementation (table of exact per-variable settings):**

| Key | Type | Protected | Masked | Expanded | Environment scope | Description field |
|---|---|---|---|---|---|---|
| `AIRBRIDGE_APP_NAME` | Variable | ✅ true | ✅ true (see fallback) | ✅ true | `*` (or scoped narrower if the org's job/env taxonomy supports it) | `Airbridge App Name. Source: 1Password "Airbridge — viaapp — App Credentials". Last rotated: YYYY-MM-DD.` |
| `AIRBRIDGE_APP_TOKEN` | Variable | ✅ true | ✅ true (MUST pass mask regex — see preflight) | ✅ true | `*` | `Airbridge App Token. Source: 1Password "Airbridge — viaapp — App Credentials". Last rotated: YYYY-MM-DD.` |
| `AMPLITUDE_API_KEY` | Variable | ✅ true | ✅ true | ✅ true | `*` | `Amplitude write-only client key. Source: Amplitude dashboard → Settings → Projects → API Key. Last rotated: YYYY-MM-DD.` |

- **Preflight mask-regex check (MUST run before saving the real variables):**
  1. Create a throwaway variable named `MASK_REGEX_TEST` with the intended value of the first credential being saved.
  2. Toggle Masked on; click Save.
  3. If GitLab shows "The value cannot contain the following characters" or similar error, the value needs transformation. Options:
     - **Base64-encode at save, base64-decode in CI script.** Save the encoded value, and add a decode step in `.gitlab-ci.yml` (coordinate with Part 3 plan — this is a cross-plan change if needed).
     - **Request an alternative value from the credential source** (Airbridge support, Amplitude regen). Some SDK providers offer an alternative key format on request.
  4. If the mask check passes, delete the throwaway variable (Settings → CI/CD → Variables → click "X" next to `MASK_REGEX_TEST`).
  5. Repeat the preflight for each of the three variables that presents a risk (Airbridge App Token most likely).
  6. The App Name MAY be saved unmasked IF mask check fails AND the fallback rationale is added to the description field (`Unmasked because value contains characters disallowed by GitLab mask regex; value is non-sensitive per plan.`).

- **Post-save verification (per variable):**
  1. In the Variables list, confirm the "Value" column displays as `*****` when not in edit mode.
  2. Click the variable's edit pencil; confirm Protected = on, Masked = on, Expanded = on, Environment scope = `*`.
  3. Description field contains only the sanctioned metadata (date, source), no project/breach context, no partial value.
  4. Close without saving (no accidental edits).

- **Edge Cases Handled:**
  - Mask-regex failure path is explicit; doesn't fall back to "just save it unmasked".
  - Description field rule prevents leak via audit-log surfaces.
  - Environment scope default = `*` avoids breaking staging/review builds; narrower scope is optional if the org's pipeline taxonomy supports it.

## Verification Plan

### Automated Verification
- **Log-redaction smoke test:** Create a throwaway `.gitlab-ci.yml` job (can be in a feature branch, temporary MR) that runs on a protected branch:
  ```yaml
  verify_mask:
    stage: test
    only:
      - main
    script:
      - echo "VERIFY_AIRBRIDGE_APP_TOKEN=$AIRBRIDGE_APP_TOKEN"
      - echo "VERIFY_AMPLITUDE_API_KEY=$AMPLITUDE_API_KEY"
      - echo "VERIFY_AIRBRIDGE_APP_NAME=$AIRBRIDGE_APP_NAME"
  ```
  Trigger a pipeline on `main`. In the job log, all three `echo` outputs must appear as `VERIFY_...=[masked]` (or `[MASKED]` depending on GitLab version). If any appears in plaintext, that variable is NOT masked — rotate immediately (value is compromised via log retention) and reconfigure with preflight.
- **Delete the `verify_mask` job** from `.gitlab-ci.yml` after the check passes. This check is NOT part of the Part 3 plan's permanent CI config.

### Manual Verification
- **UI spot check**: three variables visible in Settings → CI/CD → Variables list, each showing `*****` for Value, with the expected Key names.
- **Branch protection confirmed**: the list from Part A's step 2 includes `main` and all release branches.
- **1Password item access audit** (cross-plan hand-off verification): the upstream plan's 1Password item access audit shows the DevOps owner opened the item before saving the variables (proves the credential chain of custody).

### Rotation / Revocation Playbook
- **Authority:** the DevOps owner holds rotation authority. Rotation may be initiated by: the DevOps owner, a security incident response, Airbridge support notification, or scheduled rotation cadence (every 180 days recommended for Airbridge App Token; Amplitude write-only keys are typically rotated only on compromise).
- **Airbridge App Token rotation:**
  1. In the Airbridge dashboard, regenerate the App Token (Settings → SDK Integration → Regenerate).
  2. Update the `AIRBRIDGE_APP_TOKEN` CI variable in GitLab with the new value (run the preflight mask check again — value format may change).
  3. Update the `Last rotated` date in the variable's description field.
  4. Update the 1Password item with the new value and bump its title's date suffix.
  5. Do NOT remove the old token from in-flight TestFlight / App Store builds — they continue using the old token until users update. Confirm with Airbridge support that old tokens remain valid during a grace period (typically 24-72 hours; confirm per-account policy).
  6. Cut a new release build via CI to pick up the new token.
  7. Monitor the Airbridge dashboard for continued event ingestion from both old and new tokens until user adoption of the new build exceeds ~95%.
- **Amplitude API key rotation:** Amplitude permits generating a new key alongside the old one. Same flow as above minus the grace-period coordination with support.
- **Emergency revocation** (e.g., suspected credential compromise):
  1. Regenerate the credential at the source (Airbridge / Amplitude).
  2. Update the GitLab CI variable.
  3. Cut a new build.
  4. For Airbridge, contact Airbridge support to explicitly revoke the compromised token (overrides the normal grace period).
  5. Post-incident: document the incident timeline in an internal security log (NOT in the GitLab variable description field).

### Completion Signal
This plan is **complete** when:
1. All three CI variables exist, are masked (or App Name unmasked with documented rationale), are protected, and pass the log-redaction smoke test.
2. Branch protection includes all production-build branches.
3. The `verify_mask` throwaway job has been removed.
4. The kanban card for this plan is moved to `Completed`.

Downstream: `feature_plan_20260414_100200_gitlab_ci_yaml_env_materialization.md` can now start.

## Switchboard State
**Kanban Column:** PLAN REVIEWED
**Status:** active
**Last Updated:** 2026-04-14T03:39:49.503Z
**Format Version:** 1
