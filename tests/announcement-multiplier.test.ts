import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calculateResult,hydrateGame,newGame,roundedPair} from '../src/game/engine.js';
import {resultUtility,scorePosition} from '../src/game/bot-objective.js';
import {Store} from '../src/server/storage.js';
import {createApp} from '../src/server/app.js';
import type {Game,Announced} from '../src/game/types.js';

// Scorer unit inputs: both teams have tricks; 248 AT card points + last 10.
function scoring(multiplier:number,multiplyAnnouncements=false):Game{
 const g=newGame('medium',()=>.5,{multiplyAnnouncements});g.contract='AT';g.declarer=0;g.multiplier=multiplier;
 g.tricks=Array.from({length:8},(_,i)=>({winner:i%2,plays:[]}));
 g.tricks[0].plays=[{player:0,card:'C-J'},{player:1,card:'D-J'},{player:2,card:'H-J'},{player:3,card:'S-J'},
 {player:0,card:'C-9'},{player:1,card:'D-9'},{player:2,card:'H-9'},{player:3,card:'S-9'},
 {player:0,card:'C-A'},{player:1,card:'D-A'},{player:2,card:'H-A'},{player:3,card:'S-A'},
 {player:0,card:'C-10'},{player:1,card:'D-10'},{player:2,card:'H-10'},{player:3,card:'S-10'},
 {player:0,card:'C-K'},{player:1,card:'D-K'},{player:2,card:'H-K'},{player:3,card:'S-K'},
 {player:0,card:'C-Q'},{player:1,card:'D-Q'},{player:2,card:'H-Q'},{player:3,card:'S-Q'}];
 return g;
}
function announcement(kind:'sequence'|'four',value:number,player=0):Announced{
 return {id:'scoring-announcement',kind,value,strength:100,label:'Анонс',cards:[],player};
}

test('belot and each declaration value are added once by default and optionally multiplied with contra/recontra',()=>{
 for(const multiplier of [1,2,4])for(const enabled of [false,true])for(const value of [20,50,100,150,200]){
  const g=scoring(multiplier,enabled);g.announcements=[announcement(value>100?'four':'sequence',value)];
  let r=calculateResult(g);const factor=enabled?multiplier:1;
  assert.deepEqual(r.added,multiplier===1?roundedPair(r.raw,'AT',0):[Math.round((258*multiplier+value*factor)/10),0]);
  assert.deepEqual(r.declarationPoints,[value,0]);
  g.announcements=[];g.belots=[{player:0,suit:'C'}];r=calculateResult(g);
  assert.deepEqual(r.added,multiplier===1?roundedPair(r.raw,'AT',0):[Math.round((258*multiplier+20*factor)/10),0]);
  assert.deepEqual(r.belotPoints,[20,0]);
 }
});

test('both teams announcements and belots stay single, even on a failed contract; carried points are not multiplied',()=>{
 const g=scoring(2);g.announcements=[announcement('sequence',50),announcement('four',100,1)];
 g.belots=[{player:0,suit:'C'},{player:1,suit:'D'}];g.hanging=7;g.declarer=1;
 const r=calculateResult(g);assert.equal(r.outcome,'failed');assert.deepEqual(r.added,[78,0]); // round((516+190)/10)+7
 assert.equal(r.hanging,0);assert.deepEqual(scorePosition(g,g.tricks,0),resultUtility(r,0));
 g.multiplyAnnouncements=true;assert.deepEqual(calculateResult(g).added,[97,0]);
});

test('hanging a doubled game carries the weighted total; capot cancels every multiplication regardless of the option',()=>{
 for(const enabled of [false,true]){
  const g=scoring(2,enabled);g.tricks=Array.from({length:8},(_,i)=>({winner:i%2,plays:[]}));
  g.tricks[0].plays=[{player:0,card:'C-J'}];g.announcements=[announcement('sequence',50,0),announcement('four',50,1)];
  g.belots=[{player:1,suit:'D'}]; // 20+50 versus last 10+50+20 is not a tie; balance cards explicitly.
  g.tricks[0].plays.push({player:2,card:'D-10'}); // Both raw totals are now 80.
  let r=calculateResult(g);assert.equal(r.outcome,'hanging');assert.deepEqual(r.added,[0,0]);
  assert.equal(r.hanging,enabled?32:20); // 40 cards incl. last 10; 120 announcements.
  g.tricks.forEach(t=>t.winner=0);r=calculateResult(g);assert.equal(r.capot,true);assert.equal(r.multiplier,1);
  const single=structuredClone(g);single.multiplier=1;single.multiplyAnnouncements=false;
  assert.deepEqual(r.added,calculateResult(single).added);
 }
});

test('announcement multiplier defaults and SQLite migration preserve the other rule and speed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'belot-announcements-')),path=join(dir,'game.sqlite');let store=new Store(path);
 try{
  assert.equal(store.settings('s').multiplyAnnouncements,false);
  store.saveSettings('s',{speed:'slow',allowContraEscape:true},'existing-preferences');
  store.saveSettings('s',{multiplyAnnouncements:true},'multiply-announcements');store.close();store=new Store(path);
  assert.deepEqual(store.settings('s'),{speed:'slow',allowContraEscape:true,multiplyAnnouncements:true,higherFourWins:true,revision:2});
  store.saveSettings('s',{speed:'fast'},'speed-only');assert.equal(store.settings('s').multiplyAnnouncements,true);
  const g=newGame('medium',()=>.5);delete g.multiplyAnnouncements;assert.equal(hydrateGame(g).multiplyAnnouncements,false);
 }finally{store.close();rmSync(dir,{recursive:true});}
});

test('API saves the option immediately for active and future games, survives restart and validates boolean input',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'belot-announcements-api-')),dbPath=join(dir,'game.sqlite');let app=await createApp({dbPath,botDelay:60000});
 try{
  const first=await app.inject({url:'/api/state'}),cookies={belot:first.cookies[0].value};
  const setting=async(payload:object)=>app.inject({method:'POST',url:'/api/settings',cookies,payload});
  let r=await setting({multiplyAnnouncements:true,requestId:'announcements-on'});assert.equal(r.statusCode,200);assert.equal(r.json().settings.multiplyAnnouncements,true);
  r=await app.inject({method:'POST',url:'/api/games',cookies,payload:{difficulty:'medium',requestId:'announcements-game'}});
  const g=r.json().game;assert.equal(g.multiplyAnnouncements,true);
  r=await setting({multiplyAnnouncements:false,requestId:'announcements-off'});const updated=r.json().game;
  assert.equal(updated.multiplyAnnouncements,false);assert.equal(updated.revision,g.revision+1);
  r=await setting({allowContraEscape:true,requestId:'escape-independent'});assert.equal(r.json().settings.multiplyAnnouncements,false);
  r=await setting({multiplyAnnouncements:true,requestId:'announcements-off'});assert.equal(r.json().settings.multiplyAnnouncements,false);
  assert.equal((await setting({multiplyAnnouncements:'yes',requestId:'invalid-multiplier'})).statusCode,400);
  const other=await app.inject({url:'/api/state'});assert.equal(other.json().settings.multiplyAnnouncements,false);
  await app.close();app=await createApp({dbPath,botDelay:60000});r=await app.inject({url:'/api/state',cookies});
  assert.equal(r.json().game.multiplyAnnouncements,false);assert.equal(r.json().settings.multiplyAnnouncements,false);assert.equal(r.json().settings.allowContraEscape,true);
 }finally{await app.close();rmSync(dir,{recursive:true});}
});
