import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSetup } from './setupChanges.js';
const livePlayers = [1,2,3,4,5].map((n) => ({ id: `teamurl:team:${n}`, assetId: String(n), name: `P${n}`, selectedPosition: ['GK','DF','DF','MF','FW'][n-1], role: '' }));
const live = { formationKey:'Pyramid', players:livePlayers, tactics:{ press:'medium', tempo:'slow', lineHeight:'deep', setPieceTaker:'teamurl:team:4' } };
const rec = { formation:'Pyramid', lineup:livePlayers.map((p) => ({ ...p, id:`asset:${p.assetId}`, pos:p.selectedPosition })), tactics:{ press:'medium', tempo:'slow', lineHeight:'deep', setPieceTaker:'asset:4' } };
test('equivalent wallet and live IDs and swapped same-position order do not trigger changes', () => {
  const result = compareSetup(live, { ...rec, lineup:[rec.lineup[0],rec.lineup[2],rec.lineup[1],rec.lineup[3],rec.lineup[4]] });
  assert.deepEqual(result.changes, []);
});
test('identifies formation, lineup, position, role, tactics and set-piece changes', () => {
  const next = { formation:'Y', lineup:rec.lineup.map((p) => ({...p})), tactics:{ press:'high', tempo:'slow', lineHeight:'deep', setPieceTaker:'asset:6' } };
  next.lineup[2].selectedPosition = 'MF'; next.lineup[2].role = 'playmaker';
  next.lineup[4] = { id:'asset:6', assetId:'6', name:'New striker', pos:'FW', selectedPosition:'FW', role:'target_man' };
  const result = compareSetup(live, next);
  for (const type of ['formation','position','role','player','press','setPieceTaker']) assert.ok(result.changes.some((entry) => entry.type === type), type);
  assert.ok(result.playerChanges['asset:6'].includes('Add'));
});
test('unknown live lineup is not reported as matching', () => {
  assert.equal(compareSetup(null, rec), null);
  assert.equal(compareSetup({ ...live, isDefaultLineup:true }, rec), null);
});

test('unavailable live positions are reported as unknown', () => {
  const missing = { ...live, players: live.players.map((player) => ({ ...player, selectedPosition: null })) };
  assert.equal(compareSetup(missing, rec).positionsAvailable, false);
});
