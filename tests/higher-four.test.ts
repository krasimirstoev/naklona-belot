import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {calculateResult,declarationPoints,declarations,hydrateGame,newGame,view} from '../src/game/engine.js';
import {scorePosition,resultUtility} from '../src/game/bot-objective.js';
import {Store} from '../src/server/storage.js';
import {createApp} from '../src/server/app.js';
import {SUITS,type Rank} from '../src/game/types.js';

const four=(rank:Rank,player:number)=>({...declarations(SUITS.map(s=>`${s}-${rank}` as const),'AT')[0],player});
test('higher four wins by default; disabling keeps both teams fours and preserves sequence comparison',()=>{
 const queen=four('Q',0),king=four('K',1),ace=four('A',2),jack=four('J',3);
 assert.deepEqual(declarationPoints([queen,king]),[0,100]);
 assert.deepEqual(declarationPoints([queen,king],false),[100,100]);
 assert.deepEqual(declarationPoints([queen,king,ace]),[200,0]);
 assert.deepEqual(declarationPoints([queen,king,ace,jack]),[0,300]);
 assert.deepEqual(declarationPoints([queen,king,ace,jack],false),[200,300]);
 const low={...declarations(['C-7','C-8','C-9'],'AT')[0],player:0};
 const high={...declarations(['D-8','D-9','D-10'],'AT')[0],player:1};
 for(const enabled of [false,true])assert.deepEqual(declarationPoints([queen,king,low,high],enabled),enabled?[0,120]:[100,120]);
});

test('scoring, bot utility and legacy game defaults honor the four rule',()=>{
 const g=newGame('medium',()=>.5);g.contract='AT';g.declarer=0;
 g.tricks=[{winner:0,plays:[{player:0,card:'C-J'}]},{winner:1,plays:[]}];
 g.announcements=[four('Q',0),four('K',1)];
 assert.equal(view(g).higherFourWins,true);assert.equal(calculateResult(g).outcome,'failed');
 assert.deepEqual(calculateResult(g).declarationPoints,[0,100]);
 g.higherFourWins=false;assert.deepEqual(calculateResult(g).declarationPoints,[100,100]);
 assert.equal(calculateResult(g).outcome,'made');assert.deepEqual(scorePosition(g,g.tricks,0),resultUtility(calculateResult(g),0));
 delete g.higherFourWins;assert.equal(hydrateGame(g).higherFourWins,true);
});

test('existing SQLite settings migrate enabled; preference persists independently and updates active games',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'belot-fours-')),dbPath=join(dir,'game.sqlite');
 const db=new DatabaseSync(dbPath);db.exec("CREATE TABLE settings(session TEXT PRIMARY KEY,speed TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);INSERT INTO settings VALUES('legacy','slow',3)");db.close();
 const store=new Store(dbPath);assert.equal(store.settings('legacy').higherFourWins,true);assert.equal(store.settings('legacy').speed,'slow');store.close();
 let app=await createApp({dbPath,botDelay:60000});
 try{
  const first=await app.inject({url:'/api/state'}),cookies={belot:first.cookies[0].value};
  assert.equal(first.json().settings.higherFourWins,true);
  const setting=(payload:object)=>app.inject({method:'POST',url:'/api/settings',cookies,payload});
  let r=await setting({higherFourWins:false,requestId:'disable-fours'});assert.equal(r.statusCode,200);
  r=await app.inject({method:'POST',url:'/api/games',cookies,payload:{difficulty:'medium',requestId:'four-rule-game'}});
  assert.equal(r.json().game.higherFourWins,false);const revision=r.json().game.revision;
  r=await setting({higherFourWins:true,requestId:'enable-fours'});assert.equal(r.json().game.revision,revision+1);assert.equal(r.json().game.higherFourWins,true);
  await setting({higherFourWins:false,requestId:'disable-again'});
  r=await setting({allowContraEscape:true,multiplyAnnouncements:true,requestId:'other-options'});assert.equal(r.json().settings.higherFourWins,false);
  r=await setting({higherFourWins:true,requestId:'disable-again'});assert.equal(r.json().settings.higherFourWins,false);
  assert.equal((await setting({higherFourWins:'yes',requestId:'invalid-four'})).statusCode,400);
  await app.close();app=await createApp({dbPath,botDelay:60000});r=await app.inject({url:'/api/state',cookies});
  assert.equal(r.json().settings.higherFourWins,false);assert.equal(r.json().game.higherFourWins,false);
 }finally{await app.close();rmSync(dir,{recursive:true});}
});
