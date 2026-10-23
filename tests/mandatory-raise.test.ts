import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,deck,legalCards,newGame,view} from '../src/game/engine.js';
import {SUITS,type Card,type Contract,type Play} from '../src/game/types.js';

test('following trump must overtake the strongest trump, including a partner, for every suit and seat',()=>{
 for(const suit of SUITS)for(let player=0;player<4;player++){
  const card=(rank:string)=>`${suit}-${rank}` as Card;
  const hand=[card('8'),card('A'),card('J')];
  // The immediately preceding card is weaker than the earlier winning nine.
  const trick:Play[]=[{player:(player+2)%4,card:card('9')},{player:(player+3)%4,card:card('7')}];
  for(const contract of [suit,'AT'] as Contract[]){
   assert.deepEqual(legalCards(hand,trick,contract,player),[card('J')]);
   assert.deepEqual(legalCards(hand.slice(0,2),trick,contract,player),hand.slice(0,2));
  }
 }
});

test('side suits on a suit contract and every suit on NT permit ducking despite a higher card',()=>{
 for(const suit of SUITS){
  const card=(rank:string)=>`${suit}-${rank}` as Card;
  const hand=[card('7'),card('A')],trick:Play[]=[{player:0,card:card('10')}];
  for(const contract of [...SUITS.filter(s=>s!==suit),'NT'] as Contract[])
   assert.deepEqual(legalCards(hand,trick,contract,1),hand);
  assert.deepEqual(legalCards(hand,trick,'AT',1),[card('A')]);
 }
});

function position(contract:Contract,lead:typeof SUITS[number]){
 const card=(rank:string)=>`${lead}-${rank}` as Card;
 const g=newGame('medium'),reserved=[card('9'),card('7'),card('8'),card('J')];
 const rest=deck().filter(c=>!reserved.includes(c));
 g.hands=[[card('9')],[card('7')],[card('8'),card('J')],[]];
 for(const hand of g.hands)while(hand.length<5)hand.push(rest.shift()!);
 g.stock=rest;
 applyAction(g,0,{type:'bid',bid:contract});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
 applyAction(g,0,{type:'play',card:card('9')});applyAction(g,1,{type:'play',card:card('7')});
 return {g,card};
}

test('public legal moves and server validation enforce raising; NT and side-suit ducking are accepted',()=>{
 for(const contract of ['H','AT'] as Contract[]){
  const {g,card}=position(contract,'H');assert.deepEqual(view(g,2).legalCards,[card('J')]);
  const before=structuredClone(g);assert.throws(()=>applyAction(g,2,{type:'play',card:card('8')}));assert.deepEqual(g,before);
  applyAction(g,2,{type:'play',card:card('J')});assert.equal(g.trick.at(-1)!.card,card('J'));
 }
 for(const [contract,lead] of [['H','C'],['NT','H']] as const){
  const {g,card}=position(contract,lead);assert.ok(view(g,2).legalCards.includes(card('8')));
  assert.ok(view(g,2).legalCards.includes(card('J')));applyAction(g,2,{type:'play',card:card('8')});
 }
});
