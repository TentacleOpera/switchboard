import { KanbanColumnDefinition } from '../agentConfig';

/**
 * Closed remote command vocabulary.
 * Only two verbs allowed:
 * 1. Author content (create / update plan markdown)
 * 2. Move a card (advance column)
 *
 * A third verb — a free-text instruction channel — would collapse authoring
 * and triggering into a single write, turning a reviewed-plan pipeline into
 * a remote shell. This file is the boundary: the switch table carries no
 * free-text column, and the review gate ensures a plan entering an execution
 * column has passed review. See the-remote-command-vocabulary-is-closed.md.
 */
export const ALLOWED_REMOTE_VERBS = ['author_content', 'move_card'] as const;
export type AllowedRemoteVerb = typeof ALLOWED_REMOTE_VERBS[number];

export interface ReviewGateResult {
  allowed: boolean;
  refusalReason?: string;
}

export interface ReviewGateOptions {
  targetColumn: string;
  sourceColumn?: string;
  columns: KanbanColumnDefinition[];
  isRemote?: boolean;
}

/*
 * NOTE ON RUN HISTORY — read before adding it back.
 *
 * An earlier revision took an optional `runs: Array<{ column?: string }>` so a
 * plan that had EVER been in a reviewed column could pass even when its current
 * column is not one. Nothing could supply it. `plan_events` is the only column
 * audit trail on the board, and its persisted literal is
 *   (plan_id, event_type, workflow, action, timestamp, device_id, user_id,
 *    payload, workspace_id)
 * — there is no `column` field, and no writer puts one in `payload` either. The
 * parameter was therefore a seam whose never-wired state and whose working
 * state produced identical behaviour, which is exactly the shape this codebase
 * keeps getting bitten by. It is removed rather than left declared.
 *
 * The gate consequently keys on the plan's CURRENT column. That is stricter,
 * and stricter is the safe direction: a reviewed plan parked in STAGING is
 * refused a remote trigger and the operator sees a receipt saying why. To relax
 * it, first persist a column-transition history (a `column` field on the
 * plan_events insert, or a dedicated table) — then, and only then, feed it here.
 */

/**
 * Helper to determine if a column role or kind represents execution/coding.
 */
export function isExecutionColumn(columnName: string, columns: KanbanColumnDefinition[]): boolean {
  if (!columnName) return false;
  const col = columns.find(c => c.id === columnName || c.label.toLowerCase() === columnName.toLowerCase());
  if (col) {
    const role = (col.role || '').toLowerCase();
    const kind = (col.kind || '').toLowerCase();
    if (kind === 'coded' || role === 'lead' || role === 'coder' || role === 'intern') {
      return true;
    }
  }

  // Fallback check on standard column naming conventions
  const norm = columnName.trim().toUpperCase();
  if (norm.includes('CODED') || norm.includes('EXECUTION') || norm === 'IN_PROGRESS') {
    return true;
  }
  return false;
}

/**
 * Check if a column has passed review stage or represents review.
 */
export function isReviewedStage(columnName: string, columns: KanbanColumnDefinition[]): boolean {
  if (!columnName) return false;
  const col = columns.find(c => c.id === columnName || c.label.toLowerCase() === columnName.toLowerCase());
  if (col) {
    const role = (col.role || '').toLowerCase();
    const kind = (col.kind || '').toLowerCase();
    if (kind === 'review' || kind === 'reviewed' || role === 'planner' || role === 'reviewer' || role === 'acceptance') {
      return true;
    }
  }

  const norm = columnName.trim().toUpperCase();
  if (norm.includes('REVIEWED') || norm.includes('REVIEW') || norm.includes('TESTED') || norm.includes('DONE')) {
    return true;
  }
  return false;
}

/**
 * Validates whether moving a plan into a target column is permitted under the review gate invariant.
 * Rule: Any plan entering an execution column must have been in a reviewed column (e.g. PLAN REVIEWED)
 * or currently be in a reviewed stage. Fails closed if columns cannot resolve.
 *
 * This gate is transport-neutral: it applies to every trigger path, not only remote
 * ones, because a local agent reading a poisoned ticket authors the same plan a
 * remote one does. See the-remote-command-vocabulary-is-closed.md decision 2.
 */
export function checkReviewGate(options: ReviewGateOptions): ReviewGateResult {
  const { targetColumn, sourceColumn, columns } = options;

  if (!columns || columns.length === 0) {
    // Fail closed if columns configuration is missing
    return {
      allowed: false,
      refusalReason: `Review gate failed closed: column configuration is missing or unresolvable.`
    };
  }

  const targetIsExecution = isExecutionColumn(targetColumn, columns);
  if (!targetIsExecution) {
    // Moving to non-execution columns is always allowed
    return { allowed: true };
  }

  // Target is execution. Check if plan is coming from or has passed a reviewed column.
  if (sourceColumn && isReviewedStage(sourceColumn, columns)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    refusalReason: `Refused move to execution column '${targetColumn}': plan has not passed a reviewed column (required: column with role 'planner' / kind 'review' / reviewed stage).`
  };
}

/**
 * Formats receipt comment for remote dispatch.
 * The receipt is the operator's audit trail for what a remote surface caused.
 * It must record which credential initiated and which plan was dispatched.
 */
export function formatDispatchReceipt(planId: string, credentialSource: string, targetColumn: string): string {
  const cred = credentialSource || 'unknown';
  return `[Switchboard Remote Receipt] Dispatch executed.\n- Plan: \`${planId}\`\n- Target Column: \`${targetColumn}\`\n- Credential / Source: \`${cred}\`\n- Timestamp: ${new Date().toISOString()}`;
}

/**
 * Formats refusal comment for remote dispatch / command refusal.
 * A refusal must be visible — a silent refusal trains operators to distrust
 * the loop and hides probing. See the-remote-command-vocabulary-is-closed.md.
 */
export function formatRefusalReceipt(planId: string, credentialSource: string, reason: string): string {
  const cred = credentialSource || 'unknown';
  return `[Switchboard Remote Receipt] Dispatch REFUSED.\n- Plan: \`${planId}\`\n- Credential / Source: \`${cred}\`\n- Reason: ${reason}\n- Timestamp: ${new Date().toISOString()}`;
}
