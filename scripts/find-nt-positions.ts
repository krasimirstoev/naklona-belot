// Development fixture mining: stores complete legal deals, never production data.
import {writeFileSync} from 'node:fs';
import {newGame,applyAction,view,points,rank,suit,team,winner} from '../src/game/engine.js';
import {decideCard} from '../src/game/bot-tactics.js';
import {decideCard as before} from '../benchmarks/no-trump-baseline/bot-tactics.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {assessNoTrump} from '../src/game/bot-no-trump.js';
import type {Action} from '../src/game/types.js';
const found=new Map<string,unknown>();
for(let seed=1;seed<=500&&found.size<12;seed++){
 let n=seed;const rng=()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};
 const g=newGame('medium',rng),bids:Action[]=[{type:'bid',bid:'NT'},...Array.from({length:3},():Action=>({type:'bid',bid:'pass'}))];
 for(const a of bids)applyAction(g,g.turn,a);
 const hands=structuredClone(g.hands),history:Action[]=[];
 while(g.phase==='playing'||g.phase==='trick'){
  if(g.phase==='trick'){applyAction(g,-1,{type:'collect'});continue;}
  const v=view(g,g.turn),k=buildKnowledge(v),d=decideCard(v),a=assessNoTrump(v,k),r=d.reasons;
  const winning=winner([...v.trick,{player:v.seat,card:d.card}],'NT')===v.seat;
  const cheap=v.trick.length===3&&v.trick.every(p=>points(p.card,'NT')<=4)&&team(k.currentWinner!)!==team(v.seat)&&v.legalCards.some(c=>rank(c)==='A'&&winner([...v.trick,{player:v.seat,card:c}],'NT')===v.seat)&&v.legalCards.some(c=>winner([...v.trick,{player:v.seat,card:c}],'NT')!==v.seat);
  const topics=[
   cheap&&!winning?'duck':null,cheap&&winning&&rank(d.card)==='A'?'take-cheap':null,
   rank(d.card)==='10'&&!k.masters.includes(d.card)&&winning?'expose-ten':null,
   v.legalCards.some(c=>rank(c)==='10'&&!k.masters.includes(c))&&rank(d.card)!=='10'?'protect-ten':null,
   rank(d.card)==='10'&&k.played.includes(`${suit(d.card)}-A`)?'promoted-ten':null,
   d.strategy?.plan==='SUPPORT_PARTNER'&&points(d.card,'NT')>=10?'feed':null,
   d.strategy?.plan==='SUPPORT_PARTNER'&&v.legalCards.some(c=>k.masters.includes(c))&&!k.masters.includes(d.card)?'preserve-partner-winner':null,
   !v.trick.length&&k.masters.includes(d.card)&&a.suits.find(p=>p.suit===suit(d.card))!.masters.length>=3?'run-suit':null,
   d.strategy?.plan==='DEVELOP_SUIT'?'develop':null,
   r.some(x=>x.id==='NT_CONTRACT_OBJECTIVE')&&a.role==='defender'?'defend':null,
   v.counts.every(n=>n<=2)&&v.legalCards.length>1?'endgame':null,
   v.trick.length&&suit(d.card)!==suit(v.trick[0].card)&&v.legalCards.some(c=>k.masters.includes(c))&&!k.masters.includes(d.card)?'discard':null,
  ].filter((x):x is string=>!!x);
  for(const topic of topics)if(!found.has(topic))found.set(topic,{id:`nt-${topic}`,topic,seed,hands,bids,history:[...history],preferredCards:[d.card],previousCard:before(v).card});
  const action:Action={type:'play',card:before(v).card};history.push(action);applyAction(g,g.turn,action);
 }
}
writeFileSync('tests/fixtures/no-trump-positions.json',JSON.stringify({cases:[...found.values()]},null,2)+'\n');
console.log([...found.keys()]);
