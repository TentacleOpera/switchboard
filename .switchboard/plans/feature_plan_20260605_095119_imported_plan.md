# Skills and workflow audit

1. Summary Statistics
Total unique skills on disk: 21
Total skills registered in AGENTS.md: 16 (15 exist on disk, 1 is missing)
Orphaned skills (exist on disk, not in AGENTS.md): 6
Missing skills (declared in AGENTS.md, not on disk): 1
Misaligned skills (named differently in code vs. docs): 2
2. Registered Skills (In AGENTS.md & Exist on Disk)
These 15 skills are correctly declared in the AGENTS.md registry and map cleanly to files or directories on disk:

Registry Name in AGENTS.md	Disk Path	Format
archive	
archive.md
File
clickup_api	
clickup_api.md
File
clickup_attach	
clickup_attach.md
File
clickup_create_subpage	
clickup_create_subpage.md
File
clickup_create_task	
clickup_create_task.md
File
clickup_fetch	
clickup_fetch.md
File
clickup_modify_task	
clickup_modify_task.md
File
generate_diagram	
generate_diagram.md
File
query_switchboard_kanban	
query_switchboard_kanban.md
File
kanban_operations	
kanban_operations/
Folder (SKILL.md)
query_archive	
query_archive/
Folder (SKILL.md)
complexity_scoring	
complexity_scoring.md
File
linear_api	
linear_api.md
File
web_research	
web_research.md
File
deep_planning	
deep_planning.md
File
3. Orphaned Skills (Exist on Disk, Not in AGENTS.md)
These 6 skills reside in .agent/skills/ but have no corresponding entries in AGENTS.md. These should be added to the registry so that agents are aware they are available:

apply_patch (.agent/skills/apply_patch/SKILL.md)
Purpose: Guides the agent to apply unified diffs and AI patches cleanly to the workspace.
architectural_diagrams (.agent/skills/architectural_diagrams/)
Purpose: Details on rendering Mermaid diagrams to static image files and posting them to tickets.
clickup_mcp (.agent/skills/clickup_mcp.md)
Purpose: Contains troubleshooting guidance and workarounds (like subtask truncation) for ClickUp integration tools.
fix_plans_dropdown (.agent/skills/fix_plans_dropdown/SKILL.md)
Purpose: Troubleshooting steps for diagnosing and syncing state dropdown files (plan_tombstones.json, runsheets, workspace setting paths).
gemini_interactive (.agent/skills/gemini_interactive/SKILL.md)
Purpose: Detailed terminal synchronization handshake and paced Double-Tap input protocol for interacting with the Gemini interactive CLI.
get_tickets (.agent/skills/get_tickets.md)
Purpose: Outlines procedures for parsing target ticket parameters and importing descriptions.
4. Declared but Missing Skills (In AGENTS.md, Not on Disk)
review
Status: Listed in the AGENTS.md table as: review | User asks to review code changes, a PR, or specific files
Problem: No review.md or review/ folder exists under .agent/skills/. Agents instructed to invoke this skill will find no instructions.
5. Name Misalignments and Cross-References
generate_diagram vs. architectural_diagrams
On Disk: Two separate skill files exist: generate_diagram.md (which maps to the generate_diagram key in AGENTS.md) and the folder architectural_diagrams (which is orphaned).
The Conflict: generate_diagram.md states in its description that it "replaces generate_architectural_diagram," yet the folder architectural_diagrams remains on disk without any reference, creating duplication of intent.
archive vs. query_archive
On Disk: Both archive.md (file) and query_archive/ (folder) exist.
In AGENTS.md: Both are listed. However, archive.md includes its own internal "Skills Registry" table that points to archive but also lists architectural_diagrams and clickup_mcp (both of which are undocumented in AGENTS.md itself).