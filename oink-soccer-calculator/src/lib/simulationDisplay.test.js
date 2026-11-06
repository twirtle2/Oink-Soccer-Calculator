import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMatchupDisplay } from './simulationDisplay.js';
const estimate = { label:'Estimate', win:'16.2', draw:'18.5', loss:'65.3', myxG:'1.09', oppxG:'2.34' };
const run = { status:'done', fingerprint:'match-a', results:[{ key:'baseline', wins:720, draws:795, losses:3485, trials:5000, goalsFor:5200, goalsAgainst:12500 }] };
test('completed matching simulation controls the headline and goals', () => {
  const display = selectMatchupDisplay(estimate, run, 'match-a', 'matchup');
  assert.equal(display.source, 'engine'); assert.equal(display.win, '14.4'); assert.equal(display.draw, '15.9');
  assert.equal(display.myxG, '1.04'); assert.equal(display.oppxG, '2.50');
});
test('stale, pending, missing or off-tab simulation never displays a quick estimate', () => {
  for (const [state, key, tab] of [[run,'match-b','matchup'], [{...run,status:'running'},'match-a','matchup'], [run,'match-a','season'], [{...run,results:[]},'match-a','matchup'], [{...run,results:[{key:'baseline',trials:5000}]},'match-a','matchup']]) {
    assert.equal(selectMatchupDisplay(estimate,state,key,tab).source, 'pending');
  }
});
