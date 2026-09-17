'use strict';
/**
 * Linear per-project seed contract.
 *
 * The seed is a bulk, one-way publication of the live board into a third-party
 * SaaS. Most of the ways it goes wrong are invisible at runtime — a cursor that
 * is never re-baselined, a full-table link replace under concurrency, a rate
 * limit classified as a generic HTTP 400 — so they are asserted here against
 * source, the way the provider-capability parity contract asserts its surfaces.
 *
 * Source-level on purpose: every one of these is a line that either exists or
 * does not, and none of them can be observed from a passing run that never hit
 * the failure. `dist/` staleness is never the finding — `src/` is the truth.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
    }
}

const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const LINEAR = readSrc('services/LinearSyncService.ts');
const PROVIDER = readSrc('services/remote/LinearRemoteProvider.ts');
const SEAM = readSrc('services/remote/RemoteProvider.ts');
const DB = readSrc('services/KanbanDatabase.ts');
const TIERS = readSrc('services/storageTiers.ts');
const EXTENSION = readSrc('extension.ts');

/** The seed method body, from its signature to the next top-level member. */
function seedBody() {
    const start = LINEAR.indexOf('public async seedProjectToRemote(');
    assert.ok(start > 0, 'seedProjectToRemote is missing from LinearSyncService');
    const end = LINEAR.indexOf('\n  // ── Debounced Sync', start);
    assert.ok(end > start, 'could not bound the seed block');
    return LINEAR.slice(start, end);
}

// ── The destination mapping ─────────────────────────────────────────────────

check('the mapping table is tiered SHARED — an untiered table is absent from every snapshot and export', () => {
    assert.ok(/'remote_project_bindings'/.test(TIERS),
        'remote_project_bindings is not in SHARED_TABLES — it would be silently dropped from the board snapshot, '
        + 'the state serializers and every export format (linear_issue_links is exactly that bug)');
});

check('the mapping is keyed with the remote team, not just the board project', () => {
    const ddl = DB.match(/CREATE TABLE IF NOT EXISTS remote_project_bindings \(([\s\S]*?)\);/);
    assert.ok(ddl, 'remote_project_bindings DDL not found in the schema');
    assert.ok(/remote_team_id\s+TEXT NOT NULL/.test(ddl[1]), 'remote_team_id column missing');
    assert.ok(/PRIMARY KEY \(workspace_id, provider, remote_team_id, board_project\)/.test(ddl[1]),
        'remote_team_id must be part of the KEY: the Linear config is machine-global and re-pointable, so a '
        + 'binding without the team resolves a stale row to a project in a team the install no longer uses');
});

check('the destination resolver returns a source, never a bare id', () => {
    const sig = LINEAR.match(/public async resolveSeedDestination\([\s\S]*?\): Promise<([^>]*(?:<[^>]*>)?[^>]*)>/);
    assert.ok(sig, 'resolveSeedDestination is missing');
    assert.ok(/source:/.test(sig[1]),
        'resolveSeedDestination must return { value, source } — a mapping answer and an includeProjectNames guess '
        + 'must never be indistinguishable');
    assert.ok(/'mapping'/.test(sig[1]) && /'include-project'/.test(sig[1]) && /'none'/.test(sig[1]),
        "the three sources must be 'mapping' | 'include-project' | 'none'");
    const body = LINEAR.slice(LINEAR.indexOf('public async resolveSeedDestination('), LINEAR.indexOf('   * Generate a fingerprint for issue filter options'));
    assert.ok(/getRemoteProjectBinding\(/.test(body), 'resolveSeedDestination must consult the binding row first');
    const mappingAt = body.indexOf('getRemoteProjectBinding(');
    const legacyAt = body.indexOf('_resolveSingleIncludeProjectId(');
    assert.ok(legacyAt > mappingAt,
        'the legacy includeProjectNames guess must be the FALLBACK after the mapping lookup, not the first answer');
});

check('the DB accessor returns a { value, source } envelope', () => {
    const sig = DB.match(/public async getRemoteProjectBinding\([\s\S]*?\): Promise<\{ value: RemoteProjectBinding \| null; source: 'mapping' \| 'none' \}>/);
    assert.ok(sig, "getRemoteProjectBinding must return { value, source } — a bare Promise<string | undefined> destination resolver is a fallback-rule violation");
});

check("createIssue's write destination goes through the mapping, and the inbound filters do not", () => {
    const createIssue = LINEAR.slice(LINEAR.indexOf('public async createIssue('), LINEAR.indexOf('public async createIssueSimple('));
    assert.ok(/resolveSeedDestination\(/.test(createIssue),
        "createIssue must resolve its destination through resolveSeedDestination — otherwise the first column move "
        + 'after a seed sends the card to includeProjectNames[0] and the 1:1 breaks immediately');
    assert.ok(!/_resolveSingleIncludeProjectId\(config\)/.test(createIssue),
        'createIssue still calls the legacy single-project resolver directly');
    for (const fn of ['queryIssues', 'importIssuesFromLinear']) {
        assert.ok(LINEAR.includes(fn), `${fn} vanished — the inbound-filter call sites must stay on the legacy resolver`);
    }
});

// ── The seed pass ───────────────────────────────────────────────────────────

check('the seed re-baselines the inbound state cursor', () => {
    assert.ok(/remote\.stateCursor\.linear/.test(seedBody()),
        "the seed must write remote.stateCursor.linear on completion — every one of those updatedAt bumps is "
        + "Switchboard's own write, and its absence is the dropped-cards bug with no visible symptom");
});

check('the seed never calls the full-table link replace', () => {
    const body = seedBody() + LINEAR.slice(LINEAR.indexOf('private async _seedOnePlan('), LINEAR.indexOf('\n  // ── Debounced Sync'));
    assert.ok(!/saveSyncMap\(/.test(body),
        'the seed calls saveSyncMap — that is a full-table replace, and under concurrency it erases a sibling '
        + "worker's successful link");
    assert.ok(!/replaceAllLinearIssueLinks\(/.test(body),
        'the seed calls replaceAllLinearIssueLinks — same full-replace hazard');
    assert.ok(/deleteLinearIssueLinkByPlan\(/.test(body),
        'the seed must clean its temp marker with a targeted single-row delete');
});

check('the seed reports unmapped columns BEFORE any remote write', () => {
    const body = seedBody();
    const preflightAt = body.indexOf('onPreflight');
    const destinationAt = body.indexOf('resolveSeedDestination(');
    assert.ok(preflightAt > 0, 'the seed emits no pre-flight report');
    assert.ok(destinationAt > preflightAt,
        'the pre-flight must be emitted before the destination is resolved or created — an unmapped column is the '
        + 'majority case on a real board, and a user must learn that before the issues exist');
    assert.ok(/dryRun/.test(body), 'the seed must support a zero-write pre-flight (dryRun)');
});

check('the seed checks BOTH link stores before skipping a card as already linked', () => {
    const body = seedBody();
    assert.ok(/linearIssueId/.test(body), 'plans.linear_issue_id is not consulted');
    assert.ok(/getLinearIssueLinkByPlan\(/.test(body), 'linear_issue_links is not consulted');
});

check('the seed resolves by planId anchor before creating', () => {
    const one = LINEAR.slice(LINEAR.indexOf('private async _seedOnePlan('));
    assert.ok(/findIssueByPlanAnchor\(/.test(one),
        'a plan whose local link was lost but whose issue still carries the anchor must be ATTACHED, not duplicated');
    assert.ok(/creating_\$\{plan\.planFile\}/.test(one),
        'the seed must hold the creating_* marker across its create, or a concurrent debouncedSync double-creates');
});

check('the feature pass bypasses the realtime toggle for a deliberate seed', () => {
    assert.ok(/force\?: boolean/.test(LINEAR), 'syncFeatureWithSubtasks has no force option');
    assert.ok(/config\.realTimeSyncEnabled !== true && params\.force !== true/.test(LINEAR),
        'the realtime gate must be bypassable — a background toggle has no business deciding whether an explicit '
        + 'seed preserves feature structure');
    assert.ok(/force: true/.test(seedBody()), 'the seed does not bypass the gate');
});

check('the seed is standalone-only — no second implementation in the legacy host', () => {
    for (const symbol of ['seedProjectToRemote', 'seedBoardProject', 'createLinearProject']) {
        assert.ok(!EXTENSION.includes(symbol),
            `src/extension.ts references ${symbol} — the cutover means standalone only; a second implementation in `
            + 'the legacy host is throwaway work');
    }
});

// ── Rate limiting ───────────────────────────────────────────────────────────

check('a non-200 response is parsed before it is rejected, so HTTP 400 RATELIMITED is classified', () => {
    const block = LINEAR.slice(LINEAR.indexOf('if (res.statusCode !== 200) {'), LINEAR.indexOf('safeResolve({ data: parsed.data })'));
    assert.ok(/JSON\.parse\(raw\)/.test(block.slice(0, block.indexOf('return safeReject'))),
        'the non-200 arm rejects before parsing the body — Linear signals a rate limit as HTTP 400 with '
        + "extensions.code === 'RATELIMITED', never 429, so that detection is unreachable and retry() fast-fails");
    assert.ok(/RATELIMITED/.test(block.slice(0, block.indexOf('return safeReject'))),
        'the non-200 arm does not classify RATELIMITED');
    assert.ok(/localizeHttpError/.test(block),
        'every other non-200 must keep its localized message');
});

check('the rate-limit flags have a consumer', () => {
    const transient = LINEAR.slice(LINEAR.indexOf('private _isTransientError('), LINEAR.indexOf('private async _throttle('));
    assert.ok(/isRateLimited/.test(transient) && /RATELIMITED/.test(transient),
        '_isTransientError must honour err.isRateLimited / err.code directly — a set-but-never-read flag is the defect');
});

check('the reset headers are treated as epoch MILLISECONDS', () => {
    const pacer = LINEAR.slice(LINEAR.indexOf('private async _pauseForRateLimitBudget('), LINEAR.indexOf('public async findIssueByPlanAnchor('));
    assert.ok(pacer.length > 0, 'the seed has no rate-limit pacer');
    assert.ok(/requestsReset/.test(pacer) && /complexityReset/.test(pacer),
        'the pacer must read _lastRateLimitState, which nothing consumed before');
    assert.ok(/- Date\.now\(\)/.test(pacer),
        'the pause must be computed as reset - Date.now(): both reset fields are UTC epoch milliseconds');
    assert.ok(!/\* 1000/.test(pacer),
        'the reset fields are already milliseconds — a * 1000 makes every pause ~1000x too long');
});

// ── Project creation ────────────────────────────────────────────────────────

check('projectCreate sends teamIds and invalidates the project cache', () => {
    const matches = LINEAR.match(/mutation\(\$input: ProjectCreateInput!\)/g) || [];
    assert.strictEqual(matches.length, 1, `expected exactly one projectCreate mutation, found ${matches.length}`);
    const create = LINEAR.slice(LINEAR.indexOf('public async createLinearProject('), LINEAR.indexOf('public async resolveSingleIncludeProjectId('));
    const body = create.length > 0 ? create : LINEAR.slice(LINEAR.indexOf('public async createLinearProject('));
    assert.ok(/teamIds: \[resolvedTeamId\]/.test(body),
        'ProjectCreateInput requires teamIds: [String!]! — a project cannot be created without at least one team');
    assert.ok(/_cachedProjects = null/.test(body),
        '_cachedProjects has no TTL and is otherwise cleared only by saveConfig; a project created without this '
        + 'line is invisible for the life of a standalone host process');
    assert.ok(/attach/i.test(body),
        'a refused create must name the attach-an-existing-project remedy, not just fail');
});

check('getAvailableProjects paginates past the 50-row connection default', () => {
    const fn = LINEAR.slice(LINEAR.indexOf('public async getAvailableProjects('), LINEAR.indexOf('/**\n   * Create a Linear project'));
    assert.ok(/pageInfo/.test(fn) && /hasNextPage/.test(fn),
        'an unpaginated projects connection returns 50 rows: at project 51 "does not exist remotely" is '
        + 'indistinguishable from "on page 2", and a name-based attach silently creates a duplicate');
});

// ── The inbound query ───────────────────────────────────────────────────────

check('fetchStateDeltas orders by updatedAt and paginates', () => {
    const fn = PROVIDER.slice(PROVIDER.indexOf('public async fetchStateDeltas('), PROVIDER.indexOf('public async fetchCommentDeltas('));
    assert.ok(/orderBy: updatedAt/.test(fn),
        "Linear's default connection ordering is createdAt: filtering on updatedAt while sorting on createdAt and "
        + 'cursoring on updatedAt loses rows permanently, deterministically');
    assert.ok(/pageInfo \{ hasNextPage endCursor \}/.test(fn), 'the delta query does not paginate');
    assert.ok(/after: \$after/.test(fn), 'the delta query takes no cursor');
});

// ── The capability seam ─────────────────────────────────────────────────────

check('the seed rides its own capability, not a resurrected board-sync pair', () => {
    assert.ok(/seedProjects: boolean/.test(SEAM), 'RemoteProviderCapabilities has no seedProjects field');
    assert.ok(/seedBoardProject\?\(/.test(SEAM), 'RemoteProvider declares no seedBoardProject');
    for (const dead of ['boardSyncPush', 'boardSyncRestore', 'boardPush', 'boardRestore']) {
        assert.ok(!SEAM.includes(dead), `${dead} reappeared on the seam under the seed's banner`);
        assert.ok(!PROVIDER.includes(dead), `${dead} reappeared on LinearRemoteProvider`);
    }
    assert.ok(/seedProjects: true/.test(PROVIDER), 'LinearRemoteProvider does not declare seedProjects');
    assert.ok(/seedProjectToRemote\(/.test(PROVIDER), 'seedBoardProject must delegate to the engine, not reimplement it');
});

if (failures > 0) {
    console.error(`\n${failures} Linear seed contract check(s) failed`);
    process.exit(1);
}
console.log('Linear seed contract passed');
