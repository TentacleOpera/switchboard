# Agent CLI Workspace Trust & Consent Configuration

Agent CLIs put modal surfaces in front of the input box — folder-trust menus, ToS
consent, auth pickers, first-run setup. Switchboard's delivery path writes a
payload into whatever is on screen and presses Enter, and it cannot see which of
those it is talking to. This document records the mechanisms that pre-answer
those gates at spawn, **and how far each one has actually been verified.**

**Status of this document: measured 2026-08-27 with `scripts/probe-cli-consent.js`.**
Re-run the probe before trusting any row — third-party CLI flags go stale.

---

## 🚨 Security Policy: Trust vs Permission Distinction

Pre-consenting to workspace trust and granting unrestricted tool execution
permissions are **fundamentally different security decisions**:

### 1. Workspace Trust (Recommended Default)
- **What it answers:** *"Is this local workspace directory safe for the CLI to inspect and operate in?"*
- **Mechanism:** CLI flags (e.g. `--skip-trust`) or pre-populating directory paths in the CLI's configuration file (e.g. `trustedDirectories`).
- **Effect:** Suppresses spawn-time modal prompts that block non-interactive execution and prevent automated prompt dispatch.
- **Safety profile:** Safe for trusted local repositories and designated development directories.

### 2. Tool & Execution Permissions (User Discretion)
- **What it answers:** *"May the agent run shell commands, edit files, or execute tools without asking for confirmation?"*
- **Mechanism:** Permission-widening flags (e.g. `--dangerously-skip-permissions`, `--allow-all`, `--approval-mode yolo`).
- **Effect:** Bypasses tool approval prompts during agent execution.
- **Safety profile:** High risk. **Switchboard never applies or injects permission-widening flags by default.** Applying these flags is entirely up to the operator.

Switchboard **never rewrites your configured startup command** and never writes to
a CLI's own config file. Everything below is something you choose to configure.

---

## What the probe measured, and what it does not prove

`scripts/probe-cli-consent.js` spawns each CLI on a pty in a **fresh temporary
directory** under a **fresh temporary `HOME`**, then types 8 characters and checks
whether they echo. A mechanism qualifies only when the spawn renders no prompt
**and** typed input echoes.

**The sandboxed `HOME` also means the CLI is unauthenticated.** That is deliberate
— it guarantees an untrusted baseline — but it stacks a second gate behind the
first. So a `PROMPT_BLOCKED` result under the probe does **not** by itself prove the
trust mechanism failed; it may mean the trust gate cleared and an *auth* gate
appeared behind it. Where the probe could tell those apart, the row says so.

**Headline result: only one mechanism in this table has been positively confirmed
to remove its gate** — gemini's `--skip-trust`. The `trustedDirectories` rows are
research-sourced and **not** confirmed by probe. Treat them as candidates.

Auth is out of scope for this document. Signing a CLI in is a one-time human
action; no flag replaces it.

---

## Consent Mechanisms Table

Probe column key: **CONFIRMED** = probe showed the gate present without the
mechanism and absent with it. **NOT CONFIRMED** = probe still hit a blocking
surface with the mechanism applied. **RESEARCH ONLY** = no probe arm run.

| CLI | Block hazard measured on fresh spawn | Trust mechanism | Mechanism type | Config file / setting path | Probe status (2026-08-27) | Permission flags (NOT defaults) |
|---|---|---|---|---|---|---|
| **Gemini** (`gemini`) | Folder-trust dialog — *"Do you trust the files in this folder?"*, `● 1. Trust folder / 2. Trust parent folder / 3. Don't trust` | `--skip-trust` flag | **CLI flag** | `~/.gemini/trustedFolders.json` (alternative) | **CONFIRMED for the trust layer only.** With `--skip-trust` the folder-trust dialog is gone; the seat then blocks on the auth-method picker (*"No authentication method selected"*, *"(Use Enter to select)"*) with the ToS link beside it. Sign gemini in and the flag clears the remaining gate. | `--approval-mode yolo` |
| **GitHub Copilot** (`copilot`) | Menu with `↑↓ to navigate · Enter to select · Esc to cancel`; no echo | `trustedDirectories` array in config file | **Config file** | `~/.copilot/config.json` | **NOT CONFIRMED.** With `trustedDirectories` pre-populated the probe still landed on the same blocking menu and typed input did not echo. Unauthenticated `HOME` may be the cause; re-probe with a signed-in copilot before relying on this. | `--allow-all-paths`, `--allow-all` (`--yolo`) |
| **Claude Code** (`claude`) | No trust prompt detected; blocks on the first-run **theme picker** (`1. Auto / 2. Dark mode / 3. Light mode …`); no echo | `trustedDirectories` array in settings | **Config file** | `~/.claude/settings.json` | **NOT CONFIRMED.** `trustedDirectories` did not produce a typeable seat — a separate first-run modal (theme selection) blocks it. Completing first-run setup once, per `HOME`, is the actual unblock. | `--permission-mode bypassPermissions`, `--dangerously-skip-permissions` |
| **Antigravity** (`agy`) | Blocking prompt on fresh spawn; no echo | `trustedDirectories` array in settings | **Config file** | `~/.gemini/antigravity-cli/settings.json` | **NOT CONFIRMED.** Still blocked with the config pre-populated. (Note: the 2026-08-23 measurement in a *real* `HOME` showed agy with a normal empty input box — i.e. already trusted there.) | `--dangerously-skip-permissions` |
| **Qwen** (`qwen`) | ToS / onboarding gate; no echo | **None known.** The gate is auth-bound onboarding, not a folder-trust prompt — no flag or settings key suppresses it. | auth (out of scope) | `~/.qwen/settings.json` (credentials, not trust) | **RESEARCH ONLY** — no mechanism exists to probe. Baseline blocked, as expected. | `--approval-mode yolo`, `--allowed-tools` |
| **Droid** (`droid`) | Splash rendered and typed input **echoed** — no blocking gate in this run | **None needed for trust.** `FACTORY_API_KEY` + `droid exec` gives a non-interactive headless path. | auth (out of scope) | — | Baseline **CLEAR** (echoed). The `> Login / Exit` gate seen on 2026-08-23 did not appear within the probe window; it may render later than 18s. | `--skip-permissions-unsafe`, `--auto <level>` |
| **Devin** (`devin`) | No trust prompt; typed input did not echo within the window | **None needed — no trust prompt observed.** | — | — | Baseline **NO_PROMPT_NO_ECHO** — no gate detected, but readiness was not proven. | `--permission-mode bypass`, `--sandbox` |
| **Grok** (`grok`) | No trust prompt; typed input did not echo within the window | Account authentication only. `disable_codebase_upload` in `~/.grok/settings.json` is a **privacy** setting, not trust. | auth (out of scope) | `~/.grok/settings.json` | Baseline **NO_PROMPT_NO_ECHO** — matches the 2026-08-23 "rendered blank" observation. | `--permission-mode bypassPermissions` |

**The one human action still beats every mechanism.** Choosing *"Yes, and remember
this folder for future sessions"* once, in a real `HOME`, removes the entire class
for that CLI and folder. Nothing in this table replaces signing a CLI in or
completing its first-run setup.

---

## Configuration Instructions by Mechanism Type

### Type 1: CLI Flags (startup-command configuration)

Add the flag to the role's command in Switchboard's **Agents** tab (or the Setup
panel). This is the only mechanism that lives in the startup command.

- **Gemini** — removes the folder-trust dialog (confirmed):
  ```bash
  gemini --skip-trust
  ```

### Type 2: Config-File Pre-Population

For `copilot`, `claude`, and `agy`, trust is stored in the CLI's own settings file
rather than a flag. The startup command is unchanged. Add the **absolute** path of
your repository to the `trustedDirectories` array.

> These three rows are **NOT CONFIRMED** by probe (see the table). Configure them,
> then verify with the probe or by spawning a seat and typing into it.

#### GitHub Copilot — `~/.copilot/config.json`
```json
{
  "trustedDirectories": [
    "/Users/username/Documents/GitHub/my-project"
  ]
}
```

#### Claude Code — `~/.claude/settings.json`
```json
{
  "trustedDirectories": [
    "/Users/username/Documents/GitHub/my-project"
  ]
}
```

#### Antigravity — `~/.gemini/antigravity-cli/settings.json`
```json
{
  "trustedDirectories": [
    "/Users/username/Documents/GitHub/my-project"
  ]
}
```

---

## Re-running the measurement

The probe never touches your real CLI config — it builds a temporary `HOME`,
writes the test config there, and deletes the whole tree on exit.

```bash
# Baseline: what does a fresh, untrusted spawn actually show?
node scripts/probe-cli-consent.js gemini

# CLI-flag arm
node scripts/probe-cli-consent.js gemini --cli-args "--skip-trust"

# Config-file arm (writes trustedDirectories into a sandboxed HOME)
node scripts/probe-cli-consent.js copilot --config-type copilot

# Give a slow CLI longer before the probe types / gives up
node scripts/probe-cli-consent.js droid --settle 6000 --timeout 40000
```

Exit codes: `0` = measured, `2` = bad arguments, `3` = **INCONCLUSIVE** (the CLI
never launched, or the probe never sent input). Treat exit `3` as *no data* — never
as "no prompt".

Report fields worth reading: `verdict`, `hasTrustOrConsentPrompt`, `typedEchoed`,
and `bufferTail` (the last 1200 bytes — where the prompt usually is).
