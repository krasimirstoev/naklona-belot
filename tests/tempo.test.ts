import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as immediate} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newGame,applyAction,view} from '../src/game/engine.js';
import {turnDelay,TEMPO} from '../src/game/tempo.js';
import {TurnScheduler,type TimerClock} from '../src/server/scheduler.js';
import {createApp} from '../src/server/app.js';
import {Store} from '../src/server/storage.js';
import type {Action,Speed} from '../src/game/types.js';

class FakeClock implements TimerClock {
  now=0;private id=0;private jobs=new Map<number,{at:number;run:()=>void}>();
  setTimeout(run:()=>void,delay:number){const id=++this.id;this.jobs.set(id,{at:this.now+delay,run});return id;}
  clearTimeout(handle:unknown){this.jobs.delete(handle as number);}
  tick(ms:number){
    const end=this.now+ms;
    for(;;){const job=[...this.jobs.entries()].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!job)break;this.now=job[1].at;this.jobs.delete(job[0]);job[1].run();}
    this.now=end;
  }
}
const flush=async()=>{await immediate();};

test('all speed profiles distinguish announcements, cards, and gathering a trick',()=>{
  const g=newGame('hard');
  for(const speed of ['slow','normal','fast'] as Speed[]){
    g.phase='bidding';assert.equal(turnDelay(g,speed),TEMPO[speed].announcement);
    g.phase='playing';assert.equal(turnDelay(g,speed),TEMPO[speed].card);
    g.phase='trick';assert.equal(turnDelay(g,speed),TEMPO[speed].trick);
    g.events.push({id:1,round:1,revision:g.revision,player:0,kind:'belot',text:'Белот'});
    g.phase='playing';assert.equal(turnDelay(g,speed),TEMPO[speed].announcement);
    g.phase='trick';assert.equal(turnDelay(g,speed),Math.max(TEMPO[speed].announcement,TEMPO[speed].trick));g.events=[];
  }
});
test('scheduler retimes a sleeping task, keeps ownership of a computing task, and cancels replaced tasks',async()=>{
  const clock=new FakeClock();let calls=0,idle=0,resolve!:()=>void;
  const scheduler=new TurnScheduler(()=>idle++,clock);
  scheduler.schedule('s',1800,async()=>{calls++;await new Promise<void>(r=>resolve=r);});
  clock.tick(700);scheduler.retime('s',950);clock.tick(949);assert.equal(calls,0);
  clock.tick(1);assert.equal(calls,1);scheduler.retime('s',3000);
  scheduler.schedule('s',0,async()=>{calls++;});clock.tick(5000);assert.equal(calls,1);
  resolve();await flush();assert.equal(idle,1);
  scheduler.schedule('s',100,async()=>{calls++;});scheduler.cancel('s');clock.tick(1000);assert.equal(calls,1);
  scheduler.close();
});
test('speed settings persist without a game and changing them never changes game revision or selected hand',async()=>{
  const app=await createApp({dbPath:':memory:',botDelay:60000});
  try{
    let r=await app.inject({url:'/api/state'});assert.deepEqual(r.json().settings,{speed:'normal',revision:0});
    const cookies={belot:r.cookies[0].value};
    r=await app.inject({method:'POST',url:'/api/settings',cookies,payload:{speed:'slow',requestId:'settings-slow'}});assert.equal(r.statusCode,200);assert.equal(r.json().game,null);assert.equal(r.json().settings.speed,'slow');
    r=await app.inject({method:'POST',url:'/api/games',cookies,payload:{difficulty:'hard',requestId:'settings-game'}});const before=r.json().game;
    r=await app.inject({method:'POST',url:'/api/settings',cookies,payload:{speed:'fast',requestId:'settings-fast'}});assert.deepEqual(r.json().game,before);assert.equal(r.json().settings.speed,'fast');
    r=await app.inject({method:'POST',url:'/api/settings',cookies,payload:{speed:'slow',requestId:'settings-fast'}});assert.equal(r.json().settings.speed,'fast');
    r=await app.inject({method:'POST',url:'/api/settings',cookies,payload:{speed:'warp',requestId:'settings-invalid'}});assert.equal(r.statusCode,400);
  }finally{await app.close();}
});
test('server retimes pending bids and a speed change during a worker cannot produce a double turn',async()=>{
  const clock=new FakeClock();let calls=0,resolve!:(action:Action)=>void;
  const app=await createApp({dbPath:':memory:',clock,chooseBot:()=>{calls++;return new Promise<Action>(r=>resolve=r);}});
  try{
    let r=await app.inject({method:'POST',url:'/api/games',payload:{difficulty:'hard',requestId:'worker-game'}});const cookies={belot:r.cookies[0].value};const g=r.json().game;
    await app.inject({method:'POST',url:'/api/action',cookies,payload:{gameId:g.id,revision:0,requestId:'worker-bid',action:{type:'bid',bid:'AT'}}});
    clock.tick(1000);assert.equal(calls,0);
    await app.inject({method:'POST',url:'/api/settings',cookies,payload:{speed:'fast',requestId:'worker-fast'}});
    clock.tick(949);assert.equal(calls,0);clock.tick(1);assert.equal(calls,1);
    await app.inject({method:'POST',url:'/api/settings',cookies,payload:{speed:'slow',requestId:'worker-slow'}});
    clock.tick(10000);assert.equal(calls,1);
    resolve({type:'bid',bid:'pass'});await flush();
    r=await app.inject({url:'/api/state',cookies});assert.equal(r.json().game.revision,2);assert.equal(r.json().game.turn,2);assert.equal(r.json().game.events.length,2);
    clock.tick(2999);assert.equal(calls,1);clock.tick(1);assert.equal(calls,2);
    resolve({type:'bid',bid:'pass'});await flush();
    r=await app.inject({url:'/api/state',cookies});assert.equal(r.json().game.revision,3);
  }finally{await app.close();}
});
test('old saved games are migrated without changing cards, score, phase or revision; speed and events survive restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'belot-migration-')),path=join(dir,'game.sqlite');let store=new Store(path);
  const g=newGame('medium');applyAction(g,0,{type:'bid',bid:'H'});store.save('s',g);store.saveSettings('s',{speed:'slow'},'persist-setting');store.close();
  const legacy=structuredClone(g) as Partial<typeof g>;delete legacy.events;delete legacy.eventSeq;
  const db=new DatabaseSync(path);db.prepare('UPDATE games SET state=? WHERE session=?').run(JSON.stringify(legacy),'s');db.close();
  store=new Store(path);
  try{
    const restored=store.load('s')!;assert.equal(restored.revision,g.revision);assert.deepEqual(restored.hands,g.hands);assert.deepEqual(restored.scores,g.scores);assert.equal(restored.phase,g.phase);
    assert.equal(restored.events[0].text,'Купа');assert.equal(restored.events[0].player,0);assert.equal(restored.events[0].revision,-1);
    assert.deepEqual(store.settings('s'),{speed:'slow',revision:1});assert.deepEqual(store.settings('new-session'),{speed:'normal',revision:0});
    store.save('s',restored);assert.deepEqual(store.load('s'),restored);
  }finally{store.close();rmSync(dir,{recursive:true});}
});
test('public event IDs survive views, include passes and both kinds of double, and do not leak card combinations',()=>{
  const g=newGame('medium');
  applyAction(g,0,{type:'bid',bid:'H'});applyAction(g,1,{type:'bid',bid:'contra'});applyAction(g,2,{type:'bid',bid:'recontra'});
  for(const p of [3,0,1])applyAction(g,p,{type:'bid',bid:'pass'});
  g.hands[0]=['H-J','C-J','D-J','S-J','H-7','H-8','H-9','H-10'];
  applyAction(g,0,{type:'play',card:'H-7',declare:['four-J']});
  const events=view(g,1).events;assert.deepEqual(events.map(e=>e.id),[1,2,3,4,5,6,7]);
  assert.deepEqual(events.map(e=>e.text),['Купа','Контра','Реконтра','Пас','Пас','Пас','Каре']);
  assert.ok(events.every(e=>!('cards'in e)));assert.ok(!JSON.stringify(events.at(-1)).includes('four-J'));
  const lastId=g.eventSeq;g.phase='roundEnd';applyAction(g,0,{type:'next'});assert.equal(g.eventSeq,lastId);assert.deepEqual(view(g,1).events,events);
});

test('several declarations and belot on one card produce separate public events with the same action revision',()=>{
  const g=newGame('medium');applyAction(g,0,{type:'bid',bid:'H'});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  g.hands[0]=['C-7','C-8','C-9','H-J','H-Q','H-K','D-7','S-8'];
  const v=view(g);assert.equal(v.declarations.length,2);
  applyAction(g,0,{type:'play',card:'H-K',declare:v.declarations.map(d=>d.id),belot:true});
  const group=view(g,1).events.filter(e=>e.revision===g.revision);
  assert.deepEqual(group.map(e=>e.text),['Терца','Терца','Белот']);assert.ok(group.every(e=>e.player===0));assert.equal(new Set(group.map(e=>e.id)).size,3);
});

test('existing session settings migrate to independent revisions without losing the chosen speed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'belot-settings-')),path=join(dir,'old.sqlite');
  const db=new DatabaseSync(path);db.exec("CREATE TABLE settings(session TEXT PRIMARY KEY,speed TEXT NOT NULL);INSERT INTO settings VALUES('s','fast')");db.close();
  const store=new Store(path);
  try{assert.deepEqual(store.settings('s'),{speed:'fast',revision:0});store.saveSettings('s',{speed:'slow'},'upgrade-settings');assert.deepEqual(store.settings('s'),{speed:'slow',revision:1});}
  finally{store.close();rmSync(dir,{recursive:true});}
});
