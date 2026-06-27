# Technical Platform Integration Analysis

## Executive Summary

This report evaluates the current API behaviors of the Notion REST API (version 2022-06-28), the Linear GraphQL API, and Model Context Protocol (MCP) connectors to assess the technical feasibility of using these platforms as asynchronous message buses for an AI agent. 

### Integration Design Assumptions Matrix

| Assumption | Target Platform | Status / Verdict | Risk Level | Technical Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Database Polling via System Timestamps** | Notion | **Safe (with Syntax Caveat)** | Low | Polling via `last_edited_time` is supported. However, including a `"property"` parameter in the filter is an instant 400 error. Notion's minute-level rounding of timestamps introduces race condition risks. |
| **Integration Bot Self-Identification** | Notion | **Safe / Confirmed** | Low | The `created_by` field on database items created by the integration is populated with the integration's static bot ID. This ID can be fetched via `GET /v1/users/me` and compared directly to filter out self-authored rows. |
| **Comments Don't Bump Page Edited Time** | Notion | **Safe / Confirmed** | Low | Creating or updating page comments using the Notion API does **NOT** update the parent page's `last_edited_time` or `last_edited_by` fields. The separate "Comments" database architecture in the current design is a correct and safe workaround. |
| **Model Context Protocol (MCP) Tool Coverage** | Notion | **Risky** | Medium | Universal operations are limited to search, page reads, page creation, and property updates. Commenting and advanced querying are highly inconsistent across local/third-party MCP servers. Even the official hosted MCP server has a parameter bug (`page_id` vs `block_id`) that prevents retrieving inline comments. |
| **Linear Issue Polling via `updatedAt` for Comments** | Linear | **Wrong / Broken** | Critical | Linear `Comment` entities are separate nodes. Creating a comment on an issue does **NOT** update the parent issue's `updatedAt` timestamp. Polling issues by `updatedAt` will fail to detect comment activity, leading to missing data. |

---

## Findings

### 1. Notion Database Query API & Timestamp Filtering
*   **Verdict**: Confirmed (with Syntax Caveats & Deprecation Risk)
*   **Technical Behavior**: Under the Notion REST API version `2022-06-28`, the `POST /v1/databases/{id}/query` endpoint supports filtering by both `timestamp: "last_edited_time"` and `timestamp: "created_time"` using the `on_or_after` condition.
*   **Syntax Constraint**: The filter object must **not** contain a `"property"` field. Defining a `"property"` parameter inside a timestamp filter will result in a validation error (`400 Bad Request`). The filter must use the `"timestamp"` keyword at the root of the filter condition.
*   **Filter JSON Shape (last_edited_time)**:
    ```json
    {
      "filter": {
        "timestamp": "last_edited_time",
        "last_edited_time": {
          "on_or_after": "2025-05-15T12:00:00.000Z"
        }
      }
    }
    ```
*   **Filter JSON Shape (created_time)**:
    ```json
    {
      "filter": {
        "timestamp": "created_time",
        "created_time": {
          "on_or_after": "2025-05-15T12:00:00.000Z"
        }
      }
    }
    ```
*   **Critical Limitations**:
    1.  **Minute-Level Rounding**: Notion's system-managed `created_time` and `last_edited_time` values are rounded down to the nearest minute. This creates a severe race-condition window where multiple updates occurring within the same calendar minute cannot be sequentially ordered by timestamp, potentially leading to missed deltas or double-processing during short polling intervals.
    2.  **Filter Nesting Limits**: Compound filters can only be nested up to 2 levels deep (using `and`/`or` operators).
    3.  **Deprecation to Data Sources**: In the modern `2025-09-03` and `2026-03-11` API versions, the concepts of databases and data sources are split. Databases act as containers, and individual tables act as "data sources" under the parent database. The old database query endpoint is deprecated. Modern integrations must fetch `data_sources` from the database container first, then query the data source via `POST /v1/data_sources/{data_source_id}/query`.

### 2. Notion `created_by` on Database Items
*   **Verdict**: Confirmed
*   **Technical Behavior**: When a page (database row) is created by an integration, Notion automatically populates the `created_by` property with a Partial User object.
*   **Identity Integrity**: The `created_by` object represents the integration bot itself, containing the bot's static unique ID, and **not** the ID of the workspace owner who authorized the integration.
*   **Self-Authored Filtering**: The ID found in `created_by.id` on authored pages matches the ID returned by the `GET /v1/users/me` endpoint. Comparing these two IDs is a reliable way for an integration to identify and filter out its own self-authored rows to prevent feedback loops.
*   **User Object Shape**:
    ```json
    "created_by": {
      "object": "user",
      "id": "e79a0b74-3aba-4149-9f74-0bb5791a6ee6"
    }
    ```

### 3. Notion `/v1/users/me` Endpoint Behavior
*   **Verdict**: Confirmed
*   **Technical Behavior**: The `GET /v1/users/me` endpoint returns the user object associated with the active authentication token.
*   **Response Shape for Internal/Public Integration Tokens**:
    For bot-based integration tokens, the endpoint returns a user object of `type: "bot"`. This contains the bot's unique ID, which matches the `created_by.id` on elements modified or created by this integration.
    ```json
    {
      "object": "user",
      "id": "e79a0b74-3aba-4149-9f74-0bb5791a6ee6",
      "name": "Integration Agent Bot",
      "avatar_url": null,
      "type": "bot",
      "bot": {
        "owner": {
          "type": "workspace",
          "workspace": true
        },
        "workspace_name": "Quantify Labs"
      }
    }
    ```
*   **Behavior under Personal Access Tokens (PATs)**:
    If the integration uses a Personal Access Token (PAT) (reintroduced for user-scoped workflows), `GET /v1/users/me` behaves differently: it returns the *person* user object of the PAT's creator (`type: "person"`), which contains their email and user metadata. Pages created with a PAT show the *person* as the creator. While matching still works, the type is no longer `"bot"`.

### 4. Notion Page Comments & `last_edited_time`
*   **Verdict**: Confirmed
*   **Technical Behavior**: Adding a native comment to a page via the Notion API (e.g., `POST /v1/comments`) does **NOT** modify or update the parent page's system-managed `last_edited_time` or `last_edited_by` fields.
*   **Rationale**: Notion's page-level `last_edited_time` is only updated when a database property is modified, or when page content block structures (headings, paragraphs, etc.) are appended or edited. Native comments belong to a separate, disconnected comments stream and do not touch the page's core properties or block tree.
*   **Design Validation**: The team's choice to use a separate "Comments" database in Notion to record comments (rather than relying on native page comments) is **safe and correct** for a polling-based architecture. Writing comment records as database rows guarantees that the parent database's `last_edited_time` is bumped, making the delta polling model functional.

### 5. Notion Model Context Protocol (MCP) Capabilities
*   **Verdict**: Partially Supported
*   **Capability Matrix**:
    *   **Universally Supported (All Connectors & Hosted Server)**:
        *   `notion_search` / `notion_find`: Workspace-wide semantic/text search.
        *   `notion_fetch` / `notion_read_page`: Retrieve page metadata and content blocks, often pre-flattened to Markdown for token efficiency.
        *   `notion_create_pages` / `create-page`: Create pages under parent folders or databases.
        *   `notion_update_page`: Update page properties and text blocks.
    *   **Inconsistent or Absent Capabilities**:
        *   **Native Comments (`notion_create_comment` / `notion_get_comments`)**: Absent from most local and third-party MCP implementations (such as basic SDK wrappers). The official hosted Notion MCP server (`mcp.notion.com/mcp`) does export these tools, but they fail with a `403 Forbidden` unless the "Read comments" and "Insert comments" capabilities are explicitly toggled on the integration in the Notion Developer Portal (which are disabled by default).
        *   **Inline Block Comments Bug (Issue #175)**: The hosted MCP server's implementation of `notion-get-comments` passes a `page_id` parameter to the underlying Notion endpoint rather than `block_id`. This means that inline comments (discussions anchored to a specific block ID on the page) return empty arrays and are completely unretrievable.
        *   **Headless Integration Block**: The hosted remote MCP server uses browser-based OAuth authentication. This represents a complete blocker for background, headless, or cron-driven AI agents. A headless backend agent must bypass the hosted server and use a local MCP server configured with an internal integration token or PAT.

### 6. Linear GraphQL Issue Filtering & Comment Updates
*   **Verdict**: Partially Supported (Filtering is Confirmed, Comment Updating is Not Supported)
*   **Technical Behavior**: The Linear GraphQL API supports filtering the `issues` query using comparison operators on the `updatedAt` datetime field.
*   **GraphQL Query Shape**:
    ```graphql
    query GetIssuesUpdatedSince($since: DateTime!) {
      issues(filter: { updatedAt: { gt: $since } }, first: 50) {
        nodes {
          id
          title
          updatedAt
          comments {
            nodes {
              id
              body
              createdAt
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    ```
    *(Note: Both `{ gt: $since }` [greater-than] and `{ gte: $since }` [greater-than-or-equal] are fully supported in the Linear `DateTimeFilter` schema).*
*   **Comment Bumping Behavior (Wrong Assumption)**: Adding, editing, or deleting an issue comment via Linear's `commentCreate` mutation **does NOT update the parent issue's `updatedAt` field**. The `updatedAt` timestamp on an `Issue` is strictly restricted to modifications of the issue's properties (such as state, priority, assignee, description, or title).
*   **Impact**: Polling `issues(filter: { updatedAt: { gt: $since } })` to detect new comments is fundamentally broken. Any comments posted by users (or other agents) will not bump the issue's timestamp, leaving those comments invisible to the polling mechanism.

---

## Trade-off Evaluation

To resolve the critical failure in the Linear polling design, two alternative approaches are evaluated below for the backend engineering team.

### Architectural Alternatives Comparison

| Evaluation Dimension | Option A: Event-Driven Webhooks (Recommended) | Option B: Multi-Entity Polling Engine (Fallback) |
| :--- | :--- | :--- |
| **Data Synchronization Model** | Push-based event handling. | Dual-stream pull-based polling. |
| **Development Overhead** | **Medium**: Requires exposing a public webhook receiver endpoint and implementing signature verification (`Linear-Signature` HMAC-SHA256). | **Low**: Fits into the team's existing cron/polling architecture. |
| **Maintenance Complexity** | **Low**: Avoids managing cursors, stateful timestamps, and complex interval logic. | **High**: Must maintain two separate cursor timestamps (one for issues, one for comments) and merge states. |
| **Real-Time Latency** | **Sub-second**: Instantaneous triggering. | **High**: Constrained by the polling interval (e.g., 1 min, 5 min). |
| **API Token / Rate Limit Cost** | **Zero cost**: Webhooks do not consume API rate-limit quotas. | **High**: Doubling poll requests to query both `issues` and `comments` nodes concurrently. |
| **Infrastructure Overhead** | Requires an internet-facing endpoint to receive HTTP POST payloads from Linear's servers. | Can run completely inside a private network or VPC without public ingress. |

### Option A: Webhook-Driven Architecture (Recommended Implementation)
This approach removes polling entirely, replacing it with an event-driven model. 
1.  **Subscription**: Register a webhook in Linear with resource types `["Issue", "Comment"]`.
2.  **Processing**:
    *   When an `Issue` event (create/update) is received, extract the issue payload.
    *   When a `Comment` event (create) is received, extract `issueId` from the payload, fetch the associated issue details, and process the comment directly.

### Option B: Multi-Entity Polling Engine (Fallback Implementation)
If webhooks are forbidden due to network security constraints, the polling system must be split into two distinct queues:
1.  **Poll Issue Deltas**:
    Query `issues(filter: { updatedAt: { gt: $issueCursor } })` to capture metadata and state transitions. Update `$issueCursor` with the maximum `updatedAt` received.
2.  **Poll Comment Deltas**:
    Query `comments(filter: { createdAt: { gt: $commentCursor } })` to capture new discussions. Update `$commentCursor`. Match the comments back to the respective issues in the database using the returned `issue.id` field.
    ```graphql
    query GetRecentComments($since: DateTime!) {
      comments(filter: { createdAt: { gt: $since } }, first: 100) {
        nodes {
          id
          body
          createdAt
          issue {
            id
            title
          }
        }
      }
    }
    ```

---

## Glossary

*   **Integration Bot**: A special system user created in the Notion Developer portal that represents an API connection. It operates under specific scoped workspace and page permissions.
*   **Internal Token**: A static workspace-specific API key used to authorize internal integrations without requiring an OAuth consent flow.
*   **Model Context Protocol (MCP) Connector**: A standard gateway server that translates Model Context Protocol tool schemas into specific target API requests, enabling LLM models to interact with platforms like Notion.
*   **Delta Cursor**: A stored timestamp or ID indicator marking the high-water mark of processed updates, used to fetch only incremental changes in subsequent sync loops.
*   **DateTimeFilter**: A Linear input type schema used in GraphQL queries to apply comparison filters (`gt`, `gte`, `lt`, `lte`, `eq`) on date-time fields.
*   **System Timestamps**: Automated, non-writable date-time markers (such as `created_time`, `last_edited_time`, `createdAt`, `updatedAt`) managed directly by the platform databases.

---

## Sources

### Notion REST API & Platform Documentation (developers.notion.com)
1. Notion API Reference — Databases: `https://developers.notion.com/reference/database`
2. Notion API Reference — Query a Database: `https://developers.notion.com/reference/post-database-query`
3. Notion API Reference — Filter Database Entries: `https://developers.notion.com/reference/post-database-query-filter`
4. Notion API Reference — Sort Database Entries: `https://developers.notion.com/reference/post-database-query-sort`
5. Notion API Reference — Retrieve a Database: `https://developers.notion.com/reference/retrieve-a-database`
6. Notion API Reference — Update a Database: `https://developers.notion.com/reference/update-a-database`
7. Notion API Reference — Update Database Properties: `https://developers.notion.com/reference/update-property-schema`
8. Notion API Reference — Pages: `https://developers.notion.com/reference/page`
9. Notion API Reference — Create a Page: `https://developers.notion.com/reference/post-page`
10. Notion API Reference — Retrieve a Page: `https://developers.notion.com/reference/retrieve-a-page`
11. Notion API Reference — Update Page Properties: `https://developers.notion.com/reference/patch-page`
12. Notion API Reference — Users: `https://developers.notion.com/reference/user`
13. Notion API Reference — Retrieve a User: `https://developers.notion.com/reference/get-user`
14. Notion API Reference — List All Users: `https://developers.notion.com/reference/get-users`
15. Notion API Reference — Retrieve Token Bot User: `https://developers.notion.com/reference/get-self`
16. Notion API Reference — Comments: `https://developers.notion.com/reference/comment`
17. Notion API Reference — Create a Comment: `https://developers.notion.com/reference/post-comment`
18. Notion API Reference — Retrieve Comments: `https://developers.notion.com/reference/get-comments`
19. Notion API Reference — Blocks: `https://developers.notion.com/reference/block`
20. Notion API Reference — Append Block Children: `https://developers.notion.com/reference/patch-block-children`
21. Notion API Reference — Pagination: `https://developers.notion.com/reference/pagination`
22. Notion API Guide — Working with Databases: `https://developers.notion.com/docs/working-with-databases`
23. Notion API Guide — Working with Comments: `https://developers.notion.com/docs/working-with-comments`
24. Notion API Guide — Authorization & Connections: `https://developers.notion.com/docs/authorization`
25. Notion API Guide — Personal Access Tokens: `https://developers.notion.com/docs/personal-access-tokens`
26. Notion API Guide — Versioning and Upgrading: `https://developers.notion.com/docs/versioning`
27. Notion API Guide — Upgrade to 2025-09-03: `https://developers.notion.com/docs/upgrading-to-2025-09-03`
28. Notion API Guide — Working with Views: `https://developers.notion.com/docs/working-with-views`
29. Notion API Guide — Querying Large Data Sources: `https://developers.notion.com/docs/query-large-data-sources`
30. Notion Public Changelog — Filter by Timestamp Addition: `https://developers.notion.com/changelog/filter-databases-by-timestamp-even-if-they-dont-have-a-timestamp-property`
31. Notion Public Changelog — Last Edited Timestamp Precision Adjustment: `https://developers.notion.com/changelog/last-edited-time-is-now-rounded-to-the-nearest-minute`
32. Notion Public Changelog — Full Comment API Release Notes: `https://developers.notion.com/changelog`

### Linear GraphQL API & Platform Documentation (developers.linear.app)
33. Linear API Reference — Overview: `https://developers.linear.app/docs/graphql/working-with-api`
34. Linear API Reference — Schema Explorer (Issues): `https://developers.linear.app/docs/graphql/schema/objects/issue`
35. Linear API Reference — Schema Explorer (Comments): `https://developers.linear.app/docs/graphql/schema/objects/comment`
36. Linear API Reference — Webhooks Overview: `https://developers.linear.app/docs/graphql/webhooks`
37. Linear API Reference — OAuth Authentication: `https://developers.linear.app/docs/graphql/oauth`
38. Linear API Reference — Advanced Filtering: `https://developers.linear.app/docs/graphql/filtering`
39. Linear API Reference — Connection Pagination: `https://developers.linear.app/docs/graphql/pagination`
40. Linear Developer Guide — Fetching and Modifying Data: `https://developers.linear.app/docs/graphql/fetching-data`
41. Linear Developer Guide — Integration Best Practices (Agent Interaction): `https://developers.linear.app/docs/graphql/agent-interaction`
42. Linear Public Changelog — API and Webhook Updates: `https://linear.app/changelog`

### Developer SDKs, MCP Specs & Repositories
43. Notion official JS SDK on GitHub: `https://github.com/makenotion/notion-sdk-js`
44. Linear official TS SDK on GitHub: `https://github.com/linear/linear/tree/master/packages/sdk`
45. Notion Official Model Context Protocol (MCP) Server: `https://github.com/makenotion/notion-mcp-server`
46. Model Context Protocol Specifications: `https://modelcontextprotocol.io`
47. Community Notion MCP Server (suekou): `https://github.com/suekou/mcp-notion-server`
48. Community Linear MCP Server (cosmix): `https://github.com/cosmix/linear-mcp`
49. GitHub Issues on Notion MCP Server: `https://github.com/makenotion/notion-mcp-server/issues`
50. Linear Python SDK Client: `https://github.com/Hacker0x01/linear-python-client`