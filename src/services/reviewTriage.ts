/**
 * Review Team Triage & Apportionment Service
 *
 * Implements the review team orchestration logic:
 * 1. Plan assignment in batches of up to 2 per reviewer.
 * 2. 4-category triage:
 *    (1) needs no fixing
 *    (2) fixes needed
 *    (3) follow-ups needed for deferred issues or remaining risks
 *    (4) did not meet intent
 * 3. Apportionment of categories 2 and 3 back to originating reviewer with file-disjoint concurrency.
 * 4. Lead artifact generation for deferred items, remaining risks, and intent failures.
 */

export enum ReviewTriageCategory {
    NEEDS_NO_FIXING = 1,
    FIXES_NEEDED = 2,
    FOLLOW_UPS_NEEDED = 3,
    DID_NOT_MEET_INTENT = 4,
}

export interface ReviewPlanAssignment {
    reviewer: string;
    planIds: string[];
}

export interface ReviewPlanReport {
    planId: string;
    reviewer: string;
    category: ReviewTriageCategory;
    findings?: string;
    files?: string[];
    deferredItems?: string[];
    remainingRisks?: string[];
    intentNotes?: string;
}

export interface FixApportionmentBatch {
    reviewer: string;
    planId: string;
    files: string[];
    findings?: string;
    category: ReviewTriageCategory;
}

export interface ReviewTriageSummary {
    category1: ReviewPlanReport[];
    category2: ReviewPlanReport[];
    category3: ReviewPlanReport[];
    category4: ReviewPlanReport[];
}

/**
 * Assign a feature's subtask plans to available reviewer seats.
 * Assigns up to `batchSize` (default 2) plans per reviewer in round-robin/partitioned order.
 * Guarantees every plan is assigned exactly once (no duplicates, 100% coverage).
 */
export function assignPlansToReviewers(
    planIds: string[],
    reviewerSeats: string[],
    batchSize: number = 2
): ReviewPlanAssignment[] {
    if (!Array.isArray(planIds) || planIds.length === 0 || !Array.isArray(reviewerSeats) || reviewerSeats.length === 0) {
        return [];
    }

    const effectiveBatchSize = Math.max(1, batchSize);
    const uniquePlans = Array.from(new Set(planIds.filter(p => typeof p === 'string' && p.trim().length > 0)));
    const uniqueReviewers = Array.from(new Set(reviewerSeats.filter(r => typeof r === 'string' && r.trim().length > 0)));

    if (uniquePlans.length === 0 || uniqueReviewers.length === 0) {
        return [];
    }

    const assignments: Map<string, string[]> = new Map();
    uniqueReviewers.forEach(r => assignments.set(r, []));

    let reviewerIdx = 0;
    for (let i = 0; i < uniquePlans.length; i += effectiveBatchSize) {
        const batch = uniquePlans.slice(i, i + effectiveBatchSize);
        const reviewer = uniqueReviewers[reviewerIdx % uniqueReviewers.length];
        const existing = assignments.get(reviewer) || [];
        existing.push(...batch);
        assignments.set(reviewer, existing);
        reviewerIdx++;
    }

    const result: ReviewPlanAssignment[] = [];
    for (const [reviewer, plans] of assignments.entries()) {
        if (plans.length > 0) {
            result.push({ reviewer, planIds: plans });
        }
    }
    return result;
}

/**
 * Triage review reports into the 4 defined categories.
 */
export function triageReviewReports(reports: ReviewPlanReport[]): ReviewTriageSummary {
    const summary: ReviewTriageSummary = {
        category1: [],
        category2: [],
        category3: [],
        category4: [],
    };

    if (!Array.isArray(reports)) {
        return summary;
    }

    for (const report of reports) {
        if (!report || !report.planId) continue;
        switch (report.category) {
            case ReviewTriageCategory.NEEDS_NO_FIXING:
                summary.category1.push(report);
                break;
            case ReviewTriageCategory.FIXES_NEEDED:
                summary.category2.push(report);
                break;
            case ReviewTriageCategory.FOLLOW_UPS_NEEDED:
                summary.category3.push(report);
                break;
            case ReviewTriageCategory.DID_NOT_MEET_INTENT:
                summary.category4.push(report);
                break;
            default:
                // Default unclassified with findings to category 2, without findings to category 1
                if (report.findings && report.findings.trim().length > 0) {
                    summary.category2.push(report);
                } else {
                    summary.category1.push(report);
                }
                break;
        }
    }

    return summary;
}

/**
 * Apportion fixes for Categories 2 and 3 back to the originating reviewer.
 * Organizes fix tasks into execution batches where concurrent tasks in the same batch
 * are file-disjoint (touching disjoint sets of files).
 * Tasks with overlapping files are scheduled in sequential waves.
 */
export function apportionFixes(
    reports: ReviewPlanReport[]
): FixApportionmentBatch[][] {
    if (!Array.isArray(reports) || reports.length === 0) {
        return [];
    }

    // Only categories 2 and 3 are fixed. Categories 1 and 4 are not fixed.
    const fixableReports = reports.filter(r =>
        r && (r.category === ReviewTriageCategory.FIXES_NEEDED || r.category === ReviewTriageCategory.FOLLOW_UPS_NEEDED)
    );

    if (fixableReports.length === 0) {
        return [];
    }

    const items: FixApportionmentBatch[] = fixableReports.map(r => ({
        reviewer: r.reviewer,
        planId: r.planId,
        files: (r.files || []).map(f => f.trim()).filter(Boolean),
        findings: r.findings,
        category: r.category,
    }));

    // Group items into waves of file-disjoint tasks
    const waves: FixApportionmentBatch[][] = [];
    const remaining = [...items];

    while (remaining.length > 0) {
        const currentWave: FixApportionmentBatch[] = [];
        const filesInWave = new Set<string>();
        const reviewersInWave = new Set<string>();

        const unplaced: FixApportionmentBatch[] = [];

        for (const item of remaining) {
            const hasFileConflict = item.files.some(f => filesInWave.has(f));
            const hasReviewerConflict = reviewersInWave.has(item.reviewer);

            if (!hasFileConflict && !hasReviewerConflict) {
                currentWave.push(item);
                item.files.forEach(f => filesInWave.add(f));
                reviewersInWave.add(item.reviewer);
            } else {
                unplaced.push(item);
            }
        }

        waves.push(currentWave);
        if (unplaced.length === remaining.length) {
            // Safety fallback: if no items could be placed without conflict, push next one alone
            const next = unplaced.shift()!;
            waves.push([next]);
        }
        remaining.length = 0;
        remaining.push(...unplaced);
    }

    return waves;
}

/**
 * Generate a single review lead artifact covering:
 * - Deferred items (Category 3)
 * - Remaining risks (Category 3 / general findings)
 * - Plans that failed on intent (Category 4)
 */
export function generateReviewLeadArtifact(opts: {
    featureId: string;
    featureTitle?: string;
    reports: ReviewPlanReport[];
}): string {
    const { featureId, featureTitle, reports } = opts;
    const triage = triageReviewReports(reports || []);

    const lines: string[] = [];
    const title = featureTitle ? `Review Findings & Deferred Risks: ${featureTitle}` : `Review Findings & Deferred Risks: ${featureId}`;
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`**Feature ID:** \`${featureId}\``);
    lines.push(`**Triage Date:** ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- **Passed without fixes:** ${triage.category1.length}`);
    lines.push(`- **Fixed in review:** ${triage.category2.length}`);
    lines.push(`- **Deferred / Follow-ups:** ${triage.category3.length}`);
    lines.push(`- **Intent Failures (Require New Plan):** ${triage.category4.length}`);
    lines.push('');

    // Section 1: Deferred Items & Follow-ups
    lines.push('## Deferred Items & Follow-ups');
    if (triage.category3.length === 0) {
        lines.push('No deferred items.');
    } else {
        for (const item of triage.category3) {
            lines.push(`### Plan \`${item.planId}\` (Reviewed by ${item.reviewer})`);
            if (item.deferredItems && item.deferredItems.length > 0) {
                item.deferredItems.forEach(d => lines.push(`- ${d}`));
            } else if (item.findings) {
                lines.push(item.findings);
            } else {
                lines.push('- Follow-up recommended based on review.');
            }
            lines.push('');
        }
    }
    lines.push('');

    // Section 2: Remaining Risks
    lines.push('## Remaining Risks');
    const allRisks: Array<{ planId: string; risk: string }> = [];
    for (const r of reports) {
        if (r.remainingRisks && r.remainingRisks.length > 0) {
            r.remainingRisks.forEach(risk => allRisks.push({ planId: r.planId, risk }));
        }
    }
    if (allRisks.length === 0) {
        lines.push('No critical remaining risks flagged.');
    } else {
        for (const { planId, risk } of allRisks) {
            lines.push(`- **[${planId}]**: ${risk}`);
        }
    }
    lines.push('');

    // Section 3: Intent Failures
    lines.push('## Intent Failures (Remediation Requires New Plan)');
    if (triage.category4.length === 0) {
        lines.push('All subtasks satisfied product intent.');
    } else {
        lines.push('> [!IMPORTANT]');
        lines.push('> The following subtasks did not satisfy product intent. Per protocol, plans are not reopened or edited in-place; remediation must be planned as a new plan.');
        lines.push('');
        for (const item of triage.category4) {
            lines.push(`### Plan \`${item.planId}\` (Reviewed by ${item.reviewer})`);
            if (item.intentNotes) {
                lines.push(item.intentNotes);
            } else if (item.findings) {
                lines.push(item.findings);
            } else {
                lines.push('Plan failed to meet stated intent requirements.');
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}
