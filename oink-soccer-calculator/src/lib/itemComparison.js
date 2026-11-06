export const compareOutcomes = (before, after) => ({
  winDelta: after.win - before.win,
  drawDelta: after.draw - before.draw,
  pointBefore: before.win + before.draw,
  pointAfter: after.win + after.draw,
  pointDelta: (after.win + after.draw) - (before.win + before.draw),
});
