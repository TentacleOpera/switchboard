# Claude Code Project Skills and Configuration Architecture

## Executive Summary
This document provides a technical analysis of how Anthropic's Claude Code (the agentic CLI) discovers, invokes, and handles permissions for workspace-level `CLAUDE.md` files and custom agent skills. Designed for the maintainer of the VS Code extension "Switchboard," this reference outlines version-pinned behavior, exact schemas, and directory constraints to ensure correct generation of project-level layers.

As of the Claude Code 2.1.0 release (January 7, 2026), skills and custom commands are unified into a single watched-filesystem model that supports hot-reloading mid-session. The following findings detail the precise technical requirements your generator must target.

---

## Required Findings

### SQ1: CLAUDE.md Discovery, Nesting, and Multi-Root Behavior
*   **Auto-loading on Startup**: Claude Code discovers and loads the `CLAUDE.md` and `CLAUDE.local.md` files located in the current working directory (`cwd`) at session launch.
*   **Ancestor Resolution (Context Inheritance)**: Claude Code automatically walks **up** the directory tree from the `cwd` to the repository root (or system boundaries) on startup. It aggregates instructions from all parent `CLAUDE.md` and `CLAUDE.local.md` files.
*   **Nested Directories & Lazy Loading**: Any `CLAUDE.md` file located in a subdirectory (descendant of the launch directory) is **not** loaded at session start. These files are lazily loaded on demand when Claude reads a file or navigates into that specific subdirectory.
*   **Compaction Retain Behavior**: After a `/compact` operation (which shrinks the conversation history to preserve context), only the starting-directory `CLAUDE.md` is re-read and re-injected automatically. Lazily loaded subdirectory `CLAUDE.md` files do not persist across compaction and are only reloaded if the model reads a file in that directory again.
*   **Multi-Root Workspaces**: Claude Code behaves on a per-session `cwd` basis. If "Switchboard" manages a multi-root workspace, the CLI resolves relative boundaries based on the directory in which it is launched. However, the `/cd` command allows moving the CLI’s working directory mid-session without invalidating the active prompt cache.
*   **Modular Imports**: Since version 0.2.106, `CLAUDE.md` supports direct imports using the `@path/to/file.md` format (e.g., `@.claude/rules/security.md`), which instructs Claude Code to load these referenced files at session launch.
*   **Exclusions**: Path-based exclusions can be configured via the `claudeMdExcludes` property in `.claude/settings.local.json` to skip specific files (e.g., in monorepos).

### SQ2: Skill Invocation Mechanics
*   **Command vs. Skill Merging**: In Claude Code 2.1.0, legacy custom commands (`.claude/commands/`) were formally unified with skills (`.claude/skills/`). Placing a skill at `.claude/skills/<name>/SKILL.md` automatically exposes it both as a literal `/<name>` slash command and as an auto-invocable tool (the `Skill` tool).
*   **Relevance Triggering**: At session startup, Claude Code evaluates only the name and description from the YAML frontmatter of every discovered skill (this is "progressive disclosure," costing ~100 tokens per skill to keep the system prompt small).
*   **Full Body Loading**: The full body of `SKILL.md` is only injected into the context window under two conditions:
    1.  The user explicitly executes the slash command (e.g., `/<name>`).
    2.  The model autonomously invokes the skill (via the `Skill` tool) because the active conversation matches the skill’s frontmatter `description`.
*   **Programmatic & Visibility Controls**: Two YAML frontmatter parameters regulate invocation:
    *   `disable-model-invocation: true`: Prevents Claude from auto-triggering the skill based on semantic matching. Only explicit user commands can execute it.
    *   `user-invokable: false`: Hides the skill from the user's autocomplete slash-command list. It remains accessible to the model for autonomous loading. (Note: The correct schema key recognized by the validator is `user-invokable`, and `user-invocable` with a "c" has triggered validator warnings).

### SQ3: SKILL.md YAML Frontmatter Schema
To satisfy the Claude Code validator, frontmatter must be enclosed in standard `---` block markers at the top of the markdown file.
*   **Supported Fields**:
    *   `name` (String, Optional): The display name of the skill.
    *   `description` (String, Recommended): Semantic description of what the skill does. Combined with `when_to_use`, this is truncated at 1,536 characters in the skill indexing pass.
    *   `when_to_use` (String, Optional): Explicit trigger phrasing and matching examples.
    *   `argument-hint` (String, Optional): Placeholder text shown during slash-command autocomplete (e.g., `[id]`).
    *   `arguments` (List/Map, Optional): Definitions for variables substituted dynamically into the prompt (e.g., `$1`).
    *   `disable-model-invocation` (Boolean, Optional): Disables proactive model auto-triggering.
    *   `user-invokable` (Boolean, Optional): Restricts command visibility.
    *   `allowed-tools` (String or YAML Array, Optional): Restricts available tool sets while the skill is executing.
*   **`allowed-tools` Formats**:
    *   *Comma-Separated String*: `Read, Write, Bash(git *)`
    *   *YAML Array*:
        ```yaml
        allowed-tools:
          - Read
          - Write
          - Bash(git *)
        ```
    *   *Single String*: `allowed-tools: Bash`
*   **Tool Syntax Rules**: Native tool names (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) must be capitalized. Custom MCP tools are referenced as `mcp__<server-name>__<tool-name>`.
*   **Bash Tool Formatting**: Scoped bash patterns can filter execution boundaries:
    *   `Bash(git *)` or `Bash(git:*)` (Allows only git commands).
    *   `Bash(npm:*)` (Allows npm commands).
    *   `Bash(*)` (Allows any command).

### SQ4: Naming and Directory Structure Constraints
*   **File Placement**: Custom skills are placed under `.claude/skills/<name>/SKILL.md`.
*   **Command Derivation**: The `<name>` portion of the directory path defines the literal slash command. For example, `.claude/skills/local-proxy/SKILL.md` creates `/local-proxy`.
*   **Allowed Character Set**: Follows standard filesystem directory restrictions. The Agent Skills standard utilizes lowercase kebab-case.
*   **Collisions**: If the folder name matches a built-in slash command (e.g., `help`, `compact`, `clear`) or a bundled skill (e.g., `debug`, `code-review`), the project-level skill directory overrides the built-in behaviors within that project context (marked as **UNVERIFIED** as the exact priority resolution of native versus project skill overrides is not exhaustively documented in public CLI system source blocks).

### SQ5: .claude/settings.json Permission Allowlist
*   **Analogy of an Allowlist**: To prevent repetitive prompts (such as approving local proxy calls), you must configure the `"permissions.allow"` array inside `.claude/settings.json` or `.claude/settings.local.json`.
*   **JSON Schema Keypath**:
    ```json
    {
      "permissions": {
        "allow": [
          "Bash(curl *)",
          "Bash(node *)"
        ],
        "deny": []
      }
    }
    ```
*   **Wildcard Evaluation**: Glob-style `*` is supported for prefix and suffix matching.
*   **No Regex Support**: Regular expressions (e.g., `/pattern/`) are **not** supported. The parser reads rules as literal strings or basic glob matches.
*   **Caveat**: Wildcard matching can fail open or be bypassed if flags are merged (e.g., a rule for `sed -i` may not match `sed -ni`).

### SQ6: Hot Reloading vs. Session Restart
*   **Skills Hot-Reloading**: Since version 2.1.0, skills are managed by an internal file-watcher. Newly created skill directories, modified `SKILL.md` files, or asset files under `.claude/skills/` are **automatically hot-reloaded** mid-session. The next user turn instantly reflects the updated files without restarting the CLI.
*   **CLAUDE.md and settings.json**: Structural settings, global permissions, and root `CLAUDE.md` files are loaded only during session initialization. Changes to these files **require a session restart** (or exit and re-entry) to take effect.

---

## Recommended Findings

*   **Size Constraints**: Keep the main body of `SKILL.md` under 500 lines. Because skill content persists in the context window once active, heavy inline prompts incur cumulative token overhead. 
*   **Asset Bundling**: Offload complex script logic, static templates, or configuration files to a nested subdirectory (e.g., `.claude/skills/<name>/assets/` or `.claude/skills/<name>/references/`). The main `SKILL.md` should instruct Claude Code to execute these assets via bash instead of reading them into the primary context window.
*   **Schema Auto-completion**: We recommend adding the settings schema reference to generated settings files to enable immediate editor validation:
    `"$schema": "https://json.schemastore.org/claude-code-settings.json"`.
*   **Use local.json for Machine-Specific Paths**: When generating permissions that contain absolute file paths, write them to `.claude/settings.local.json` rather than the main `settings.json`. This prevents environment paths from being committed to shared repositories.

---

## Opinion Findings

*   **Allowed-Tools Enforcement Inconsistency**: Community developers have observed that while the `allowed-tools` frontmatter metadata is correctly recognized by the CLI, it can sometimes be ignored by the model's internal routing, resulting in the agent executing forbidden tools when highly abstract goals are requested.
*   **Portability to the Agent SDK**: When the skill is run inside an application utilizing the Anthropic Agent SDK rather than the CLI directly, the `allowed-tools` field in `SKILL.md` is ignored, necessitating manual replication of rules inside the programmatic client configuration.
*   **Bypass / Overwrite UI Bug**: Users have noted a recurring issue where clicking "Accept, do not ask again" on a CLI tool execution prompt can sometimes overwrite and wipe out existing wildcard permission configurations in `settings.local.json` with a single, highly specific rule.

---

## Trade-off Evaluation

For a VS Code extension ("Switchboard") generating a native Claude Code layer, selecting the invocation trigger represents a fundamental design choice.

```
+---------------------------------------------------------------------------------+
|                         Trigger Mechanism Comparison                            |
+------------------------------+--------------------------------------------------+
| Slash-Command (User-Explicit)| Model-Auto-Invocation (Semantic Trigger)         |
+------------------------------+--------------------------------------------------+
| * Highly predictable execution| * Dynamic, proactive contextual assistance       |
| * Zero unintended token cost | * Frictionless user experience                   |
| * Requires user training     | * Susceptible to over/under-triggering           |
| * Safe for side-effect tools | * Truncated description metadata window (1.5k)  |
+------------------------------+--------------------------------------------------+
```

### Strategic Implications for the Generator:
1.  **For Proxy Tools (with Side-Effects)**: If "Switchboard" generates host-neutral bash scripts that query local proxies to mutate state, write `disable-model-invocation: true` in the frontmatter. This ensures the proxy is only hit when the user explicitly triggers `/switchboard-action`.
2.  **For Information Retrieval (Context Providers)**: If the skill is designed to explain a local database schema or project state, set `user-invokable: false` and supply a rich, semantic description. This lets Claude pull the workspace structure when it is relevant, preventing slash-command clutter.
3.  **Preserving Context Window**: Relying heavily on `CLAUDE.md` to hold procedural guidelines will continuously consume context tokens. Offloading these guidelines to on-demand skills with specific semantic descriptions allows the workspace to scale efficiently.

---

## Glossary

*   **Agent Skill**: A modular directory structure containing a `SKILL.md` file (and optional scripts/resources) that defines metadata, execution rules, and capabilities for an agent.
*   **Slash Command**: An explicit command syntax (`/<name>`) exposed to the CLI user that runs custom prompts or automation directly.
*   **allowed-tools**: A configuration parameter (used in settings and skill frontmatter) defining the subset of tools Claude is authorized to use during a turn or session.
*   **settings.json Allow-List**: The `"permissions.allow"` array stored in the hierarchy of Claude Code configurations to grant automatic approval for specific tools or bash commands.

---

## Source List

### Official Documentation & Guides
1. Anthropic, "Best practices for Claude Code - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/best-practices`
2. Anthropic, "Overview - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/overview`
3. Anthropic, "How Claude remembers your project - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/memory`
4. Anthropic, "Extend Claude with skills - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/skills`
5. Anthropic Help Center, "What are skills?," `support.anthropic.com`
6. Anthropic, "CLI reference - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/cli-reference`
7. Anthropic, "Use Claude Code in VS Code - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/vscode`
8. Anthropic, "Hooks reference - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/hooks-reference`
9. Anthropic, "Authentication - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/auth`
10. Anthropic, "Claude Code settings - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/settings`
11. Anthropic, "Tools reference - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/tools-reference`
12. Anthropic, "Configure permissions - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/permissions`
13. Anthropic, "Enterprise deployment overview - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/enterprise`
14. Anthropic, "Set up Claude Code in a monorepo or large codebase," `docs.anthropic.com/en/docs/claude-code/monorepo`
15. Anthropic, "Create custom subagents - Claude Code Docs," `docs.anthropic.com/en/docs/claude-code/subagents`

### Release Changelogs & Specs
16. Anthropic, "Claude Code Changelog: Releases & Changes," GitHub: `anthropics/claude-code/CHANGELOG.md`
17. Anthropic, "v2.1.0 Support - Release Notes (Jan 7, 2026)," GitHub: `anthropics/claude-code/CHANGELOG.md`
18. Anthropic, "v2.1.59 - Auto Memory Release Notes," GitHub: `anthropics/claude-code/CHANGELOG.md`
19. Anthropic, "v2.1.73 - Output Styles Deprecation Notes," GitHub: `anthropics/claude-code/CHANGELOG.md`
20. Anthropic, "v2.1.83 - Drop-in Configuration Directories," GitHub: `anthropics/claude-code/CHANGELOG.md`
21. Anthropic, "v2.1.181 - Shell Execution Improvements," GitHub: `anthropics/claude-code/CHANGELOG.md`
22. Anthropic, "Agent Skills Specification and Open Standard," GitHub: `anthropics/skills`
23. Anthropic, "Equipping agents with Agent Skills," Anthropic Engineering Blog (Oct 2025/Dec 2025 Updates)
24. Anthropic, "The Complete Guide to Building Skills for Claude (Jan 2026)"

### Verified GitHub Issues (anthropics/claude-code)
25. GitHub Issue #889: "Allow specifying allowedTools for all projects"
26. GitHub Issue #534: "RFC: Multi-directory CLAUDE.md feature"
27. GitHub Issue #28266: "nested skills in skills/*/SKILL.md not discovered"
28. GitHub Issue #25380: "SKILL.md validator only recognizes Agent Skills standard fields"
29. GitHub Issue #36923: "Bug: SKILL.md creation prompts for permission even in bypass mode"
30. GitHub Issue #18737: "Major Inconsistency in SKILL.md allowed-tools support"
31. GitHub Issue #37683: "allowed-tools in SKILL.md frontmatter does not restrict tool access"
32. GitHub Issue #17499: "DOCS: Syntax for allowed-tools in skills"
33. GitHub Issue #14956: "Skill allowed-tools doesn't grant permission for Bash commands"
34. GitHub Issue #19114: "DOCS: Inconsistent documentation for allowed-tools syntax"
35. GitHub Issue #30 (claude-code-action): "allowed_tools yaml doesn't work"
36. GitHub Issue #18973: "DOCS: Explicitly link allowedTools flags to permissions settings"
37. GitHub Issue #13331: "BUG: plugin-dev:agent-development skill documents wrong tools format"
38. GitHub Issue #13494: "BUG: Inconsistent tool permission behavior in skill's allowed-tools"
39. GitHub Issue #19141: "DOCS: Clarify distinction between user-invocable and disable-model-invocation"
40. GitHub Issue #26251: "Skill with disable-model-invocation cannot be slash invoked"
41. GitHub Issue #41417: "disable-model-invocation does not remove skill from system-reminder"
42. GitHub Issue #43809: "BUG: Skills with disable-model-invocation cannot be invoked by subagents"
43. GitHub Issue #23723: "BUG: Claude Code SKILL.md attribute user-invocable vs user-invokable"
44. GitHub Issue #37509: "FEATURE: Support regex patterns in permission rules"
45. GitHub Issue #9792: "BUG: Permissions: denied commands ignored with wildcard mistake"
46. GitHub Issue #27139: "Broad wildcard permissions in settings.local.json not respected"
47. GitHub Issue #2928: "Allow wildcard on permissions.allow for all tools from a particular MCP"
48. GitHub Issue #26276: "Permission precedence: allow wildcard overrides ask rules"
49. GitHub Issue #47394: "Bash(*) wildcard in permissions.allow doesn't match all Bash commands"
50. GitHub Issue #68835: "BUG: Read glob in ~/.claude/settings.json does not suppress prompts"
51. GitHub Issue #40076: "Permission allow rules with glob not matching paths outside cwd"
52. GitHub Issue #9814: "settings.local.json permissions overwritten when clicking accept, do not ask again"
53. GitHub Issue #20507: "Feature Request: Add /reload-skills command to dynamically reload skills"
54. GitHub Issue #15858: "RFC: Config Hot-Reload for CLAUDE.md and Settings"