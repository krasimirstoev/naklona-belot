import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/storage.js';
import { createApp } from '../src/server/app.js';
import { newGame, applyAction } from '../src/game/engine.js';

test('SQLite round-trip preserves the exact pending turn and revision',()=>{
  const dir=mkdtempSync(join(tmpdir(),'belot-'));const path=join(dir,'test.sqlite');
  let store=new Store(path);const g=newGame('hard');applyAction(g,0,{type:'bid',bid:'S'});store.save('session',g);store.close();
  store=new Store(path);assert.deepEqual(store.load('session'),g);store.close();rmSync(dir,{recursive:true});
});
test('API validates actions, hides hands, rejects stale requests and is idempotent',async()=>{
  const app=await createApp({dbPath:':memory:',botDelay:60000});
  try {
    let r=await app.inject({method:'GET',url:'/api/state'});assert.equal(r.statusCode,200);assert.equal(r.json().game,null);
    const cookie=r.cookies[0];assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Strict');const cookies={belot:cookie.value};
    r=await app.inject({method:'POST',url:'/api/games',cookies,payload:{difficulty:'medium',requestId:'new-game-123'}});assert.equal(r.statusCode,200);let g=r.json().game;
    assert.ok(!('hands'in g));assert.ok(!('stock'in g));
    const payload={gameId:g.id,revision:g.revision,requestId:'action-123',action:{type:'bid',bid:'S'}};
    r=await app.inject({method:'POST',url:'/api/action',cookies,payload});assert.equal(r.statusCode,200);g=r.json().game;
    r=await app.inject({method:'POST',url:'/api/action',cookies,payload});assert.equal(r.statusCode,200);assert.equal(r.json().game.revision,g.revision);
    r=await app.inject({method:'POST',url:'/api/action',cookies,payload:{...payload,requestId:'action-other'}});assert.equal(r.statusCode,409);
    r=await app.inject({method:'POST',url:'/api/action',cookies,payload:{...payload,revision:g.revision,action:{type:'collect'}}});assert.equal(r.statusCode,400);
    r=await app.inject({method:'POST',url:'/api/games',cookies,payload:{difficulty:'impossible',requestId:'new-game-456'}});assert.equal(r.statusCode,400);
    r=await app.inject({method:'POST',url:'/api/games',cookies,headers:{origin:'https://other.example'},payload:{difficulty:'easy',requestId:'new-game-789'}});assert.equal(r.statusCode,403);
    r=await app.inject({method:'GET',url:'/api/state'});assert.equal(r.json().game,null);
  }finally{await app.close();}
});
test('saved match and idempotency receipt survive a server restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'belot-api-')),dbPath=join(dir,'game.sqlite');
  let app=await createApp({dbPath,botDelay:60000});
  try{
    let r=await app.inject({method:'POST',url:'/api/games',payload:{difficulty:'hard',requestId:'restart-123'}});
    const cookies={belot:r.cookies[0].value},g=r.json().game;
    const payload={gameId:g.id,revision:g.revision,requestId:'restart-action-123',action:{type:'bid',bid:'H'}};
    r=await app.inject({method:'POST',url:'/api/action',cookies,payload});const expected=r.json().game;
    await app.close();app=await createApp({dbPath,botDelay:60000});
    r=await app.inject({method:'GET',url:'/api/state',cookies});assert.deepEqual(r.json().game,expected);
    r=await app.inject({method:'POST',url:'/api/action',cookies,payload});assert.equal(r.statusCode,200);assert.equal(r.json().game.revision,expected.revision);
  }finally{await app.close();rmSync(dir,{recursive:true});}
});
