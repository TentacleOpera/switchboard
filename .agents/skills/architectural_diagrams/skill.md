# Architectural Diagrams Skill

Generate Mermaid architectural diagrams from codebase analysis, render to images, and upload to ClickUp/Linear tickets.

## When to Use
- When creating plans that involve service boundary changes
- When reviewing architectural impact of proposed changes
- When documenting data flow for complex operations
- When team review requires visual artifacts in tickets

## Usage
Invoke with `skill: "architectural_diagrams"` during plan generation or review. Requires a ClickUp task ID or Linear issue ID to upload the diagram.

## Diagram Types
- **Flowchart:** Service boundaries and dependencies (default)
- **Sequence:** Data flow and operation sequencing
- **Component:** Module structure and interfaces

## Parameters
- `diagramType`: "flowchart" (default), "sequence", "component"
- `maxNodes`: Maximum nodes to display (default 50, use lower for large codebases)
- `focusPath`: Relative path to focus analysis on (e.g., "src/services/")
- `detailLevel`: "summary" (grouped) or "detailed" (expanded)
- `target`: ClickUp task ID or Linear issue ID to upload the diagram to
- `platform`: "clickup" or "linear"
- `preview`: Show IDE preview before upload (default: true)

## Prerequisites
- Configure ClickUp/Linear API tokens in VS Code settings

## Example
```
skill: "architectural_diagrams"
Generate a flowchart diagram for src/services/ with maxNodes=30
Preview in IDE, then upload to ClickUp task ABC123
```
