# Query Kanban Plans

Ready-made SQL templates for querying the Switchboard Kanban `plans` table by workspace name, project, and feature/subtask relationships.

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

## Feature and Subtask Queries

### List all features in a workspace

```sql
SELECT plan_id, topic, kanban_column
FROM plans
WHERE is_feature = 1 AND workspace_name = 'Autism360App' AND status = 'active';
```

### Find all subtasks for a specific feature

```sql
SELECT plan_id, topic, kanban_column, status
FROM plans
WHERE feature_id = '<feature_plan_id>' AND workspace_name = 'Autism360App' AND status = 'active';
```

### Get all features with their active subtask counts

```sql
SELECT feature.plan_id AS feature_id, feature.topic AS feature_topic, COUNT(sub.plan_id) AS subtask_count
FROM plans feature
LEFT JOIN plans sub ON sub.feature_id = feature.plan_id AND sub.status = 'active'
WHERE feature.is_feature = 1 AND feature.workspace_name = 'Autism360App' AND feature.status = 'active'
GROUP BY feature.plan_id, feature.topic;
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
