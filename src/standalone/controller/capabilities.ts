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

/** The supervisor SEAT — an agent that can act. Distinct from the platform probe. */
export interface SupervisorSeatProbe {
    configured: boolean;
    seat: string | null;
    present: boolean;
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
    supervisorSeat: SupervisorSeatProbe;
    surviveBoard: SurviveBoardProbe;
    providers: ProviderProbe;
}

export interface CapabilityContext {
    workspaceRoot: string;
    port: number;
    apiRequest: ControllerApiRequest;
    /** The resolved judgement tiers — endpoints/models/keySet resolved board-side. */
    tiers: TierDeclaration[];
    /** The configured supervisor seat name, or null. */
    supervisorSeat: string | null;
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

async function probeSupervisorSeat(ctx: CapabilityContext, fleet: any[] | null): Promise<SupervisorSeatProbe> {
    const seat = ctx.supervisorSeat && ctx.supervisorSeat.trim() ? ctx.supervisorSeat.trim() : null;
    if (!seat) {
        return { configured: false, seat: null, present: false, source: 'controller.judgement:supervisorSeat', reason: 'no supervisor seat configured' };
    }
    if (fleet === null) {
        return { configured: true, seat, present: false, source: 'fleet:ptyListTerminals', reason: `fleet unreadable — cannot confirm supervisor seat '${seat}' is live` };
    }
    const live = fleet.find(t => t && t.friendlyName === seat && t.status === 'active');
    return {
        configured: true,
        seat,
        present: !!live,
        source: 'fleet:ptyListTerminals',
        reason: live ? `supervisor seat '${seat}' is live` : `supervisor seat '${seat}' is configured but not live`,
    };
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
    const [surviveBoard, providers, supervisorSeat] = await Promise.all([
        probeSurviveBoard(ctx),
        probeProviders(ctx, fleet),
        probeSupervisorSeat(ctx, fleet),
    ]);
    return {
        model: probeModel(ctx),
        supervisor: probeSupervisor(ctx),
        supervisorSeat,
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
        case 'supervisor': {
            const s = caps.supervisorSeat;
            return { enabled: s.present, reason: s.reason, source: s.source };
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
 * Whether one escalation rung is reachable with the current capability set.
 * `restart-board` is not reached by a judgement classification in this subtask
 * (row 7 declares itself unavailable); the judgement rungs need a tier and, for
 * the supervisor rung, a live supervisor seat.
 */
export function rungReachable(rung: string, caps: CapabilitySnapshot): boolean {
    switch (rung) {
        case 'nudge':
        case 'clear-respawn':
        case 'escalate-human':
            return true;
        case 'relay-answer':
        case 'stand-down':
        case 'record-unknown':
            return capabilityForKey('model', caps).enabled;
        case 'reroute':
            return capabilityForKey('model', caps).enabled && capabilityForKey('two-providers', caps).enabled;
        case 'supervisor':
            return capabilityForKey('model', caps).enabled && capabilityForKey('supervisor', caps).enabled;
        case 'restart-board':
            return false;
        default:
            return false;
    }
}
