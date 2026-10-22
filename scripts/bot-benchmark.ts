// Paired, deterministic suit-contract rounds; no changes to production state.
import { basicAction, heuristicCard, selectDeclarations } from '../src/game/bots.js';
import { applyAction, newGame, team, view } from '../src/game/engine.js';
import { SUITS, type Action, type View } from '../src/game/types.js';

function seeded(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function legacy(v: View): Action {
  const card = heuristicCard(v.hand, v.trick, v.contract!, v.seat, v.legalCards, v.tricks.flatMap(t => t.plays));
  return { type: 'play', card, declare: selectDeclarations(v.declarations), belot: v.belotCards.includes(card) };
}
const seedCount = Number(process.argv[2] ?? 24);
if (!Number.isInteger(seedCount) || seedCount < 1) throw new Error('Expected a positive seed count');
const results = SUITS.map(contract => ({ contract, rounds: 0, wins: 0, ties: 0, cardPointDifference: 0 }));
for (const result of results) for (let seed = 1; seed <= seedCount; seed++) for (const policyTeam of [0, 1]) {
  const g = newGame('medium', seeded(seed));
  applyAction(g, 0, { type: 'bid', bid: result.contract });
  for (const p of [1, 2, 3]) applyAction(g, p, { type: 'bid', bid: 'pass' });
  while (g.phase !== 'roundEnd') {
    if (g.phase === 'trick') applyAction(g, -1, { type: 'collect' });
    else {
      const v = view(g, g.turn);
      applyAction(g, g.turn, team(g.turn) === policyTeam ? basicAction(v) : legacy(v));
    }
  }
  const score = g.results[0].cardPoints;
  const difference = score[policyTeam] - score[1 - policyTeam];
  result.rounds++;
  result.cardPointDifference += difference;
  if (difference > 0) result.wins++;
  if (difference === 0) result.ties++;
}
const total = results.reduce((a, b) => ({ rounds: a.rounds + b.rounds, wins: a.wins + b.wins,
  ties: a.ties + b.ties, cardPointDifference: a.cardPointDifference + b.cardPointDifference }),
{ rounds: 0, wins: 0, ties: 0, cardPointDifference: 0 });
console.log(JSON.stringify({ seedCount, description: 'New medium policy vs original heuristic; same deals, teams exchanged. Card points only, including last trick.',
  contracts: results, total: { ...total, meanCardPointDifference: total.cardPointDifference / total.rounds } }, null, 2));
