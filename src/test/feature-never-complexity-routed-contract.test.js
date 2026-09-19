/**
 * Contract: a FEATURE is never complexity-routed. It goes to the lead.
 *
 * Complexity routing answers "how hard is this work?" — the right question for a
 * plan, the wrong one for a feature. A feature is not work a seat does; it is a set
 * of subtasks the team HEAD orders into rounds and registers. Routed by score, a
 * complexity-6 feature landed on a coder seat that cannot fan it out, and the
 * feature sat owned and undispatched with every subtask untouched.
 *
 * Operator decision, 2026-09-19: when a feature is dispatched, complexity routing is
 * ignored.
 */
const assert = require('assert');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(require('path').resolve(__dirname,'..','services','KanbanProvider.ts'),'utf8');
const i = SRC.indexOf('private async _resolveComplexityRoutedRole(');
const fn = SRC.slice(i, SRC.indexOf('\n    private async _updateRoutingConfig(', i));

let pass=0, fail=0;
const t=(n,f)=>{try{f();console.log('  ✅ '+n);pass++;}catch(e){console.log('  ❌ '+n+'\n     '+e.message);fail++;}};

t('a feature returns lead from the DB record, before any complexity is read', () => {
  const guard = fn.indexOf("Number(record.isFeature) === 1");
  const read  = fn.indexOf('getComplexityFromPlan');
  assert.ok(guard > 0, 'the isFeature guard must exist');
  assert.ok(read > 0 && guard < read, 'it must run BEFORE the complexity score is read');
  const ret = fn.slice(guard, guard + 400);
  assert.ok(/return 'lead';/.test(ret), "it must return 'lead'");
});

t('a feature still returns lead when the DB read throws', () => {
  const g = fn.indexOf("includes('/.switchboard/features/')");
  const read = fn.indexOf('getComplexityFromPlan');
  assert.ok(g > 0, 'the plan-file-path guard must exist for the run-sheet fallback');
  assert.ok(g < read, 'it must also run before the complexity score is read');
});

t('neither guard depends on a team being live', () => {
  const upto = fn.slice(0, fn.indexOf('getComplexityFromPlan'));
  assert.ok(!/resolveImplementationHead|_liveImplementationTeams|aliveNames/.test(upto),
    'routing a feature to a seat is wrong whether or not a team is up — the guard must not be '
    + 'conditional on liveness, or a feature dispatched before the team starts goes to a coder again');
});

t('the ONLY non-lead outcomes remain the complexity map', () => {
  const returns = [...fn.matchAll(/return '(lead|coder|intern)'/g)].map(m=>m[1]);
  assert.ok(returns.filter(r=>r!=='lead').length === 0,
    'every literal return in this function must be lead; coder/intern come only from resolveRoutedRole');
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
