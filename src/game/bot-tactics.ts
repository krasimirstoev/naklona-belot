import { assessNoTrump, evaluateNoTrump, type NoTrumpOptions } from './bot-no-trump.js';
import { analyzeCardTactics, analyzeTacticalContext } from './bot-analysis.js';
export { analyzeCardTactics, analyzeTacticalContext } from './bot-analysis.js';
import { strategicCandidates, type StrategyAssessment } from './bot-strategy.js';
import { legalCards, points, strength, suit, team, winner } from './engine.js';
import { type Card } from './types.js';
import { buildKnowledge, type BotKnowledge, type BotPosition } from './bot-knowledge.js';

export interface BotReason { id: string; contribution: number; facts: string[] }
export interface CardEvaluation { card: Card; score: number; reasons: BotReason[]; utility?: number[]; supported?:boolean }
export interface SearchDiagnostics { completedBatches: number; abortedBatches: number; uniqueSamples: number; sampleAttempts?:number; rejectedSamples?:number; fallback: boolean; objective: string[]; exhaustive?:boolean; minimumBatches?:number; lowConfidence?:boolean }
export interface BotDecision { card: Card; reasons: BotReason[]; candidates: CardEvaluation[]; strategy?: StrategyAssessment; search?: SearchDiagnostics }

/** Shared public-information policy for medium play and hard rollouts. */
export function decideTacticalCard(v: BotPosition, legal = legalCards(v.hand, v.trick, v.contract!, v.seat), knowledge = buildKnowledge(v), ntOptions: NoTrumpOptions = {}): BotDecision {
  if (!legal.length) throw new Error('Bot has no legal card');
  const k = knowledge, contract = v.contract!;
  const context = analyzeTacticalContext(v,k);
  const nt = contract==='NT' ? assessNoTrump(v,k) : null;
  const candidates = legal.map(card => {
    const reasons: BotReason[] = [];
    const analysis = analyzeCardTactics(v, card, k, context, k.declaringTeam !== null && k.declaringTeam !== team(v.seat));
    const add = (id: string, contribution: number, ...facts: string[]) => reasons.push({ id, contribution, facts });
    const cost = points(card, contract) * .35 + strength(card, contract) * .1;
    if (nt) {
      reasons.push(...evaluateNoTrump(v,k,card,nt,ntOptions));
    } else if (!v.trick.length) {
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

/** Планът избира предпочитано множество; тактическата оценка разрешава равенствата. */
export function decideCard(v: BotPosition, legal = legalCards(v.hand,v.trick,v.contract!,v.seat), knowledge = buildKnowledge(v), ntOptions: NoTrumpOptions = {}): BotDecision {
  const tactical = decideTacticalCard(v,legal,knowledge,ntOptions);
  let strategy = strategicCandidates(v,knowledge,legal);
  const pool = tactical.candidates.filter(c=>strategy.preferred.includes(c.card));
  const best = pool.reduce((a,b)=>b.score>a.score?b:a);
  if(v.contract==='NT'&&strategy.plan==='BALANCED_PLAY') {
    const wins=winner([...v.trick,{player:v.seat,card:best.card}],'NT')===v.seat;
    const duck=v.trick.length>0&&!wins&&legal.some(card=>winner([...v.trick,{player:v.seat,card}],'NT')===v.seat);
    const plan=best.reasons.some(r=>r.id==='NT_CONTRACT_OBJECTIVE')?'SECURE_CONTRACT':
      duck?'DUCK_TRICK':!v.trick.length&&knowledge.masters.includes(best.card)?'CASH_WINNERS':
      v.trick.length&&!wins?'PRESERVE_ENTRY':'BALANCED_PLAY';
    strategy={...strategy,plan,preferred:[best.card],objective:'Сравняваме прибиране на точки, запазени ресурси и качество на продължението.',
      facts:best.reasons.flatMap(r=>r.facts),assumptions:['Вероятностите за притежание и бъдещата стойност са приближения, не гаранция за договора.'],
      invalidatedBy:['Всяка нова публична карта променя блокерите, входовете и оставащите точки.']};
  }
  const candidates = tactical.candidates.map(c=>({...c,reasons:[...c.reasons,{
    id: strategy.preferred.includes(c.card)?'plan.preferred':'plan.alternative', contribution:0,
    facts:[strategy.plan,...strategy.facts, ...(strategy.preferred.includes(c.card)?[]:['Има допустим ход, който запазва повече от ресурсите на избрания план.'])]
  }]}));
  return {card:best.card,reasons:candidates.find(c=>c.card===best.card)!.reasons,candidates,strategy};
}
