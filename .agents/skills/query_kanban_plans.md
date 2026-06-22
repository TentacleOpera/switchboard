---
name: Query Kanban Plans
description: Query the Kanban database for plans by workspace name, project, and epics.
---

# Query Kanban Plans

Ready-made SQL templates for querying the Switchboard Kanban `plans` table by workspace name, project, and epic/subtask relationships.

## Discovering Workspace Names

Run this query first to identify the human-readable workspace names present in the database:

```sql
SELECT DISTINCT workspace_name FROM plans WHERE workspace_name != '';
```

---

## Workspace Name Queries

### Find all active plans in a workspace by name

```sql
SELECT plan_id, topic, kanban_column, complexity, project
FROM plans
WHERE workspace_name = 'Autism360App' AND status = 'active';
```

---

## Project Queries

### Find all plans assigned to a specific project in a workspace

```sql
SELECT plans.plan_id, plans.topic, plans.kanban_column
FROM plans
JOIN projects ON plans.project_id = projects.id
WHERE projects.name = 'MyProject' AND plans.workspace_name = 'Autism360App' AND plans.status = 'active';
```

### Find all unassigned plans in a workspace

```sql
SELECT plan_id, topic, kanban_column
FROM plans
WHERE project_id IS NULL AND workspace_name = 'Autism360App' AND status = 'active';
```

---

## Epic and Subtask Queries

### List all epics in a workspace

```sql
SELECT plan_id, topic, kanban_column
FROM plans
WHERE is_epic = 1 AND workspace_name = 'Autism360App' AND status = 'active';
```

### Find all subtasks for a specific epic

```sql
SELECT plan_id, topic, kanban_column, status
FROM plans
WHERE epic_id = '<epic_plan_id>' AND workspace_name = 'Autism360App' AND status = 'active';
```

### Get all epics with their active subtask counts

```sql
SELECT epic.plan_id AS epic_id, epic.topic AS epic_topic, COUNT(sub.plan_id) AS subtask_count
FROM plans epic
LEFT JOIN plans sub ON sub.epic_id = epic.plan_id AND sub.status = 'active'
WHERE epic.is_epic = 1 AND epic.workspace_name = 'Autism360App' AND epic.status = 'active'
GROUP BY epic.plan_id, epic.topic;
```

---

## Plan Type & Classification Queries

### Count plans by column type for a workspace

```sql
SELECT kanban_column, COUNT(*) AS count
FROM plans
WHERE workspace_name = 'Autism360App' AND status = 'active'
GROUP BY kanban_column;
```
