const MAX_GOALS = 40;

const toSafeRate = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const getPoissonOutcomePercentages = (myxG, oppxG) => {
  const myRate = toSafeRate(myxG);
  const oppRate = toSafeRate(oppxG);

  const getProbabilities = (rate) => {
    const probabilities = new Array(MAX_GOALS + 1).fill(0);
    let probability = Math.exp(-rate);
    probabilities[0] = probability;
    for (let goals = 1; goals <= MAX_GOALS; goals += 1) {
      probability *= rate / goals;
      probabilities[goals] = probability;
    }
    return probabilities;
  };

  const myProbabilities = getProbabilities(myRate);
  const oppProbabilities = getProbabilities(oppRate);
  const oppSuffix = new Array(MAX_GOALS + 2).fill(0);
  for (let goals = MAX_GOALS; goals >= 0; goals -= 1) {
    oppSuffix[goals] = oppSuffix[goals + 1] + oppProbabilities[goals];
  }

  let win = 0;
  let draw = 0;
  let loss = 0;

  for (let myGoals = 0; myGoals <= MAX_GOALS; myGoals += 1) {
    const myProbability = myProbabilities[myGoals];
    win += myProbability * oppSuffix[myGoals + 1];
    draw += myProbability * oppProbabilities[myGoals];
    loss += myProbability * (oppSuffix[0] - oppSuffix[myGoals]);
  }

  const total = win + draw + loss;
  if (total <= 0) return { win: 0, draw: 100, loss: 0 };

  return {
    win: (win / total) * 100,
    draw: (draw / total) * 100,
    loss: (loss / total) * 100,
  };
};
