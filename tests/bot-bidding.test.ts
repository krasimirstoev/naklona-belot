import {test} from 'node:test';
import assert from 'node:assert/strict';
import {basicAction,decideHardCard} from '../src/game/bots.js';
import {decideCard} from '../src/game/bot-tactics.js';
import {partnerOpeningSuit} from '../src/game/bot-strategy.js';
import {applyAction,deck,newGame,suit,view} from '../src/game/engine.js';
import type {Bid,Card,Difficulty} from '../src/game/types.js';
const levels:Difficulty[]=['easy','medium','hard'];
function bidding(hand:Card[],difficulty:Difficulty){
 const g=newGame(difficulty,()=>.5),rest=deck().filter(c=>!hand.includes(c));
 g.hands=[hand,...[0,1,2].map(i=>rest.slice(i*5,i*5+5))];g.stock=rest.slice(15);
 return view(g,0);
}
function opening(bids:Bid[],hand:Card[]=['H-7','C-A','D-A','S-A','C-7','D-8','S-8','C-8']){
 const g=newGame('medium',()=>.5),rest=deck().filter(c=>!hand.includes(c));
 const hands=[hand,...[0,1,2].map(i=>rest.slice(i*8,i*8+8))];
 g.hands=hands.map(h=>h.slice(0,5));g.stock=hands.flatMap(h=>h.slice(5));
 for(const bid of bids)applyAction(g,g.turn,{type:'bid',bid});
 assert.equal(g.phase,'playing');assert.equal(g.turn,0);
 return g;
}

test('major sequence plus side points is not trump control; passing is valid at every difficulty',()=>{
 for(const difficulty of levels)for(const s of ['C','D','H','S'] as const){
  const others=['C','D','H','S'].filter(other=>other!==s);
  const hand:Card[]=[`${s}-Q`,`${s}-K`,`${s}-A`,`${others[0]}-10` as Card,`${others[1]}-K` as Card];
  const v=bidding(hand,difficulty);
  assert.deepEqual(basicAction(v,()=>.999),{type:'bid',bid:'pass'},`${difficulty}: ${s}`);
 }
});

test('short honours or a lone jack do not justify a suit, but a supported trump holding does',()=>{
 for(const difficulty of levels){
  for(const hand of [
   ['H-J','H-9','C-7','D-8','S-Q'],
   ['H-J','H-7','H-8','C-7','D-8'],
   ['H-A','H-10','H-K','H-Q','D-7'],
  ] as Card[][])assert.deepEqual(basicAction(bidding(hand,difficulty),()=>.999),{type:'bid',bid:'pass'});
  for(const hand of [
   ['H-J','H-9','H-7','C-7','D-8'],
   ['H-J','H-7','H-8','H-Q','D-7'],
   ['H-J','H-A','H-7','D-A','S-8'],
  ] as Card[][])assert.deepEqual(basicAction(bidding(hand,difficulty),()=>.5),{type:'bid',bid:'H'});
 }
});

test('first lead returns the partner suit, even a singleton, on suit and all-trump contracts at every difficulty',()=>{
 for(const final of ['H','AT'] as const){
  const bids:Bid[]=final==='H'?['pass','pass','H','pass','pass','pass']:['pass','pass','H','AT','pass','pass','pass'];
  const g=opening(bids),v=view(g,0),before=structuredClone(v);
  assert.equal(partnerOpeningSuit(v),'H');
  const d=decideCard(v,v.legalCards);assert.equal(d.strategy?.plan,'OPEN_PARTNER_SUIT');assert.equal(suit(d.card),'H');
  assert.ok(d.strategy!.assumptions.length);
  for(const difficulty of levels){const action=basicAction({...v,difficulty},()=>.99);assert.equal(action.type,'play');if(action.type==='play')assert.equal(suit(action.card),'H');}
  const hard=decideHardCard(v,2000,()=>.37,3);
  assert.equal(hard.strategy?.plan,'OPEN_PARTNER_SUIT');assert.equal(suit(hard.card),'H');
  assert.deepEqual(v,before);
  // This preference is public auction information, not a claim of known cards.
  assert.deepEqual(decideCard(Object.assign(structuredClone(v),{hands:g.hands.toReversed()}),v.legalCards),d);
 }
});

test('use the latest partner suit after an auction upgrade; never borrow the opponent suit',()=>{
 const g=opening(['pass','pass','C','D','pass','pass','H','AT','pass','pass','pass']);
 const v=view(g,0);assert.equal(partnerOpeningSuit(v),'H');assert.equal(suit(decideCard(v,v.legalCards).card),'H');
 for(const final of ['S','NT'] as const){
  const other=opening(['pass','pass','H',final,'pass','pass','pass']),ov=view(other,0);
  assert.equal(partnerOpeningSuit(ov),null);assert.notEqual(decideCard(ov,ov.legalCards).strategy?.plan,'OPEN_PARTNER_SUIT');
 }
});

test('partner opening preference expires after the opening card and cannot require an absent suit',()=>{
 const g=opening(['pass','pass','H','pass','pass','pass']);
 applyAction(g,0,{type:'play',card:'H-7'});
 while(g.phase==='playing'){
  const v=view(g,g.turn);assert.equal(partnerOpeningSuit(v),null);applyAction(g,g.turn,basicAction(v));
 }
 applyAction(g,-1,{type:'collect'});
 const next=view(g,g.turn);assert.equal(partnerOpeningSuit(next),null);assert.notEqual(decideCard(next,next.legalCards).strategy?.plan,'OPEN_PARTNER_SUIT');
 const missing=opening(['pass','pass','H','pass','pass','pass'],['C-A','C-7','C-8','D-A','D-7','D-8','S-A','S-7']);
 const v=view(missing,0),d=decideCard(v,v.legalCards);
 assert.ok(v.legalCards.includes(d.card));assert.notEqual(d.strategy?.plan,'OPEN_PARTNER_SUIT');
});
