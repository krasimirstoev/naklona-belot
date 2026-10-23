import { points, rank, strength, suit, team, winner } from '../../src/game/engine.js';
import { possiblePlays, analyzeCardTactics, analyzeTacticalContext } from './bot-analysis.js';
import { SUITS, type Card, type Suit } from '../../src/game/types.js';
import type { BotKnowledge, BotPosition } from './bot-knowledge.js';

export type StrategyPlan = 'SUPPORT_PARTNER'|'PROTECT_TEN'|'DRAW_TRUMPS'|'PRESERVE_TRUMPS'|'CASH_WINNERS'|'STOP_DRAWING'|'FORCE_DECLARER'|'DEVELOP_SUIT'|'BALANCED_PLAY';
export interface StrategyAssessment {
  plan: StrategyPlan; objective: string; facts: string[]; assumptions: string[];
  invalidatedBy: string[]; preferred: Card[];
}
/** Сигурни граници, а не очаквана дължина или вероятност. */
export function suitLengthBounds(v: BotPosition,k: BotKnowledge,seat: number,s: Suit) {
  const possible=k.remaining.filter(c=>k.possibleOwners[c]?.includes(seat));
  const certain=possible.filter(c=>k.possibleOwners[c]?.length===1);
  return {min:Math.max(certain.filter(c=>suit(c)===s).length,v.counts[seat]-possible.filter(c=>suit(c)!==s).length),
    max:Math.min(possible.filter(c=>suit(c)===s).length,v.counts[seat]-certain.filter(c=>suit(c)!==s).length)};
}
/** Достатъчно условие за сигурност: никой оставащ противник няма възможен законен биещ ход. */
export function secureTeamTrick(v: BotPosition,k: BotKnowledge,card: Card): boolean {
  const prior=[...v.trick,{player:v.seat,card}],contract=v.contract!;
  if(team(winner(prior,contract))!==team(v.seat)) return false;
  for(let offset=1;offset<4-v.trick.length;offset++) {
    const seat=(v.seat+offset)%4;
    if(team(seat)!==team(v.seat)&&possiblePlays(v,k,seat,prior).some(c=>winner([...prior,{player:seat,card:c}],contract)===seat)) return false;
  }
  return true;
}
export function tenGuardDiscard(v: BotPosition,k: BotKnowledge,card: Card): boolean {
  const s=suit(card);
  return v.trick.length>0&&s!==suit(v.trick[0].card)&&rank(card)!=='10'&&
    (v.contract==='NT'||(v.contract!=='AT'&&s!==v.contract))&&v.hand.includes(`${s}-10` as Card)&&
    v.hand.filter(c=>suit(c)===s).length===2&&
    k.possibleOwners[`${s}-A`]?.some(p=>team(p)!==team(v.seat))===true;
}
export function strategicCandidates(v: BotPosition,k: BotKnowledge,legal: Card[]): StrategyAssessment {
  const context=analyzeTacticalContext(v,k),contract=v.contract!;
  const make=(plan:StrategyPlan,preferred:Card[],objective:string,facts:string[],invalidatedBy:string[],assumptions:string[]=[]):StrategyAssessment=>
    ({plan,preferred,objective,facts,invalidatedBy,assumptions});
  const partner=(v.seat+2)%4;
  if(v.trick.length&&k.currentWinner===partner) {
    const secure=legal.filter(c=>secureTeamTrick(v,k,c));
    // Храним със застрашени точки, преди да подаряваме бъдещи взятки или кратък коз.
    const expendable=secure.filter(c=>!k.masters.includes(c)&&!tenGuardDiscard(v,k,c)&&
      !(contract!=='NT'&&contract!=='AT'&&suit(c)===contract));
    if(expendable.length) {
      const most=Math.max(...expendable.map(c=>points(c,contract)));
      return make('SUPPORT_PARTNER',expendable.filter(c=>points(c,contract)===most),'Прибираме застрашени точки при сигурен партньорски контрол.',
        ['Партньорът води.','Никой оставащ противник няма възможна законна карта, която да отнеме взятката.','Запазваме собствените бъдещи печеливши карти и козове.'],['Партньорът губи контрол.','Появява се възможно надбиване.']);
    }
    const preserved=(secure.length?secure:legal).filter(c=>!k.masters.includes(c)&&!tenGuardDiscard(v,k,c));
    if(preserved.length) {
      const least=Math.min(...preserved.map(c=>points(c,contract)));
      return make('SUPPORT_PARTNER',preserved.filter(c=>points(c,contract)===least),'Подкрепяме партньора, без да жертваме бъдеща печеливша карта.',
        ['Партньорът води.',secure.length?'Няма свободни застрашени точки за качване.':'Взятката не е доказано сигурна; не качваме скъпа карта.'],['Партньорът вече не води.','Задължителното отговаряне премахва алтернативата.']);
    }
  }
  if(v.trick.length) {
    const guards=legal.filter(c=>tenGuardDiscard(v,k,c));
    const alternatives=legal.filter(c=>!guards.includes(c)&&!k.masters.includes(c));
    // Не пазим поп за сметка на десетката му или по-скъпа жертва.
    const economical=alternatives.filter(c=>points(c,contract)<=Math.min(...guards.map(c=>points(c,contract))));
    if(guards.length&&economical.length) return make('PROTECT_TEN',economical,'Запазваме защитата на десетка срещу възможно чуждо асо.',
      ['Десетката има само една придружаваща карта.','Можем да изхвърлим друга, не по-скъпа карта.'],['Асото излиза или престава да е възможно у противник.','Налага се отговаряне в защитаваната боя.']);
  }
  if(!v.trick.length&&context.suitContract) {
    const safeSide=legal.filter(c=>suit(c)!==contract&&(!analyzeCardTactics(v,c,k,context,false).ruffRisk||points(c,contract)===0));
    if(context.enemyTrumps.length&&safeSide.length&&((context.ruffSuit&&context.trumps.length>0&&context.trumps.length<=2)||context.preservePartner))
      return make('PRESERVE_TRUMPS',safeSide,'Запазваме кратък коз за странично цакане.',
        [context.preservePartner?'Партньорът има доказан единствен полезен коз.':`Нямаме боя ${context.ruffSuit}; козовете са ${context.trumps.length}.`],['Липсващата боя е изчерпана.','Цакането вече не е възможно.','Всички странични ходове са прекалено уязвими.']);
    const control=legal.filter(c=>suit(c)===contract&&k.masters.includes(c));
    if(k.declaringTeam===team(v.seat)&&context.enemyTrumps.length&&context.trumps.length>=2&&control.length)
      return make('DRAW_TRUMPS',control,'Намаляваме риска за страничните карти чрез контролирано теглене.',
        ['Нашият отбор е обявил.','Имаме най-силен останал коз с продължение.','Противникови козове още са възможни.'],['Противниковите козове са изчерпани.','Губим контрола.','Става по-полезно да пазим коз за цакане.']);
    const side=legal.filter(c=>suit(c)!==contract);
    if(!context.enemyTrumps.length&&side.length) return make(side.some(c=>k.masters.includes(c))?'CASH_WINNERS':'STOP_DRAWING',side,'Използваме страничните бои след изчерпване на противниковия коз.',
      ['Нито един оставащ коз не може да е у противниците.'],['Остават само козове в ръката.']);
  }
  if(!v.trick.length&&contract==='NT') {
    const developing=SUITS.flatMap(s=>{
      const cards=legal.filter(c=>suit(c)===s);
      const entry=k.masters.some(c=>suit(c)!==s);
      const forcing=cards.filter(c=>rank(c)!=='10').sort((a,b)=>strength(b,contract)-strength(a,contract));
      const lead=forcing[0];
      const blockers=lead?k.unknown.filter(c=>suit(c)===s&&strength(c,contract)>strength(lead,contract)):[];
      const futureWinner=lead&&cards.some(c=>c!==lead&&k.unknown.filter(other=>suit(other)===s&&strength(other,contract)>strength(c,contract))
        .every(other=>blockers.includes(other)));
      return cards.length>=3&&blockers.length===1&&futureWinner&&entry&&
        !cards.some(c=>k.masters.includes(c))&&lead&&['K','Q'].includes(rank(lead))?[lead]:[];
    });
    if(developing.length) return make('DEVELOP_SUIT',developing,'Разработваме дълга боя, като пазим страничен вход.',
      ['Имаме поне три карти в боята.','Има точно една по-силна неизвестна карта за изваждане.','След нея остава собствен победител в боята и страничен вход.'],['Входът изчезне.','Боята стане най-силна.','Дължината вече не позволява разработване.'],['Противникът може да задържи високата карта; не гарантираме разработена боя.']);
  }
  return make('BALANCED_PLAY',legal,'Избираме според приложимите тактически условия.',
    ['Няма достатъчно сигурни условия за специализиран план.'],['Следващият публичен ход променя сигурността или ресурсите.']);
}
