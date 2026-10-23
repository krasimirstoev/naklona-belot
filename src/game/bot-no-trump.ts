import { points, rank, strength, suit, team, winner } from './engine.js';
import { SUITS, type Card, type Suit } from './types.js';
import type { BotKnowledge, BotPosition } from './bot-knowledge.js';
import type { BotReason } from './bot-tactics.js';

export interface NoTrumpOptions { retention?: boolean; tempo?: boolean }
export interface NTSuitAssessment {
  suit: Suit; cards: Card[]; masters: Card[]; blockers: Card[];
  outsidePoints: number; entries: number; development: number;
}
export interface NTAssessment {
  suits: NTSuitAssessment[]; collected: number[]; tricksLeft: number;
  role: 'declarer'|'defender'; pointsToMajority: number;
}
/** Public resources only. Own consecutive honours are all masters, even with an
 * intervening own card; unknown higher cards are blockers, not known enemies. */
export function assessNoTrump(v: BotPosition, k: BotKnowledge): NTAssessment {
  const collected=[0,0];
  for(const t of v.tricks) collected[team(t.winner)]+=t.plays.reduce((n,p)=>n+points(p.card,'NT'),0);
  const suits=SUITS.map(s=>{
    const cards=v.hand.filter(c=>suit(c)===s).sort((a,b)=>strength(b,'NT')-strength(a,'NT'));
    const blockers=k.unknown.filter(c=>suit(c)===s&&cards.length&&strength(c,'NT')>strength(cards[0],'NT'));
    const masters=cards.filter(c=>k.masters.includes(c));
    const entries=k.masters.filter(c=>suit(c)!==s).length;
    // Length alone cannot develop: enough time, an outside entry, few forcing
    // rounds and multiple cards left after those rounds are all necessary.
    const development=entries&&cards.length>=3&&blockers.length>0&&blockers.length<cards.length-1
      ? Math.min(cards.length-blockers.length-1,8-v.tricks.length-blockers.length-1)/(1+blockers.length):0;
    return {suit:s,cards,masters,blockers,entries,development:Math.max(0,development),
      outsidePoints:k.unknown.filter(c=>suit(c)===s).reduce((n,c)=>n+points(c,'NT'),0)};
  });
  return {suits,collected,tricksLeft:8-v.tricks.length,role:k.declaringTeam===team(v.seat)?'declarer':'defender',
    pointsToMajority:Math.max(0,132-collected[team(v.seat)])};
}

/** Chance proxy for no later opponent owning a beating card. This deliberately
 * makes no assumption that a partner will rescue a vulnerable current winner.
 * Marginal owner weights respect capacity but are not independent in reality. */
export function ntCaptureChance(v: BotPosition,k: BotKnowledge,card: Card): number {
  const prior=[...v.trick,{player:v.seat,card}],won=winner(prior,'NT');
  if(team(won)!==team(v.seat))return 0;
  const top=prior.find(p=>p.player===won)!.card;
  let safe=1;
  for(const c of k.unknown)if(suit(c)===suit(prior[0].card)&&strength(c,'NT')>strength(top,'NT')) {
    const owners=k.possibleOwners[c]??[],total=owners.reduce((n,p)=>n+v.counts[p],0);
    const threats=owners.filter(p=>team(p)!==team(v.seat)&&
      Array.from({length:3-v.trick.length},(_,i)=>(v.seat+i+1)%4).includes(p));
    safe*=1-(total?threats.reduce((n,p)=>n+v.counts[p],0)/total:0);
  }
  return safe;
}

/** One shared valuation for real Medium decisions and Hard's public rollouts.
 * Immediate capture pays for spending a resource; retained winners and runnable
 * continuations are opportunity costs, rather than unconditional ace rules. */
export function evaluateNoTrump(v: BotPosition,k: BotKnowledge,card: Card,a: NTAssessment,options:NoTrumpOptions={}): BotReason[] {
  const reasons:BotReason[]=[];
  const add=(id:string,contribution:number,...facts:string[])=>reasons.push({id,contribution,facts});
  const profile=a.suits.find(p=>p.suit===suit(card))!;
  const ownPoints=points(card,'NT'),pot=v.trick.reduce((n,p)=>n+points(p.card,'NT'),0);
  const capture=ntCaptureChance(v,k,card),master=k.masters.includes(card);
  const following=v.trick.length>0&&suit(card)===suit(v.trick[0].card);
  const winning=winner([...v.trick,{player:v.seat,card}],'NT')===v.seat;
  const last=a.tricksLeft===1?20:0;
  const cost=ownPoints*.35+strength(card,'NT')*.1;
  const partnerWinning=v.trick.length>0&&team(k.currentWinner!)===team(v.seat);
  const immediate=!v.trick.length?(master?12+ownPoints*.25:-cost):
    partnerWinning?(v.trick.length===3?ownPoints:-cost):capture*(12+pot*.4+last)-cost;
  add('NT_CAPTURE',immediate,
    `Оценка за запазване на отборната взятка: ${capture.toFixed(3)} (приближение).`,
    `На масата: ${pot}; последна взятка: ${last}; роля: ${a.role}.`);
  if(options.retention!==false) {
    const blockers=k.unknown.filter(c=>suit(c)===suit(card)&&strength(c,'NT')>strength(card,'NT')).length;
    const potential=master?1:1/(1+blockers*2);
    // A winner's additional value is a future trick and entry, not just its
    // printed points. Its own points are still credited when cashed now.
    const future=.1*potential*(ownPoints+8)*Math.min(1,(a.tricksLeft-1)/2);
    add(master?'NT_CASH_WINNERS':rank(card)==='10'?'NT_PROTECT_TEN':'NT_RETAIN_RESOURCE',-future,
      master?'Няма по-силна неизвестна карта в боята.':`${blockers} по-силни неизвестни карти; бъдещият победител не е гарантиран.`,
      `Пропусната бъдеща стойност: ${future.toFixed(2)}.`);
    if(v.trick.length&&!following&&profile.cards.length===2&&rank(card)!=='10'&&profile.cards.some(c=>rank(c)==='10')&&
      k.possibleOwners[`${profile.suit}-A`]?.some(p=>team(p)!==team(v.seat)))
      add('NT_PROTECT_TEN',-8,'Изхвърлянето оставя десетката сама срещу възможно чуждо асо.');
  }
  if(options.tempo!==false) {
    const continuation=a.suits.reduce((best,p)=>Math.max(best,p.masters.filter(c=>c!==card).length),0);
    // Initiative depends on runnable resources. No generic lead/void bonus.
    if(winning) add('NT_TEMPO_CONTROL',capture*continuation*.5,
      `След вземане остават до ${continuation} последователни собствени победителя в боя.`);
    if(!v.trick.length&&master) add('NT_DEVELOP_LONG_SUIT',Math.min(4,profile.masters.length-1)*.5+profile.outsidePoints*.15,
      `Боята съдържа ${profile.masters.length} непосредствени победителя и ${profile.outsidePoints} неизвестни точки.`);
    if(!v.trick.length&&!master&&profile.cards[0]===card&&profile.development>0)
      add('NT_DEVELOP_LONG_SUIT',profile.development*3,
        `${profile.blockers.length} блокиращи карти; ${profile.entries} странични входа.`,
        'Противниците могат да задържат блокерите; разработването е хипотеза.');
    if(v.trick.length===3&&winning&&master&&profile.masters.length===1&&profile.cards.length>=2&&profile.entries>0&&a.tricksLeft>3&&pot<=6)
      add('NT_PRESERVE_ACE',-profile.outsidePoints*.3,'Евтина завършена взятка; имаме страничен вход и останала карта в боята.',
        `${profile.outsidePoints} неизвестни точки в боята могат да бъдат прибрани по-късно; това не е гаранция.`);
  }
  // A secure majority makes throwing away current points unnecessary. No claim
  // about success probability is derived from this deterministic threshold.
  if(winning&&capture===1&&pot+ownPoints+last>=a.pointsToMajority&&a.pointsToMajority>0)
    add('NT_CONTRACT_OBJECTIVE',24,`Сигурното прибиране достига ${a.pointsToMajority} точки до строго мнозинство.`,
      a.role==='defender'?'Отнемаме възможността за изпълнение на чуждия договор.':'Осигуряваме изпълнение на собствения договор.');
  return reasons;
}
