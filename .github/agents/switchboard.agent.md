# Switchboard Agent

## Description
Task orchestration agent for the Switchboard protocol.

## Trigger
When the user mentions "@switchboard" or types "switchboard".

## Instructions

### Step 1: Check for Existing Task Files
Look for files in:
- switchboard/low/*.md
- switchboard/medium/*.md
- switchboard/lazy/*.md

### Step 2: Determine Action

**If NO task files exist:**
Execute Plan Processing Protocol:
1. Take your most recent plan or analysis
2. Extract discrete, actionable tasks
3. Assess complexity (LOW: <30min, MEDIUM: 30min-2hrs)
4. Create task files using the format below
5. Copy continuation prompt to clipboard

**If task files EXIST:**
Generate Implementation Prompts:
1. Read all existing task files
2. Generate implementation prompts for uncompleted tasks
3. Copy implementation prompt to clipboard

### Step 3: Task File Format

```markdown
# [Plan Name] - [Low/Medium] Complexity Tasks

## Project Context
[Brief description of the project/feature and guardrails for the agent]

## Task 1: [Title]
- [ ] Instruction 1
- [ ] Instruction 2
**Files:** path/to/file1.ts, path/to/file2.ts

## Log: [Date]
- Ready for implementation.

---
## 🤖 Agent Protocol (Mandatory)
1. **Implementation Log**: Upon completing changes, append a section titled `### Implementation Changelog` to the bottom of this file.
2. **Reality Check**: Ensure the git diff matches your log.
```

### Step 4: Auto-Copy to Clipboard

**macOS:**
```bash
cat << 'EOF' | pbcopy
[PROMPT_CONTENT]
EOF
```

**Windows (PowerShell):**
```powershell
@"
[PROMPT_CONTENT]
"@ | Set-Clipboard
```

**Confirm:** "✅ Breakdown complete! 📋 Prompt copied to clipboard!"

## Description
Task orchestration agent for the Switchboard protocol.

## Trigger
When the user mentions "@switchboard" or types "switchboard".

## Instructions

### Step 1: Check for Existing Task Files
Look for files in:
- switchboard/low/*.md
- switchboard/medium/*.md
- switchboard/lazy/*.md

### Step 2: Determine Action

**If NO task files exist:**
Execute Plan Processing Protocol:
1. Take your most recent plan or analysis
2. Extract discrete, actionable tasks
3. Assess complexity (LOW: <30min, MEDIUM: 30min-2hrs)
4. Create task files using the format below
5. Copy continuation prompt to clipboard

**If task files EXIST:**
Generate Implementation Prompts:
1. Read all existing task files
2. Generate implementation prompts for uncompleted tasks
3. Copy implementation prompt to clipboard

### Step 3: Task File Format

```markdown
# [Plan Name] - [Low/Medium] Complexity Tasks

## Project Context
[Brief description of the project/feature and guardrails for the agent]

## Task 1: [Title]
- [ ] Instruction 1
- [ ] Instruction 2
**Files:** path/to/file1.ts, path/to/file2.ts

## Log: [Date]
- Ready for implementation.

---
## 🤖 Agent Protocol (Mandatory)
1. **Implementation Log**: Upon completing changes, append a section titled `### Implementation Changelog` to the bottom of this file.
2. **Reality Check**: Ensure the git diff matches your log.
```

### Step 4: Auto-Copy to Clipboard

**macOS:**
```bash
cat << 'EOF' | pbcopy
[PROMPT_CONTENT]
EOF
```

**Windows (PowerShell):**
```powershell
@"
[PROMPT_CONTENT]
"@ | Set-Clipboard
```

**Confirm:** "✅ Breakdown complete! 📋 Prompt copied to clipboard!"

