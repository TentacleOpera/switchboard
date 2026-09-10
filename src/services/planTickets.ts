/**
 * Plan ↔ ticket association as first-class shared board state.
 *
 * See `.switchboard/plans/ticket-metadata-as-first-class-board-state.md`.
 *
 * Before this module, a plan imported from Linear or ClickUp carried exactly two
 * opaque strings — `plans.linear_issue_id` and `plans.clickup_task_id` — and
 * everything else the provider told us lived in `.switchboard/tickets/`, which is
 * gitignored. A fresh clone, a worktree, or a `git clean -xdf` therefore lost the
 * ticket entirely, and a teammate never had it in the first place.
 *
 * This module defines the *typed core* of a ticket snapshot: the small set of
 * fields Switchboard is prepared to assert an equivalence about across providers,
 * plus a provider payload for everything else.
 *
 * ## Three rules this module exists to enforce
 *
 * 1. **Unknown is NULL, never a plausible blank.** Every optional field is
 *    `string | null`. `null` means "we were never told"; `''` means "the provider
 *    told us it is empty". `labels: null` (never fetched) and `labels: []` (fetched,
 *    none) are different facts and are stored differently. Nothing here ever
 *    substitutes a default that reads like a fetched value — a snapshot that
 *    fabricates an assignee is worse than one that admits it has none.
 *
 * 2. **No cross-provider force-fit.** Linear's *project* and ClickUp's *list* are
 *    not the same concept, so there is no `project` column here. There is
 *    `containerKind` (a provider-qualified string like `linear.project` or
 *    `clickup.list`) alongside `containerId` / `containerName`. A reader that wants
 *    "the project" must first ask which concept answered. The same applies to
 *    priority: `priorityRaw` carries the provider's own representation and
 *    `priorityScheme` names the scale it is on (`linear.0-4` is an integer where 1
 *    is urgent; `clickup.label` is a word). They are never normalised into one
 *    number, because that would assert an ordering neither provider agreed to.
 *
 * 3. **Bodies and comments are sized and excludable.** They are the largest text
 *    the board would ever hold and the most expensive to replicate. When the
 *    operator excludes them, `bodyExcluded` records *that they were excluded* —
 *    so "no body because policy" stays distinguishable from "no body because the
 *    ticket has none". Attachments are references (title + URL) and never blobs.
 */

/** Providers that can promote a ticket to a plan. */
export type PlanTicketProvider = 'linear' | 'clickup';

/**
 * Which code path wrote a row. Recorded on the row itself so "where did this
 * metadata come from?" is answerable after the fact — a backfilled row with a bare
 * id must never be mistaken for a fetched snapshot.
 */
export type PlanTicketMetadataSource =
    /** Written by the import-ticket-as-plan path from a live provider fetch. */
    | 'import'
    /** Written by a later refetch of the same ticket. */
    | 'refetch'
    /** V75 backfill from `plans.linear_issue_id` / `plans.clickup_task_id`. Id only; every other field NULL. */
    | 'backfill-plan-column'
    /** V75 backfill from the `linear_issue_links` table. Id only; every other field NULL. */
    | 'backfill-issue-link'
    /** V75 backfill from a parseable `.switchboard/tickets/` file. Only the frontmatter keys actually present. */
    | 'backfill-file-cache';

/** A ticket comment, flattened to the three fields every provider agrees on. */
export interface PlanTicketComment {
    author: string | null;
    createdAt: string | null;
    body: string;
}

/**
 * A ticket attachment, stored as a *reference*. Blobs are never pulled into the
 * board store — a shared store that carries attachment bytes is a shared store
 * nobody can afford to replicate.
 */
export interface PlanTicketAttachment {
    title: string | null;
    url: string;
    filename: string | null;
}

/**
 * The typed core of a ticket snapshot, plus the provider payload.
 *
 * This is what `plan_tickets` stores, one row per (plan, provider, external id).
 */
export interface PlanTicketSnapshot {
    provider: PlanTicketProvider;
    /** The provider's own opaque id. Always known — it is what links the plan. */
    externalId: string;
    /** Human-facing id (Linear `ENG-123`). ClickUp has no such thing → null, not the opaque id. */
    externalKey: string | null;
    url: string | null;
    title: string | null;
    /** The provider's own state name ("In Progress"). Never mapped onto a board column. */
    stateName: string | null;
    /** The provider's state category ("started", "completed"). Provider vocabulary, unmapped. */
    stateType: string | null;
    assigneeName: string | null;
    assigneeEmail: string | null;
    /** `null` = never fetched. `[]` = fetched, no labels. */
    labels: string[] | null;
    parentExternalId: string | null;
    /** Provider-qualified container concept: `linear.project`, `clickup.list`. Never bare `project`. */
    containerKind: string | null;
    containerId: string | null;
    containerName: string | null;
    /**
     * Point/time estimate, as the provider stated it. Currently NULL for both
     * providers: neither `LinearIssue` nor `ClickUpTask` carries an estimate in the
     * shapes Switchboard fetches. The column exists so a later fetch has somewhere
     * honest to land — it is not populated by guessing.
     */
    estimate: string | null;
    /** The provider's own priority representation, unnormalised. */
    priorityRaw: string | null;
    /** Names the scale `priorityRaw` is on, so no reader assumes a shared ordering. */
    priorityScheme: string | null;
    /** `null` when never fetched OR when excluded by policy — `bodyExcluded` disambiguates. */
    body: string | null;
    bodyHash: string | null;
    /** True when an operator setting kept the body out of the board store. */
    bodyExcluded: boolean;
    comments: PlanTicketComment[] | null;
    commentsHash: string | null;
    /** True when an operator setting kept comments out of the board store. */
    commentsExcluded: boolean;
    attachments: PlanTicketAttachment[] | null;
    /** Provider-specific extras that have no typed home. Always an object, possibly empty. */
    payload: Record<string, unknown>;
    sourceCreatedAt: string | null;
    /** The provider's own updated-at. Staleness is `sourceUpdatedAt` vs `fetchedAt`. */
    sourceUpdatedAt: string | null;
    /** When Switchboard last read this from the provider. */
    fetchedAt: string;
    metadataSource: PlanTicketMetadataSource;
}

/**
 * The bounded projection that may ride in `board.json` / a git-carried snapshot.
 *
 * Deliberately excludes body, comments and attachments: the snapshot is a card
 * index, not a ticket archive, and the body is both the largest field and the one
 * most likely to be stale. The full snapshot lives in the Board store, which is
 * where a teammate reads it from.
 */
export interface SharedTicketProjection {
    provider: PlanTicketProvider;
    external_id: string;
    external_key: string | null;
    url: string | null;
    title: string | null;
    state: string | null;
    assignee: string | null;
    labels: string[] | null;
    source_updated_at: string | null;
    /** Present so a reader can tell a fetched snapshot from a backfilled id. */
    metadata_source: PlanTicketMetadataSource;
    /** Present so an orphaned ticket is visibly orphaned in the snapshot, not silently normal. */
    orphaned_at?: string;
}

/** Trim to a non-empty string, or null. Never returns `''` — blank is not a fact. */
function nonEmpty(v: unknown): string | null {
    if (v === undefined || v === null) { return null; }
    const s = String(v).trim();
    return s.length > 0 ? s : null;
}

/** FNV-1a over UTF-8, hex. Content identity for staleness checks — not a security hash. */
export function hashTicketText(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
        if (text.charCodeAt(i) > 0xff) {
            h ^= (text.charCodeAt(i) >> 8) & 0xff;
            h = Math.imul(h, 0x01000193) >>> 0;
        }
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** How much ticket text the board store is allowed to hold. */
export interface TicketContentPolicy {
    /** Store the ticket body. */
    storeBody: boolean;
    /** Store the ticket comment thread. */
    storeComments: boolean;
    /** Hard cap on stored body characters; longer bodies are truncated with a marker. */
    maxBodyChars: number;
    /** Hard cap on stored comments. */
    maxComments: number;
    /** Hard cap on characters per stored comment. */
    maxCommentChars: number;
}

/**
 * Defaults. Bodies and comments are stored by default because "see everything
 * associated with the ticket" is the actual requirement, and a card that omits the
 * ticket's text does not meet it. The caps are what keeps that affordable: a
 * runaway 400KB body cannot make a replica sync expensive on its own.
 */
export const DEFAULT_TICKET_CONTENT_POLICY: TicketContentPolicy = {
    storeBody: true,
    storeComments: true,
    maxBodyChars: 64_000,
    maxComments: 100,
    maxCommentChars: 8_000,
};

const TRUNCATION_MARKER = '\n\n_[truncated by Switchboard: ticket body exceeded the board-store size cap]_';

/**
 * Apply the size cap to a body. The marker is part of the stored text so a reader
 * of the board record can see that it is not the whole ticket — a silently cut
 * body would be a wrong value that looks like a right one.
 */
function capBody(body: string, maxChars: number): string {
    if (body.length <= maxChars) { return body; }
    return body.slice(0, maxChars) + TRUNCATION_MARKER;
}

function capComments(
    comments: PlanTicketComment[],
    policy: TicketContentPolicy
): PlanTicketComment[] {
    return comments.slice(0, policy.maxComments).map(c => ({
        author: c.author,
        createdAt: c.createdAt,
        body: c.body.length > policy.maxCommentChars
            ? c.body.slice(0, policy.maxCommentChars) + ' […]'
            : c.body,
    }));
}

/**
 * Fold body/comments into a snapshot under the content policy.
 *
 * `bodyExcluded` / `commentsExcluded` record the *policy decision*, so a NULL body
 * on a row is never ambiguous: excluded means the operator said no, not-excluded
 * with a NULL body means the ticket genuinely had none.
 */
function applyContentPolicy(
    snapshot: PlanTicketSnapshot,
    rawBody: string | null,
    rawComments: PlanTicketComment[] | null,
    policy: TicketContentPolicy
): PlanTicketSnapshot {
    if (policy.storeBody && rawBody !== null) {
        const capped = capBody(rawBody, policy.maxBodyChars);
        snapshot.body = capped;
        // Hash the ORIGINAL text, not the capped copy: the hash answers "has the
        // ticket changed upstream", and truncation is our doing, not the ticket's.
        snapshot.bodyHash = hashTicketText(rawBody);
        snapshot.bodyExcluded = false;
    } else {
        snapshot.body = null;
        // A hash of excluded content is still useful — it lets a refetch detect an
        // upstream change without ever having stored the text.
        snapshot.bodyHash = rawBody !== null ? hashTicketText(rawBody) : null;
        snapshot.bodyExcluded = !policy.storeBody;
    }

    if (policy.storeComments && rawComments !== null) {
        snapshot.comments = capComments(rawComments, policy);
        snapshot.commentsHash = hashTicketText(JSON.stringify(rawComments));
        snapshot.commentsExcluded = false;
    } else {
        snapshot.comments = null;
        snapshot.commentsHash = rawComments !== null ? hashTicketText(JSON.stringify(rawComments)) : null;
        snapshot.commentsExcluded = !policy.storeComments;
    }

    return snapshot;
}

/** The shape of a Linear issue this mapper reads. Structural, so it accepts `LinearIssue`. */
export interface LinearIssueLike {
    id: string;
    identifier?: string;
    title?: string;
    description?: string;
    state?: { id?: string; name?: string; type?: string } | null;
    priority?: number | null;
    assignee?: { id?: string; name?: string; email?: string } | null;
    project?: { id?: string; name?: string } | null;
    labels?: Array<{ id?: string; name?: string }>;
    createdAt?: string;
    updatedAt?: string;
    url?: string;
    parentId?: string | null;
}

export interface LinearTicketSourceData {
    issue: LinearIssueLike;
    comments?: Array<{ body?: string; createdAt?: string; user?: { name?: string; email?: string } | null }> | null;
    attachments?: Array<{ title?: string; url?: string; filename?: string }> | null;
    /** Linear team, when the caller knows it. Not on `LinearIssue` — omitted rather than guessed. */
    team?: { id?: string; name?: string } | null;
}

/**
 * Map a Linear issue to the typed core.
 *
 * Mapping decisions worth stating, because a wrong one asserts an equivalence that
 * is not there:
 * - `project` → `containerKind: 'linear.project'`. Not a bare `project` column;
 *   ClickUp's list lands in the same three columns under its own kind.
 * - `priority` (0–4, where 0 is *no priority* and 1 is *urgent*) → `priorityRaw`
 *   with `priorityScheme: 'linear.0-4'`. Never normalised against ClickUp's words.
 * - Team is carried only when the caller supplies it; `LinearIssue` does not fetch
 *   it, and inventing one from the identifier prefix would be a guess.
 */
export function mapLinearIssueToSnapshot(
    data: LinearTicketSourceData,
    fetchedAt: string,
    policy: TicketContentPolicy = DEFAULT_TICKET_CONTENT_POLICY,
    metadataSource: PlanTicketMetadataSource = 'import'
): PlanTicketSnapshot {
    const issue = data.issue;

    const payload: Record<string, unknown> = {};
    if (issue.state?.id) { payload.stateId = String(issue.state.id); }
    if (data.team?.id || data.team?.name) {
        payload.team = { id: nonEmpty(data.team?.id), name: nonEmpty(data.team?.name) };
    }
    if (Array.isArray(issue.labels) && issue.labels.length > 0) {
        payload.labelIds = issue.labels.map(l => nonEmpty(l?.id)).filter((v): v is string => v !== null);
    }
    if (issue.assignee?.id) { payload.assigneeId = String(issue.assignee.id); }

    const snapshot: PlanTicketSnapshot = {
        provider: 'linear',
        externalId: String(issue.id),
        externalKey: nonEmpty(issue.identifier),
        url: nonEmpty(issue.url),
        title: nonEmpty(issue.title),
        stateName: nonEmpty(issue.state?.name),
        stateType: nonEmpty(issue.state?.type),
        assigneeName: nonEmpty(issue.assignee?.name),
        assigneeEmail: nonEmpty(issue.assignee?.email),
        labels: Array.isArray(issue.labels)
            ? issue.labels.map(l => nonEmpty(l?.name)).filter((v): v is string => v !== null)
            : null,
        parentExternalId: nonEmpty(issue.parentId),
        containerKind: issue.project?.id || issue.project?.name ? 'linear.project' : null,
        containerId: nonEmpty(issue.project?.id),
        containerName: nonEmpty(issue.project?.name),
        // Not fetched by LinearSyncService.getIssue — stays unknown rather than 0.
        estimate: null,
        priorityRaw: issue.priority === undefined || issue.priority === null ? null : String(issue.priority),
        priorityScheme: issue.priority === undefined || issue.priority === null ? null : 'linear.0-4',
        body: null,
        bodyHash: null,
        bodyExcluded: false,
        comments: null,
        commentsHash: null,
        commentsExcluded: false,
        attachments: Array.isArray(data.attachments)
            ? data.attachments
                .map(a => ({ title: nonEmpty(a?.title), url: String(a?.url || '').trim(), filename: nonEmpty(a?.filename) }))
                .filter(a => a.url.length > 0)
            : null,
        payload,
        sourceCreatedAt: nonEmpty(issue.createdAt),
        sourceUpdatedAt: nonEmpty(issue.updatedAt),
        fetchedAt,
        metadataSource,
    };

    const rawComments = Array.isArray(data.comments)
        ? data.comments.map(c => ({
            author: nonEmpty(c?.user?.name) ?? nonEmpty(c?.user?.email),
            createdAt: nonEmpty(c?.createdAt),
            body: String(c?.body ?? ''),
        }))
        : null;

    return applyContentPolicy(snapshot, nonEmpty(issue.description), rawComments, policy);
}

/** The shape of a ClickUp task this mapper reads. Structural, so it accepts `ClickUpTask`. */
export interface ClickUpTaskLike {
    id: string;
    name?: string;
    description?: string;
    markdownDescription?: string;
    markdown_description?: string;
    url?: string;
    parentId?: string | null;
    parent?: string | null;
    status?: { status?: string; color?: string; type?: string; orderindex?: string } | null;
    priority?: { id?: string; priority?: string; color?: string; orderindex?: string } | null;
    list?: { id?: string; name?: string } | null;
    assignees?: Array<{ id?: string; username?: string; email?: string }>;
    tags?: Array<{ name?: string }>;
    dateCreated?: string;
    dateUpdated?: string;
}

export interface ClickUpTicketSourceData {
    task: ClickUpTaskLike;
    comments?: Array<{ comment_text?: string; date?: string; user?: { username?: string; email?: string } | null }> | null;
    attachments?: Array<{ title?: string; url?: string; filename?: string }> | null;
}

/**
 * ClickUp epoch-ms strings (`dateCreated`, `dateUpdated`, comment `date`) → ISO,
 * so `source_updated_at` is comparable with Linear's ISO timestamps. A value that
 * is not a finite number is passed through verbatim rather than coerced to the
 * epoch — an unparseable timestamp must not silently become 1970.
 */
function clickUpDateToIso(v: unknown): string | null {
    const s = nonEmpty(v);
    if (s === null) { return null; }
    const ms = Number(s);
    if (Number.isFinite(ms) && ms > 0) {
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? s : d.toISOString();
    }
    return s;
}

/**
 * Map a ClickUp task to the typed core.
 *
 * Mapping decisions worth stating:
 * - `list` → `containerKind: 'clickup.list'`. A ClickUp list is not a Linear
 *   project; the kind column keeps them distinguishable instead of collapsing both
 *   into a `project` field that would mean two different things per row.
 * - `priority.priority` (a word: "urgent"/"high"/…) → `priorityRaw` with
 *   `priorityScheme: 'clickup.label'`. Never converted to Linear's integers.
 * - ClickUp has multiple assignees; the typed core holds one. The first is stored
 *   in the typed columns and the *full* list goes to `payload.assignees`, so
 *   nothing is lost and nothing is asserted to be "the" assignee beyond the card
 *   rendering that needs one.
 * - Space and folder are not fetched by `getTaskDetails` — absent, not invented.
 */
export function mapClickUpTaskToSnapshot(
    data: ClickUpTicketSourceData,
    fetchedAt: string,
    policy: TicketContentPolicy = DEFAULT_TICKET_CONTENT_POLICY,
    metadataSource: PlanTicketMetadataSource = 'import'
): PlanTicketSnapshot {
    const task = data.task;
    const assignees = Array.isArray(task.assignees) ? task.assignees : [];

    const payload: Record<string, unknown> = {};
    if (assignees.length > 0) {
        payload.assignees = assignees.map(a => ({
            id: nonEmpty(a?.id),
            username: nonEmpty(a?.username),
            email: nonEmpty(a?.email),
        }));
    }
    if (task.status?.color) { payload.statusColor = String(task.status.color); }
    if (task.priority?.orderindex) { payload.priorityOrderIndex = String(task.priority.orderindex); }
    if (task.priority?.color) { payload.priorityColor = String(task.priority.color); }

    const snapshot: PlanTicketSnapshot = {
        provider: 'clickup',
        externalId: String(task.id),
        // ClickUp has no human-facing key distinct from the opaque id. Storing the
        // id here would look like a key and read wrong on a card.
        externalKey: null,
        url: nonEmpty(task.url),
        title: nonEmpty(task.name),
        stateName: nonEmpty(task.status?.status),
        stateType: nonEmpty(task.status?.type),
        assigneeName: nonEmpty(assignees[0]?.username),
        assigneeEmail: nonEmpty(assignees[0]?.email),
        labels: Array.isArray(task.tags)
            ? task.tags.map(t => nonEmpty(t?.name)).filter((v): v is string => v !== null)
            : null,
        parentExternalId: nonEmpty(task.parentId) ?? nonEmpty(task.parent),
        containerKind: task.list?.id || task.list?.name ? 'clickup.list' : null,
        containerId: nonEmpty(task.list?.id),
        containerName: nonEmpty(task.list?.name),
        // ClickUp's time_estimate is not in the fetched shape — unknown, not 0.
        estimate: null,
        priorityRaw: nonEmpty(task.priority?.priority),
        priorityScheme: nonEmpty(task.priority?.priority) ? 'clickup.label' : null,
        body: null,
        bodyHash: null,
        bodyExcluded: false,
        comments: null,
        commentsHash: null,
        commentsExcluded: false,
        attachments: Array.isArray(data.attachments)
            ? data.attachments
                .map(a => ({ title: nonEmpty(a?.title), url: String(a?.url || '').trim(), filename: nonEmpty(a?.filename) }))
                .filter(a => a.url.length > 0)
            : null,
        payload,
        sourceCreatedAt: clickUpDateToIso(task.dateCreated),
        sourceUpdatedAt: clickUpDateToIso(task.dateUpdated),
        fetchedAt,
        metadataSource,
    };

    const rawBody = nonEmpty(task.markdownDescription)
        ?? nonEmpty(task.markdown_description)
        ?? nonEmpty(task.description);

    const rawComments = Array.isArray(data.comments)
        ? data.comments.map(c => ({
            author: nonEmpty(c?.user?.username) ?? nonEmpty(c?.user?.email),
            createdAt: clickUpDateToIso(c?.date),
            body: String(c?.comment_text ?? ''),
        }))
        : null;

    return applyContentPolicy(snapshot, rawBody, rawComments, policy);
}

/**
 * Staleness, computed rather than stored: the board holds a snapshot, so a card
 * must be able to say how old it is without asking the provider.
 *
 * Returns `'unknown'` when the provider never gave an updated-at — a backfilled
 * row, for instance. `'unknown'` is deliberately not `'fresh'`: a row we know
 * nothing about must not render as a row we just checked.
 */
export function ticketStaleness(
    sourceUpdatedAt: string | null,
    fetchedAt: string | null
): 'fresh' | 'stale' | 'unknown' {
    if (!sourceUpdatedAt || !fetchedAt) { return 'unknown'; }
    const src = Date.parse(sourceUpdatedAt);
    const got = Date.parse(fetchedAt);
    if (!Number.isFinite(src) || !Number.isFinite(got)) { return 'unknown'; }
    // The provider changed the ticket after we last read it.
    return src > got ? 'stale' : 'fresh';
}

/**
 * The minimal slice of `vscode.workspace.getConfiguration('switchboard')` this
 * module needs. Taking it as a parameter keeps this file free of a `vscode`
 * import, so both hosts and the unit tests exercise exactly the same resolver.
 */
export interface TicketPolicyConfigReader {
    get<T>(section: string, defaultValue?: T): T | undefined;
    inspect?<T>(section: string): {
        key: string;
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
    } | undefined;
}

/** Where a resolved policy value came from. */
export type TicketPolicySource =
    | 'workspace-folder-setting'
    | 'workspace-setting'
    | 'global-setting'
    | 'standalone-config'
    | 'built-in-default';

export interface ResolvedTicketContentPolicy {
    policy: TicketContentPolicy;
    /** One entry per policy field, so "which layer answered?" is answerable after the fact. */
    sources: Record<keyof TicketContentPolicy, TicketPolicySource>;
}

const PROBE = Symbol('switchboard.ticketPolicy.unset');

/**
 * Resolve one boolean/number setting AND say where it came from.
 *
 * Ticket content policy governs what leaves this machine — an excluded body must
 * not reach the store, a shared replica, or a projection — so a default that reads
 * exactly like a configured value would turn "the operator never decided" into
 * "the operator decided this", silently. Every read here is therefore tagged.
 *
 * The two hosts expose provenance differently and both are handled:
 * - VS Code populates `inspect()` layers for explicit settings and reports the
 *   package.json default in `inspect().defaultValue`. An explicit layer names
 *   itself; no layer plus a present `defaultValue` means the built-in default.
 * - The standalone shim returns all-undefined layers, so provenance comes from a
 *   sentinel probe instead: a `get()` that hands the sentinel back means
 *   `.switchboard/config.json` does not carry the key.
 */
function resolveTagged<T>(
    cfg: TicketPolicyConfigReader | null | undefined,
    key: string,
    fallback: T
): { value: T; source: TicketPolicySource } {
    if (!cfg) { return { value: fallback, source: 'built-in-default' }; }

    let inspected: ReturnType<NonNullable<TicketPolicyConfigReader['inspect']>> | undefined;
    try { inspected = cfg.inspect?.<T>(key); } catch { inspected = undefined; }

    if (inspected) {
        if (inspected.workspaceFolderValue !== undefined) {
            return { value: inspected.workspaceFolderValue as T, source: 'workspace-folder-setting' };
        }
        if (inspected.workspaceValue !== undefined) {
            return { value: inspected.workspaceValue as T, source: 'workspace-setting' };
        }
        if (inspected.globalValue !== undefined) {
            return { value: inspected.globalValue as T, source: 'global-setting' };
        }
        if (inspected.defaultValue !== undefined) {
            // VS Code: no explicit layer, and the package.json default answered.
            return { value: inspected.defaultValue as T, source: 'built-in-default' };
        }
    }

    // Standalone (or a host with no inspect): probe with a sentinel the config
    // store cannot possibly hold. Getting it back means the key is unset.
    let probed: unknown;
    try { probed = cfg.get<unknown>(key, PROBE as unknown as T); } catch { probed = PROBE; }
    if (probed === PROBE || probed === undefined) {
        return { value: fallback, source: 'built-in-default' };
    }
    return { value: probed as T, source: 'standalone-config' };
}

/** Clamp a configured number into a sane range without silently accepting nonsense. */
function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) { return fallback; }
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Resolve the ticket content policy from configuration, tagged with its source.
 *
 * Callers MUST log `sources` where the policy is applied — that is what makes
 * "why is this body missing?" answerable months later, and it is the difference
 * between an excluded body and a lost one.
 */
export function resolveTicketContentPolicy(
    cfg: TicketPolicyConfigReader | null | undefined
): ResolvedTicketContentPolicy {
    const d = DEFAULT_TICKET_CONTENT_POLICY;
    const storeBody = resolveTagged<boolean>(cfg, 'tickets.storeBodyInBoardStore', d.storeBody);
    const storeComments = resolveTagged<boolean>(cfg, 'tickets.storeCommentsInBoardStore', d.storeComments);
    const maxBodyChars = resolveTagged<number>(cfg, 'tickets.maxBodyChars', d.maxBodyChars);
    const maxComments = resolveTagged<number>(cfg, 'tickets.maxComments', d.maxComments);
    const maxCommentChars = resolveTagged<number>(cfg, 'tickets.maxCommentChars', d.maxCommentChars);

    return {
        policy: {
            storeBody: storeBody.value === true,
            storeComments: storeComments.value === true,
            maxBodyChars: clampNumber(maxBodyChars.value, d.maxBodyChars, 0, 1_000_000),
            maxComments: clampNumber(maxComments.value, d.maxComments, 0, 1_000),
            maxCommentChars: clampNumber(maxCommentChars.value, d.maxCommentChars, 0, 100_000),
        },
        sources: {
            storeBody: storeBody.source,
            storeComments: storeComments.source,
            maxBodyChars: maxBodyChars.source,
            maxComments: maxComments.source,
            maxCommentChars: maxCommentChars.source,
        },
    };
}

/**
 * Format the resolved policy for a log line, source included.
 *
 * Deliberately verbose about provenance: "bodies excluded" is a fact an operator
 * needs to be able to trace back to the setting that caused it.
 */
export function describeTicketContentPolicy(resolved: ResolvedTicketContentPolicy): string {
    const p = resolved.policy;
    const s = resolved.sources;
    return `body=${p.storeBody ? 'stored' : 'EXCLUDED'} (${s.storeBody}), ` +
        `comments=${p.storeComments ? 'stored' : 'EXCLUDED'} (${s.storeComments}), ` +
        `caps=${p.maxBodyChars}c body/${p.maxComments}×${p.maxCommentChars}c comments ` +
        `(${s.maxBodyChars}/${s.maxComments}/${s.maxCommentChars})`;
}

/**
 * Project a stored ticket record to the bounded subset that may ride in a
 * git-carried board snapshot.
 *
 * The body, the comment thread and the attachment list are deliberately absent:
 * `board.json` is a card index that every clone of the repo carries, and the
 * body is both the largest field and the one most likely to be stale. A reader who
 * wants the body reads the Board store, which is where it actually lives.
 */
export function projectSharedTicket(record: {
    provider: string;
    externalId: string;
    externalKey: string | null;
    url: string | null;
    title: string | null;
    stateName: string | null;
    assigneeName: string | null;
    labels: string[] | null;
    sourceUpdatedAt: string | null;
    metadataSource: PlanTicketMetadataSource;
    orphanedAt?: string | null;
}): SharedTicketProjection {
    return {
        provider: record.provider as PlanTicketProvider,
        external_id: record.externalId,
        external_key: record.externalKey,
        url: record.url,
        title: record.title,
        state: record.stateName,
        assignee: record.assigneeName,
        labels: record.labels,
        source_updated_at: record.sourceUpdatedAt,
        metadata_source: record.metadataSource,
        ...(record.orphanedAt ? { orphaned_at: record.orphanedAt } : {}),
    };
}
