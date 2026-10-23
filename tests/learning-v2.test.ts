import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decideTacticalCard as frozenTacticalCard} from '../benchmarks/no-trump-baseline/bot-tactics.js';
import manifest from '../src/game/learning-manifest.json' with {type:'json'};
import {applyAction,deck,newGame,view,team} from '../src/game/engine.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {analyzeCardTactics,decideCard,decideTacticalCard} from '../src/game/bot-tactics.js';
import {ACTION_SIZE,ENCODING_VERSION,OBSERVATION_SIZE,prepareLearningDecision,validateModel} from '../src/game/learning.js';
import {scenarioExamples,scenarioPosition,scenarios} from '../training/scenarios.js';
import {CONTRACTS,SUITS,type View} from '../src/game/types.js';

test('v2 manifest dimensions, bidding applicability and old model rejection',()=>{
 assert.equal(ENCODING_VERSION,2); assert.equal(OBSERVATION_SIZE,1998);assert.equal(ACTION_SIZE,100);
 const p=prepareLearningDecision(view(newGame('medium',()=>.3),0));
 assert.ok(p.observation.slice(1752).every(x=>x===0));
 assert.ok(p.actionFeatures.every(a=>a.slice(81).every(x=>x===0)));
 assert.equal(p.knowledge,undefined);
 assert.throws(()=>validateModel({encodingVersion:1,formatVersion:1}));
 assert.equal(manifest.action.reduce((n,b)=>n+b.size,0),100);
});

test('all scenario deals replay legally, independent bases stay within their split and preferences are legal',()=>{
 assert.equal(scenarios.length,12);
 const bases=new Map<string,string>();
 for(const s of scenarios){
  assert.ok(!bases.has(s.baseId)||bases.get(s.baseId)===s.split);bases.set(s.baseId,s.split);
  const v=scenarioPosition(s),p=prepareLearningDecision(v);
  assert.ok(v.legalCards.length>s.preferredCards.length);
  assert.ok(s.preferredCards.includes(decideCard(v).card));
  // Every remaining actual owner must still be possible; no inference may exclude a valid deal.
  const played=[...v.tricks.flatMap(t=>t.plays),...v.trick].map(p=>p.card);
  for(let seat=0;seat<4;seat++) for(const c of s.hands[seat].filter(c=>!played.includes(c))) assert.ok(p.knowledge!.possibleOwners[c]?.includes(seat),`${s.id}: ${c}`);
  for(const a of p.actions) assert.equal(a.type,'play');
 }
 assert.equal(bases.size,12);
 assert.equal(new Set(scenarios.map(s=>JSON.stringify(s.hands))).size,12);
 for(const topic of new Set(scenarios.map(s=>s.topic))) assert.deepEqual(scenarios.filter(s=>s.topic===topic).map(s=>s.split).sort(),['control','train']);
 const examples=scenarioExamples().examples;
 assert.equal(examples.length,6);
 for(const e of examples){assert.ok(e.preferred.length);assert.equal(scenarios.find(s=>s.id===e.id)!.split,'train');}
 const bad=structuredClone(scenarios[0]);bad.hands[0][0]=bad.hands[1][0];assert.throws(()=>scenarioPosition(bad));
});

test('scenario themes encode opportunities and exceptions without heuristic bonuses',()=>{
 for(const s of scenarios){
  const v=scenarioPosition(s),p=prepareLearningDecision(v),k=p.knowledge!;
  const facts=v.legalCards.map(card=>({card,a:analyzeCardTactics(v,card,k)}));
  if(s.topic==='draw-control') assert.ok(facts.some(({card,a})=>s.preferredCards.includes(card)&&a.trump&&a.control&&a.enemyTrumps.length));
  if(s.topic==='preserve-short-trump') assert.ok(facts.some(({a})=>a.ruffSuit&&a.trumps.length<=2&&a.trumps.length>0));
  if(s.topic==='exhausted-trumps') assert.ok(facts.every(({a})=>!a.enemyTrumps.length));
  if(s.topic==='cheap-force') assert.ok(facts.some(({card,a})=>s.preferredCards.includes(card)&&a.targets.length&&a.stakes<=4));
  if(s.topic==='costly-sacrifice') assert.ok(facts.some(({a})=>a.targets.length&&a.stakes>=10));
  if(s.topic==='partner-winning-exception'){
   assert.ok(k.currentWinner!==null&&team(k.currentWinner)!==team(v.seat));
   assert.ok(facts.every(({a})=>!a.targets.length));
  }
  p.actions.forEach((action,i)=>{
   if(action.type!=='play')return;
   const a=analyzeCardTactics(v,action.card,k),f=p.actionFeatures[i].slice(81);
   assert.equal(f[0],1);assert.equal(f[1],+a.trump);assert.equal(f[3],+a.wins);assert.equal(f[14],a.stakes/162);
   for(let rel=0;rel<4;rel++)assert.equal(f[5+rel],+a.targets.includes((v.seat+rel)%4));
  });
 }
});

function rotate(v:View):View{
 const rel=(p:number)=>(p+1)%4;
 const play=(p:View['trick'][number])=>({...p,player:rel(p.player)});
 return {...structuredClone(v),seat:rel(v.seat),turn:rel(v.turn),dealer:rel(v.dealer),declarer:v.declarer===null?null:rel(v.declarer),
 counts:[v.counts[3],...v.counts.slice(0,3)],scores:[v.scores[1],v.scores[0]],calls:v.calls.map(c=>({...c,player:rel(c.player)})),
 trick:v.trick.map(play),tricks:v.tricks.map(t=>({...t,winner:rel(t.winner),plays:t.plays.map(play)})),
 announcements:v.announcements.map(a=>({...a,player:rel(a.player)})),belots:v.belots.map(b=>({...b,player:rel(b.player)}))};
}
test('v2 facts and candidate features normalize seats and ignore hidden information after public histories',()=>{
 for(const s of scenarios){
  const v=scenarioPosition(s),p=prepareLearningDecision(v),r=prepareLearningDecision(rotate(v));
  assert.deepEqual(p.observation,r.observation);assert.deepEqual(p.actionFeatures,r.actionFeatures);
  const hidden=Object.assign(structuredClone(v),{hands:[...s.hands].reverse(),stock:deck()});
  const other=prepareLearningDecision(hidden);
  assert.deepEqual(p.observation,other.observation);assert.deepEqual(p.actionFeatures,other.actionFeatures);
  const k=buildKnowledge(v);
  const offset=1753;
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)assert.equal(p.observation[offset+i*4+j],+k.voidSuits[(v.seat+i)%4].includes(SUITS[j]));
 }
});

test('NT specialization preserves complete tactical decisions for the other contracts and reachable histories',()=>{
 for(const contract of CONTRACTS){
  let seed=59;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const g=newGame('medium',rng);
  applyAction(g,0,{type:'bid',bid:contract});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  while(g.phase==='playing'||g.phase==='trick'){
   if(g.phase==='trick'){applyAction(g,-1,{type:'collect'});continue;}
   const v=view(g,g.turn);
   if(v.trick.length===3) for(const card of v.legalCards) assert.equal(analyzeCardTactics(v,card,buildKnowledge(v)).ruffRisk,false);
   if(contract!=='NT')assert.deepEqual(decideTacticalCard(v),frozenTacticalCard(v));
   applyAction(g,g.turn,{type:'play',card:v.legalCards[Math.floor(rng()*v.legalCards.length)]});
  }
 }
 for(const s of scenarios){
  const v=scenarioPosition(s);
  if(v.contract!=='NT')assert.deepEqual(decideTacticalCard(v),frozenTacticalCard(v));
 }
});
