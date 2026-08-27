# Remove stale setup.html startup-command references from docs and comments

## Goal

`setup.html` no longer contains startup-command input fields — they live in the Agents tab of the Agent Control panel (currently served via `kanban.html`'s `data-view="agent-control"` projection; the extraction plan `extract-agent-control-into-its-own-panel-file.md` moves it to a dedicated `agent-control.html`, and `retire-the-agent-tabs-from-kanban-html.md` removes the old projection after UAT). The "Setup panel no longer sends commands" comment at `setup.html:2100` confirms this:

```javascript
// (Setup panel no longer sends `commands`; leave lastStartupCommands untouched.)
```

And at `setup.html:2036–2040`:
```javascript
// Agent CLI commands are managed in the Terminals/Agents tab, NOT here.
// Do NOT echo `commands` back: this payload is a full REPLACE on the
// server, so re-sending a stale/empty cached map (e.g. right after a
// reinstall, before the cache hydrates) would WIPE the user's real
// startup commands. Omitting the field leaves the stored value untouched.
```

Any future plan that says "add help next to the startup-command fields in setup.html" is working from a stale premise and will place guidance where the user is not. The startup-command fields are in the Agent Control panel's Agents tab (currently rendered from `kanban.html` line 4493: `agents-tab-custom-agent-command`, line 4508: `startupCommand`; will move to `agent-control.html` per the extraction plan).

The `docs/AGENT_CLI_CONSENT_FLAGS.md` file references "Some CLIs support flags in their startup command" in the context of the setup panel — this guidance is in the right panel (`setup.html`) for trust/consent configuration, but if it implies the startup commands themselves are configured in setup.html, it is misleading.

**Root cause:** The startup-command input fields were moved from `setup.html` to the Agent Control panel's Agents tab (currently projected from `kanban.html`), but documentation and comments may still reference setup.html as the configuration location. This is a documentation/comment accuracy issue, not a functional bug.

> **Superseded:** The original plan cited `docs/AGENT_CLI_CONSENT_FLAGS.md (line 748)` as the location of the stale docs reference. Line 748 is in `src/webview/setup.html`, not the docs file — the docs file is only 156 lines long. The citation was never verified against the actual file.
> **Reason:** The line number was transcribed without opening the docs file, so the plan aimed at the wrong target and missed the real stale text.
> **Replaced with:** The actual stale reference is `docs/AGENT_CLI_CONSENT_FLAGS.md` line 86-87: *"Add the flag to the role's command in Switchboard's **Agents** tab (or the Setup panel)."* The parenthetical "(or the Setup panel)" is the stale claim — the Setup panel no longer has startup-command input fields. The fix is to correct that line directly, not merely to append a note below it.

## Metadata

**Complexity:** 2
**Tags:** docs, ui, refactor
**Project:** Browser Switchboard

## User Review Required

This plan makes documentation/comment edits only — no functional code changes. Review the exact wording of the two doc edits and the one setup.html clarification before dispatch, since user-facing text is involved. No architectural decision is pending.

## Complexity Audit

### Routine
- Audit all references to "startup command" in the context of `setup.html` across the codebase.
- Correct the stale "(or the Setup panel)" parenthetical at `docs/AGENT_CLI_CONSENT_FLAGS.md:86-87` to point solely to the Agents tab.
- Add a "Where to configure startup commands" note to `docs/AGENT_CLI_CONSENT_FLAGS.md` after the consent mechanisms table.
- Add a note in `setup.html`'s consent-flags section (line 748) clarifying that startup commands are configured in the Agents tab, not here.

### Complex / Risky
- None. This is a documentation/comment accuracy fix. No functional changes.

## Edge-Case & Dependency Audit

- **`docs/AGENT_CLI_CONSENT_FLAGS.md:86-87`** — *"Add the flag to the role's command in Switchboard's **Agents** tab (or the Setup panel)."* The parenthetical "(or the Setup panel)" is STALE — the Setup panel no longer has startup-command input fields. This is the primary stale reference and must be corrected, not merely annotated.
- **`docs/AGENT_CLI_CONSENT_FLAGS.md:31`** — *"Switchboard never rewrites your configured startup command..."* Accurate; no change needed.
- **`docs/AGENT_CLI_CONSENT_FLAGS.md:84,97`** — References to "startup-command configuration" / "the startup command is unchanged." Accurate; these describe the concept, not a configuration location in setup.html.
- **`src/webview/setup.html:748`** — The consent-flags section says "Some CLIs support flags in their startup command (e.g. Gemini `--skip-trust`)..." This is ACCURATE guidance about what flags to put in startup commands, but it does not say WHERE those startup commands are configured. It is incomplete, not stale. The fix is to append a clarifying sentence pointing to the Agents tab.
- **`src/webview/setup.html:2100`** — The comment "(Setup panel no longer sends `commands`; leave lastStartupCommands untouched.)" is accurate and should remain — it documents why the setup panel doesn't send commands.
- **`src/webview/setup.html:2036–2040`** — The comment "Agent CLI commands are managed in the Terminals/Agents tab, NOT here." is accurate and should remain.
- **`src/webview/setup.html:1254`** — Historical comment about "wiped startup commands via the old `commands` echo." Accurate; documents a past bug class. No change.
- **`src/webview/setup.html:3101`** — `case 'startupCommands'` IPC handler. This is functioning code that hydrates `lastStartupCommands` for display; the setup panel receives but never echoes/sends commands. Accurate; no change.
- **`src/webview/kanban.html:4493`** — The Agents tab's custom agent form has `agents-tab-custom-agent-command` — this is where startup commands are configured. Currently rendered via `kanban.html`'s `data-view="agent-control"` projection; will move to `agent-control.html` per the extraction plan. Confirmed.
- **`src/webview/kanban.html:4508`** — `startupCommand` read from the form field. Confirmed.
- **`src/webview/kanban.html:5640`** — Comment notes "jules is visibility-only (no startup-command input in the AGENTS tab, absent from DEFAULT_ROLE_CONFIG...)" — accurate. The "AGENTS tab" here refers to the Agent Control panel's Agents tab, not a kanban board tab.
- **`docs/IPC_PROTOCOL.md:459,502`** — Describes the `startupCommands` IPC message. Accurate (the message still exists, handled at setup.html:3101). No change.
- **`docs/TECHNICAL_DOC.md:46`** — "resets `state.json` baseline (preserving `startupCommands`)." Accurate. No change.

## Dependencies

None blocking. This plan has no upstream or downstream plan dependencies — it is a self-contained documentation accuracy fix. However, the terminology it introduces ("Agent Control panel") is aligned with two related plans:
- `extract-agent-control-into-its-own-panel-file.md` — extracts the Agents/Teams/Prompts tabs from `kanban.html` into a dedicated `agent-control.html` file.
- `retire-the-agent-tabs-from-kanban-html.md` — removes the old projection from `kanban.html` after a week of clean UAT.

Using "Agent Control panel" in the docs now is forward-compatible: it is accurate today (the `/agent-control` route and panel identity already exist) and stays accurate through both transitions.

## Adversarial Synthesis

Key risks: (1) the original plan's grep-only verification would pass while the real stale phrase "(or the Setup panel)" remained, because the grep pattern doesn't match that phrasing; (2) appending a clarifying note while leaving the contradictory stale text in place produces two opposing sentences in the same file. Mitigations: correct the stale line 86-87 directly (remove the parenthetical), and add a direct string-absence assertion to the verification plan alongside the grep sweep.

## Proposed Changes

### 1. `docs/AGENT_CLI_CONSENT_FLAGS.md` — correct the stale configuration-location reference (line 86-87)

**Context:** Line 86-87 currently reads:
```
Add the flag to the role's command in Switchboard's **Agents** tab (or the Setup
panel). This is the only mechanism that lives in the startup command.
```
The parenthetical "(or the Setup panel)" is stale — the Setup panel no longer contains startup-command input fields.

**Logic:** Remove the stale parenthetical so the docs name exactly one configuration location.

**Implementation:** Replace line 86-87 with:
```markdown
Add the flag to the role's command in Switchboard's **Agents** tab (in the Agent
Control panel). This is the only mechanism that lives in the startup command.
```

**Edge Cases:** None — this narrows a stale disjunction to the single correct location. No functional code is touched. The Agent Control panel (`/agent-control`) already exists as a registered panel with its own route, icon, and label; the extraction plan (`extract-agent-control-into-its-own-panel-file.md`) moves its HTML into a dedicated file, and the retirement plan (`retire-the-agent-tabs-from-kanban-html.md`) removes the old projection from `kanban.html` after UAT. Referencing "the Agent Control panel" is accurate now and stays accurate through both transitions.

### 2. `docs/AGENT_CLI_CONSENT_FLAGS.md` — add a "Where to configure" note after the consent mechanisms table

**Context:** After the table (which ends around line 78, before the "Configuration Instructions by Mechanism Type" heading at line 82), add an explicit pointer so readers who skim the table know where to act.

**Logic:** A single blockquote note, placed immediately after the table's closing prose (after line 78, before the `---` separator at line 80).

**Implementation:**
```markdown
> **Where to configure startup commands:** Agent CLI startup commands (including
> trust flags like `--skip-trust`) are configured in the **Agents tab** of the
> Switchboard Agent Control panel, not in the Setup panel. The Setup panel's
> consent-flags section provides guidance only — it does not contain
> startup-command input fields.
```

**Edge Cases:** Place the note after the table's closing paragraph ("The one human action still beats every mechanism...") and before the `---` separator, so it sits with the table context, not under the "Configuration Instructions" heading where it would duplicate edit #1.

### 3. `src/webview/setup.html` — clarify consent-flags section (line 748)

**Context:** Line 748 gives accurate guidance about what flags to put in startup commands but never says where those commands are configured. A user reading this section may believe the configuration lives here.

**Logic:** Append one sentence to the existing consent-flags `<div>` (line 747-751) pointing to the Agents tab. Do not remove or alter the existing accurate guidance.

**Implementation:** Update the consent-flags guidance block at line 747-751 to:
```html
<div style="font-size: 10px; color: var(--text-secondary); line-height: 1.4; margin-top: 4px; padding: 8px; background: var(--panel-bg2); border: 1px solid var(--border-color); border-radius: 4px;">
    Configure workspace trust pre-consent for your agent CLIs so prompt dispatch never stalls on an unseen modal gate. Some CLIs support flags in their startup command (e.g. Gemini <code style="font-size:10px;">--skip-trust</code>), while others (Copilot, Claude, Antigravity) require pre-populating <code style="font-size:10px;">trustedDirectories</code> in their configuration file. Startup commands are configured in the <strong>Agents tab</strong> of the Agent Control panel, not here.
    <br><br>
    See <code style="font-size:10px;">docs/AGENT_CLI_CONSENT_FLAGS.md</code> in this repository for the per-CLI mechanisms, config-file paths, how far each one has actually been verified, and the trust-vs-permission distinction.
</div>
```

**Edge Cases:** The only added text is the single sentence "Startup commands are configured in the **Agents tab** of the Agent Control panel, not here." — appended to the first paragraph, before the `<br><br>`. All existing text is preserved verbatim.

### 4. Audit all other references (sweep, no expected edits)

Search for any other references that imply startup commands are configured in setup.html:

```bash
grep -rn 'startup.command.*setup\|setup.*startup.command\|Setup panel.*startup\|startup.*Setup panel' src/ docs/
```

As of this audit, all other matches (IPC_PROTOCOL.md, TECHNICAL_DOC.md, setup.html comments at 1254/2040/3101) are accurate functioning code/docs and require no change. The sweep is a guard against future drift, not an expected source of edits.

## Verification Plan

### Automated Tests
- Run `npm run mirror:check` — assert no drift (if the docs file is not mirrored, this is a no-op).
- Run the full contract suite — assert no regressions from the documentation changes.

### Goal Invariants
- Assert the string "(or the Setup panel)" is **absent** from `docs/AGENT_CLI_CONSENT_FLAGS.md` (negative — the stale claim is gone).
- Assert the string "Agent Control panel" is **present** in `docs/AGENT_CLI_CONSENT_FLAGS.md` (positive — the correct panel is named).
- Assert the string "Agent Control panel" is **present** in `src/webview/setup.html` (positive — the setup panel now points to the Agent Control panel).
- Assert the string "(or the Setup panel)" is **absent** from `src/webview/setup.html` line 748's consent-flags block (negative — no stale parenthetical introduced).
- Assert the string "Kanban panel" is **absent** from the edited sections of both files (negative — no stale panel name introduced; the Agents tab is in the Agent Control panel, not the Kanban panel).
- Run `grep -rn 'Setup panel.*startup.command\|startup.command.*Setup panel' src/ docs/` — assert no stale references remain that pair "Setup panel" with "startup command" as a configuration location.

## Outstanding Questions

- **[user]** The corrected docs line 86-87 reads "Switchboard's **Agents** tab (in the Agent Control panel)" — confirm the parenthetical "(in the Agent Control panel)" is desired, or whether the bare "Switchboard's **Agents** tab" is clearer. Proceeding on the assumption that the parenthetical aids readers who don't know where the Agents tab lives. The panel name "Agent Control" matches the registered panel label and route (`/agent-control`); the extraction plan (`extract-agent-control-into-its-own-panel-file.md`) will make it a dedicated file, and the retirement plan (`retire-the-agent-tabs-from-kanban-html.md`) removes the old `kanban.html` projection after UAT — so "Agent Control panel" is the stable name through all transitions.
