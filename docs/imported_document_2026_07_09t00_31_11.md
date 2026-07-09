# Antigravity Skills Guide

1. Filesystem Auto-Discovery of .agents/skills/<name>/SKILL.md
Auto-Discovery: Yes, Google Antigravity performs filesystem auto-discovery at startup for directories conforming to the layout: [customization_root]/skills/<name>/SKILL.md

Where the customization roots are:

Global Customizations Root: /Users/patrickvuleta/.gemini/config
Workspace Customizations Root: .agents (relative to the workspace root)
Metadata & YAML Frontmatter: Yes, a SKILL.md file must begin with YAML frontmatter containing the name and description keys:

yaml


---
name: <unique-skill-name>
description: <clear-description-of-what-the-skill-does>
---
Mechanism: The IDE uses a progressive disclosure pattern (introduced in the Agent Skills open specification in December 2025). During startup, only the name and description fields are parsed into memory (~100 tokens total) to minimize context window bloating. The full markdown body of SKILL.md (and related subdirectories like references/ or scripts/) is only loaded into the agent's context when a user request triggers a match against the skill’s description.

2. Handling of Flat Markdown Files in .agents/skills/
Discovery status: Flat markdown files placed directly in .agents/skills/ (e.g., .agents/skills/archive.md) are ignored by Antigravity’s automatic skill discovery and registration engine. They will not appear in the model's auto-generated <skills> system block and cannot be auto-triggered based on semantic relevance.
Usability: Although ignored by the discovery registry, they are still usable in other ways. The active agent can read them directly using file-viewing tools (like view_file), and they can be manually cross-referenced via markdown links (e.g., [label](file:///absolute/path/to/file.md)).
3. Relation of AGENTS.md to .agents/skills/
Registry Separation: AGENTS.md is separate from filesystem skill discovery. The actual discovery system scans the physical folders and reads SKILL.md YAML blocks.
Role of AGENTS.md: AGENTS.md is primarily used to register Rules (style guidelines, coding standards, and behavioral constraints) scoped either globally or project-wide.
Available Skills Table: In some projects, users manually construct an "Available Skills" table inside AGENTS.md (as seen in the Switchboard protocol). This serves as a prompt-level hint/guide to help the model select and manually trigger a skill using commands like skill: "<name>". However, this table is a user-maintained convention and not the IDE's authoritative registration database.
4. Directory Structures, Frontmatter, and Invocation Differences
Skill vs. Workflow Structure
Feature / Characteristic	Antigravity Skill	Antigravity Workflow
Location	[root]/skills/<name>/SKILL.md	.agents/workflows/<workflow_name>.md
Frontmatter	Must contain YAML name and description	Simple YAML description or none (often metadata-free flat Markdown)
Structure	Directory-based. Can bundle optional folders: scripts/, references/, resources/, examples/	File-based. A single flat Markdown file outlining sequential execution instructions
Invocation Differences
Workflow Invocation (User Slash-Command):
Triggered explicitly by the user writing a slash command (e.g., /accuracy, /improve-plan) or a natural language command mapped to it (e.g., "start memo capture").
The model detects the command, reads the workflow file using view_file, and is strictly bound by protocol rules to execute the steps sequentially without improvising.
Skill Invocation (Model-Auto-Invocation / Progressive Disclosure):
Auto-triggered implicitly when the user's prompt matches a registered skill's YAML description.
The IDE automatically injects the full SKILL.md body into the model's system context, letting the model apply the specialized knowledge on-demand.
Can also be triggered via prompt directives advising the model to invoke it (e.g., skill: "archive").
Authoritative Reference Citations & Version-Specific Flags
December 2025 Release Specifications: The core behavior of SKILL.md, YAML metadata parsing, and progressive disclosure constraints are defined in the Agent Skills Open Specification (December 2025).
Version/Legacy Support Flag: Some documentation mentions legacy folder matching. While .agents/skills/ is the standard project directory, legacy support also matches .agent/skills/ (singular) in older versions.
Manual Registration Override: While standard directories use auto-discovery, you can manually define non-standard locations (such as shared network paths) using a skills.json configuration file at the customization root.