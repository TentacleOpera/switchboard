import { MAX_TERMINALS_PER_ROLE, getNextTerminalName } from './agentConfig';

export { MAX_TERMINALS_PER_ROLE, getNextTerminalName };
export const MAX_AUTOBAN_TERMINALS_PER_ROLE = MAX_TERMINALS_PER_ROLE;
export const getNextAutobanTerminalName = getNextTerminalName;

export const MISSION_CONTROL_TERMINAL_NAME = 'Mission Control';

export type MissionControlConfig = {
    intervalMinutes: number;   // wake interval for Mission Control
};

export const DEFAULT_MISSION_CONTROL_CONFIG: MissionControlConfig = {
    intervalMinutes: 10
};

export function normalizeMissionControlConfig(state?: Partial<MissionControlConfig> | null): MissionControlConfig {
    return {
        // Floor of 1 minute, no ceiling — "once every few hours" and "overnight"
        // are valid wake intervals.
        intervalMinutes: Math.max(1, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 10)
    };
}

/**
 * Mission Control seat when a session adopted the role in place (POST
 * /mission-control/adopt) rather than the host seating a terminal named
 * 'Mission Control'. `terminalName` is the pty friendlyName when the caller could
 * name itself (SWITCHBOARD_TERMINAL) — omitted when it could not, in which case
 * the seat is real but has no live delivery channel and reads the reports inbox.
 * Absent (the shipped default) = no adopted seat = pre-adopt behaviour.
 */
export interface MissionControlSeat {
    terminalName?: string;
    adoptedAt: string | number;
    instanceId?: string;
    customPrompt?: string;
}

export type MissionRunFlavour = 'unattended' | 'operations';

export interface MissionRunConfig {
    missionId: string;
    flavour: MissionRunFlavour;
}

export function normalizeMissionRunConfig(config: unknown): MissionRunConfig | null {
    if (!config || typeof config !== 'object') return null;
    const c = config as any;
    if (typeof c.missionId !== 'string' || !c.missionId.trim()) return null;
    const flavour: MissionRunFlavour = c.flavour === 'operations' ? 'operations' : 'unattended';
    return {
        missionId: c.missionId.trim(),
        flavour
    };
}

export type AutobanConfigState = {
    missionControlArmed?: boolean;
    missionControlSeat?: MissionControlSeat;
    pairProgrammingMode: 'off' | 'cli-cli' | 'cli-ide' | 'ide-cli' | 'ide-ide';
    aggressivePairProgramming: boolean;
    missionControlConfig?: MissionControlConfig;
};

export function normalizeAutobanConfigState(state?: Partial<AutobanConfigState> | null): AutobanConfigState {
    const legacyState = (state ?? {}) as any;
    const rawArmed = state?.missionControlArmed !== undefined
        ? state.missionControlArmed
        : legacyState.orchestratorArmed;
    const rawSeat = legacyState.missionControlSeat ?? legacyState.orchestratorSeat;
    const rawMissionControlConfig = legacyState.missionControlConfig ?? legacyState.orchestrationConfig;

    const missionControlArmed = typeof rawArmed === 'boolean' ? rawArmed : undefined;

    return {
        missionControlArmed,
        missionControlSeat: (function (s: any): MissionControlSeat | undefined {
            if (!s || typeof s !== 'object') return undefined;
            const rawAdoptedAt = s.adoptedAt;
            const adoptedAt = (typeof rawAdoptedAt === 'string' || typeof rawAdoptedAt === 'number')
                ? rawAdoptedAt
                : (rawAdoptedAt ? String(rawAdoptedAt) : '');
            if (adoptedAt === '' || adoptedAt === undefined || adoptedAt === null) return undefined;
            const terminalName = typeof s.terminalName === 'string' && s.terminalName.trim()
                ? s.terminalName.trim() : undefined;
            const instanceId = typeof s.instanceId === 'string' && s.instanceId.trim()
                ? s.instanceId.trim() : undefined;
            const customPrompt = typeof s.customPrompt === 'string'
                ? s.customPrompt : undefined;
            return {
                ...(terminalName !== undefined ? { terminalName } : {}),
                adoptedAt,
                ...(instanceId !== undefined ? { instanceId } : {}),
                ...(customPrompt !== undefined ? { customPrompt } : {})
            };
        })(rawSeat),
        pairProgrammingMode: (function(m: any, legacyEnabled: any) {
            const valid = ['off', 'cli-cli', 'cli-ide', 'ide-cli', 'ide-ide'];
            if (valid.includes(m)) return m;
            if (legacyEnabled === true) return 'cli-cli';
            return 'off';
        })((state as any)?.pairProgrammingMode, (state as any)?.pairProgrammingEnabled),
        aggressivePairProgramming: state?.aggressivePairProgramming === true,
        missionControlConfig: normalizeMissionControlConfig(rawMissionControlConfig),
    };
}

export function buildAutobanBroadcastState(
    state: AutobanConfigState
): AutobanConfigState {
    return normalizeAutobanConfigState(state);
}
