import { legalCards, points, suit, team, winner } from '../../src/game/engine.js';
import { SUITS, type Card, type Play } from '../../src/game/types.js';
import type { BotKnowledge, BotPosition } from './bot-knowledge.js';

/** An overestimate of legal holdings: use only cards this seat can still own. */
export function possiblePlays(v: BotPosition, k: BotKnowledge, seat: number, prior: Play[]): Card[] {
  const known = k.remaining.filter(c => k.possibleOwners[c]?.length === 1 && k.possibleOwners[c]![0] === seat);
  return k.remaining.filter(c => k.possibleOwners[c]?.includes(seat) &&
    legalCards([...new Set([...known, c])], prior, v.contract!, seat).includes(c));
}

/** Only claim forcing if no intervening player can remove the obligation to ruff. */
function forcingTargets(v: BotPosition, k: BotKnowledge, card: Card): number[] {
  const contract = v.contract!;
  const prior = [...v.trick, { player: v.seat, card }];
  const best = prior.find(p => p.player === winner(prior, contract))!;
  if (team(best.player) !== team(v.seat) || suit(best.card) === contract) return [];
  const lead = suit(prior[0].card), targets: number[] = [];
  for (let offset = 1; offset < 4 - v.trick.length; offset++) {
    const seat = (v.seat + offset) % 4;
    if (team(seat) !== team(v.seat) && k.voidSuits[seat].includes(lead) &&
      k.remainingTrumps.some(c => k.possibleOwners[c]?.includes(seat))) targets.push(seat);
    // An intervening trump or enemy winner makes later forcing uncertain.
    if (possiblePlays(v, k, seat, prior).some(c => suit(c) === contract ||
      (team(seat) !== team(v.seat) && winner([...prior, { player: seat, card: c }], contract) === seat))) break;
  }
  return targets;
}

/** Conditions only: no heuristic bonuses, probabilities or guaranteed side-suit tricks. */
export function analyzeTacticalContext(v: BotPosition, k: BotKnowledge) {
  const contract = v.contract!;
  const suitContract = contract !== 'NT' && contract !== 'AT';
  const trumps = v.hand.filter(c => suit(c) === contract);
  const enemyTrumps = k.remainingTrumps.filter(c => k.possibleOwners[c]?.some(p => team(p) !== team(v.seat)));
  const ruffSuit = SUITS.find(s => s !== contract && k.voidSuits[v.seat].includes(s) &&
    k.remaining.some(c => suit(c) === s && k.possibleOwners[c]?.some(p => team(p) !== team(v.seat))));
  const partner = (v.seat + 2) % 4;
  const partnerTrumps = k.remainingTrumps.filter(c => k.possibleOwners[c]?.includes(partner));
  const preservePartner = partnerTrumps.length === 1 && k.possibleOwners[partnerTrumps[0]]?.length === 1 &&
    k.voidSuits[partner].some(s => s !== contract && k.remaining.some(c => suit(c) === s &&
      k.possibleOwners[c]?.some(p => team(p) !== team(v.seat))));
  return {contract,suitContract,trumps,enemyTrumps,ruffSuit,preservePartner,partner};
}
export function analyzeCardTactics(v: BotPosition, card: Card, k: BotKnowledge, context = analyzeTacticalContext(v,k), includeForcing = true) {
  const {contract,suitContract,trumps,enemyTrumps,ruffSuit,preservePartner,partner}=context;
  const prior = [...v.trick, {player:v.seat, card}];
  const currentWinner = winner(prior,contract);
  const winningCard = prior.find(p=>p.player===currentWinner)!.card;
  const lead = suit(prior[0].card);
  const futurePlayers = Array.from({length:3-v.trick.length},(_,i)=>(v.seat+i+1)%4);
  const ruffRisk = suitContract && suit(winningCard) !== contract &&
    futurePlayers.some(p => team(p) !== team(v.seat) && k.voidSuits[p].includes(lead) &&
      k.remainingTrumps.some(c => k.possibleOwners[c]?.includes(p)));
  const targets = includeForcing && suitContract && suit(card) !== contract ? forcingTargets(v, k, card) : [];
  const certainTargets = targets.filter(p => k.remainingTrumps.some(c => k.possibleOwners[c]?.length === 1 && k.possibleOwners[c]![0] === p));
  return { suitContract, trumps, enemyTrumps, ruffSuit, preservePartner, ruffRisk, targets, certainTargets,
    trump: suitContract && suit(card) === contract,
    wins: currentWinner === v.seat,
    partnerWinning: k.currentWinner === partner,
    stakes: [...v.trick.map(p => p.card), card].reduce((n,c) => n + points(c,contract),0),
    control: k.masters.includes(card) && trumps.length >= 2,
    sideMasters: k.masters.filter(c => suit(c) !== contract) };
}

