# Delta Sync Filtering in ClickUp and Linear APIs

## Executive Summary
This document provides a technical evaluation of server-side filtering capabilities by last-updated timestamps in the ClickUp v2 REST API and the Linear GraphQL API. Both platforms support server-side timestamp filtering, making incremental (delta) synchronization possible. However, they use distinct paradigms: ClickUp relies on a REST interface using Unix-millisecond timestamps and query parameters, whereas Linear utilizes a typed GraphQL schema with ISO 8601 strings and durations. 

This analysis details the exact parameters, data schemas, rate limits, and webhook architectures to assist the development team in integrating these tools into a VS Code extension.

---

## Tiered Findings

### Sub-Question 1: ClickUp List Task Endpoint
**Tier: Confirmed**

The ClickUp `GET /list/{list_id}/task` endpoint supports server-side filtering by the last-updated timestamp through specific query parameters.

* **Exact Parameter Name**: `date_updated_gt` (greater than) and `date_updated_lt` (less than).
* **Expected Value Format**: Unix epoch milliseconds represented as an integer (e.g., `1735689600000` for January 1, 2026, 00:00:00 UTC).
* **Support for `order_by=updated`**: Supported. The query parameter `order_by` accepts the value `updated` (default is `created`; other options include `id` and `due_date`).
* **Code Example**:
```http
GET https://api.clickup.com/api/v2/list/901500234123/task?date_updated_gt=1735689600000&order_by=updated&reverse=true HTTP/1.1
Authorization: pk_12345678_EXAMPLEKEY
Accept: application/json
```

---

### Sub-Question 2: ClickUp Workspace Task Fallback
**Tier: Confirmed**

Since the list-level task endpoint natively supports `date_updated_gt`, a fallback is not strictly required. However, for broader or cross-list synchronizations, ClickUp provides a workspace-level equivalent.

* **Fallback Endpoint**: `GET /team/{team_id}/task` (Get Filtered Team Tasks).
* **Filtering and Sorting Support**: This endpoint accepts the same query parameters as the list endpoint, including `date_updated_gt`, `date_updated_lt`, and `order_by=updated`.
* **Code Example**:
```http
GET https://api.clickup.com/api/v2/team/9010065123/task?date_updated_gt=1735689600000&order_by=updated HTTP/1.1
Authorization: pk_12345678_EXAMPLEKEY
Accept: application/json
```

---

### Sub-Question 3: Linear GraphQL `IssueFilter` Field
**Tier: Confirmed**

Linear’s GraphQL API supports filtering by update dates within its `IssueFilter` input object.

* **Comparison Field**: `updatedAt`.
* **GraphQL Input Type**: `DateComparator`.
* **Operators**: Supports comparison operators including `gt` (greater than), `gte` (greater than or equal), `lt` (less than), `lte` (less than or equal), `eq`, `neq`, `in`, and `nin`.
* **Expected Value Format**: `DateTimeOrDuration` scalar type. This accepts:
  1. Standard **ISO 8601 strings** (e.g., `"2026-01-01T00:00:00.000Z"`).
  2. Relative **duration strings** (e.g., `"-P2W1D"` representing two weeks and one day ago).
  3. Year shortcuts (e.g., `"2025"`).

---

### Sub-Question 4: Linear GraphQL Query Syntax
**Tier: Confirmed**

The correct GraphQL query structure uses the `filter` argument inside the `issues` connection. The `updatedAt` field is an object that wraps the comparison operator.

* **Query Syntax Example**:
```graphql
query GetDeltaIssues($cursor: String) {
  issues(
    filter: {
      updatedAt: { gt: "2026-01-01T00:00:00Z" }
    }
    orderBy: updatedAt
    first: 50
    after: $cursor
  ) {
    nodes {
      id
      identifier
      title
      updatedAt
      state {
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

---

### Sub-Question 5: Rate-Limiting Considerations
**Tier: Confirmed**

Polling every 30 to 60 seconds with delta queries requires handling rate-limiting behavior.

* **ClickUp Limits**: 
  * Enforces a standard rate limit of **100 requests per minute** per API token (for personal and OAuth tokens).
  * Exceeding this limit returns an **HTTP 429 Too Many Requests** status code.
  * Response headers include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix timestamp). Developers should inspect the `Retry-After` header before re-attempting requests.
* **Linear Limits**:
  * Enforces a standard rate limit of **5,000 requests per hour** for personal API keys and OAuth tokens.
  * Returns an **HTTP 429** status on exhaustion.
  * Response headers include `X-RateLimit-Requests-Limit`, `X-RateLimit-Requests-Remaining`, and `X-RateLimit-Requests-Reset` (UTC epoch milliseconds).
  * *Query Complexity*: Linear computes query complexity dynamically. Simple flat queries like `issues` have low cost, but nested queries with deep relationships consume the limit faster.
* **VS Code Polling Impact**: Polling once every 30 seconds yields 120 requests/hour per active user. This safely fits under both ClickUp's (~6,000 requests/hour) and Linear's (5,000 requests/hour) thresholds. However, if multiple files or workspaces are synced concurrently, or if multiple developers share a single token, workspace-level rate limits can be reached.

---

### Sub-Question 6: Webhook Alternatives for VS Code Extensions
**Tier: Likely**

Both platforms support webhook architectures to push changes in real-time, offering an alternative to constant polling.

* **ClickUp Webhooks**: Webhooks can be registered via the API (`POST /webhook`) to trigger on events like `taskUpdated`, `taskCreated`, and `taskDeleted`.
* **Linear Webhooks**: Offers a webhook subscription model with event types like `Issue` (`create`, `update`, `remove`). Payloads are delivered as JSON and verified using HMAC-SHA256 signatures.
* **Local Client Limitation**: VS Code extensions run locally on developers' machines behind local firewalls and NAT configurations. These environments cannot directly receive public incoming HTTP POST requests from ClickUp or Linear servers.
* **Recommended Extension Architectures**:
  1. **Relay Server (WebSocket/SSE Proxy)**: Host a lightweight cloud receiver (e.g., AWS Lambda, Vercel, or Hookdeck). This server registers as the webhook URL with ClickUp/Linear. When a webhook is received, the server pushes the event to the VS Code extension over a persistent WebSocket connection or Server-Sent Events (SSE) stream.
  2. **Short-Interval Local Polling fallback**: Continue using delta-timestamp polling within the local client. To mitigate rate limits, implement backoff logic that suspends polling when the VS Code window is unfocused or idle.

---

## Trade-Off Evaluation

### Architecture 1: Polling vs. Webhooks

| Evaluation Dimension | Polling (30-60s Delta Sync) | Webhooks (via Cloud Relay) |
| :--- | :--- | :--- |
| **Data Latency** | High (up to 60 seconds delay). | Low (near real-time delivery within seconds). |
| **Infrastructure Overhead** | None (client-side execution only). | Medium (requires hosting, monitoring, and securing a cloud relay service). |
| **API Token Efficiency** | Low (creates constant request noise even when no tasks change). | High (requests are only made when meaningful mutations occur). |
| **Local Environment Compatibility** | High (works behind NAT, firewalls, and offline). | Low (requires a gateway proxy to cross the local boundary). |

---

### Architecture 2: Server-Side vs. Client-Side Filtering

| Evaluation Dimension | Server-Side Filtering (`date_updated_gt` / `updatedAt`) | Client-Side Filtering (Fetch All & Filter locally) |
| :--- | :--- | :--- |
| **Network Bandwidth** | Low (only transfers newly modified tasks). | Very High (downloads the entire workspace database every sync). |
| **Local Memory Footprint** | Minimal (parses small, incremental payloads). | High (requires processing and diffing large datasets in-memory). |
| **API Rate Limit Consumption** | Low (requires fewer paginated pages per request cycle). | Extremely High (exhausts limits quickly by fetching historic tasks repeatedly). |
| **Implementation Complexity** | Medium (requires managing sync states and date math). | Low (trivial to implement, but unscalable). |

---

## Glossary of API-Specific Terms

* **`date_updated_gt`**: A ClickUp REST API query parameter used to request tasks with an update timestamp greater than a specified value.
* **`DateComparator`**: A Linear GraphQL input object containing scalar-to-scalar comparison keys (`eq`, `gt`, `lt`, etc.) used to evaluate date fields.
* **`DateTimeOrDuration`**: A custom Linear GraphQL scalar that parses standard ISO 8601 timestamps or relative ISO 8601 duration offsets.
* **Epoch Milliseconds**: A numeric representation of date/time as milliseconds elapsed since January 1, 1970. Standard format for ClickUp date fields.
* **ISO 8601**: An international standard for date and time formatting (e.g., `YYYY-MM-DDTHH:mm:ssZ`). Standard format for Linear timestamp inputs.
* **Relay-Style Pagination**: A Cursor-based pagination design patterns using `first`/`after` variables and `pageInfo` metadata to navigate records without offset drift.

---

## Source List

### Required Sources (Official Documentation)
1. **ClickUp REST API Reference**: `GET /list/{list_id}/task` Endpoint Specifications (developer.clickup.com)
2. **ClickUp REST API Reference**: `GET /team/{team_id}/task` Workspace Task Filtering (developer.clickup.com)
3. **ClickUp API Reference Manual**: Rate Limiting Thresholds and HTTP Headers (developer.clickup.com)
4. **ClickUp Webhooks API Guide**: Subscription Management and Location Scoping (developer.clickup.com)
5. **ClickUp Help Center**: Automations, Webhooks, and Action Quota Limits by Plan (help.clickup.com)
6. **Linear Developers Portal**: GraphQL API Filtering System (developers.linear.app)
7. **Linear Developers Portal**: Cursor-Based Pagination and Ordering Guidelines (developers.linear.app)
8. **Linear Developers Portal**: Webhooks Architecture & Payload Signature Verification (developers.linear.app)
9. **Linear Developers Portal**: API Request Rate Limiting Best Practices (developers.linear.app)
10. **Linear GraphQL Schema Definitions**: `IssueFilter` Input Object Specification (Studio / Apollo)
11. **Linear GraphQL Schema Definitions**: `DateComparator` Structure and Comparison Keys
12. **Linear GraphQL Schema Definitions**: `DateTimeOrDuration` Scalar Parsing Rules
13. **Linear GraphQL Schema Definitions**: `Issue` Object Fields
14. **Linear VS Code Integration**: Authentication and Extension Guidelines (linear.app)

### Recommended Sources (Community & SDKs)
15. **Apache DevLake Github Repository**: Issue #8901 - Linear Incremental Sync Implementation using `updatedAt`
16. **Linear Python Client SDK (`Hacker0x01/linear-python-client`)**: Syntax for `IssuesRequest` and Filter Dictionary Mapping
17. **Linear Go SDK (`github.com/guillermo/linear`)**: Go Types for `DateComparator` and `IssueFilter`
18. **Prismatic Integration Connector Docs**: "ClickUp Connector Changelog - `date_updated_gt` Implementation"
19. **VS Code Extension Marketplace**: `strigo.linear` - VSCode Linear Extension Source Repository
20. **Vertex AI ClickUp R Interface (`clickrup`)**: Task Query Parameters Mapping and Date Conversion
21. **Reddit Community (`r/clickup`)**: Troubleshooting Python Task List API Errors
22. **Reddit Community (`r/clickup`)**: Custom Field Support for ClickUp Subtasks
23. **Truto API Integrations**: ClickUp Task Response Format and Field Definitions

### Opinion Sources (Blog Posts & Newsletters)
24. **Merge.dev Engineering Blog**: "How to retrieve and sync tasks from ClickUp using JavaScript"
25. **Inventive HQ Guides**: "Linear Webhooks: Complete Integration Guide with Payload Examples"
26. **Medium Publication (Coders Stop)**: "Webhook vs Polling: When to Use Each Approach"
27. **Medium Publication (Sohail Saifi)**: "The Math Behind Polling Inefficiencies and Webhook Architecture"
28. **ByteByteGo Newsletter**: "EP100: Structural Tradeoffs Between Polling and Webhooks"
29. **Merge.dev Engineering Blog**: "API Polling vs Webhooks: When to Use One Over the Other"
30. **Hookdeck Engineering Guides**: "Throttling and Queueing Webhooks to Solve Rate Limiting Issues"
31. **Truto Engineering Blog**: "Connect ClickUp to AI Agents: Parsing Task Stagnation via `date_updated`"
32. **Hevo Data Integration Guides**: "ClickUp Data Pipeline Authentication and Rate Limits"
33. **Steampipe SQL Database Blog**: "Ingesting Web Data Directly: Querying ClickUp via Postgres"