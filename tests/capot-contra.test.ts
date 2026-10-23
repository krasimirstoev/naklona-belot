import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,calculateResult,deck,legalCards,newGame,points,team,view} from '../src/game/engine.js';
import {decideHardCard,decideMediumCard} from '../src/game/bots.js';
import {resultUtility} from '../src/game/bot-objective.js';
import {CONTRACTS,SUITS,type Card,type Contract,type Game} from '../src/game/types.js';

function arrange(hands:Card[][],contract:Contract,multiplier:number,declarer=0){
 assert.equal(new Set(hands.flat()).size,32);
 const g=newGame('medium',()=>.5);g.hands=hands.map(h=>h.slice(0,5));g.stock=hands.flatMap(h=>h.slice(5));
 while(g.turn!==declarer)applyAction(g,g.turn,{type:'bid',bid:'pass'});
 applyAction(g,g.turn,{type:'bid',bid:contract});
 if(multiplier>1)applyAction(g,g.turn,{type:'bid',bid:'contra'});
 if(multiplier===4)applyAction(g,g.turn,{type:'bid',bid:'recontra'});
 while(g.phase==='bidding')applyAction(g,g.turn,{type:'bid',bid:'pass'});
 return g;
}
function finish(g:Game){
 while(g.phase==='playing'||g.phase==='trick'){
  if(g.phase==='trick')applyAction(g,-1,{type:'collect'});
  else applyAction(g,g.turn,{type:'play',card:legalCards(g.hands[g.turn],g.trick,g.contract!,g.turn)[0]});
 }
 return g.results[0];
}
function capotDeal(contract:Contract,multiplier:number,declarer=0){
 const s=SUITS.find(s=>s===contract)??'C';
 return arrange([s,...SUITS.filter(other=>other!==s)].map(s=>deck().filter(c=>c.startsWith(`${s}-`))),contract,multiplier,declarer);
}
function capotChoice(multiplier:number,announce=false){
 const hands:Card[][]=[
  ['C-J','C-7','H-J','H-9','H-A','H-10','H-K','H-Q'],
  ['C-9','D-7','H-7','H-8','C-8','C-10','C-K','C-A'],
  ['D-A','D-8','S-J','S-9','S-A','S-10','S-K','S-Q'],
  ['D-J','D-9','S-7','S-8','C-Q','D-10','D-Q','D-K'],
 ];
 const g=arrange(hands,'AT',multiplier);
 const tricks:Card[][]=[
  ['H-J','H-7','S-J','S-7'],['H-9','H-8','S-9','S-8'],
  ['H-A','C-8','S-A','C-Q'],['H-10','C-10','S-10','D-10'],
  ['H-K','C-K','S-K','D-Q'],['H-Q','C-A','S-Q','D-K'],
 ];
 for(const trick of tricks){for(const card of trick)applyAction(g,g.turn,{type:'play',card,declare:announce&&g.turn===0&&g.tricks.length===0?view(g).declarations.filter(d=>d.kind==='sequence').map(d=>d.id):[]});applyAction(g,-1,{type:'collect'});}
 assert.ok(g.tricks.every(t=>team(t.winner)===0));assert.equal(g.turn,0);
 return g;
}

test('capot cancels contra and recontra for every contract, whether declarers or defenders take all tricks',()=>{
 for(const contract of CONTRACTS)for(const declarer of [0,1]){
  const plain=finish(capotDeal(contract,1,declarer));
  for(const multiplier of [2,4]){
   const g=capotDeal(contract,multiplier,declarer),r=finish(g);
   assert.equal(r.capot,true);assert.equal(r.multiplier,1);assert.equal(g.multiplier,multiplier);
   assert.deepEqual(r.added,plain.added);assert.equal(r.outcome,plain.outcome);
   assert.equal(g.phase,'roundEnd');
   if(contract==='AT')assert.deepEqual(r.added,[35,0]);
  }
 }
});

test('carried points are paid once and capot still cannot end the match',()=>{
 const g=capotDeal('AT',4);g.scores=[140,100];g.hanging=9;
 const r=finish(g);assert.deepEqual(r.added,[44,0]);assert.equal(r.hanging,0);assert.equal(r.multiplier,1);
 assert.equal(g.phase,'roundEnd');assert.equal(resultUtility(r,0)[0],0);
});

test('Medium and Hard prefer preserving the double to an available 35-point capot, using only public information',()=>{
 for(const multiplier of [2,4]){
  const g=capotChoice(multiplier),v=view(g),before=structuredClone(v);
  assert.deepEqual(new Set(v.legalCards),new Set(['C-J','C-7']));
  const medium=decideMediumCard(v),hard=decideHardCard(v,Infinity,()=>.37,100);
  assert.equal(medium.card,'C-7');assert.equal(hard.card,'C-7');
  assert.equal(medium.search?.exhaustive,true);assert.equal(hard.search?.exhaustive,true);
  assert.deepEqual(v,before);
  const hidden=Object.assign(structuredClone(v),{hands:g.hands.toReversed(),stock:deck()});
  assert.deepEqual(decideMediumCard(hidden),medium);
  const cash=structuredClone(g);applyAction(cash,0,{type:'play',card:'C-J'});const capot=finish(cash);
  const concede=structuredClone(g);applyAction(concede,0,{type:'play',card:medium.card});const preserved=finish(concede);
  assert.equal(capot.capot,true);assert.deepEqual(capot.added,[35,0]);
  assert.equal(preserved.capot,false);assert.equal(preserved.multiplier,multiplier);
  assert.deepEqual(preserved.added,[multiplier===2?52:103,0]);
 }
});

test('without a double the same legal deal favours taking the capot; a forced win must still obey the rules',()=>{
 const g=capotChoice(1),v=view(g);
 assert.equal(decideMediumCard(v).card,'C-J');assert.equal(decideHardCard(v,Infinity,()=>.37,20).card,'C-J');
 const forced=capotDeal('AT',2);
 while(forced.tricks.length<7){
  if(forced.phase==='trick')applyAction(forced,-1,{type:'collect'});
  else applyAction(forced,forced.turn,{type:'play',card:view(forced,forced.turn).legalCards[0]});
 }
 const last=view(forced,forced.turn);assert.equal(last.legalCards.length,1);assert.equal(decideMediumCard(last).card,last.legalCards[0]);
 assert.deepEqual(finish(forced).added,[35,0]);
});

test('the reference all-trump contra deal with a 14-point last trick records 52:0',()=>{
 const g=arrange([
  ['C-J','C-7','H-J','H-9','H-A','H-10','H-K','H-Q'],
  ['C-9','C-8','H-7','H-8','C-10','C-Q','C-K','C-A'],
  ['S-J','S-7','S-8','S-9','S-A','S-10','S-K','S-Q'],
  ['D-9','D-K','D-7','D-8','D-A','D-10','D-Q','D-J'],
 ],'AT',2);
 const tricks:Card[][]=[
  ['H-J','H-7','S-8','D-7'],['H-9','H-8','S-9','D-8'],
  ['H-A','C-10','S-A','D-A'],['H-10','C-Q','S-10','D-10'],
  ['H-K','C-K','S-K','D-Q'],['H-Q','C-A','S-Q','D-J'],
  ['C-J','C-9','S-J','D-9'],['C-7','C-8','S-7','D-K'],
 ];
 for(const trick of tricks){for(const card of trick)applyAction(g,g.turn,{type:'play',card});applyAction(g,-1,{type:'collect'});}
 const r=g.results[0];assert.deepEqual(r.cardPoints,[244,14]);assert.equal(r.capot,false);
 assert.equal(r.multiplier,2);assert.deepEqual(r.added,[52,0]);assert.equal(r.outcome,'made');
});


test('endgame simulations apply the announcement option while capot stays unchanged',()=>{
 const g=capotChoice(2,true);assert.equal(g.announcements[0].value,100);
 const single=view(g);g.multiplyAnnouncements=true;const doubled=view(g);
 for(const decide of [decideMediumCard,(v:ReturnType<typeof view>)=>decideHardCard(v,Infinity,()=>.37,100)]){
  const a=decide(single),b=decide(doubled);
  const utility=(d:typeof a,card:Card)=>d.candidates.find(c=>c.card===card)!.utility![2];
  assert.ok(utility(b,'C-7')>utility(a,'C-7'));
  assert.equal(utility(b,'C-J'),utility(a,'C-J'));
 }
});
