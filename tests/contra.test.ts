import {test} from 'node:test';
import {setImmediate as immediate} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newGame,applyAction,legalBids,view,deck,hydrateGame} from '../src/game/engine.js';
import {basicAction} from '../src/game/bots.js';
import {createApp} from '../src/server/app.js';
import {Store} from '../src/server/storage.js';
import type {Bid,Card} from '../src/game/types.js';

function doubled(allowContraEscape=false){
 const g=newGame('medium',()=>.5,{allowContraEscape});
 applyAction(g,0,{type:'bid',bid:'D'});applyAction(g,1,{type:'bid',bid:'contra'});
 return g;
}

test('default contra locks all higher contracts for both teams while either declarer-team player can recontra',()=>{
 for(const caller of [0,2]){
  const g=doubled();assert.equal(g.allowContraEscape,false);
  for(const p of [0,1,2,3])assert.deepEqual(legalBids(g,p),p%2===0?['pass','recontra']:['pass']);
  if(caller===0)for(const p of [2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  applyAction(g,caller,{type:'bid',bid:'recontra'});assert.equal(g.multiplier,4);
  for(const p of [0,1,2,3])assert.deepEqual(legalBids(g,p),['pass']);
 }
 for(const bid of ['H','S','NT','AT'] as Bid[]){
  const g=doubled(),before=structuredClone(g);
  assert.throws(()=>applyAction(g,2,{type:'bid',bid}));assert.deepEqual(g,before);
 }
});

test('enabled escape allows the declarer and partner to upgrade; the new contract clears contra/recontra',()=>{
 for(const multiplier of [2,4])for(const caller of [0,2])for(const bid of ['H','S','NT','AT'] as Bid[]){
  const g=doubled(true);
  if(multiplier===4){
   if(caller===2){for(const p of [2,3])applyAction(g,p,{type:'bid',bid:'pass'});applyAction(g,0,{type:'bid',bid:'recontra'});applyAction(g,1,{type:'bid',bid:'pass'});}
   else {applyAction(g,2,{type:'bid',bid:'recontra'});applyAction(g,3,{type:'bid',bid:'pass'});}
  }
  else if(caller===0){applyAction(g,2,{type:'bid',bid:'pass'});applyAction(g,3,{type:'bid',bid:'pass'});}
  assert.ok(legalBids(g,caller).includes(bid));applyAction(g,caller,{type:'bid',bid});
  assert.equal(g.contract,bid);assert.equal(g.declarer,caller);assert.equal(g.multiplier,1);assert.equal(g.passes,0);
  assert.equal(g.allowContraEscape,true);
 }
});

test('a bot can rescue its partner only with escape enabled and a supported higher suit',()=>{
 for(const enabled of [false,true]){
  const hand:Card[]=['H-J','H-9','H-7','C-7','S-8'],rest=deck().filter(c=>!hand.includes(c));
  const g=newGame('medium',()=>.5,{allowContraEscape:enabled});
  g.hands=[rest.slice(0,5),rest.slice(5,10),hand,rest.slice(10,15)];g.stock=rest.slice(15);
  applyAction(g,0,{type:'bid',bid:'D'});applyAction(g,1,{type:'bid',bid:'contra'});
  const action=basicAction(view(g,2));assert.deepEqual(action,{type:'bid',bid:enabled?'H':'pass'});
  applyAction(g,2,action);assert.equal(g.multiplier,enabled?1:2);
 }
});

test('old saves default to no escape; the rule survives dealing the next round',()=>{
 const g=newGame('medium',()=>.5,{allowContraEscape:true});g.phase='roundEnd';applyAction(g,0,{type:'next'},()=>.5);
 assert.equal(g.allowContraEscape,true);assert.equal(view(g).allowContraEscape,true);
 delete g.allowContraEscape;assert.equal(hydrateGame(g).allowContraEscape,false);
});

test('settings persist without a game, merge with speed, apply immediately, and survive restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'belot-contra-')),dbPath=join(dir,'game.sqlite');
 let app=await createApp({dbPath,botDelay:60000});
 try{
  const first=await app.inject({url:'/api/state'}),cookies={belot:first.cookies[0].value};
  const setting=async(payload:object)=>app.inject({method:'POST',url:'/api/settings',cookies,payload});
  let r=await setting({allowContraEscape:true,requestId:'enable-escape'});
  assert.equal(r.statusCode,200);assert.equal(r.json().game,null);assert.equal(r.json().settings.allowContraEscape,true);
  r=await app.inject({method:'POST',url:'/api/games',cookies,payload:{difficulty:'medium',requestId:'contra-game'}});
  const before=r.json().game;assert.equal(before.allowContraEscape,true);
  r=await setting({speed:'slow',requestId:'speed-contra'});assert.deepEqual(r.json().game,before);assert.equal(r.json().settings.allowContraEscape,true);
  r=await setting({allowContraEscape:false,requestId:'disable-escape'});
  const updated=r.json().game;assert.equal(updated.revision,before.revision+1);assert.equal(updated.allowContraEscape,false);assert.equal(r.json().settings.speed,'slow');
  r=await setting({allowContraEscape:true,requestId:'disable-escape'});assert.deepEqual(r.json().game,updated);assert.equal(r.json().settings.allowContraEscape,false);
  const other=await app.inject({url:'/api/state'});assert.equal(other.json().settings.allowContraEscape,false);
  for(const payload of [{allowContraEscape:'yes',requestId:'bad-flag-value'},{requestId:'empty-settings'},{allowContraEscape:true,extra:1,requestId:'extra-settings'}])assert.equal((await setting(payload)).statusCode,400);
  await app.close();app=await createApp({dbPath,botDelay:60000});
  r=await app.inject({url:'/api/state',cookies});assert.deepEqual(r.json().game,updated);assert.equal(r.json().settings.allowContraEscape,false);assert.equal(r.json().settings.speed,'slow');
 }finally{await app.close();rmSync(dir,{recursive:true});}
});

test('API rejects a disabled escape, accepts recontra, and exposes legal upgrades immediately after enabling',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'belot-contra-api-')),dbPath=join(dir,'game.sqlite');
 const session='11111111-1111-4111-8111-111111111111',g=doubled();
 for(const p of [2,3])applyAction(g,p,{type:'bid',bid:'pass'});
 const store=new Store(dbPath);store.save(session,g);store.close();
 const app=await createApp({dbPath,botDelay:60000}),cookies={belot:session};
 try{
  const action=async(bid:Bid,revision:number,id:string)=>app.inject({method:'POST',url:'/api/action',cookies,payload:{gameId:g.id,revision,requestId:id,action:{type:'bid',bid}}});
  let r=await action('AT',g.revision,'blocked-upgrade');assert.equal(r.statusCode,400);
  r=await app.inject({url:'/api/state',cookies});assert.deepEqual(r.json().game.legalBids,['pass','recontra']);
  r=await app.inject({method:'POST',url:'/api/settings',cookies,payload:{allowContraEscape:true,requestId:'unlock-contra'}});
  const v=r.json().game;assert.ok(v.legalBids.includes('AT'));assert.ok(v.legalBids.includes('recontra'));
  assert.equal((await action('AT',g.revision,'stale-upgrade')).statusCode,409);
  r=await action('recontra',v.revision,'valid-recontra');assert.equal(r.statusCode,200);assert.equal(r.json().game.multiplier,4);
 }finally{await app.close();rmSync(dir,{recursive:true});}
});


test('changing rules discards an in-flight bot decision and commits only the fresh turn',async()=>{
 const jobs=new Map<number,()=>void>();let jobId=0;
 const clock={setTimeout(run:()=>void){const id=++jobId;jobs.set(id,run);return id;},clearTimeout(id:unknown){jobs.delete(id as number);}};
 const tick=()=>{const runs=[...jobs.values()];jobs.clear();for(const run of runs)run();};
 const choices:((action:{type:'bid';bid:'contra'})=>void)[]=[];
 const app=await createApp({dbPath:':memory:',clock,botDelay:0,chooseBot:()=>new Promise(resolve=>choices.push(resolve))});
 try{
  let r=await app.inject({method:'POST',url:'/api/games',payload:{difficulty:'hard',requestId:'changing-rules-game'}});
  const cookies={belot:r.cookies[0].value},g=r.json().game;
  r=await app.inject({method:'POST',url:'/api/action',cookies,payload:{gameId:g.id,revision:g.revision,requestId:'changing-rules-bid',action:{type:'bid',bid:'D'}}});
  tick();assert.equal(choices.length,1);
  r=await app.inject({method:'POST',url:'/api/settings',cookies,payload:{allowContraEscape:true,requestId:'changing-rules-enable'}});
  const revision=r.json().game.revision;tick();assert.equal(choices.length,2);
  choices[0]({type:'bid',bid:'contra'});await immediate();
  r=await app.inject({url:'/api/state',cookies});assert.equal(r.json().game.revision,revision);assert.equal(r.json().game.multiplier,1);
  choices[1]({type:'bid',bid:'contra'});await immediate();
  r=await app.inject({url:'/api/state',cookies});assert.equal(r.json().game.revision,revision+1);assert.equal(r.json().game.turn,2);assert.equal(r.json().game.multiplier,2);
 }finally{await app.close();}
});
