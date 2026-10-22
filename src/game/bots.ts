import { compareUtility, scorePosition, objectiveLabels, UTILITY_FIELDS, type UtilityObjective, type RoundUtility, type ScoringPosition } from './bot-objective.js';
import { createHandSampler } from './bot-sampling.js';
import { availableBelots, declarations, deck, legalCards, points, rank, strength, suit, team, winner } from './engine.js';
import { buildKnowledge, type BotPosition, type BotKnowledge } from './bot-knowledge.js';
import { decideCard, decideTacticalCard, type BotDecision } from './bot-tactics.js';
import { CONTRACTS, SUITS, type Action, type Card, type Contract, type Play, type View, type Declaration } from './types.js';

function bidValue(hand: Card[], contract: Contract): number {
  const value=hand.reduce((n,c)=>n+points(c,contract)+(strength(c,contract)>=6?8:0),0);
  if(contract==='NT') return value/2 + SUITS.filter(s=>hand.includes(`${s}-A`)).length*5;
  if(contract==='AT') return value*.61 + hand.filter(c=>rank(c)==='J').length*5;
  const trumps=hand.filter(c=>suit(c)===contract);
  return value + trumps.length*8 + (trumps.some(c=>rank(c)==='J')?9:0) - (trumps.length<2?25:0);
}
export function basicAction(v: View, rng=Math.random): Action {
  if(v.phase==='bidding') {
    const candidates=CONTRACTS.filter(c=>v.legalBids.includes(c)).map(c=>({c,value:bidValue(v.hand,c)})).sort((a,b)=>b.value-a.value);
    const jitter=v.difficulty==='easy'?(rng()-.5)*24:0;
    const threshold=v.difficulty==='easy'?62:v.difficulty==='medium'?59:55;
    if(v.legalBids.includes('recontra') && bidValue(v.hand,v.contract!)>85) return {type:'bid',bid:'recontra'};
    if(v.legalBids.includes('contra') && bidValue(v.hand,v.contract!)>95) return {type:'bid',bid:'contra'};
    if(candidates[0] && candidates[0].value+jitter>threshold && !(v.declarer!==null && team(v.declarer)===team(v.seat))) return {type:'bid',bid:candidates[0].c};
    return {type:'bid',bid:'pass'};
  }
  let card: Card;
  if(v.difficulty==='easy') card=v.legalCards[Math.floor(rng()*v.legalCards.length)];
  else card=decideCard(v,v.legalCards).card;
  return playAction(v,card);
}
export function selectDeclarations(options: Declaration[]): string[] {
  let best: Declaration[]=[],bestValue=-1;
  for(let mask=0;mask<(1<<options.length);mask++) {
    const chosen=options.filter((_,i)=>mask&(1<<i));
    const cards=chosen.flatMap(d=>d.cards);
    if(new Set(cards).size!==cards.length)continue;
    const value=chosen.reduce((n,d)=>n+d.value,0);
    if(value>bestValue){bestValue=value;best=chosen;}
  }
  return best.map(d=>d.id);
}
function playAction(v: View, card: Card): Action {
  return {type:'play',card,declare:selectDeclarations(v.declarations),belot:v.belotCards.includes(card)};
}

/** Original policy retained for reproducible benchmark comparisons only. */
export function heuristicCard(hand: Card[], trick: Play[], contract: Contract, seat: number, legal=legalCards(hand,trick,contract,seat), seen: Play[]=[]): Card {
  const cheap=(cards: Card[])=>[...cards].sort((a,b)=>points(a,contract)-points(b,contract) || strength(a,contract)-strength(b,contract))[0];
  if(!trick.length) {
    const masters=legal.filter(c=>!deck().some(other=>suit(other)===suit(c) && strength(other,contract)>strength(c,contract) && !hand.includes(other) && !seen.some(p=>p.card===other)));
    if(masters.length) return [...masters].sort((a,b)=>points(b,contract)-points(a,contract))[0];
    return cheap(legal);
  }
  const best=winner(trick,contract);
  if(team(best)===team(seat)) {
    if(trick.length===3) return [...legal].sort((a,b)=>points(b,contract)-points(a,contract))[0];
    return cheap(legal);
  }
  const winning=legal.filter(c=>winner([...trick,{player:seat,card:c}],contract)===seat);
  return cheap(winning.length?winning:legal);
}

// Each candidate assignment respects every public play, including inferred voids and
// mandatory overtrumps, as well as combinations revealed after the first trick.
export function sampleHands(v: View, rng=Math.random): Card[][] | null {
  const knowledge=buildKnowledge(v),sampler=createHandSampler(v,knowledge);
  if(!sampler)return null;
  for(let attempt=0;attempt<100;attempt++){
    const hands=sampler.sample(rng);
    if(sampledAnnouncements(v,hands,rng)!==null)return hands;
  }
  return null;
}
export interface HardSearchOptions { objective?:UtilityObjective; rollout?:'strategy'|'tactical'; selection?:'mean'|'supported' }
interface RolloutState extends ScoringPosition {}
/** Видимият вид анонс ограничава извадката; чуждите му карти са хипотеза, не знание на играча. */
function sampledAnnouncements(v:View,hands:Card[][],rng:()=>number):View['announcements']|null {
  const history=[...v.tricks.flatMap(t=>t.plays),...v.trick];
  const result:View['announcements']=[];
  for(let player=0;player<4;player++) {
    const publicCalls=v.announcements.filter(a=>a.player===player);
    if(!publicCalls.length)continue;
    const full=[...hands[player],...history.filter(p=>p.player===player).map(p=>p.card)];
    const options=declarations(full,v.contract!);
    const assignments:Declaration[][]=[];
    function visit(i:number,chosen:Declaration[],used:Set<Card>) {
      if(i===publicCalls.length){assignments.push(chosen);return;}
      const announced=publicCalls[i];
      for(const d of options) if(d.kind===announced.kind&&(!announced.value||d.value===announced.value)&&
        (!announced.cards.length||announced.cards.every(c=>d.cards.includes(c)))&&d.cards.every(c=>!used.has(c)))
        visit(i+1,[...chosen,d],new Set([...used,...d.cards]));
    }
    visit(0,[],new Set());
    if(!assignments.length)return null;
    for(const d of assignments[Math.floor(rng()*assignments.length)])result.push({...d,player});
  }
  return result;
}
function announceRollout(state:RolloutState,hand:Card[],trick:Play[],seat:number,card:Card) {
  if(!state.tricks.length&&!state.announcements.some(a=>a.player===seat)) {
    const options=declarations(hand,state.contract!),chosen=selectDeclarations(options);
    state.announcements.push(...options.filter(d=>chosen.includes(d.id)).map(d=>({...d,player:seat})));
  }
  if(availableBelots(hand,trick,state.contract!,state.belots,seat).includes(card))state.belots.push({player:seat,suit:suit(card)});
}
function simulation(hands:Card[][],trick:Play[],turn:number,state:RolloutState,perspective:number,deadline:number,options:HardSearchOptions):RoundUtility|null {
  while(hands.some(h=>h.length)) {
    if(performance.now()>deadline)return null;
    if(hands.reduce((n,h)=>n+h.length,0)<=7)return search(hands,trick,turn,state,perspective,deadline,options);
    const position:BotPosition={hand:hands[turn],seat:turn,counts:hands.map(h=>h.length),contract:state.contract,declarer:state.declarer,
      trick,tricks:state.tricks,belots:state.belots,
      announcements:state.announcements.map(a=>a.player===turn?a:{...a,cards:[],id:'hidden',strength:0,value:a.kind==='four'?0:a.value})};
    const card=(options.rollout==='tactical'?decideTacticalCard(position):decideCard(position)).card;
    announceRollout(state,hands[turn],trick,turn,card);
    hands[turn].splice(hands[turn].indexOf(card),1);trick.push({player:turn,card});
    if(trick.length===4){turn=winner(trick,state.contract!);state.tricks.push({plays:trick,winner:turn});trick=[];}
    else turn=(turn+1)%4;
  }
  return performance.now()>deadline?null:scorePosition(state,state.tricks,perspective);
}
/** Малък ендшпил с открити карти; терминалната оценка използва същото отчитане като играта. */
function search(hands:Card[][],trick:Play[],turn:number,state:RolloutState,perspective:number,deadline:number,options:HardSearchOptions,
  alpha:RoundUtility|null=null,beta:RoundUtility|null=null):RoundUtility|null {
  if(performance.now()>deadline)return null;
  if(trick.length===4){
    const won=winner(trick,state.contract!);state.tricks.push({plays:trick,winner:won});
    const value=hands.every(h=>!h.length)?scorePosition(state,state.tricks,perspective):search(hands,[],won,state,perspective,deadline,options,alpha,beta);
    state.tricks.pop();return value;
  }
  const maximize=team(turn)===perspective;let best:RoundUtility|null=null;
  for(const card of legalCards(hands[turn],trick,state.contract!,turn)) {
    const index=hands[turn].indexOf(card),belots=state.belots.length,announcements=state.announcements.length;
    announceRollout(state,hands[turn],trick,turn,card);hands[turn].splice(index,1);
    const value=search(hands,[...trick,{player:turn,card}],(turn+1)%4,state,perspective,deadline,options,alpha,beta);
    hands[turn].splice(index,0,card);state.belots.length=belots;state.announcements.length=announcements;
    if(value===null)return null;
    if(best===null||(maximize?compareUtility(value,best,options.objective)>0:compareUtility(value,best,options.objective)<0))best=value;
    if(maximize){if(alpha===null||compareUtility(best!,alpha,options.objective)>0)alpha=best;}
    else if(beta===null||compareUtility(best!,beta,options.objective)<0)beta=best;
    if(alpha&&beta&&compareUtility(alpha,beta,options.objective)>=0)break;
  }
  return best;
}
export function hardAction(v: View, budgetMs=220, rng=Math.random, maxIterations=100): Action {
  if(v.phase!=='playing' || v.legalCards.length<=1) return basicAction(v,rng);
  return playAction(v,decideHardCard(v,budgetMs,rng,maxIterations).card);
}
/** Само вътрешна диагностика; публичният ход остава непроменен. */
export function decideHardCard(v:View,budgetMs=220,rng=Math.random,maxIterations=100,options:HardSearchOptions={}):BotDecision {
  const deadline=performance.now()+budgetMs,knowledge=buildKnowledge(v),tactical=decideCard(v,v.legalCards,knowledge);
  const sampler=performance.now()<deadline-15?createHandSampler(v,knowledge):null;
  const totals:RoundUtility[]=v.legalCards.map(()=>[0,0,0,0]);
  const tacticalIndex=v.legalCards.indexOf(tactical.card),supported=v.legalCards.map(()=>true);
  let iterations=0,abortedBatches=0,attempts=0,rejectedSamples=0;
  const unique=new Set<string>();
  while(iterations<maxIterations&&attempts<Math.max(100,maxIterations*10)&&performance.now()<deadline-15) {
    const sampled=sampler?.sample(rng);if(!sampled)break;
    attempts++;
    const announcements=sampledAnnouncements(v,sampled,rng);if(!announcements){rejectedSamples++;continue;}
    const scores:RoundUtility[]=[];let complete=true;
    for(const card of v.legalCards) {
      if(performance.now()>deadline-2){complete=false;break;}
      const hands=sampled.map(h=>[...h]);
      const state:RolloutState={contract:v.contract,declarer:v.declarer,multiplier:v.multiplier,scores:v.scores,hanging:v.hanging,round:v.round,
        announcements:announcements.map(a=>({...a})),belots:[...v.belots],tricks:[...v.tricks]};
      announceRollout(state,hands[v.seat],v.trick,v.seat,card);
      hands[v.seat].splice(hands[v.seat].indexOf(card),1);
      let trick=[...v.trick,{player:v.seat,card}],turn=(v.seat+1)%4;
      if(trick.length===4){turn=winner(trick,v.contract!);state.tricks.push({plays:trick,winner:turn});trick=[];}
      const rollout=simulation(hands,trick,turn,state,team(v.seat),deadline,options);
      if(rollout===null){complete=false;break;}
      scores.push(rollout);
    }
    if(!complete){abortedBatches++;break;}
    scores.forEach((value,i)=>{
      if(compareUtility(value,scores[tacticalIndex],options.objective)<0)supported[i]=false;
      value.forEach((n,j)=>totals[i][j]+=n);
    });iterations++;
    unique.add(sampled.map(h=>[...h].sort().join(',')).join('|'));
  }
  const searchInfo={completedBatches:iterations,abortedBatches,uniqueSamples:unique.size,sampleAttempts:attempts,rejectedSamples,fallback:!iterations,objective:objectiveLabels(options.objective)};
  if(!iterations)return {...tactical,search:searchInfo,reasons:[...tactical.reasons,{
    id:'search.fallback',contribution:0,facts:['Няма завършена сравнителна партида; използваме стратегическата политика.']
  }]};
  let best=v.legalCards.indexOf(tactical.card);
  for(let i=0;i<totals.length;i++) if((options.selection!=='supported'||supported[i])&&compareUtility(totals[i],totals[best],options.objective)>0)best=i;
  const candidates=tactical.candidates.map((candidate,i)=>{
    const utility=totals[i].map(n=>n/iterations) as RoundUtility;
    return {card:candidate.card,score:utility[3],utility,supported:supported[i],reasons:[{
      id:'search.sampled-points',contribution:utility[3],facts:[`${iterations} завършени сравнителни партиди; средна разлика в общите картови точки.`]
    },{id:'search.contract-objective',contribution:0,facts:[`Лексикографска оценка: ${utility.join(', ')}.`,`Полета на вектора: ${UTILITY_FIELDS.join('; ')}.`,`Ред на целите: ${objectiveLabels(options.objective).join('; ')}.`,
      'Честотите са оценки върху допустими извадки, а не сигурни факти.','Бъдещите анонси и белоти следват автоматичната политика на ботовете.',
      options.selection==='supported'&&!supported[i]?'Алтернативата е по-лоша от стратегическия избор в поне една завършена извадка; не заменя плана.':'Сравняваме завършените оценки без достъп до реалните чужди ръце.']},
    {id:'search.tactical-order',contribution:0,facts:[`При равна крайна полезност предпочитаме плана ${tactical.strategy?.plan??'BALANCED_PLAY'} и карта ${tactical.card}.`,...candidate.reasons.flatMap(r=>[r.id,...r.facts])]}]};
  });
  return {card:candidates[best].card,reasons:candidates[best].reasons,candidates,strategy:tactical.strategy,search:searchInfo};
}
