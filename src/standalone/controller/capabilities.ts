import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MatrixCapabilityKey } from './matrix';
import type { TierDeclaration } from '../judgement/tiers';

/**
 * Capability probes for the controller
 * (plan: the-controller-wakes-on-a-clock-diagnoses-and-reports, change 6;
 *  plan: judgement-tiers-the-supervisor-seat-and-reroute, change 7).
 *
 * Arming, capability and liveness are three declared states, never collapsed:
 * `armed: false` is not the same value as "no controller configured". Following
 * `capabilities.shutdown`, each row publishes `{ enabled, reason, source }`,
 * computed from the probes here.
 *
 * The probes run at the top of EVERY wake, not once at arm: fleet composition
 * changes under a live controller, and a model host sleeps and wakes. A
 * capability set computed once at arm is either permanently unavailable or
 * permanently claimed, and both are wrong in a way the report would never show.
 *
 * This module makes NO outbound model call and opens NO socket of its own — all
 * board reads go through the injected `apiRequest` (the CLI's own request
 * path). Reachability of a judgement tier is determined by the chain walk in
 * `walkJudgementChain`, not guessed here; a tier that is configured but
 * unreachable degrades that pass and never blocks the mechanical rows.
 */

export interface ControllerApiResponse {
    status: number;
    body: string;
    json: () => any;
}

export type ControllerApiRequest = (
    port: number,
    method: string,
    pathname: string,
    workspaceRoot: string,
    payload?: unknown,
    query?: Record<string, string>,
    timeoutMs?: number
) => Promise<ControllerApiResponse>;

export interface ModelProbe {
    configured: boolean;
    /** `null` = unknown at probe time; the chain walk reports the real answer. */
    reachable: boolean | null;
    constrainedOutput: boolean | null;
    source: string;
    reason: string;
    /** The ordered tiers this probe saw, with their declared metadata. */
    tiers: Array<Pick<TierDeclaration, 'providerId' | 'role' | 'locality' | 'operator' | 'costClass' | 'keySet' | 'source'>>;
}

/**
 * The platform probe — "will something restart the CONTROLLER". It is a
 * fail-safe question: a dead controller means no automation, not a dead board.
 * It does NOT gate row 7; the controller restarts the board itself.
 */
export interface SupervisorProbe {
    outcome: 'present' | 'absent' | 'platform-undetectable';
    detail: string;
    source: string;
}

/**
 * The NAVIGATOR's model slot, as `GET /controller/navigator` reports it
 * (plan: the-pilot-and-the-navigator-are-one-crew).
 *
 * This replaces the supervisor-SEAT probe. The supervisor was an agent in a pty
 * whose liveness had to be read from the fleet; the Navigator is a model
 * pointer, so "present" is not a fleet question at all. What is left is what an
 * operator needs: is a Navigator configured, what model answers for it, and —
 * when it is not configured — which of the three not-configured states this is.
 *
 * The three failure states stay DISTINCT. `unset` (nobody chose a provider),
 * `row-missing` (the pointer names a provider with no row) and `unreadable`
 * (the config could not be read) are three different fixes, and a single
 * "not configured" would answer for all three — the fallback rule.
 */
export interface NavigatorProbe {
    configured: boolean;
    providerId: string | null;
    model: string | null;
    endpoint: string | null;
    locality: string | null;
    costClass: string | null;
    operator: string | null;
    /** `row:navigator` | `unset` | `row-missing` | `unreadable` — never collapsed. */
    source: string;
    reason: string;
}

export interface SurviveBoardProbe {
    value: boolean | null;
    source: string;
    reason?: string;
}

export interface ProviderProbe {
    /** Distinct, RECORDED providers among live seats. */
    providers: string[];
    /** Live seats whose provider is not recorded (`cliFamily: 'unknown'`). */
    unknownSeats: string[];
    seats: Array<{ seat: string; provider: string | null; source: string }>;
    source: string;
    reason?: string;
}

export interface CapabilitySnapshot {
    model: ModelProbe;
    supervisor: SupervisorProbe;
    navigator: NavigatorProbe;
    surviveBoard: SurviveBoardProbe;
    providers: ProviderProbe;
}

export interface CapabilityContext {
    workspaceRoot: string;
    port: number;
    apiRequest: ControllerApiRequest;
    /** The resolved judgement tiers — endpoints/models/keySet resolved board-side. */
    tiers: TierDeclaration[];
    /**
     * The Navigator's slot, already read this wake from
     * `GET /controller/navigator`. Provided rather than read here so the
     * capability block the report prints and the escalation gate that spends
     * the call can never be reading two different answers.
     */
    navigator?: NavigatorProbe | null;
    /** A fleet list already read this wake; avoids a second round-trip. */
    fleet?: any[];
    /** Injectable for tests; defaults to the real filesystem/env. */
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homeDir?: string;
    /** A `/health` body already read this wake; avoids a second round-trip. */
    health?: any;
}

const TIER_SOURCE = 'controller.judgement';

function probeModel(ctx: CapabilityContext): ModelProbe {
    const tiers = Array.isArray(ctx.tiers) ? ctx.tiers : [];
    const summary = tiers.map(t => ({
        providerId: t.providerId,
        role: t.role,
        locality: t.locality,
        operator: t.operator,
        costClass: t.costClass,
        keySet: t.keySet,
        source: t.source,
    }));
    if (tiers.length === 0) {
        return {
            configured: false,
            reachable: null,
            constrainedOutput: null,
            source: TIER_SOURCE,
            reason: 'no judgement backend configured',
            tiers: summary,
        };
    }
    return {
        configured: true,
        // Reachability is answered by the chain walk on this wake, not guessed
        // here — a `false` for a merely unprobed host reads as "the model is
        // down", which is the quiet wrong answer.
        reachable: null,
        constrainedOutput: null,
        source: TIER_SOURCE,
        reason: `${tiers.length} judgement tier(s) configured [${tiers.map(t => `${t.providerId}:${t.role}/${t.locality}/${t.operator}/${t.costClass}`).join(', ')}]`,
        tiers: summary,
    };
}

function probeSupervisor(ctx: CapabilityContext): SupervisorProbe {
    const env = ctx.env ?? process.env;
    const platform = ctx.platform ?? process.platform;
    const homeDir = ctx.homeDir ?? os.homedir();

    if (platform === 'darwin') {
        const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
        try {
            const entries = fs.existsSync(launchAgents) ? fs.readdirSync(launchAgents) : [];
            const match = entries.find(f => /switchboard|labcom/i.test(f) && f.endsWith('.plist'));
            if (match) {
                return { outcome: 'present', detail: `launchd agent '${match}'`, source: `fs:${launchAgents}` };
            }
            return { outcome: 'absent', detail: 'no matching launchd agent', source: `fs:${launchAgents}` };
        } catch (e) {
            return { outcome: 'platform-undetectable', detail: `launchd agent scan failed: ${e instanceof Error ? e.message : String(e)}`, source: `fs:${launchAgents}` };
        }
    }

    if (platform === 'linux') {
        if (env.INVOCATION_ID) {
            return { outcome: 'platform-undetectable', detail: 'running under systemd, but the unit restart policy is not readable from here', source: 'env:INVOCATION_ID' };
        }
        try {
            if (fs.existsSync('/.dockerenv')) {
                return { outcome: 'platform-undetectable', detail: 'container restart policy is not readable from inside the container', source: 'fs:/.dockerenv' };
            }
            if (fs.existsSync('/run/systemd/system')) {
                return { outcome: 'platform-undetectable', detail: 'systemd is present, but no unit is associated with this process', source: 'fs:/run/systemd/system' };
            }
            return { outcome: 'absent', detail: 'no systemd, launchd or container supervisor detected', source: 'platform:linux' };
        } catch (e) {
            return { outcome: 'platform-undetectable', detail: `supervisor detection failed: ${e instanceof Error ? e.message : String(e)}`, source: 'platform:linux' };
        }
    }

    if (platform === 'win32') {
        return { outcome: 'platform-undetectable', detail: 'Windows service detection is not implemented', source: 'platform:win32' };
    }
    return { outcome: 'absent', detail: `no supervisor concept on platform '${platform}'`, source: `platform:${platform}` };
}

/**
 * The Navigator's slot, read from `GET /controller/navigator`
 * (plan: the-pilot-and-the-navigator-are-one-crew).
 *
 * This is a BOARD READ, not a model call: it resolves the Navigator's own
 * pointer over the shared provider rows and reports the endpoint, the model and
 * the key-set flag. Key VALUES never cross this route.
 *
 * The four states are kept apart rather than collapsed into a boolean. An
 * operator fixing an escalation that is not reaching anybody needs to know
 * whether nobody chose a provider, whether the pointer names a provider with no
 * row, or whether the config could not be read at all — and a Navigator whose
 * endpoint is set but whose model is missing is NOT configured: a request with
 * no model name against a hosted endpoint is a 400 dressed as a call.
 */
export async function readNavigatorSlot(
    ctx: Pick<CapabilityContext, 'apiRequest' | 'port' | 'workspaceRoot'>,
): Promise<NavigatorProbe> {
    const unconfigured = (source: string, reason: string): NavigatorProbe => ({
        configured: false, providerId: null, model: null, endpoint: null,
        locality: null, costClass: null, operator: null, source, reason,
    });
    let res: ControllerApiResponse | null;
    try {
        res = await ctx.apiRequest(ctx.port, 'GET', '/controller/navigator', ctx.workspaceRoot);
    } catch (e) {
        return unconfigured('unreadable', `the Navigator endpoint could not be reached (${e instanceof Error ? e.message : String(e)})`);
    }
    let view: any = null;
    if (res && res.status === 200) {
        try { view = res.json()?.navigator; } catch { view = null; }
    }
    if (!view || typeof view !== 'object') {
        return unconfigured('unreadable', res ? 'the board returned no navigator view' : 'the Navigator endpoint is unreachable');
    }
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const source = str(view.source) || 'unknown';
    const providerId = str(view.providerId);
    const endpoint = str(view.endpoint);
    const model = str(view.model);
    const reason = str(view.reason);
    const base = {
        providerId,
        model,
        endpoint,
        locality: str(view.locality),
        costClass: str(view.costClass),
        operator: str(view.operator),
    };
    if (source === 'unset') {
        return { configured: false, ...base, source, reason: reason || 'no Navigator model configured' };
    }
    if (source === 'row-missing') {
        return { configured: false, ...base, source, reason: reason || `the Navigator names provider '${providerId || 'unset'}', which has no row in agentControlProviders` };
    }
    if (source === 'unreadable') {
        return { configured: false, ...base, source, reason: reason || 'the Navigator config could not be read' };
    }
    // Configured means USABLE, not merely "a pointer is set". A local server
    // names its own model, so an empty model is legal for that provider alone.
    const configured = !!endpoint && (!!model || providerId === 'local');
    return {
        configured,
        ...base,
        source,
        reason: configured
            ? `Navigator model '${providerId || 'unset'}'${model ? ` (${model})` : ' (server names its own model)'} is configured`
            : `${source === 'row:navigator' ? 'the Navigator row' : 'the Navigator'} has ${endpoint ? 'no model set' : 'no endpoint'} — no model answers for it`,
    };
}

async function probeNavigator(ctx: CapabilityContext): Promise<NavigatorProbe> {
    if (ctx.navigator) { return ctx.navigator; }
    return readNavigatorSlot(ctx);
}

async function probeSurviveBoard(ctx: CapabilityContext): Promise<SurviveBoardProbe> {
    try {
        const json = ctx.health ?? (await ctx.apiRequest(ctx.port, 'GET', '/health', ctx.workspaceRoot, undefined, undefined, 5000)).json();
        const ptyHost = json?.ptyHost;
        if (ptyHost && typeof ptyHost.surviveBoard === 'boolean') {
            return { value: ptyHost.surviveBoard, source: 'health:ptyHost.surviveBoard' };
        }
        return { value: null, source: 'health:ptyHost.surviveBoard', reason: 'health reported no pty host' };
    } catch (e) {
        return { value: null, source: 'health:ptyHost.surviveBoard', reason: `health read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
}

/**
 * The provider per seat is RECORDED, not guessed: the fleet carries the
 * `cliFamily` the board derived from the seat's INNER command. `unknown` is
 * reported as unknown — never coerced to a plausible provider, because a guessed
 * provider would silently route work onto the wrong family.
 */
export function providerForSeat(seat: any): { provider: string | null; source: string } {
    const family = seat && typeof seat.cliFamily === 'string' ? seat.cliFamily : '';
    if (!family || family === 'unknown') {
        return { provider: null, source: 'fleet:cliFamily' };
    }
    return { provider: family, source: 'fleet:cliFamily' };
}

async function readFleet(ctx: CapabilityContext): Promise<any[] | null> {
    if (Array.isArray(ctx.fleet)) { return ctx.fleet; }
    try {
        const res = await ctx.apiRequest(ctx.port, 'POST', '/terminals/verb/ptyListTerminals', ctx.workspaceRoot, {});
        const data = res.json();
        if (Array.isArray(data)) { return data; }
        if (Array.isArray(data?.terminals)) { return data.terminals; }
        if (Array.isArray(data?.result)) { return data.result; }
        return [];
    } catch {
        return null;
    }
}

async function probeProviders(ctx: CapabilityContext, fleet: any[] | null): Promise<ProviderProbe> {
    if (fleet === null) {
        return { providers: [], unknownSeats: [], seats: [], source: 'terminals:ptyListTerminals', reason: 'fleet read failed' };
    }
    const seats: ProviderProbe['seats'] = [];
    const unknownSeats: string[] = [];
    const providerSet = new Set<string>();
    for (const t of fleet) {
        if (!t || t.status !== 'active') { continue; }
        const seat = String(t.friendlyName || '');
        if (!seat) { continue; }
        const found = providerForSeat(t);
        seats.push({ seat, provider: found.provider, source: found.source });
        if (found.provider) { providerSet.add(found.provider); }
        else { unknownSeats.push(seat); }
    }
    return {
        providers: Array.from(providerSet).sort(),
        unknownSeats,
        seats,
        source: 'terminals:ptyListTerminals',
    };
}

export async function probeCapabilities(ctx: CapabilityContext): Promise<CapabilitySnapshot> {
    const fleet = await readFleet(ctx);
    const [surviveBoard, providers, navigator] = await Promise.all([
        probeSurviveBoard(ctx),
        probeProviders(ctx, fleet),
        probeNavigator(ctx),
    ]);
    return {
        model: probeModel(ctx),
        supervisor: probeSupervisor(ctx),
        navigator,
        surviveBoard,
        providers,
    };
}

/**
 * `{ enabled, reason, source }` for one capability key, given a snapshot.
 * Never a bare boolean — a hidden capability is indistinguishable from one that
 * never existed, which is the fallback rule applied to the surface itself.
 */
export function capabilityForKey(key: MatrixCapabilityKey, caps: CapabilitySnapshot): { enabled: boolean; reason: string; source: string } {
    switch (key) {
        case 'mechanical':
            return { enabled: true, reason: 'mechanical — no judgement backend required', source: 'capability:mechanical' };
        case 'model': {
            const m = caps.model;
            // Enabled when a tier is configured with an endpoint. Reachability
            // is answered per call by the chain walk; a configured-but-dead
            // tier degrades that pass rather than disabling the row outright.
            const usable = m.tiers.some(t => !!t.providerId);
            const enabled = m.configured && usable;
            return { enabled, reason: m.reason, source: m.source };
        }
        case 'two-providers': {
            const p = caps.providers;
            const enabled = p.providers.length >= 2;
            const unknownNote = p.unknownSeats.length > 0 ? ` (${p.unknownSeats.length} seat(s) with an unrecorded provider)` : '';
            return {
                enabled,
                reason: `${p.providers.length} distinct provider(s) seated [${p.providers.join(', ') || 'none'}]${unknownNote}`,
                source: p.source,
            };
        }
    }
}

/**
 * Whether one escalation rung is reachable with the current capability set
 * (plan: the-pilot-acts-on-the-board-not-on-the-agent rewrote the ladder).
 *
 * The three cheap rungs and the terminal one need NOTHING but a seat: a byte, a
 * re-dispatch, a respawn and a stop are board operations, not model calls. The
 * judgement rungs need a tier, and `supervisor` needs a configured NAVIGATOR
 * rather than a live supervisor seat — the seat is retired, the rung is not.
 *
 * `restart-board` is RETIRED (plan:
 * the-board-restarts-only-when-it-stops-answering), so it is no longer a rung
 * and no longer has a case here.
 */
export function rungReachable(rung: string, caps: CapabilitySnapshot): boolean {
    switch (rung) {
        case 'bare-enter':
        case 'redeliver-dispatch':
        case 'respawn-seat':
        case 'reset-context':
        case 'stop':
            return true;
        case 'stand-down':
            return capabilityForKey('model', caps).enabled;
        case 'reroute':
            return capabilityForKey('model', caps).enabled && capabilityForKey('two-providers', caps).enabled;
        case 'supervisor':
            return capabilityForKey('model', caps).enabled && caps.navigator.configured;
        default:
            return false;
    }
}
