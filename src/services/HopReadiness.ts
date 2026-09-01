import { heldByTeam } from './LocalApiServer';

export type HopName = 'plan' | 'code' | 'review';
export type HopId = HopName | 1 | 2 | 3;

export interface HopSeat {
    friendlyName: string;
    role?: string;
    status?: string;
    lastDataAt?: number;
    [key: string]: any;
}

export interface HopBoardCard {
    planId?: string;
    topic?: string;
    kanbanColumn?: string;
    dispatchedTerminal?: string;
    dispatchedAgent?: string;
    dispatchedAt?: string | number | null;
    completedAt?: string | number | null;
    featureId?: string | null;
    [key: string]: any;
}

export interface HopSnapshot {
    seats?: HopSeat[] | null;
    board?: HopBoardCard[] | null;
    teamMembers?: string[] | null;
}

export type HopReadinessResult =
    | { free: boolean; reason: string }
    | { unknown: string };

export const HOP_DESTINATION_ROLES: Record<HopName, string[]> = {
    plan: ['planner'],
    code: ['lead', 'coder', 'intern'],
    review: ['reviewer'],
};

export const HOP_READINESS_ROLES: Record<HopName, string[]> = {
    plan: ['planner'],
    code: ['lead', 'coder', 'intern', 'reviewer'],
    review: ['lead', 'coder', 'intern', 'reviewer'],
};

export const HOP_SOURCE_COLUMNS: Record<HopName, string[]> = {
    plan: ['CREATED'],
    code: ['PLAN REVIEWED'],
    review: ['LEAD CODED', 'CODER CODED', 'INTERN CODED', 'CODED'],
};

export function normalizeHop(hop: HopId): HopName {
    if (hop === 1 || hop === 'plan') return 'plan';
    if (hop === 2 || hop === 'code') return 'code';
    if (hop === 3 || hop === 'review') return 'review';
    return hop as HopName;
}

/**
 * Checks whether the destination team for a given hop is free to receive new work.
 *
 * Rules:
 * 1. Missing inputs (empty fleet or missing board) return `{ unknown: string }`.
 *    Empty fleet fails closed: an empty fleet means unknown -> do not dispatch.
 * 2. If the destination team has no live seat in the fleet, return `{ unknown: string }`.
 * 3. Checks card assignment on the board via `heldByTeam` for all seats matching
 *    the hop's readiness roles. If any seat holds an uncompleted card, return `{ free: false, reason: string }`.
 * 4. Otherwise return `{ free: true, reason: string }`.
 */
export function teamIsFree(hop: HopId, snapshot?: HopSnapshot | null): HopReadinessResult {
    const hopName = normalizeHop(hop);
    if (!snapshot) {
        return { unknown: 'snapshot unavailable' };
    }
    if (!Array.isArray(snapshot.seats) || snapshot.seats.length === 0) {
        return { unknown: 'fleet unavailable' };
    }
    if (!Array.isArray(snapshot.board)) {
        return { unknown: 'board unavailable' };
    }

    const destRoles = HOP_DESTINATION_ROLES[hopName];
    if (!destRoles) {
        return { unknown: `unknown hop: ${String(hop)}` };
    }

    // Check that at least one destination seat is seated (and not exited)
    const destSeats = snapshot.seats.filter(
        s => s && s.friendlyName && s.status !== 'exited' && destRoles.includes((s.role || '').toLowerCase())
    );
    if (destSeats.length === 0) {
        return { unknown: `no ${destRoles.join('/')} seat available` };
    }

    // Readiness seats: seats in the readiness role set
    const readinessRoles = HOP_READINESS_ROLES[hopName];
    const readinessSeats = snapshot.seats.filter(
        s => s && s.friendlyName && s.status !== 'exited' && readinessRoles.includes((s.role || '').toLowerCase())
    );
    const readinessTerminalNames = new Set<string>(readinessSeats.map(s => s.friendlyName));

    // Check if any card is held by any readiness terminal
    for (const card of snapshot.board) {
        if (heldByTeam(card, readinessTerminalNames)) {
            const holder = card.dispatchedTerminal;
            const cardId = card.planId || card.topic || 'unknown';
            return {
                free: false,
                reason: `seat '${holder}' holds uncompleted card '${cardId}' in '${card.kanbanColumn || 'unknown'}'`
            };
        }
    }

    return {
        free: true,
        reason: `${hopName} team free`
    };
}
