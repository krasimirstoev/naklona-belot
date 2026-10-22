import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, availableBelots, calculateResult, deal, deck, declarationPoints, declarations, legalBids, legalCards, newGame, points, roundedPair, view, winner } from '../src/game/engine.js';
import { basicAction, hardAction, sampleHands, selectDeclarations } from '../src/game/bots.js';
import type { Card, Contract, Difficulty, Game, Play } from '../src/game/types.js';
function seeded(seed=7) { return ()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}; }
const asCards=(s:string)=>s.split(' ') as Card[];
function contractGame(contract:Contract='H') {
  const g=newGame('medium',seeded());applyAction(g,0,{type:'bid',bid:contract});
  for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});return g;
}
test('deck, 3+2 dealing, bidding with five cards and final three cards',()=>{
  const g=newGame('medium',seeded());assert.equal(new Set(deck()).size,32);assert.deepEqual(g.hands.map(h=>h.length),[5,5,5,5]);assert.equal(g.stock.length,12);
  applyAction(g,0,{type:'bid',bid:'S'});assert.throws(()=>applyAction(g,1,{type:'bid',bid:'H'}));
  for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  assert.equal(g.phase,'playing');assert.equal(g.turn,0);assert.deepEqual(g.hands.map(h=>h.length),[8,8,8,8]);assert.equal(g.stock.length,0);assert.equal(new Set(g.hands.flat()).size,32);
});
test('four passes rotate dealer and redeal; contra resets passes; higher call cancels contra',()=>{
  const g=newGame('easy',seeded());for(const p of [0,1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  assert.equal(g.dealer,0);assert.equal(g.turn,1);assert.equal(g.round,2);
  applyAction(g,1,{type:'bid',bid:'C'});assert.ok(!legalBids(g,3).includes('contra'));
  applyAction(g,2,{type:'bid',bid:'contra'});assert.equal(g.multiplier,2);assert.equal(g.passes,0);
  applyAction(g,3,{type:'bid',bid:'recontra'});assert.equal(g.multiplier,4);
  applyAction(g,0,{type:'bid',bid:'H'});assert.equal(g.multiplier,1);
});
test('trick ranking for suit, no trumps and all trumps',()=>{
  const t:Play[]=[{player:0,card:'C-A'},{player:1,card:'H-7'},{player:2,card:'H-J'},{player:3,card:'C-J'}];
  assert.equal(winner(t,'H'),2);assert.equal(winner(t,'NT'),0);assert.equal(winner(t,'AT'),3);
  assert.equal(deck().reduce((n,c)=>n+points(c,'H'),0),152);assert.equal(deck().reduce((n,c)=>n+points(c,'AT'),0),248);assert.equal(deck().reduce((n,c)=>n+points(c,'NT'),0),240);
});
test('follow suit; overtrump; partner exception; no compulsory undertrump',()=>{
  const t:Play[]=[{player:1,card:'C-A'},{player:2,card:'H-9'}];
  assert.deepEqual(legalCards(asCards('C-7 H-J S-A'),t,'H',3),['C-7']);
  assert.deepEqual(legalCards(asCards('H-J H-7 S-A'),t,'H',3),['H-J']);
  assert.deepEqual(legalCards(asCards('H-7 S-A'),t,'H',3),['H-7','S-A']);
  assert.deepEqual(legalCards(asCards('H-J H-7 S-A'),t,'H',0),['H-J','H-7','S-A']);
  assert.deepEqual(legalCards(asCards('H-7 S-A'),[{player:1,card:'C-A'}],'H',2),['H-7']);
  assert.deepEqual(legalCards(asCards('H-7 S-A'),[{player:1,card:'C-A'}],'NT',2),['H-7','S-A']);
});
test('all trumps mandatory raise even above partner, no cross-suit trump',()=>{
  const trick:Play[]=[{player:0,card:'C-9'},{player:1,card:'C-7'}];
  assert.deepEqual(legalCards(asCards('C-J C-8 H-A'),trick,'AT',2),['C-J']);
  assert.deepEqual(legalCards(asCards('H-J S-A'),trick,'AT',2),['H-J','S-A']);
});
test('sequences, fours, independent declaration competitions and ties',()=>{
  const seq=declarations(asCards('H-7 H-8 H-9 H-10 H-J C-J D-J S-J'),'AT');
  assert.equal(seq.length,2);assert.equal(seq[0].value,100);assert.equal(seq[1].value,200);
  const low=declarations(asCards('C-7 C-8 C-9'),'H')[0];
  const high=declarations(asCards('D-8 D-9 D-10'),'H')[0];
  assert.deepEqual(declarationPoints([{...low,player:0},{...high,player:1},{...seq[1],player:2}]),[200,20]);
  assert.deepEqual(declarationPoints([{...low,player:0},{...low,player:1}]),[0,0]);
  assert.equal(declarations(asCards('H-7 H-8 H-9'),'NT').length,0);
});
test('belot only at first eligible K/Q; all trumps discard does not announce',()=>{
  const hand=asCards('H-K H-Q');const trick:Play[]=[{player:3,card:'C-A'}];
  assert.deepEqual(availableBelots(hand,trick,'H',[],0),hand);assert.deepEqual(availableBelots(hand,trick,'AT',[],0),[]);
  assert.deepEqual(availableBelots(hand,[],'AT',[],0),hand);assert.deepEqual(availableBelots(hand,[],'NT',[],0),[]);
  assert.deepEqual(availableBelots(['H-Q'],[],'H',[],0),[]);
});
test('server view excludes stock, other hands and unrevealed combinations',()=>{
  const g=contractGame();const v=view(g,2);assert.equal(v.hand.length,8);assert.deepEqual(v.hand,[...g.hands[2]].sort((a,b)=>['C','D','H','S'].indexOf(a[0])-['C','D','H','S'].indexOf(b[0])||['7','8','9','10','J','Q','K','A'].indexOf(a.split('-')[1])-['7','8','9','10','J','Q','K','A'].indexOf(b.split('-')[1])));
  assert.ok(!('hands' in v));assert.ok(!('stock' in v));
  g.announcements=[{...declarations(asCards('H-7 H-8 H-9'),'H')[0],player:0}];
  assert.deepEqual(view(g,1).announcements[0].cards,[]);
});
test('rounding boundaries match reference table',()=>{
  assert.deepEqual(roundedPair([96,66],'H',0),[9,7]);assert.deepEqual(roundedPair([134,124],'AT',0),[13,13]);
  assert.deepEqual(roundedPair([106,106],'S',0),[11,10]);assert.deepEqual(roundedPair([154,154],'AT',1),[15,16]);
  assert.deepEqual(roundedPair([170,90],'NT',0),[17,9]);assert.deepEqual(roundedPair([138,64],'H',0),[14,6]);
});
function fixture(g:Game,declaring:number=0){g.declarer=declaring;g.tricks=Array.from({length:8},(_,i)=>({winner:i%2,plays:[]}));g.announcements=[];g.belots=[];}
test('settlement: made, failed, hanging, contra, recontra and carried points',()=>{
  const g=contractGame('H');fixture(g);
  // 2 aces + a ten: 32, versus 9 + last: 24.
  g.tricks[0].plays=[{player:0,card:'C-A'},{player:1,card:'D-A'},{player:2,card:'C-10'}];
  g.tricks[1].plays=[{player:1,card:'H-9'}];
  let r=calculateResult(g);assert.deepEqual(r.raw,[32,24]);assert.equal(r.outcome,'made');
  g.declarer=1;r=calculateResult(g);assert.equal(r.outcome,'failed');assert.deepEqual(r.added,[6,0]);
  g.multiplier=2;r=calculateResult(g);assert.deepEqual(r.added,[11,0]);
  g.multiplier=4;g.hanging=8;r=calculateResult(g);assert.deepEqual(r.added,[30,0]);assert.equal(r.hanging,0);
  fixture(g);g.multiplier=1;g.hanging=0;g.tricks[0].plays=[{player:0,card:'C-10'}];r=calculateResult(g);
  assert.equal(r.outcome,'hanging');assert.equal(r.hanging,1);assert.deepEqual(r.added,[0,1]);
  g.multiplier=2;r=calculateResult(g);assert.deepEqual(r.added,[0,0]);assert.equal(r.hanging,4);
});
test('capot bonus, no-trump doubling, and match cannot end on capot',()=>{
  const g=contractGame('NT');g.hands=[[],[],[],[]];g.tricks=Array.from({length:7},(_,i)=>({winner:0,plays:deck().slice(i*4,i*4+4).map((card,player)=>({player,card}))}));
  g.trick=deck().slice(28).map((card,player)=>({player,card}));g.phase='trick';g.scores=[150,0];
  // Force the last trick winner to team zero while preserving all 32 cards.
  const winning=winner(g.trick,'NT');g.trick=g.trick.map(p=>({...p,player:(p.player+winning)%4}));
  applyAction(g,-1,{type:'collect'});assert.equal(g.results[0].raw[0],350);assert.equal(g.results[0].capot,true);assert.equal(g.phase,'roundEnd');
});
test('reject illegal action, wrong actor, late declaration, duplicate declaration and invalid belot',()=>{
  const g=contractGame();assert.throws(()=>applyAction(g,1,{type:'play',card:g.hands[1][0]}));
  assert.throws(()=>applyAction(g,0,{type:'play',card:g.hands[0][0],declare:['imaginary']}));
  assert.throws(()=>applyAction(g,0,{type:'collect'}));
  assert.throws(()=>applyAction(g,0,{type:'play',card:g.hands[0].find(c=>!['K','Q'].includes(c.split('-')[1]))!,belot:true}));
});
for(const difficulty of ['easy','medium','hard'] as Difficulty[])test(`complete simulated matches: ${difficulty}, cards conserved, no blocked turns`,()=>{
  const rng=seeded(123);const g=newGame(difficulty,rng);let actions=0,rounds=0;
  while(g.phase!=='matchEnd' && actions<18000) {
    if(g.phase==='roundEnd'){rounds++;applyAction(g,0,{type:'next'},rng);}
    else if(g.phase==='trick')applyAction(g,-1,{type:'collect'},rng);
    else {
      const v=view(g,g.turn);const a=difficulty==='hard'?hardAction(v,18,rng):basicAction(v,rng);
      if(a.type==='play')assert.ok(v.legalCards.includes(a.card));
      applyAction(g,g.turn,a,rng);
    }
    const cards=[...g.hands.flat(),...g.stock,...g.trick.map(p=>p.card),...g.tricks.flatMap(t=>t.plays.map(p=>p.card))];
    assert.equal(cards.length,32);assert.equal(new Set(cards).size,32);actions++;
  }
  assert.equal(g.phase,'matchEnd',`stalled after ${actions} actions, ${rounds} rounds`);assert.ok(Math.max(...g.scores)>=151);
});
test('hard bot sampling uses only public constraints and preserves known ownership',()=>{
  const rng=seeded(4),g=contractGame('AT');
  for(let i=0;i<12;i++){if(g.phase==='trick')applyAction(g,-1,{type:'collect'});else applyAction(g,g.turn,basicAction(view(g,g.turn),rng));}
  if(g.phase==='trick')applyAction(g,-1,{type:'collect'});
  const v=view(g,g.turn),hands=sampleHands(v,rng);assert.ok(hands);assert.deepEqual(hands[v.seat],v.hand);assert.deepEqual(hands.map(h=>h.length),v.counts);
  assert.equal(new Set(hands.flat()).size,hands.flat().length);
  const publicCards=v.tricks.flatMap(t=>t.plays.map(p=>p.card));assert.ok(hands.flat().every(c=>!publicCards.includes(c)));
});

test('overlapping sequence and four require a choice; bots choose the best disjoint set',()=>{
  const g=contractGame('AT');g.hands[0]=asCards('H-7 H-8 H-9 H-10 H-J C-J D-J S-J');
  const options=declarations(g.hands[0],'AT');assert.equal(options.length,2);
  assert.throws(()=>applyAction(g,0,{type:'play',card:'H-7',declare:options.map(d=>d.id)}),/Една карта/);
  const chosen=selectDeclarations(options);assert.deepEqual(chosen,[options.find(d=>d.value===200)!.id]);
  applyAction(g,0,{type:'play',card:'H-7',declare:chosen});assert.equal(g.announcements.length,1);
  const opponent=view(g,1);assert.equal(opponent.announcements[0].label,'Каре');assert.equal(opponent.announcements[0].value,0);assert.deepEqual(opponent.announcements[0].cards,[]);
  assert.ok(!g.message.includes('Каре J'));
  g.tricks.push({winner:0,plays:[...g.trick]});assert.deepEqual(view(g,1).announcements[0].cards,[]);
  g.phase='roundEnd';assert.equal(view(g,1).announcements[0].cards.length,4);
});
