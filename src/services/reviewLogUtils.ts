export function formatReviewLogEntries(events: any[]): { timestamp: string; workflow: string; details: string }[] {
    const columnRoleMap: Record<string, string> = {
        'CREATED': 'Planner',
        'PLAN REVIEWED': 'Planner',
        'LEAD CODED': 'Lead Coder',
        'CODER CODED': 'Coder',
        'CODE REVIEWED': 'Reviewer',
        'ACCEPTANCE TESTED': 'Acceptance Tester'
    };

    return [...events].reverse().map((event) => {
        const action = String(event?.action || '').trim().toLowerCase();
        const targetColumn = String(event?.targetColumn || '').trim();
        const outcome = String(event?.outcome || '').trim().toLowerCase();
        const workflow = String(event?.workflow || 'unknown').trim() || 'unknown';

        const role = columnRoleMap[targetColumn] || '';

        let details = '';
        if (action === 'execute' || action === 'delegate_task') {
            details = role ? `SENT TO ${role}` : `Dispatched (${workflow})`;
        } else if (action === 'submit_result') {
            details = role ? `COMPLETED — ${role}` : `Completed (${workflow})`;
        } else if (outcome === 'failed' || outcome === 'fail') {
            details = role ? `FAILED — ${role}` : `Failed (${workflow})`;
        } else if (action === 'start_workflow') {
            details = `Started ${workflow}`;
        } else if (action === 'complete_workflow_phase') {
            details = `Phase completed (${workflow})`;
        } else {
            const parts = [
                action ? `action=${action}` : '',
                outcome ? `outcome=${outcome}` : '',
                targetColumn ? `target=${targetColumn}` : ''
            ].filter(Boolean);
            details = parts.join(' · ') || 'No additional details';
        }

        return { timestamp: String(event?.timestamp || ''), workflow, details };
    });
}
