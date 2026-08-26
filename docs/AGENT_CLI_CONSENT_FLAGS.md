# Agent CLI Workspace Trust & Consent Configuration

This document specifies the verified startup flags and configuration mechanisms for suppressing modal workspace-trust and Terms of Service (ToS) consent gates across supported agent CLIs.

---

## 🚨 Security Policy: Trust vs Permission Distinction

Pre-consenting to workspace trust and granting unrestricted tool execution permissions are **fundamentally different security decisions**:

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

---

## Verified Consent Mechanisms Table

| CLI | Block Hazard at Spawn | Trust Mechanism | Mechanism Type | Config File / Setting Path | Permission Flags (NOT Defaults) |
|---|---|---|---|---|---|
| **GitHub Copilot CLI** (`copilot`) | Folder-trust menu (`1. Yes / 2. Yes, and remember / 3. No`) | `trustedDirectories` array in config file | **Config File** | `~/.copilot/config.json` | `--allow-all-paths`, `--allow-all` |
| **Gemini Code Assist** (`gemini`) | Workspace trust dialog & ToS notice | `--skip-trust` flag OR `GEMINI_CLI_TRUST_WORKSPACE=true` | **CLI Flag / Env** | `~/.gemini/trustedFolders.json` | `--approval-mode yolo` |
| **Claude Code** (`claude`) | Workspace trust approval prompt | `trustedDirectories` array in settings | **Config File** | `~/.claude/settings.json` | `--permission-mode bypassPermissions`, `--dangerously-skip-permissions` |
| **Antigravity CLI** (`agy`) | Workspace trust dialog in untrusted folders | `trustedDirectories` array in settings | **Config File** | `~/.gemini/antigravity-cli/settings.json` | `--dangerously-skip-permissions` |
| **Qwen Code** (`qwen`) | Initial ToS / Onboarding gate | Auth / First-run setup (no standalone trust flag) | **Auth Setup** | `~/.qwen/settings.json` | `--approval-mode yolo`, `--allowed-tools` |
| **Droid** (`droid`) | Account login prompt (`> Login / Exit`) | Auth session or `FACTORY_API_KEY` with headless mode | **Auth Setup** | `~/.factory/config.json` | `--skip-permissions-unsafe`, `--auto <level>` |
| **Devin** (`devin`) | None (normal REPL input box) | None needed | **None** | N/A | `--permission-mode bypass`, `--sandbox` |
| **Grok** (`grok`) | Blank screen / Auth onboarding | Account authentication session | **Auth Setup** | `~/.grok/settings.json` | `--permission-mode bypassPermissions` |

---

## Configuration Instructions by Mechanism Type

### Type 1: CLI Flags (Startup Command Configuration)

For CLIs that support trust pre-consent flags (such as `gemini`), add the flag directly to the startup command in Switchboard's **Terminals / Agents** configuration panel:

- **Gemini Code Assist:**
  ```bash
  gemini --skip-trust
  ```

### Type 2: Config File Pre-Population

For CLIs where workspace trust is stored in user configuration files rather than CLI flags (such as `copilot`, `claude`, and `agy`), add your repository or project path to the `trustedDirectories` array in the respective settings file:

#### 1. GitHub Copilot CLI (`~/.copilot/config.json`)
```json
{
  "trustedDirectories": [
    "/Users/username/Documents/GitHub/my-project"
  ]
}
```

#### 2. Claude Code (`~/.claude/settings.json`)
```json
{
  "trustedDirectories": [
    "/Users/username/Documents/GitHub/my-project"
  ]
}
```

#### 3. Antigravity CLI (`~/.gemini/antigravity-cli/settings.json`)
```json
{
  "trustedDirectories": [
    "/Users/username/Documents/GitHub/my-project"
  ]
}
```

---

## Standalone Diagnostic Verification

Switchboard includes a diagnostic script to verify prompt suppression and keyboard echo behavior in an isolated environment without modifying operator configuration:

```bash
# Test baseline spawn
node scripts/probe-cli-consent.js gemini

# Test CLI flag suppression
node scripts/probe-cli-consent.js gemini --cli-args "--skip-trust"

# Test config-file pre-population in isolated sandbox
node scripts/probe-cli-consent.js copilot --config-type copilot
```
