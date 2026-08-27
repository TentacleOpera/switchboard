# Add caveats to trustedDirectories docs for unconfirmed CLI trust mechanisms

## Goal

The `trustedDirectories` trust mechanism documented for copilot, claude, and agy in `docs/AGENT_CLI_CONSENT_FLAGS.md` is NOT confirmed. A 2026-08-27 probe run showed all three still blocking with the config pre-populated. The probe sandboxes `HOME`, so these may be auth gates behind a cleared trust gate rather than failed mechanisms — but the docs cannot recommend them without a caveat until they are re-probed on a signed-in machine.

The docs table (line 67–69) already marks these as **NOT CONFIRMED**, but the document's headline (line 49–51) says "only one mechanism in this table has been positively confirmed to remove its gate — gemini's `--skip-trust`. The `trustedDirectories` rows are research-sourced and not confirmed by probe." This is accurate but may not be prominent enough — operators reading just the table row may miss the caveat.

**Root cause:** The probe (`scripts/probe-cli-consent.js`) sandboxes `HOME` to a fresh temporary directory, which means the CLI is unauthenticated. A `PROMPT_BLOCKED` result under the probe does not prove the trust mechanism failed — it may mean the trust gate cleared and an auth gate appeared behind it. The docs need to explicitly recommend re-probing on a signed-in machine before relying on `trustedDirectories` for copilot, claude, or agy.

## Metadata

**Complexity:** 2
**Tags:** docs, cli
**Project:** Browser Switchboard

## Complexity Audit

**Routine:**
- Add a prominent caveat to the `trustedDirectories` rows in the consent table.
- Add a re-probe instruction for operators who want to verify on their own signed-in machine.

**Complex/Risky:**
- None. This is a documentation-only change. The probe results and table content are already accurate — the fix is making the caveat more prominent and actionable.

## Edge-Case & Dependency Audit

- **`docs/AGENT_CLI_CONSENT_FLAGS.md`:** The document is the canonical reference for CLI trust mechanisms. It is linked from `setup.html` (line 750). Changes to the doc should be reflected in any setup panel guidance.
- **`scripts/probe-cli-consent.js`:** The probe script is the measurement tool. Its `--keep-env` flag allows retaining auth env vars (line 106), which could be used for a signed-in re-probe. The docs should reference this.
- **Probe status column:** The table already has a "Probe status" column with **NOT CONFIRMED** for the three CLIs. The caveat should be added as a footnote or inline emphasis, not by changing the column value.

## Proposed Changes

### 1. `docs/AGENT_CLI_CONSENT_FLAGS.md` — add prominent caveat to trustedDirectories rows

Add a footnote marker after each **NOT CONFIRMED** entry for copilot, claude, and agy, and add a footnote section:

```markdown
| **GitHub Copilot** (`copilot`) | ... | **NOT CONFIRMED.**¹ With `trustedDirectories` pre-populated the probe still landed on the same blocking menu... | ... |
| **Claude Code** (`claude`) | ... | **NOT CONFIRMED.**¹ `trustedDirectories` did not produce a typeable seat... | ... |
| **Antigravity** (`agy`) | ... | **NOT CONFIRMED.**¹ Still blocked with the config pre-populated... | ... |

---

¹ **Re-probe needed on a signed-in machine.** The probe sandboxes `HOME`, so these
results may show an auth gate behind a cleared trust gate, not a failed trust mechanism.
Before relying on `trustedDirectories` for copilot, claude, or agy, re-probe with:

```bash
# On a machine signed in to the CLI, with the real HOME:
node scripts/probe-cli-consent.js <cli> --config-type <cli> --keep-env <auth-env-vars>
```

If the probe shows CLEAR (no prompt, typed input echoed), the mechanism is confirmed.
```

### 2. Add a "How to re-probe" section

After the consent table, add:

```markdown
## Re-probing on a signed-in machine

The probe sandboxes `HOME` to guarantee an untrusted baseline. To test whether
`trustedDirectories` actually clears the trust gate on a signed-in machine:

1. Sign in to the CLI in your real `HOME` (complete first-run setup if needed).
2. Run the probe with `--keep-env` to retain auth env vars:

   ```bash
   node scripts/probe-cli-consent.js copilot --config-type copilot --keep-env COPILOT_TOKEN
   node scripts/probe-cli-consent.js claude --config-type claude --keep-env CLAUDE_API_KEY
   node scripts/probe-cli-consent.js agy --config-type agy --keep-env GEMINI_API_KEY
   ```

3. If the verdict is `CLEAR`, the mechanism is confirmed for that CLI + auth combination.
4. Update this document's table row from **NOT CONFIRMED** to **CONFIRMED**.
```

## Verification Plan

1. Read `docs/AGENT_CLI_CONSENT_FLAGS.md` — assert the caveat is prominent and the re-probe instructions are clear.
2. Verify the footnote markers match the table rows.
3. Verify the `--keep-env` flag names match the `TRUST_ENV_LEAKS` list in `scripts/probe-cli-consent.js` (line 172–177).
4. Run `npm run mirror:check` — assert no drift (the docs file is not mirrored, so this should be unaffected).
