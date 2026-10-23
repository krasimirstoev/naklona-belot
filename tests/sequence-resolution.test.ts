import {test} from 'node:test';
import assert from 'node:assert/strict';
import {declarationPoints,declarations,newGame,view} from '../src/game/engine.js';
import {resolveDeclarations} from '../src/game/declaration-resolution.js';
import type {Card} from '../src/game/types.js';
const sequence=(cards:Card[],player:number)=>({...declarations(cards,'AT')[0],player});
const queen=sequence(['C-10','C-J','C-Q'],0),ace=sequence(['D-Q','D-K','D-A'],1);
const four=sequence(['H-7','H-8','H-9','H-10'],0),five=sequence(['S-7','S-8','S-9','S-10','S-J'],1);

test('higher top breaks equal-length sequences; a four beats a three and a five beats a four',()=>{
 for(const [ann,points] of [[[queen,ace],[0,20]],[[four,ace],[50,0]],[[four,five],[0,100]]] as const){
  assert.deepEqual(declarationPoints([...ann]),points);
 }
});
test('winning team keeps its lower sequences and cancels only the opposing sequences',()=>{
 const partner=sequence(['S-7','S-8','S-9'],2),opponent=sequence(['D-Q','D-K','D-A'],3);
 const ann=[four,partner,opponent];
 assert.deepEqual(resolveDeclarations(ann),['counted','counted','beaten']);
 assert.deepEqual(declarationPoints(ann),[70,0]);
 const tied=sequence(['D-7','D-8','D-9','D-10'],1);
 assert.deepEqual(resolveDeclarations([four,partner,tied]),['tied','tied','tied']);
 assert.deepEqual(declarationPoints([four,partner,tied]),[0,0]);
});
test('opposing sequence cards and their tops are revealed only when the round ends',()=>{
 const g=newGame('medium');g.phase='playing';g.announcements=[ace];
 assert.deepEqual(view(g).announcements[0].cards,[]);assert.equal(view(g).announcements[0].strength,0);
 for(const phase of ['roundEnd','matchEnd'] as const){g.phase=phase;assert.deepEqual(view(g).announcements,[ace]);}
});
