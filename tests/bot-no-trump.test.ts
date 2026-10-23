import {test} from 'node:test';
import assert from 'node:assert/strict';
import catalog from './fixtures/no-trump-positions.json' with {type:'json'};
import {scenarioPosition,type TacticalScenario} from '../training/scenarios.js';
import {assessNoTrump,ntCaptureChance} from '../src/game/bot-no-trump.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {createHandSampler} from '../src/game/bot-sampling.js';
import {decideCard} from '../src/game/bot-tactics.js';
import {decideMediumCard,decideHardCard} from '../src/game/bots.js';
import {decideCard as before} from '../benchmarks/no-trump-baseline/bot-tactics.js';
import {applyAction,deck,newGame,points,rank,suit,team,view,winner} from '../src/game/engine.js';
import {secureTeamTrick} from '../src/game/bot-strategy.js';
import {compareUtility,type RoundUtility} from '../src/game/bot-objective.js';
import type {Card} from '../src/game/types.js';
type Fixture=Pick<TacticalScenario,'id'|'hands'|'bids'|'history'|'preferredCards'>&{topic:string};
const cases=catalog.cases as unknown as Fixture[];
const position=(topic:string)=>scenarioPosition(cases.find(c=>c.topic===topic)!);
function seeded(n:number){return ()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};}

test('NT scenarios replay complete legal deals; candidate explanations add up and public state stays pure',()=>{
 assert.equal(cases.length,12);
 for(const c of cases){
  const v=scenarioPosition(c),copy=structuredClone(v),d=decideCard(v),k=buildKnowledge(v),a=assessNoTrump(v,k);
  assert.ok(v.legalCards.includes(d.card),c.id);
  assert.equal(a.collected.reduce((n,x)=>n+x,0),v.tricks.flatMap(t=>t.plays).reduce((n,p)=>n+points(p.card,'NT'),0));
  for(const candidate of d.candidates)assert.equal(candidate.score,candidate.reasons.reduce((n,r)=>n+r.contribution,0));
  assert.deepEqual(v,copy);
  const hidden=Object.assign(structuredClone(v),{hands:c.hands.toReversed(),stock:deck()});
  assert.deepEqual(decideMediumCard(hidden),decideMediumCard(v));
 }
});

test('cheap trick: retain an ace with outside entries and richer future captures, but take without those entries',()=>{
 const duck=position('duck'),take=position('take-cheap');
 for(const v of [duck,take]){
  assert.equal(v.trick.length,3);
  assert.ok(v.trick.reduce((n,p)=>n+points(p.card,'NT'),0)<=6);
  assert.ok(v.legalCards.some(c=>rank(c)==='A'&&winner([...v.trick,{player:v.seat,card:c}],'NT')===v.seat));
  assert.ok(v.legalCards.some(c=>winner([...v.trick,{player:v.seat,card:c}],'NT')!==v.seat));
 }
 const d=decideCard(duck);
 assert.equal(d.strategy?.plan,'DUCK_TRICK');assert.notEqual(rank(d.card),'A');
 assert.equal(rank(before(duck).card),'A');
 assert.ok(d.candidates.some(c=>rank(c.card)==='A'&&c.reasons.some(r=>r.id==='NT_PRESERVE_ACE'&&r.contribution<0)));
 assert.equal(rank(decideCard(take).card),'A');
});

test('ten promotion, mandatory following, feeding vulnerable points and preserving a future partner-side winner',()=>{
 const promoted=position('promoted-ten'),pk=buildKnowledge(promoted),pd=decideCard(promoted);
 assert.equal(rank(pd.card),'10');assert.ok(pk.played.includes(`${suit(pd.card)}-A`));assert.ok(pk.masters.includes(pd.card));
 const exposed=position('expose-ten'),ed=decideCard(exposed);
 assert.equal(rank(ed.card),'10');assert.ok(!buildKnowledge(exposed).masters.includes(ed.card));
 assert.equal(exposed.legalCards.length,1); // Following suit overrides retention.
 for(const topic of ['feed','preserve-partner-winner']){
  const v=position(topic),k=buildKnowledge(v),d=decideCard(v);
  assert.equal(d.strategy?.plan,'SUPPORT_PARTNER');assert.ok(secureTeamTrick(v,k,d.card));
  if(topic==='feed')assert.ok(points(d.card,'NT')>=20);
  else {assert.ok(v.legalCards.some(c=>k.masters.includes(c)));assert.ok(!k.masters.includes(d.card));}
 }
});

test('long suits distinguish established runs from development requiring blockers and an outside entry',()=>{
 const run=position('run-suit'),rk=buildKnowledge(run),rd=decideCard(run),a=assessNoTrump(run,rk);
 assert.ok(a.suits.find(p=>p.suit===suit(rd.card))!.masters.length>=3);
 assert.ok(rk.masters.includes(rd.card));
 const developing=position('develop'),dk=buildKnowledge(developing),dd=decideCard(developing);
 assert.equal(dd.strategy?.plan,'DEVELOP_SUIT');
 const p=assessNoTrump(developing,dk).suits.find(p=>p.suit===suit(dd.card))!;
 assert.ok(p.entries>0&&p.blockers.length>0&&p.development>0);
 assert.ok(dd.strategy!.assumptions.length>0);
});

test('defensive threshold uses already collected doubled points; intelligent discard does not throw a master',()=>{
 const v=position('defend'),k=buildKnowledge(v),a=assessNoTrump(v,k),d=decideCard(v);
 assert.equal(a.role,'defender');assert.ok(a.pointsToMajority>0);
 assert.ok(d.reasons.some(r=>r.id==='NT_CONTRACT_OBJECTIVE'));
 assert.equal(ntCaptureChance(v,k,d.card),1);
 const discard=position('discard'),dc=decideCard(discard),dk=buildKnowledge(discard);
 assert.notEqual(suit(dc.card),suit(discard.trick[0].card));
 assert.ok(!dk.masters.includes(dc.card));assert.ok(discard.legalCards.some(c=>dk.masters.includes(c)));
});

test('enumerated endgame covers every legal allocation once and Medium aggregates the existing exact solver',()=>{
 const v=position('endgame'),k=buildKnowledge(v),sampler=createHandSampler(v,k)!;
 const worlds=[...sampler.enumerate()];
 assert.equal(worlds.length,sampler.distributions);
 assert.equal(new Set(worlds.map(h=>JSON.stringify(h))).size,worlds.length);
 for(const hands of worlds){
  assert.deepEqual(hands.map(h=>h.length),v.counts);
  assert.equal(new Set(hands.flat()).size,k.remaining.length);
  for(let p=0;p<4;p++)for(const c of hands[p])assert.ok(k.possibleOwners[c]!.includes(p));
 }
 const d=decideMediumCard(v),other=decideHardCard(v,Infinity,seeded(99),100);
 assert.ok(d.search?.exhaustive);assert.equal(d.search?.completedBatches,worlds.length);
 assert.deepEqual(d,other);assert.equal(d.search?.fallback,false);
 const limited=decideHardCard(v,Infinity,seeded(19),4);
 assert.equal(limited.search?.exhaustive,false);assert.equal(limited.search?.completedBatches,4);
 assert.deepEqual(limited,decideHardCard(v,Infinity,seeded(19),4));
 const best=d.candidates.find(c=>c.card===d.card)!;
 for(const c of d.candidates)assert.ok(compareUtility(best.utility as RoundUtility,c.utility as RoundUtility)>=0);
});

test('one sampled opening world cannot replace the fallback; bounded work is reproducible with enough budget',()=>{
 const v=position('duck');
 const small=decideHardCard(v,Infinity,seeded(4),1);
 assert.equal(small.search?.completedBatches,1);assert.equal(small.search?.fallback,true);
 assert.equal(small.search?.lowConfidence,true);assert.equal(small.card,decideCard(v).card);
 const d=decideHardCard(v,Infinity,seeded(4),3);
 assert.equal(d.search?.fallback,false);assert.equal(d.search?.completedBatches,3);
 assert.deepEqual(d,decideHardCard(v,Infinity,seeded(4),3));
});

test('frozen current baseline and improved policy agree outside NT across full deals',()=>{
 for(const contract of ['C','D','H','S','AT'] as const){
  const g=newGame('medium',seeded(39));applyAction(g,0,{type:'bid',bid:contract});
  for(let i=0;i<3;i++)applyAction(g,g.turn,{type:'bid',bid:'pass'});
  while(g.phase==='playing'||g.phase==='trick'){
   if(g.phase==='trick'){applyAction(g,-1,{type:'collect'});continue;}
   const v=view(g,g.turn),d=decideMediumCard(v);
   assert.deepEqual(d,before(v,v.legalCards));
   applyAction(g,g.turn,{type:'play',card:d.card});
  }
 }
});

test('duck regression: a legal full-deal continuation defeats the contract that immediately cashing the ace lets through',()=>{
 const fixture=cases.find(c=>c.topic==='duck')!;
 const results=fixture.preferredCards.concat('C-A').map(card=>{
  const g=newGame('medium',()=>.5);g.hands=fixture.hands.map(h=>h.slice(0,5));g.stock=fixture.hands.flatMap(h=>h.slice(5));
  for(const a of [...fixture.bids,...fixture.history]){if(g.phase==='trick')applyAction(g,-1,{type:'collect'});applyAction(g,g.turn,a);}
  applyAction(g,g.turn,{type:'play',card});
  while(g.phase==='playing'||g.phase==='trick'){
   if(g.phase==='trick')applyAction(g,-1,{type:'collect'});
   else {const v=view(g,g.turn);applyAction(g,g.turn,{type:'play',card:before(v).card});}
  }
  return g.results[0];
 });
 assert.equal(results[0].outcome,'failed');assert.equal(results[1].outcome,'made');
});
