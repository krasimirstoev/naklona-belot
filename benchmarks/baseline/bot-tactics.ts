// Замразена политика преди стратегическия модул; само за тестове и измерване.
import { legalCards, points, strength, suit, team, winner } from '../../src/game/engine.js';
import { SUITS, type Card, type Play } from '../../src/game/types.js';
import { buildKnowledge, type BotKnowledge, type BotPosition } from '../../src/game/bot-knowledge.js';

export interface BotReason { id: string; contribution: number; facts: string[] }
export interface CardEvaluation { card: Card; score: number; reasons: BotReason[] }
export interface BotDecision { card: Card; reasons: BotReason[]; candidates: CardEvaluation[] }

/** An overestimate of legal holdings: use only cards this seat can still own. */
function possiblePlays(v: BotPosition, k: BotKnowledge, seat: number, prior: Play[]): Card[] {
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

/** Shared public-information policy for medium play and hard rollouts. */
export function decideCard(v: BotPosition, legal = legalCards(v.hand, v.trick, v.contract!, v.seat), knowledge = buildKnowledge(v)): BotDecision {
  if (!legal.length) throw new Error('Bot has no legal card');
  const k = knowledge, contract = v.contract!;
  const context = analyzeTacticalContext(v,k);
  const candidates = legal.map(card => {
    const reasons: BotReason[] = [];
    const analysis = analyzeCardTactics(v, card, k, context, k.declaringTeam !== null && k.declaringTeam !== team(v.seat));
    const add = (id: string, contribution: number, ...facts: string[]) => reasons.push({ id, contribution, facts });
    const cost = points(card, contract) * .35 + strength(card, contract) * .1;
    if (!v.trick.length) {
      add('base.lead', k.masters.includes(card) ? 12 + points(card, contract) * .25 : -cost,
        k.masters.includes(card) ? 'Няма по-силна неизвестна карта в боята.' : 'Предпочитаме евтина карта при липса на друг план.');
    } else if (team(k.currentWinner!) === team(v.seat)) {
      add('base.support', v.trick.length === 3 ? points(card, contract) : -cost,
        v.trick.length === 3 ? 'Партньорът взема завършената взятка.' : 'Партньорът води; остават играчи след нас.');
    } else {
      add('base.win', (analysis.wins ? 12 : 0) - cost,
        'Вземаме с евтина карта, когато можем.');
    }
    if (contract !== 'NT' && contract !== 'AT') {
      const ours = k.declaringTeam === team(v.seat);
      const { trumps, enemyTrumps } = analysis;
      if (!v.trick.length && suit(card) === contract && !enemyTrumps.length && legal.some(c => suit(c) !== contract)) {
        add('trump.exhausted', -24, 'Противниците нямат останали козове; предпочитаме странична боя.');
      }
      if (!v.trick.length && k.masters.includes(card) && analysis.ruffRisk) {
        add('trump.ruff-risk', -12 - points(card, contract) * .8,
          'Силната странична карта може да бъде цакана от противник с липсваща боя.');
      }
      if (!v.trick.length && ours && suit(card) === contract && enemyTrumps.length) {
        const control = analysis.control;
        const sideMasters = analysis.sideMasters;
        if (control) add('trump.draw', 18 + Math.min(6, sideMasters.length * 2),
          'Нашият отбор е обявил.', 'Водим сигурен коз и имаме продължение.',
          `${enemyTrumps.length} неизиграни коза могат да са у противниците.`, `${sideMasters.length} странични печеливши карти за защита.`);
        else add('trump.control-risk', -8, 'Нямаме сигурен коз с продължение; тегленето може да предаде контрола.');
        const ruffSuit = analysis.ruffSuit;
        if (ruffSuit && trumps.length <= 2) add('trump.preserve-ruff', -42,
          `Нямаме боя ${ruffSuit}; краткият ни коз може да вземе странична взятка.`);
        if (analysis.preservePartner) {
          add('trump.preserve-partner', -42, 'Партньорът има един известен коз и липсваща странична боя.');
        }
      }
      if (k.declaringTeam !== null && !ours && suit(card) !== contract) {
        const targets = analysis.targets;
        if (targets.length) {
          const target = targets.includes(v.declarer!) ? v.declarer! : targets[0];
          const certainTrump = analysis.certainTargets.includes(target);
          const stakes = analysis.stakes;
          const gain = (target === v.declarer ? 14 : 9) - (certainTrump ? 0 : 4) - stakes * 1.1;
          if (gain > 0) add('trump.force-ruff', gain,
            `Играч ${target} няма водената боя.`, 'Преди него противниковият му отбор не може да поведе взятката.',
            certainTrump ? 'Има известен коз и трябва да цака.' : 'Ако има коз, трябва да цака.',
            `Рискуваме ${stakes} точки; загубата на хода е включена в консервативния бонус.`);
        }
      }
    }
    return { card, score: reasons.reduce((sum, r) => sum + r.contribution, 0), reasons };
  });
  const best = candidates.reduce((a, b) => b.score > a.score ? b : a);
  return { card: best.card, reasons: best.reasons, candidates };
}
