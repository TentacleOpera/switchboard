# ClickUp API Version Inventory

This file tracks the version (v2 vs. v3) of all ClickUp REST API endpoint families used in Switchboard.

Core CRUD (tasks, lists, folders, spaces, comments, tags, members, webhooks) stays on v2 as there are no v3 equivalents. When ClickUp ships a v3 equivalent for a family, flip that family's call sites through `httpRequestVersioned('v3', ...)` and update this ledger.

| Endpoint family | Call sites (line numbers / methods) | v3 status as of 2026-07 | Version used |
| :--- | :--- | :--- | :--- |
| `GET /team` (workspaces list, health check) | workspaces list, `isAvailable()` | Stays v2 (no v3 workspaces list) | v2 |
| `GET /team/{id}/space` | `getSpaces()` | Stays v2 (no v3 equivalents) | v2 |
| `GET/POST /space/{id}/folder`, `DELETE /folder/{id}` | `getFolders()`, etc. | Stays v2 (no v3 equivalents) | v2 |
| `GET/POST /folder/{id}/list`, `GET /space/{id}/list`, `GET /list/{id}` | `getLists()`, etc. | Stays v2 (no v3 equivalents) | v2 |
| Task CRUD (`GET/PUT/DELETE /task/{id}`, `POST /list/{id}/task`, `GET /list/{id}/task`) | `updateTask()`, task details | Stays v2 (no v3 equivalents) | v2 |
| Tasks in Multiple Lists (`POST /list/{id}/task/{taskId}`) | add to lists | Stays v2 (no v3 equivalents) | v2 |
| Comments (`GET/POST /task/{id}/comment`, `GET/POST /comment/{id}/reply`) | `addTaskComment()`, comments list | Stays v2 (no v3 comment CRUD) | v2 |
| Tags, members, custom fields on lists (`GET /space/{id}/tag`, `GET /list/{id}/member`, `POST /list/{id}/field`) | list fields, members | Stays v2 (no v3 equivalents) | v2 |
| Task attachment upload (`POST /task/{id}/attachment`) | `attachFile()` | migrated to modern v3 Attachments API | v3 |
| Docs (`/workspaces/{id}/docs...`) | `createDocPage()`, ClickUpDocsAdapter | Already v3 (singular forms deprecated, plural is canonical) | v3 |
| Raw proxy (`makeApiRequest`) | LocalApiServer proxy endpoint | Version-aware (respects /v2/ or /v3/ prefix) | v2 / v3 |
| Move Task (`PUT /api/v3/workspaces/{workspace_id}/tasks/{task_id}/home_list/{list_id}`) | `moveTask()` | modern v3-only endpoint | v3 |
