# Update README with Recent Features

## Goal
Update the `README.md` to document major features that have been implemented but not yet committed to the public documentation. This includes new PM tool integrations (ClickUp, Linear, Notion), new agent roles (Team Lead, Acceptance Tester), configuration improvements (Central Setup Panel, Customize Default Prompts, Git Ignore Strategy), and development workflow conventions (plan writing location). Add a new "Planning Tools" section to document IDE chat commands and the windsurf planning memory convention.

## Metadata
**Tags:** none
**Complexity:** 2

## User Review Required
> [!NOTE]
> This README update should be manually checked against the shipped feature cards before publishing. If any linked feature is still in flight, keep the prose tentative or defer the sentence rather than overstating availability.

## Complexity Audit
### Routine
- Update `README.md` section ordering and headings.
- Add documentation for recently shipped features and roles.
- Move IDE chat commands into a Planning Tools section.
- Refresh wording in setup and workflow sections to match current UI labels.
### Complex / Risky
- Align the README language with active feature work so the doc does not promise unmerged behavior; this is the only real risk in a docs-only change.

## Edge-Case & Dependency Audit
- **Race Conditions:** None in code, but there is a publication-order risk if README lands before the feature cards; phrase features as available only after verification.
- **Security:** No security changes. Avoid documenting token handling beyond current setup flows.
- **Side Effects:** README will become more accurate; section movement could break links if anchors are referenced elsewhere, so keep heading text stable where possible.
- **Dependencies & Conflicts:** 
  - Active Planned cards with direct README impact: ClickUp Integration parts 1-3, Linear Integration parts 1-4, Notion Integration parts 1-3, Add Team Lead Orchestrator Role, Feature Plan: Add Acceptance Tester Role, Move Configuration Components to Central Setup Panel, Customize Default Prompts, Add Git Ignore Strategy UI to Setup Menu, and the existing README update card itself.
  - No New-column items were present at query time.
  - Conflict risk: if any of the above implementation cards slip or change labels, the README wording must be revised to match the final shipped UI text.

## Adversarial Synthesis
### Grumpy Critique
> This README is already talking past the product. It lists features like a victory lap, but if the UI labels, role names, or integration flows drift even a little, the documentation becomes a museum plaque for a version nobody ships. Don’t just paste marketing copy into the file and call it “updated.” Cross-check every heading against the active feature cards, or you’ll publish confident nonsense with immaculate Markdown.

### Balanced Synthesis
The plan should keep the original scope but tighten the wording discipline: update only `README.md`, place the new sections where users will actually find them, and verify every feature name against the active implementation cards before finalizing. That keeps the change small, accurate, and safe.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Execution Order
- **Low-complexity:** add the new Planning Tools section, update the agent-role copy, and move/refresh the configuration notes in `README.md`.
- **Low-complexity:** add the PM tool integration docs and keep the Google Jules section where it already lives unless the final README layout clearly reads better with a grouped integrations block.
- **High-complexity / Risky:** reconcile terminology and feature status against the active Planned/Reviewed cards so the README never claims a feature is available before it actually is.

### 1. Add PM Tool Integrations Section
#### [MODIFY] `README.md`
- **Context:** ClickUp, Linear, and Notion integrations have been implemented but are not yet fully documented in the README. Group them under a dedicated integrations section so readers can find setup and sync behavior quickly.
- **Logic:**
  1. Insert a new `### Project Management Tool Integrations` block under `## Advanced features`, positioned near `### Google Jules integration` so the PM-tool docs sit together.
  2. Keep the description intentionally factual: mention setup, sync-on-move, and import flows only where the active feature cards support them.
  3. Preserve the existing Google Jules documentation; if the final layout is clearer, move it with the other integrations, but do not delete it.
  4. Use the final UI labels from the implementation cards, not guessed product names.
- **Implementation:**
```markdown
## Project Management Tool Integrations

Switchboard syncs plan state to external project management tools using their official MCP servers. This enables bidirectional sync between the AUTOBAN and your PM workflow.

### ClickUp Integration

1. Open **Setup** and navigate to **Integrations**
2. Click **Setup ClickUp** and authenticate with your ClickUp workspace
3. Select a folder and list to sync with
4. Plans are automatically synced to ClickUp tasks when cards move between columns
5. Use **Import from ClickUp** to pull existing tasks as plans into the AUTOBAN
6. Plan content is pushed back to ClickUp task descriptions when implementation is complete

### Linear Integration

1. Open **Setup** and navigate to **Integrations**
2. Click **Setup Linear** and authenticate with your Linear workspace
3. Plans are automatically synced to Linear issues when cards move between columns
4. Use **Import from Linear** to pull existing issues as plans into the AUTOBAN
5. Supports issue labels, milestones, and project associations

### Notion Integration

1. Open **Setup** and navigate to **Integrations**
2. Click **Setup Notion** and authenticate with your Notion workspace
3. Select a database to sync with
4. Plans are automatically synced to Notion database pages when cards move between columns
5. Includes a dedicated Planning Tab UI for managing Notion-linked plans
```
- **Edge Cases Handled:** This wording stays within the implemented scope and avoids promising any PM-tool behavior that was not shown in the active cards.

### 2. Update Agent Roles Section
#### [MODIFY] `README.md`
- **Context:** New agent roles (Team Lead, Acceptance Tester) have been added, and the Getting Started role list needs to match the current routing model.
- **Logic:**
  1. Update `### 2. Set up your agent team` in `README.md`.
  2. Add the Team Lead role immediately after Planner so the hierarchy reads naturally.
  3. Add Acceptance Tester as a distinct validation role, not as a synonym for Reviewer.
  4. Keep Lead Coder, Coder, Reviewer, and Analyst wording aligned with the current complexity-routing behavior.
- **Implementation:**
```markdown
Assign agents to roles in the sidebar:

- **Planner** — your premium model (Opus, Windsurf, Copilot). Writes detailed plans, assigns complexity scores, recommends routing.
- **Team Lead** — orchestrator role for coordinating agents and managing complex workflows. Handles cross-agent coordination and high-level decision making.
- **Lead Coder** — handles high-complexity tasks. Typically your best CLI agent.
- **Coder** — handles low-complexity and boilerplate. A cheap, fast model like Gemini Flash.
- **Reviewer** — compares implementations against plans, flags scope creep, and ships with the Grumpy Principal Engineer persona.
- **Acceptance Tester** — validates implementations against acceptance criteria, runs automated tests, and reports testing failures.
- **Analyst** — general purpose questions and research.
```
- **Edge Cases Handled:** This keeps the team model explicit and avoids collapsing testing into review or hiding the Team Lead role from first-time users.

### 3. Add Configuration Improvements Section
#### [MODIFY] `README.md`
- **Context:** Central Setup Panel, Customize Default Prompts, Git Ignore Strategy, and repository exclusion behavior all belong in the docs, but the current README only hints at them.
- **Logic:**
  1. Expand the `### Prompt Controls` area under `## Advanced features` so it references the new Setup consolidation.
  2. Add a short `### Configuration Improvements` subsection that explains the consolidated Setup panel and the new controls.
  3. Document Customize Default Prompts, Git Ignore Strategy, and Repository Exclusion using the actual UI labels from the implementation cards.
  4. Keep the wording practical: what users can change, where they click, and what the setting affects.
- **Implementation:**
```markdown
### Configuration Improvements

#### Central Setup Panel

All configuration options have been consolidated into a unified Setup panel. Access from the sidebar or use the "OPEN SETUP" button in Terminal Operations. This provides a single location for:
- Agent role assignments and CLI commands
- Custom agent configuration
- Prompt controls and routing rules
- Integration setup (ClickUp, Linear, Notion, Jules)
- Git ignore strategies
- Repository exclusion rules

#### Customize Default Prompts

Override the default prompts for any agent role. Customize how agents receive tasks, what instructions they follow, and how they format responses. Access via the Setup panel under each agent's configuration.

#### Git Ignore Strategy

Configure which files and patterns agents should ignore during operations. Set workspace-specific or global ignore rules to prevent agents from modifying sensitive files, build artifacts, or generated code.

#### Repository Exclusion System

Exclude specific repositories from Switchboard operations. Useful for preventing accidental modifications to production databases, third-party libraries, or read-only dependencies.
```
- **Edge Cases Handled:** This keeps configuration guidance centralized and avoids duplicating setup instructions in multiple README sections.

### 4. Add Planning Tools Section
#### [MODIFY] `README.md`
- **Context:** The IDE chat commands currently sit under Advanced features, but they are planning workflow tools and should have their own section. The plan-file location convention also belongs here.
- **Logic:**
  1. Insert `## Planning Tools` after `## Core workflows` and before `## Advanced features`.
  2. Move the existing IDE chat commands table into that new section without changing the command semantics.
  3. Add a short convention note that plan files live in `.switchboard/plans/` at the workspace root.
  4. Keep the `/chat` description aligned with collaborative plan writing and avoid implying it edits random files.
- **Implementation:**
```markdown
## Planning Tools

Switchboard provides multiple tools for creating and managing plans, from IDE chat commands to the AUTOBAN interface.

### IDE Chat Commands

Use these within Antigravity or Windsurf chat:

| Command | What it does |
| :--- | :--- |
| `/chat` | Switches the AI into planning mode — no code, just collaborative plan writing saved directly to `.switchboard/plans/` |
| `/improve-plan` | Deep planning, dependency checks, and adversarial review in one pass |
| `/archive` | Query or search the historical DuckDB plan archive |
| `/export` | Export the current conversation to the plan archive database |

### Plan File Convention

When using the `/chat` workflow or creating plans manually, plan files are stored in `.switchboard/plans/` at your workspace root. This directory contains all active and archived plans in markdown format. Plans follow a structured format with metadata, complexity scores, and implementation steps.

### Collaborative Planning

The `/chat` command enables collaborative plan writing directly in your IDE chat. The AI enters planning mode and helps you:
- Break down complex tasks into implementable steps
- Assign complexity scores and recommend agent routing
- Identify dependencies between tasks
- Save plans directly to the `.switchboard/plans/` directory

Plans created this way are immediately available in the AUTOBAN for routing to agents.
```
- **Edge Cases Handled:** This preserves the command behavior while making the plan-storage convention explicit and easy to find.

### 5. Update Existing Sections for Accuracy
#### [MODIFY] `README.md`
- **Context:** A few existing sections need small accuracy passes so the new feature docs do not contradict older wording.
- **Logic:**
  1. Review `### Complexity routing` in `README.md` and ensure the Lead Coder/Coder split still matches the current board behavior.
  2. Review `### AUTOBAN Automation` and make sure any references to agent count, batching, or role assignment still read naturally after the Team Lead and Acceptance Tester additions.
  3. Review `### Prompt Controls` so it references Customize Default Prompts and the Setup panel instead of sounding like a stale feature list.
  4. Review headings and cross-references for anchor stability after moving `### IDE chat commands`.
- **Implementation:** Make targeted prose edits only; do not change any feature claims beyond what is required for accuracy.
- **Edge Cases Handled:** This is the main risk-reduction step because README drift usually comes from stale wording, not from missing sections.

## Verification Plan
### Automated Tests
- No code tests are required because this is a documentation-only plan update.

### Manual Checks
- Re-open `README.md` and confirm the new section order reads cleanly.
- Confirm the plan still documents all original feature groups: PM integrations, agent roles, configuration improvements, and planning tools.
- Confirm no existing feature description was deleted; only reorganized or clarified.
- Confirm all wording matches the active Planned/Reviewed cards and does not promise unmerged behavior.

**Recommended Agent:** Send to Coder

## Reviewer Execution Update

### Stage 1 (Grumpy Principal Engineer)
> **MAJOR** The README was still lying about product surfaces. It claimed integration setup belonged to the Setup panel, even though the shipped ClickUp/Linear entry points live on the AUTOBAN strip. That is not a cute wording issue; it is how you send users on a scavenger hunt through the wrong UI and then wonder why they think the docs are fiction.
>
> **MAJOR** The new Planning Tools section also ducked one of the plan’s explicit asks: the Windsurf planning-memory convention. Saying plans live in `.switchboard/plans/` is only half the job. The whole point of that section is to explain that this folder is the shared durable planning location across IDE chat and the board, not just a random directory name.
>
> **NIT** The prompt-controls copy also drifted from the actual UI label. “Append PRD” is close enough for a hallway conversation, but not for published docs that are supposed to match the buttons people can actually click.

### Stage 2 (Balanced)
Keep the overall README structure and feature coverage; those are good. Fix the inaccurate Setup-panel integration claim, add one explicit sentence documenting `.switchboard/plans/` as the shared Windsurf planning-memory convention, and align the prompt-controls wording with the real Setup label. Those are direct plan-alignment fixes, and once they land the README is accurate enough to ship.

### Fixed Items
- Corrected the inaccurate Setup-panel integration claim in `README.md`.
- Added the missing Windsurf planning-memory convention note to the Planning Tools section.
- Aligned the Design Doc / PRD prompt-control copy with the shipped Setup label.

### Files Changed
- `README.md`
- `.switchboard/plans/update_readme_with_recent_features.md`

### Validation Results
- Reviewed the updated README sections in place and confirmed:
  - ClickUp / Linear setup is documented on the AUTOBAN strip, not the Setup panel.
  - `.switchboard/plans/` is explicitly described as the shared Windsurf planning-memory location.
  - The prompt-controls wording now matches the shipped Design Doc / PRD label.

### Remaining Risks
- README accuracy still depends on adjacent feature cards keeping their shipped UI labels stable.
- This remains documentation-only verification; no code/build checks were necessary for the reviewer fixes above.
