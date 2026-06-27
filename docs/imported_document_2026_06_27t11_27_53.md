# Linear API Behavioral and Rate Limit Investigation

## Executive Summary

Integrating a VS Code extension with Linear's GraphQL API requires a clear understanding of its rate-limiting mechanisms, schema behaviors, and plan restrictions. This investigation clarifies Linear's API patterns, confirming that core issue updates bump the `updatedAt` field, while child entities (like comments and relations) do not. It also establishes that the free-tier limit is strictly 250 non-archived issues per workspace, and details the newly introduced public GraphQL subscription features alongside traditional webhooks. The central finding indicates that while Linear's API design is developer-friendly, a successful bidirectional sync and automation pipeline must combine GraphQL subscriptions (or webhooks) with robust query-complexity budget management to operate efficiently under Linear’s strict rate limits.

## Findings by Sub-Question

### 1. `updatedAt` Behavior and Delta-Polling

*   **API Behavior**: Updating an issue's description, title, priority, assignee, status, or other standard properties via the `issueUpdate` mutation immediately bumps the issue's `updatedAt` timestamp. However, modifying associated child entities—such as adding/editing a `Comment`, linking an `Attachment`, defining an `IssueRelation`, or adding an emoji `Reaction`—does **NOT** modify the parent issue's `updatedAt` timestamp. These sub-resources contain their own separate `updatedAt` fields.
*   **API Reliability**: `updatedAt` is exposed as a `DateTime!` field in the GraphQL schema. It is indexed and reliable for sorting and filtering issues (e.g., querying `issues(orderBy: updatedAt, filter: { updatedAt: { gt: $since } })`).
*   **Finding Tier**: **Required** (Official GraphQL Schema and Developers Guide).
*   **Trade-off Evaluation**: Polling only updated issues via `updatedAt` will fail to detect new comments, attachments, or issue relations. Integrations relying solely on issue-level delta polling will experience sync drift unless they separately poll child collections or utilize webhooks/subscriptions.

### 2. Free-Tier Active-Issue Limit

*   **Current Limit**: The free tier restricts workspaces to **250 total issues**. 
*   **Definition of "Active"**: While historically referred to as "active issues," the limit applies to **all non-archived issues**. This includes backlog, triage, active, completed (done), and canceled states. Only issues where the `archivedAt` field is populated (archived issues) are excluded from this 250-issue limit. 
*   **Workspace vs. Team Scope**: The 250-issue limit applies **per workspace**, not per team. If a workspace exceeds 250 non-archived issues across all teams combined, issue creation is blocked.
*   **Finding Tier**: **Required** (Official Pricing and Billing Docs).
*   **Trade-off Evaluation**: Completed and canceled issues will quickly consume the 250-issue quota. Automated archival of completed issues is a highly effective way to keep free-tier users below the limit, though archived issues load slightly slower on-demand in the UI.

### 3. GraphQL API Rate Limits and Complexity

*   **Hourly Global Request Limits**:
    *   *Personal API Keys*: 2,500 requests per user per hour.
    *   *OAuth App Authentication*: 5,000 requests per user/app per hour.
    *   *Unauthenticated*: 600 requests per IP address per hour.
*   **Hourly Complexity Limits**:
    *   *Personal API Keys*: 3,000,000 complexity points per hour.
    *   *OAuth App Authentication*: 2,000,000 complexity points per hour.
    *   *Unauthenticated*: 100,000 complexity points per hour.
    *   *Single-Query Limit*: Max 10,000 complexity points per single request.
*   **Complexity Score Calculation**: Linear calculates query complexity based on retrieved schema depth and node weights:
    *   Each scalar property (e.g., `id`, `title`) = 0.1 points.
    *   Each nested object = 1 point.
    *   Connections (arrays) multiply the total points of their child fields by the pagination limit argument (e.g., `first: 50` or the default fallback of 50 if unspecified).
    *   The total score is rounded up to the nearest integer.
*   **Budgeting**: Read and write operations share the same hourly request and complexity budget. However, specific mutations or queries may have lower endpoint-specific limits, indicated in response headers starting with `X-RateLimit-Endpoint-*`.
*   **Finding Tier**: **Required** (Official Rate Limiting Docs).
*   **Trade-off Evaluation**: Request pagination depth must be explicitly constrained (e.g., `first: 10`). Relying on default connection sizes of 50 will quickly deplete the 10,000-point single-query budget, triggering immediate 400 Bad Request errors with the extensions code `RATELIMITED`.

### 4. Idempotency of Issue Archival

*   **Archiving Mechanism**: Archival cannot be performed by passing `archivedAt` via `issueUpdate`. Instead, it must be performed using the dedicated `issueArchive` mutation.
*   **Archival Mutation Shape**:
    ```graphql
    mutation IssueArchive($id: String!) {
      issueArchive(id: $id) {
        success
        entity {
          id
          archivedAt
        }
      }
    }
    ```
*   **Idempotency**: The `issueArchive` mutation is idempotent. If executed on an issue that has already been archived, the API returns `success: true` and the archived `entity` containing its original `archivedAt` timestamp. It does not throw an error or return an validation exception.
*   **Checking State**: To check an issue's archival state prior to executing a mutation, the integration must query the `archivedAt` field on the `Issue` type. The raw GraphQL schema does **NOT** expose an `isArchived` boolean field.
*   **Finding Tier**: **Required** (GraphQL Schema & Reference).
*   **Trade-off Evaluation**: Since `issueArchive` is fully idempotent, the extension does not need to execute a pre-check query, preserving API request and complexity budgets.

### 5. GraphQL Mutations and Payload Shapes

*   **Create Issue in Triage**: Issues created without an explicit `stateId` automatically route to the team's first Backlog status, or directly to the "Triage" view if triage is enabled.
    ```graphql
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          title
          description
          state {
            id
            name
          }
        }
      }
    }
    ```
    *Variables*:
    ```json
    {
      "input": {
        "title": "VS Code Sync Failure",
        "description": "Bidirectional description sync failed.",
        "teamId": "9cfb482a-81e3-4154-b5b9-2c805e70a02d"
      }
    }
    ```
*   **Create Comment with Programmatic Marker**:
    ```graphql
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment {
          id
          body
        }
      }
    }
    ```
    *Variables*:
    ```json
    {
      "input": {
        "issueId": "539068e2-ae88-4d09-bd75-22eb4a59612f",
        "body": "This comment contains hidden sync metadata.\n\n<!-- vscode-sync-id: 12345 -->"
      }
    }
    ```
*   **Sanitization Behavior**: Linear stores description and comment bodies verbatim as Markdown. It does not strip or sanitize HTML comment blocks (`<!-- marker -->`). This behavior makes HTML comment blocks a safe mechanism for embedding hidden sync metadata.
*   **Finding Tier**: **Required** / **Recommended** (Schema specification and verified developer Markdown behavior).
*   **Trade-off Evaluation**: Embedding metadata in HTML comments ensures data persistence across sync cycles without impacting readability for end-users.

### 6. Webhooks and Real-Time Subscriptions

*   **Webhooks**:
    *   *Availability*: Available on **all tiers**, including the Free plan.
    *   *Payload & Verification*: Linear webhooks emit JSON payloads matching the affected GraphQL models for create, update, and delete actions on issues and comments. Integrity is validated via a `Linear-Signature` header carrying an HMAC-SHA256 hash of the request body.
*   **GraphQL Subscriptions**:
    *   *Availability*: **GraphQL subscriptions have been officially added to the public API**. 
    *   *Protocol*: Real-time subscriptions operate over WebSockets (conforming to the `graphql-ws` protocol). They support direct filtering arguments to monitor specific teams or issues for created and updated events.
*   **Finding Tier**: **Required** (Changelog and Developer Documentation).
*   **Trade-off Evaluation**: While webhooks require a publicly accessible endpoint (demanding a proxy server for local VS Code clients), GraphQL subscriptions run over WebSocket connections initiated by the VS Code client, eliminating local network ingress issues.

---

## Trade-Off Evaluation

Based on the verified API behaviors, the extension's architectural choices should be structured as follows:

```
                          [ VS CODE EXTENSION CLIENT ]
                           /           |            \
                          /            |             \
                         /             |              \
           (A) Subscription            |           (C) Local Parsing
                  |                    |                    |
                  v                    v                    v
      [ Real-Time SSE/WS ]    (B) Auto-Archiving     [ HTML Metadata ]
     graphql-ws subscription     issueArchive()      <!-- vscode-sync-id -->
                  |                    |                    |
                  v                    v                    v
         [ Linear GraphQL ] <==== [ Workspace ] ====> [ Comment Verbatim ]
```

### (a) Delta-Polling via `updatedAt` vs. GraphQL Subscriptions / Webhooks
Delta polling the `issues` collection using the `updatedAt` field is highly efficient for detecting changes made directly to issue properties (such as description updates). However, it is fundamentally incapable of detecting changes to sub-resources, such as newly posted comments or linked code repositories, because those actions do not trigger an update to the parent issue's `updatedAt` timestamp.
*   *Recommendation*: Rely on the newly released **GraphQL Subscriptions** over WebSockets. This allows the extension to listen directly to both issue updates and comment creation events without maintaining a public webhook callback URL or draining the workspace's hourly request quota through continuous polling.

### (b) Auto-Archive-on-Completion Default-ON
Because Canceled and Completed issues count against the free-tier limit of 250 issues, workspaces will hit this threshold quickly. Enabling auto-archiving by default is the most effective way to help free-tier teams stay within their quota.
*   *Recommendation*: Implement the archival routine using the dedicated `issueArchive` mutation, which is fully idempotent and can be safely executed repeatedly on completed issues without pre-checks. Keep in mind that archiving removes issues from default active views and slows down search recovery marginally, so users must be explicitly informed of this behavior.

### (c) Comment-Based Command Channel
Building a command channel that triggers actions based on comment text requires the extension to process comments reliably.
*   *Recommendation*: Since Linear does not sanitize or strip HTML comment blocks from the Markdown body, the extension should append hidden execution metadata (e.g., `<!-- vscode-cmd: completed, client-id: 789 -->`) directly to the comment body. When processing comments via GraphQL subscriptions, the extension can parse this hidden payload to avoid infinite feedback loops and safely identify commands issued by the integration.

---

## Glossary

*   **Active Issue**: Any issue that resides in a workflow state belonging to the Backlog, Triage, Unstarted, or Started state categories. In the context of pricing limits, "active" is frequently used colloquially to mean "non-archived," which also includes Completed and Canceled issues.
*   **Archived Issue**: An issue that has been transitioned to a read-only terminal state using the `issueArchive` mutation. Archived issues do not count toward free-tier usage limits and are loaded on-demand rather than cached on the client.
*   **Channel**: A contextual delivery stream in Linear, often corresponding to notification paths (e.g., Slack, Email, Browser Push) or the intake source of an issue (such as Slack-integrated Triage channels).
*   **Team**: A distinct organizational unit in Linear that has its own workflow states, cycles, templates, labels, and issue identifiers (e.g., "ENG" or "DESIGN").
*   **Workspace**: The highest-level organizational boundary in Linear, containing members, billing configurations, integrations, and multiple teams.
*   **GraphQL Complexity Score**: A calculated cost assigned to every incoming GraphQL query to protect Linear's backend. Calculated by allocating 0.1 points per scalar field, 1 point per object, and multiplying the sub-tree cost of connections by their pagination limits.

---

## Source List

1.  **Linear Developers**: *Rate Limiting Guide*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/rate-limiting`
2.  **Linear Developers**: *Getting Started with the API*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/getting-started`
3.  **Linear Pricing**: *Workspace Tiers & Feature Matrix*. Available at: `https://linear.app/pricing`
4.  **Linear Docs**: *Billing and Plans*. Available at: `https://linear.app/docs/billing-and-plans`
5.  **Linear Developers**: *Webhooks Guide*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/webhooks`
6.  **Linear Developers**: *Interaction Best Practices*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/interaction-best-practices`
7.  **Linear Developers**: *Filtering API Data*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/filtering`
8.  **Linear Developers**: *Fetching and Modifying Data*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/fetching-and-modifying-data`
9.  **Linear Developers**: *Pagination*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/pagination`
10. **Linear Developers**: *Attachments*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/attachments`
11. **Linear Developers**: *Deprecations*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/deprecations`
12. **Linear Developers**: *Managing Customers*. Available at: `https://developers.linear.app/docs/graphql/working-with-the-graphql-api/managing-customers`
13. **Linear Changelog**: *Introducing Linear Agent (March 24, 2026)*. Available at: `https://linear.app/changelog/2026-03-24-introducing-linear-agent`
14. **Linear Changelog**: *Web Forms and Custom Views (April 2, 2026)*. Available at: `https://linear.app/changelog/2026-04-02-custom-views`
15. **Linear Changelog**: *Pull Request Reviews Alpha (January 23, 2025)*. Available at: `https://linear.app/changelog/2025-01-23-pull-request-reviews`
16. **Linear Changelog**: *Personalized Sidebar & Settings (December 18, 2024)*. Available at: `https://linear.app/changelog/2024-12-18-personalized-sidebar`
17. **Linear Changelog**: *SLA and Markdown Improvements (December 9, 2024)*. Available at: `https://linear.app/changelog/2024-12-09-sla-improvements`
18. **Linear Changelog**: *Jira & GitHub Issues Sync (November 13, 2024)*. Available at: `https://linear.app/changelog/2024-11-13-jira-github-issues-sync`
19. **Linear Changelog**: *Project Dependencies & Core Fixes (August 8, 2024)*. Available at: `https://linear.app/changelog/2024-08-08-project-dependencies`
20. **Linear Changelog**: *General Availability & Free Tier Introduction (September 2, 2020)*. Available at: `https://linear.app/changelog/2020-09-02-general-availability`
21. **Linear Docs**: *Delete and Archive Issues*. Available at: `https://linear.app/docs/delete-and-archive-issues`
22. **Linear Docs**: *Teams & Workspace Structure*. Available at: `https://linear.app/docs/teams`
23. **Linear Docs**: *Issue Labels*. Available at: `https://linear.app/docs/issue-labels`
24. **Linear Docs**: *Estimates & Story Points*. Available at: `https://linear.app/docs/estimates`
25. **Linear Docs**: *Members, Roles, & Workspace Permissions*. Available at: `https://linear.app/docs/members-and-roles`
26. **Linear Docs**: *Custom Views*. Available at: `https://linear.app/docs/custom-views`
27. **Linear Docs**: *Creating and Managing Issues*. Available at: `https://linear.app/docs/create-issues`
28. **Linear Docs**: *Exporting Data & CSV Limits*. Available at: `https://linear.app/docs/exporting-data`
29. **Linear Docs**: *Releases & CI/CD Pipelines*. Available at: `https://linear.app/docs/releases`
30. **Linear Docs**: *Private Teams*. Available at: `https://linear.app/docs/private-teams`
31. **Linear Docs**: *Comments, Reactions & Threads*. Available at: `https://linear.app/docs/comments-and-reactions`
32. **Linear Docs**: *AI Credits & Usage Allocation*. Available at: `https://linear.app/docs/ai-credits`
33. **GitHub**: *Linear/linear SDK Package Directory*. Available at: `https://github.com/linear/linear/tree/master/packages/sdk`
34. **GitHub**: *Linear Generated GraphQL Documents Schema*. Available at: `https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_documents.graphql`
35. **GitHub**: *Linear GitHub Webhook Proxy*. Available at: `https://github.com/linear/github-webhook-proxy`
36. **GitHub**: *Linear SDK Issue #596: Webhook payload types*. Available at: `https://github.com/linear/linear/issues/596`
37. **GitHub**: *Linear SDK Issue #63: project() in Issue returns 400*. Available at: `https://github.com/linear/linear/issues/63`
38. **Apollo Studio**: *Linear API Current Production Schema*. Available at: `https://studio.apollographql.com/sandbox/schema/reference/linear-api`
39. **LobeHub**: *Linear Skill Integration on Lobe Sharing*. Available at: `https://github.com/lobehub/lobe-sharing/tree/main/skills/linear`
40. **GitHub**: *OpenClaw Linear Agent Plugin Architecture*. Available at: `https://github.com/calltelemetry/openclaw-linear-plugin`
41. **Airbyte Docs**: *Linear Connector Integration Details*. Available at: `https://docs.airbyte.com/integrations/sources/linear`
42. **Steampipe Hub**: *Linear Plugin Documentation*. Available at: `https://hub.steampipe.io/plugins/turbot/linear`
43. **dltHub**: *dlt Ecosystem Linear Source Connector*. Available at: `https://dlthub.com/docs/dlt-ecosystem/sources/linear`
44. **Rollout Blog**: *Linear API Essential Guide*. Available at: `https://rollout.co/blog/linear-api-guide`
45. **Endgrate Blog**: *Using the Linear API to Retrieve Issues*. Available at: `https://endgrate.com/blog/using-linear-api-get-issues`
46. **Endgrate Blog**: *Create or Update Issues with Linear API*. Available at: `https://endgrate.com/blog/create-update-issues-linear-api`
47. **Rhumb Blog**: *Linear vs Jira vs Asana for AI Agents*. Available at: `https://rhumb.io/blog/linear-jira-asana-ai-agents`
48. **Browserbeam Blog**: *GraphQL vs REST for Agent Workflows*. Available at: `https://browserbeam.com/blog/graphql-vs-rest-agent-workflows`
49. **Zuplo Blog**: *Essential API Tools & Frameworks in 2025*. Available at: `https://zuplo.com/blog/essential-api-tools-2025`
50. **MojoAuth Blog**: *Top 13 API Generation Software in 2026*. Available at: `https://mojoauth.com/blog/api-generation-software-2026`