'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const implementationHtmlPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const terminalsJsPath = path.join(process.cwd(), 'src', 'webview', 'terminals.js');
    const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const extensionPath = path.join(process.cwd(), 'src', 'extension.ts');

    const kanbanHtmlSource = fs.readFileSync(kanbanHtmlPath, 'utf8');
    const implementationHtmlSource = fs.readFileSync(implementationHtmlPath, 'utf8');
    const terminalsJsSource = fs.readFileSync(terminalsJsPath, 'utf8');
    const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
    const extensionSource = fs.readFileSync(extensionPath, 'utf8');

    assert.ok(
        !kanbanHtmlSource.includes("document.querySelectorAll('.card-btn.view')"),
        'Expected kanban.html to remove the card-btn.view click binding.'
    );
    assert.ok(
        !kanbanHtmlSource.includes("type: 'viewPlan'"),
        'Expected kanban.html to stop posting Kanban viewPlan messages.'
    );
    assert.ok(
        !kanbanHtmlSource.includes('card-btn icon-btn view'),
        'Expected kanban.html to stop rendering the Kanban View button.'
    );
    // The surviving card actions, pinned by their class markers rather than by a
    // `title=` attribute. The board moved to a custom `data-tooltip` system — the
    // panel font stack renders no native tooltip worth having — so asserting on
    // `title="Review Plan Ticket"` / `title="Complete Plan"` went stale and this
    // whole test died silently at this line (it was never wired into CI, so nobody
    // saw it). Class + tooltip text is the stable shape: the removal being guarded
    // here is `viewPlan`, and what must survive it is that review/complete/copy
    // still render.
    assert.ok(
        kanbanHtmlSource.includes('card-btn icon-btn review') &&
        kanbanHtmlSource.includes('data-tooltip="Complete and archive"') &&
        kanbanHtmlSource.includes('${copyLabel}'),
        'Expected the remaining Kanban card actions (review, complete, copy) to stay intact.'
    );
    // The review/complete click bindings moved from per-card `querySelectorAll(...)
    // .forEach(btn => btn.addEventListener('click'))` loops to a single delegated
    // listener per `.column-body` (`handleCardClick`), which dispatches by button
    // class. What must survive the viewPlan removal is that both buttons still
    // reach a handler that posts their verb — not the binding mechanism, which is
    // an implementation detail this assertion must not re-pin.
    assert.ok(
        kanbanHtmlSource.includes("btn.classList.contains('review')") &&
        kanbanHtmlSource.includes("btn.classList.contains('complete')"),
        'Expected the review and complete card buttons to keep their click bindings (delegated via handleCardClick).'
    );
    assert.ok(
        kanbanHtmlSource.includes("type: 'reviewPlan'") &&
        kanbanHtmlSource.includes("type: 'completePlan'"),
        'Expected the review and complete card buttons to still post reviewPlan / completePlan.'
    );

    assert.ok(
        !kanbanProviderSource.includes("case 'viewPlan'"),
        'Expected KanbanProvider to remove the Kanban-only viewPlan message handler.'
    );
    assert.ok(
        !extensionSource.includes('switchboard.viewPlanFromKanban'),
        'Expected extension.ts to remove the Kanban-only viewPlan command registration.'
    );
    assert.ok(
        !taskViewerSource.includes('public async handleKanbanViewPlan('),
        'Expected TaskViewerProvider to remove the unused handleKanbanViewPlan wrapper.'
    );

    assert.ok(
        implementationHtmlSource.includes("type: 'reviewPlan'"),
        'Expected implementation.html to post reviewPlan (opens Project panel) instead of viewPlan (opens markdown preview).'
    );
    assert.ok(
        !implementationHtmlSource.includes("type: 'viewPlan'"),
        'Expected implementation.html to no longer post the old viewPlan message.'
    );
    assert.ok(
        taskViewerSource.includes('private async _handleViewPlan(sessionId: string, workspaceRoot?: string) {'),
        'Expected TaskViewerProvider to preserve the generic _handleViewPlan implementation (used as fallback in reviewPlan handler).'
    );

    // The terminals kanban-pane row has a button LABELLED `view` that posts the
    // `reviewPlan` verb. That mismatch is the whole hazard: a coder tidying the
    // call site "corrects" the verb to match the label, and the deleted
    // markdown-preview verb is back. The call-site comment is not enough — pin it.
    assert.ok(
        terminalsJsSource.includes("fetch('/kanban/verb/reviewPlan'"),
        'Expected the terminals kanban-pane view button to post the reviewPlan verb.'
    );
    assert.ok(
        !terminalsJsSource.includes('/kanban/verb/viewPlan') &&
        !terminalsJsSource.includes("type: 'viewPlan'"),
        'Expected terminals.js to never post the deleted kanban-surface viewPlan verb (the pane button is labelled `view` but the verb is `reviewPlan`).'
    );

    console.log('kanban view-plan removal regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban view-plan removal regression test failed:', error);
    process.exit(1);
}
