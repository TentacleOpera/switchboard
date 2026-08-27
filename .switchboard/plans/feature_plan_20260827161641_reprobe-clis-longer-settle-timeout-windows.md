# Re-probe CLIs with longer settle and timeout windows to verify consent table measurements

## Goal

The consent probe (`scripts/probe-cli-consent.js`) measured droid as CLEAR and grok/devin as NO_PROMPT_NO_ECHO under an 18s probe window (default `--settle 2500 --timeout 15000`). This contradicts the 2026-08-23 measurement that recorded droid at `> Login / Exit`. The probe window may be shorter than these CLIs' first render — droid may render its login prompt after 18s, and grok/devin may echo input after a longer settle period.

If the probe window is too short, every short-window row in the consent table (`docs/AGENT_CLI_CONSENT_FLAGS.md`) is unreliable. The table's droid row (line 71) says "Baseline CLEAR (echoed). The `> Login / Exit` gate seen on 2026-08-23 did not appear within the probe window; it may render later than 18s." The grok row (line 73) says "Baseline NO_PROMPT_NO_ECHO — matches the 2026-08-23 'rendered blank' observation." The devin row (line 72) says "Baseline NO_PROMPT_NO_ECHO — no gate detected, but readiness was not proven."

**Root cause:** The default probe window (`--settle 2500 --timeout 15000`) may be too short for CLIs that have slow first renders. Droid's login prompt may appear after 18s, and grok/devin may need more than 2500ms to settle before typed input can echo. The fix is to re-probe with `--settle 6000 --timeout 40000` to give the CLIs enough time to render and accept input.

## Metadata

**Complexity:** 2
**Tags:** cli, test, docs
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Re-probe droid, grok, and devin with `--settle 6000 --timeout 40000`.
- Update the consent table rows with the new measurements.
- If the new measurements differ from the old ones, update the docs to reflect the longer-window results.

**Complex/Risky:**
- None. This is a measurement + documentation update. The probe script already supports `--settle` and `--timeout` flags. The only risk is that the longer window doesn't change the results (the CLIs are genuinely CLEAR/NO_PROMPT_NO_ECHO), in which case the docs are confirmed as-is.

## Edge-Case & Dependency Audit

- **`scripts/probe-cli-consent.js`:** The `--settle` flag (line 101–102) controls how long the probe waits before typing, even if nothing renders. The `--timeout` flag (line 97–98) controls the max run duration. Both are in milliseconds.
- **`docs/AGENT_CLI_CONSENT_FLAGS.md`:** The table rows for droid (line 71), devin (line 72), and grok (line 73) need updating with the new probe results.
- **Probe window reliability:** If the longer window changes the results, other rows in the table may also need re-probing with the longer window to ensure consistency. The gemini and copilot rows were measured with the default window and may also benefit from a longer window.
- **Sibling detection plan:** The echo-detection signal (Issue 11) is the same signal used here. If the probe is upgraded to use echo detection as the primary signal, the re-probe should use the upgraded probe.

## Proposed Changes

### 1. Re-probe droid, grok, and devin with longer windows

```bash
# Droid — was CLEAR under 18s, may show Login/Exit with longer window
node scripts/probe-cli-consent.js droid --settle 6000 --timeout 40000

# Grok — was NO_PROMPT_NO_ECHO, may echo with longer settle
node scripts/probe-cli-consent.js grok --settle 6000 --timeout 40000

# Devin — was NO_PROMPT_NO_ECHO, may echo with longer settle
node scripts/probe-cli-consent.js devin --settle 6000 --timeout 40000
```

### 2. Update `docs/AGENT_CLI_CONSENT_FLAGS.md` with new measurements

For each CLI, update the "Probe status" column with the longer-window result:

- **Droid:** If the longer window shows `> Login / Exit`, update the row to reflect that droid blocks on a login prompt that renders after 18s. If it remains CLEAR, confirm the row as-is and note the longer-window verification.
- **Grok:** If the longer window shows CLEAR (input echoes), update the row from NO_PROMPT_NO_ECHO to CLEAR. If it remains NO_PROMPT_NO_ECHO, confirm the row and note the longer-window verification.
- **Devin:** Same as grok.

### 3. Consider re-probing all CLIs with the longer window for consistency

If any of the three CLIs change verdict under the longer window, re-probe all CLIs in the table with `--settle 6000 --timeout 40000` to ensure the table is consistent.

## Verification Plan

1. Run the three probes with `--settle 6000 --timeout 40000` — capture the verdicts.
2. Compare the new verdicts to the old ones in the docs table.
3. Update the docs table rows for any CLI whose verdict changed.
4. If all three verdicts are unchanged, add a note to each row: "Verified with `--settle 6000 --timeout 40000` — no change from default-window measurement."
5. Run `npm run mirror:check` — assert no drift (docs file is not mirrored).
