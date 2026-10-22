import {test} from 'node:test';
import assert from 'node:assert/strict';
import catalog from './fixtures/strategy-positions.json' with {type:'json'};
import {scenarioPosition,type TacticalScenario} from '../training/scenarios.js';
import {applyAction,calculateResult,deck,newGame,points,rank,suit,team,view} from '../src/game/engine.js';
import {decideCard} from '../src/game/bot-tactics.js';
import {basicAction,decideHardCard} from '../src/game/bots.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {createHandSampler} from '../src/game/bot-sampling.js';
import {secureTeamTrick,suitLengthBounds,tenGuardDiscard} from '../src/game/bot-strategy.js';
import {compareUtility,resultUtility,scorePosition} from '../src/game/bot-objective.js';
import {CONTRACTS,SUITS,type Card} from '../src/game/types.js';

type Fixture=Pick<TacticalScenario,'id'|'hands'|'bids'|'history'|'preferredCards'>&{topic:string;oldCard:Card};
const cases=catalog.cases as unknown as Fixture[];
function seeded(seed:number){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
function playToEnd(g:ReturnType<typeof newGame>){while(g.phase==='playing'||g.phase==='trick')applyAction(g,g.phase==='trick'?-1:g.turn,g.phase==='trick'?{type:'collect'}:basicAction(view(g,g.turn)));}

test('Стратегическите сценарии са пълни раздавания със законна история и сигурни граници на дължините',()=>{
 assert.equal(cases.length,20);
 for(const c of cases){
  const v=scenarioPosition(c),k=buildKnowledge(v),d=decideCard(v);
  assert.ok(c.preferredCards.includes(d.card),c.id);
  assert.ok(d.strategy?.facts.length&&d.strategy.invalidatedBy.length,c.id);
  const played=[...v.tricks.flatMap(t=>t.plays),...v.trick].map(p=>p.card);
  for(let p=0;p<4;p++)for(const s of SUITS){
   const actual=c.hands[p].filter(card=>!played.includes(card)&&suit(card)===s).length,bounds=suitLengthBounds(v,k,p,s);
   assert.ok(actual>=bounds.min&&actual<=bounds.max,`${c.id} ${p} ${s}`);
  }
 }
});

test('Партньорска сигурност: качване преди последния играч, запазен победител и отказ от скъпа несигурна жертва',()=>{
 for(const c of cases.filter(c=>c.topic.startsWith('feed-')||c.topic==='unsafe-partner')){
  const v=scenarioPosition(c),k=buildKnowledge(v),d=decideCard(v);
  assert.equal(d.strategy?.plan,'SUPPORT_PARTNER');
  if(c.topic==='feed-preserve-winner'){
   assert.ok(k.masters.includes(c.oldCard));assert.ok(!k.masters.includes(d.card));
   assert.ok(secureTeamTrick(v,k,d.card));
  }else if(c.topic==='feed-before-last'){
   assert.ok(v.trick.length<3);assert.ok(secureTeamTrick(v,k,d.card));
   assert.ok(points(d.card,v.contract!)>points(c.oldCard,v.contract!));
  }else{
   assert.ok(!v.legalCards.some(card=>secureTeamTrick(v,k,card)));
   assert.equal(points(d.card,v.contract!),0);
   assert.ok(v.legalCards.some(card=>points(card,v.contract!)>=10));
  }
 }
});

test('Защита на десетка: пазим единствената придружаваща карта само при възможно чуждо асо',()=>{
 for(const c of cases.filter(c=>c.topic==='protect-ten'||c.topic==='ten-no-guard-needed')){
  const v=scenarioPosition(c),k=buildKnowledge(v),d=decideCard(v);
  if(c.topic==='protect-ten'){
   assert.equal(d.strategy?.plan,'PROTECT_TEN');assert.ok(tenGuardDiscard(v,k,c.oldCard));
   assert.ok(!tenGuardDiscard(v,k,d.card));
   assert.ok(points(d.card,v.contract!)<=points(c.oldCard,v.contract!));
  }else{
   assert.notEqual(d.strategy?.plan,'PROTECT_TEN');
   assert.ok(v.hand.some(card=>rank(card)==='10'&&k.played.includes(`${suit(card)}-A`)));
  }
 }
});

test('Без коз разработваме дълга боя със запазен вход; без вход планът не се активира',()=>{
 for(const c of cases.filter(c=>c.topic.startsWith('develop-'))){
  const v=scenarioPosition(c),k=buildKnowledge(v),d=decideCard(v);
  assert.equal(v.contract,'NT');
  if(c.topic==='develop-entry'){
   assert.equal(d.strategy?.plan,'DEVELOP_SUIT');assert.ok(k.masters.includes(c.oldCard));
   assert.notEqual(d.card,c.oldCard);assert.ok(v.hand.filter(card=>suit(card)===suit(d.card)).length>=3);
   assert.ok(d.strategy!.assumptions.length);
  }else{assert.notEqual(d.strategy?.plan,'DEVELOP_SUIT');if(c.topic==='develop-no-entry')assert.equal(k.masters.length,0);else assert.ok(k.masters.length>0);}
 }
});

test('Планът разрешава конфликта между теглене и запазване; всичко коз не наследява козово теглене',()=>{
 for(const c of cases.filter(c=>c.topic==='draw-control'||c.topic==='preserve-draw-conflict')){
  const v=scenarioPosition(c),d=decideCard(v);
  assert.equal(d.strategy?.plan,c.topic==='draw-control'?'DRAW_TRUMPS':'PRESERVE_TRUMPS');
  assert.equal(suit(d.card)===v.contract,c.topic==='draw-control');
 }
 for(const c of cases.filter(c=>scenarioPosition(c).contract==='AT')){
  const d=decideCard(scenarioPosition(c));assert.ok(!['DRAW_TRUMPS','PRESERVE_TRUMPS','DEVELOP_SUIT'].includes(d.strategy!.plan));
 }
});

test('Публичните факти и стратегическите решения не зависят от подадени чужди ръце',()=>{
 for(const c of cases){
  const v=scenarioPosition(c),before=structuredClone(v),hidden=Object.assign(structuredClone(v),{hands:[...c.hands].reverse(),stock:deck()});
  assert.deepEqual(decideCard(v),decideCard(hidden));assert.deepEqual(v,before);
 }
});

test('Преоценяване след всяко действие: плановете отпадат, а принуденото отговаряне остава законно',()=>{
 const g=newGame('medium',seeded(5));applyAction(g,0,{type:'bid',bid:'NT'});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
 const plans=new Set<string>();let forced=0;
 while(g.phase==='playing'||g.phase==='trick'){
  if(g.phase==='trick'){applyAction(g,-1,{type:'collect'});continue;}
  const v=view(g,g.turn),d=decideCard(v);plans.add(d.strategy!.plan);
  if(v.legalCards.length===1){assert.equal(d.card,v.legalCards[0]);forced++;}
  assert.ok(v.legalCards.includes(d.card));applyAction(g,g.turn,basicAction(v));
 }
 assert.ok(plans.size>=2);assert.ok(forced>0);
});

test('Равномерният генератор брои всички допустими разпределения и не предпочита първото DFS решение',()=>{
 const g=newGame('medium',seeded(49));applyAction(g,0,{type:'bid',bid:'NT'});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
 while(g.tricks.length<6){if(g.phase==='trick')applyAction(g,-1,{type:'collect'});else applyAction(g,g.turn,basicAction(view(g,g.turn)));}
 const v=view(g,g.turn),k=buildKnowledge(v),sampler=createHandSampler(v,k);assert.ok(sampler);
 const worlds=new Set<string>(),hands:Card[][]=[[],[],[],[]];hands[v.seat]=[...v.hand];
 const signature=(h:Card[][])=>h.map(hand=>[...hand].sort().join(',')).join('|');
 function enumerate(i:number){
  if(i===k.unknown.length){if(hands.every((h,p)=>h.length===v.counts[p]))worlds.add(signature(hands));return;}
  const card=k.unknown[i];for(const p of k.possibleOwners[card]??[])if(hands[p].length<v.counts[p]){hands[p].push(card);enumerate(i+1);hands[p].pop();}
 }
 enumerate(0);assert.ok(worlds.size>=2);assert.equal(sampler.distributions,worlds.size);
 const counts=new Map<string,number>(),rng=seeded(337),n=12000;
 for(let i=0;i<n;i++){const key=signature(sampler.sample(rng));assert.ok(worlds.has(key));counts.set(key,(counts.get(key)??0)+1);}
 assert.equal(counts.size,worlds.size);
 for(const count of counts.values())assert.ok(Math.abs(count/n-1/worlds.size)<.025);
});

test('Крайната оценка съвпада с двигателя за всички договори, контри, висящи точки и край на мача',()=>{
 for(const contract of CONTRACTS)for(const multiplier of [1,2,4]){
  const g=newGame('medium',seeded(83));g.scores=[140,145];g.hanging=20;
  applyAction(g,0,{type:'bid',bid:contract});
  if(multiplier>=2)applyAction(g,g.turn,{type:'bid',bid:'contra'});
  if(multiplier===4)applyAction(g,g.turn,{type:'bid',bid:'recontra'});
  for(let p=0;p<3;p++)applyAction(g,g.turn,{type:'bid',bid:'pass'});
  playToEnd(g);const r=calculateResult(g);
  assert.equal(r.multiplier,multiplier);
  for(const perspective of [0,1])assert.deepEqual(scorePosition(g,g.tricks,perspective),resultUtility(r,perspective));
 }
 const g=newGame('medium',seeded(7));g.hands=SUITS.map(s=>deck().filter(c=>suit(c)===s).slice(0,5));g.stock=SUITS.flatMap(s=>deck().filter(c=>suit(c)===s).slice(5));
 g.scores=[150,0];applyAction(g,0,{type:'bid',bid:'H'});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
 playToEnd(g);assert.equal(g.results[0].capot,true);assert.equal(resultUtility(g.results[0],0)[0],0);
 // Лексикографски ред: излизане > записан резултат > договор > картови точки.
 assert.ok(compareUtility([1,1,1,1],[0,1,100,252])>0);
 assert.ok(compareUtility([0,1,1,-10],[0,-1,100,100])<0);
 assert.ok(compareUtility([0,1,1,-10],[0,-1,100,100],'contract')>0);
});

test('Експерименталният устойчив избор не сменя плана с алтернатива, влошаваща поне една обща извадка',()=>{
 const v=scenarioPosition(cases.find(c=>c.topic==='protect-ten')!);
 const d=decideHardCard(v,2000,seeded(77),2,{selection:'supported'});
 assert.equal(d.search?.fallback,false);
 const chosen=d.candidates.find(c=>c.card===d.card)!;assert.equal(chosen.supported,true);
 for(const c of d.candidates.filter(c=>c.supported))assert.ok(compareUtility(chosen.utility as [number,number,number,number],c.utility as [number,number,number,number])>=0);
});

test('Трудният бот сравнява еднакъв брой завършени извадки и връща честен резервен избор',()=>{
 const v=scenarioPosition(cases.find(c=>c.topic==='protect-ten')!),before=structuredClone(v);
 const d=decideHardCard(v,2000,seeded(77),2);
 assert.equal(d.search?.completedBatches,2);assert.equal(d.search?.fallback,false);
 assert.ok(d.search!.uniqueSamples>=1);assert.ok(d.candidates.every(c=>c.utility?.length===4));
 const chosen=d.candidates.find(c=>c.card===d.card)!;
 for(const c of d.candidates)assert.ok(compareUtility(chosen.utility as [number,number,number,number],c.utility as [number,number,number,number])>=0);
 assert.deepEqual(v,before);
 const hidden=Object.assign(structuredClone(v),{hands:cases[0].hands,stock:deck()});
 assert.deepEqual(decideHardCard(hidden,2000,seeded(77),2),d);
 const fallback=decideHardCard(v,0,seeded(77));assert.equal(fallback.card,decideCard(v).card);
 assert.equal(fallback.search?.fallback,true);assert.equal(fallback.search?.completedBatches,0);
});
