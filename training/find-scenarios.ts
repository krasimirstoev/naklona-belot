import {writeFileSync} from 'node:fs';
import {newGame,applyAction,view,suit,team,points} from '../src/game/engine.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {analyzeCardTactics,decideCard} from '../src/game/bot-tactics.js';
import type {Card,Action} from '../src/game/types.js';
const topics=['draw-control','preserve-short-trump','exhausted-trumps','cheap-force','partner-winning-exception','costly-sacrifice'];
const rationale:Record<string,string>={"preserve-short-trump": "Имаме кратък коз и празна странична боя за бъдещо цакане; предпочитаме допустима странична карта без установен риск от цакане.", "cheap-force": "Противник с доказана липсваща боя и възможен коз ще трябва да цака; даваме най-много четири картови точки.", "exhausted-trumps": "Нито един оставащ коз не може да е у противниците; предпочитаме странична боя.", "partner-winning-exception": "Отборът на следващия противник вече печели; липсващата му боя не го задължава да цака. Не можем да вземем и избираме евтин ход.", "draw-control": "Водим коз без по-силен неизвестен коз, имаме продължение и противниковите козове не са изчерпани; няма установена нужда да пазим кратък коз.", "costly-sacrifice": "Има ход с условно задължение за цакане, но жертва поне десет точки; предпочитаме евтина странична алтернатива без установен риск от цакане."};
const cases:any[]=[];
for(let seed=1;seed<30000 && cases.length<12;seed++) {
 let state=seed;const rng=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 const g=newGame('medium',rng), declarer=seed%4;
 const bids:Action[]=[];
 for(let i=0;i<declarer;i++) bids.push({type:'bid',bid:'pass'});
 bids.push({type:'bid',bid:'H'},...Array.from({length:3},()=>({type:'bid',bid:'pass'} as Action)));
 for(const a of bids) applyAction(g,g.turn,a);
 const hands=structuredClone(g.hands), history:Action[]=[];
 while(g.phase==='playing'||g.phase==='trick') {
  if(g.phase==='trick') {applyAction(g,-1,{type:'collect'});continue;}
  const v=view(g,g.turn), k=buildKnowledge(v), d=decideCard(v);
  const facts=v.legalCards.map(card=>({card,a:analyzeCardTactics(v,card,k)}));
  if(v.legalCards.length>=2) for(const topic of topics) {
   if(cases.filter(c=>c.topic===topic).length>=2 || cases.some(c=>c.sourceSeed===seed)) continue;
   let preferred:Card[]=[];
   if(topic==='draw-control' && !v.trick.length && team(v.seat)===team(declarer)) preferred=facts.filter(({a})=>a.trump&&a.control&&a.enemyTrumps.length&&!a.ruffSuit&&!a.preservePartner).map(x=>x.card);
   if(topic==='preserve-short-trump' && !v.trick.length && team(v.seat)===team(declarer)&&facts.some(({a})=>a.trump&&a.ruffSuit&&a.trumps.length<=2&&a.enemyTrumps.length)) preferred=facts.filter(({a})=>!a.trump&&!a.ruffRisk).map(x=>x.card);
   if(topic==='exhausted-trumps' && !v.trick.length && facts.some(({a})=>a.trump&&!a.enemyTrumps.length)) preferred=facts.filter(({a})=>!a.trump).map(x=>x.card);
   if(topic==='cheap-force' && team(v.seat)!==team(declarer)) preferred=facts.filter(({a})=>a.targets.length&&a.stakes<=4).map(x=>x.card);
   if(topic==='costly-sacrifice' && team(v.seat)!==team(declarer)&&facts.some(({a})=>a.targets.length&&a.stakes>=10)) preferred=facts.filter(({a})=>!a.trump&&a.stakes<=4&&!a.ruffRisk).map(x=>x.card);
   if(topic==='partner-winning-exception' && v.trick.length>0 && v.trick.length<3 && k.currentWinner!==null && team(k.currentWinner)!==team(v.seat)) {
    const next=(v.seat+1)%4;
    if(team(next)!==team(v.seat)&&team(next)===team(k.currentWinner)&&k.voidSuits[next].includes(suit(v.trick[0].card))&&k.remainingTrumps.some(c=>k.possibleOwners[c]?.includes(next))&&facts.every(({a})=>!a.wins&&!a.targets.length)) {
     const min=Math.min(...facts.map(({card})=>points(card,'H')));
     preferred=facts.filter(({card})=>points(card,'H')===min).map(x=>x.card);
    }
   }
   if(preferred.length && preferred.length<v.legalCards.length && preferred.includes(d.card)) cases.push({rationale:rationale[topic],id:`${topic}-${cases.some(c=>c.topic===topic)?'control':'train'}`,topic,split:cases.some(c=>c.topic===topic)?'control':'train',sourceSeed:seed,baseId:`deal-${seed}`,hands,bids,history:structuredClone(history),preferredCards:preferred});
  }
  // Alternate teacher and exploratory legal play; fixtures retain every actual action.
  const card=rng()<.6?d.card:v.legalCards[Math.floor(rng()*v.legalCards.length)];
  const action:Action={type:'play',card};history.push(action);applyAction(g,g.turn,action);
 }
}
writeFileSync('training/scenarios/catalog.json',JSON.stringify({version:1,cases},null,2)+'\n');
console.log(cases.map(c=>[c.id,c.sourceSeed,c.history.length,c.preferredCards]));
if(cases.length!==12) throw Error('Missing scenarios');
