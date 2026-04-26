'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const providerPath = path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts');
const source = fs.readFileSync(providerPath, 'utf8');

describe('brain new-plan visibility regressions', () => {
    it('recognizes the current Antigravity plan markdown shape as a plan file', () => {
        assert.match(
            source,
            /const planSections = firstLines\.match\([\s\S]*Goal\|Goals\|Metadata\|User Review Required\|User Requirements Captured\|Complexity Audit\|Problem Description\|Proposed Solutions\|Proposed Changes[\s\S]*Verification Plan[\s\S]*Adversarial Synthesis[\s\S]*\) \|\| \[\];[\s\S]*const hasPlanMetadata = \/\\\*\\\*\(\?:Complexity\|Tags\):\\\*\\\*\/i\.test\(firstLines\);[\s\S]*return planSections\.length >= 2 \|\| \(planSections\.length >= 1 && hasPlanMetadata\);/,
            'Expected _isLikelyPlanFile to accept the repo\'s current Antigravity plan sections instead of only a narrow legacy subset.'
        );
    });

    it('trusts canonical implementation_plan basenames after the H1 gate', () => {
        assert.match(
            source,
            /const hasH1 = \/\^#\\s\+\.\+\/m\.test\(firstLines\);[\s\S]*if \(!hasH1\) return false;[\s\S]*const baseFilename = path\.basename\(this\._getBaseBrainPath\(filePath\)\)\.toLowerCase\(\);[\s\S]*if \(baseFilename === 'implementation_plan\.md'\) \{[\s\S]*return true;/,
            'Expected _isLikelyPlanFile to treat implementation_plan.md and implementation_plan.md.resolved variants as plan files after the H1 gate.'
        );
    });

    it('auto-claims fresh unregistered brain plans on follow-up change events', () => {
        assert.match(
            source,
            /const isFreshUnregisteredCandidate =[\s\S]*!existingEntry[\s\S]*!runSheetKnown[\s\S]*!fs\.existsSync\(mirrorPath\)[\s\S]*NEW_BRAIN_PLAN_AUTOCLAIM_WINDOW_MS;/,
            'Expected _mirrorBrainPlan to treat fresh unseen brain files as auto-claim candidates.'
        );
        assert.match(
            source,
            /const wouldAutoClaim = !eligibility\.eligible && \(allowAutoClaim \|\| isFreshUnregisteredCandidate\) && !existingEntry;[\s\S]*const canClaim = wouldAutoClaim[\s\S]*const shouldAutoClaim = wouldAutoClaim && canClaim;/,
            'Expected _mirrorBrainPlan to keep auto-claim enabled for fresh follow-up change events after the initial create event.'
        );
    });
});
