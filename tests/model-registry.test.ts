import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ENCODING_VERSION, INPUT_SIZE, OBSERVATION_SIZE, ACTION_SIZE } from '../src/game/learning.js';
import { newGame, view } from '../src/game/engine.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/storage.js';
import { referenceFingerprint } from '../src/server/bot-reference.js';
import { modelDigest, workerAction, type EvaluationReport, type ModelApproval } from '../src/server/learned-bot.js';
import { activateModel, activeModels, modelForNewMatch, modelPath, registerModel, rollbackModel } from '../src/server/model-registry.js';

function qualified(path: string, variant: number, champion?: string) {
  const model = {formatVersion:1,encodingVersion:ENCODING_VERSION,observationSize:OBSERVATION_SIZE,actionSize:ACTION_SIZE,hiddenSizes:[128,128],
    layers:[INPUT_SIZE,128,128].map((n,i)=>({weight:Array.from({length:i===2?1:128},()=>Array(n).fill(0)),bias:Array(i===2?1:128).fill(i===2?variant:0)}))};
  if(variant){
    model.layers[0].weight[0][OBSERVATION_SIZE+38]=1; // AT candidate feature.
    model.layers[1].weight[0][0]=1;model.layers[2].weight[0][0]=1;
  }
  const bytes=JSON.stringify(model),id=modelDigest(bytes);
  const report=(partner:'hard'|'medium'):EvaluationReport=>({version:1,modelSha256:id,referenceFingerprint:referenceFingerprint(),
    split:'final',namespace:'final-v1:'+('a'.repeat(32)),partner,seedsRequested:partner==='hard'?1000:200,
    completedSeeds:partner==='hard'?1000:200,games:partner==='hard'?4000:800,complete:true,
    confidence:{mean:.6,lower:.55,upper:.65},latency:{count:100,p95Ms:10}});
  const approval:ModelApproval={version:1,modelSha256:id,primary:report('hard'),crossplay:report('medium')};
  if(champion)approval.champion={...report('hard'),opponentSha256:champion};
  writeFileSync(path,bytes);writeFileSync(`${path}.approval.json`,JSON.stringify(approval));
  return {id,approval};
}

test('activation requires proof against current champion; registry versions cannot be overwritten',()=>{
  const dir=mkdtempSync(join(tmpdir(),'belot-registry-')),registry=join(dir,'registry');
  try{
    const a=join(dir,'a.json'),b=join(dir,'b.json'),first=qualified(a,0);
    assert.equal(modelForNewMatch(registry,''),null);
    assert.equal(activateModel(a,registry).current,first.id);
    assert.equal(modelForNewMatch(registry,''),first.id);
    const second=qualified(b,1);
    assert.throws(()=>activateModel(b,registry),/current active/);
    assert.equal(activeModels(registry).current,first.id);
    qualified(b,1,first.id);
    assert.deepEqual(activateModel(b,registry),{version:1,current:second.id,previous:first.id,revision:2});
    const original=readFileSync(modelPath(first.id,registry),'utf8');
    writeFileSync(a,'changed source');
    assert.equal(readFileSync(modelPath(first.id,registry),'utf8'),original);
    const frozen=readFileSync(`${modelPath(second.id,registry)}.approval.json`,'utf8');
    const changed=JSON.parse(frozen);changed.primary.latency.p95Ms=11;
    writeFileSync(`${b}.approval.json`,JSON.stringify(changed));
    assert.throws(()=>registerModel(b,registry),/Immutable/);
    assert.equal(readFileSync(`${modelPath(second.id,registry)}.approval.json`,'utf8'),frozen);
    assert.equal(rollbackModel(registry).current,first.id);
    assert.equal(rollbackModel(registry).current,second.id);
    assert.throws(()=>modelPath('../outside',registry));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('rollback returns to original hard policy; invalid and concurrent activations preserve the manifest',()=>{
  const dir=mkdtempSync(join(tmpdir(),'belot-rollback-')),registry=join(dir,'registry'),a=join(dir,'a.json');
  try{
    const first=qualified(a,0);
    assert.throws(()=>rollbackModel(registry));
    activateModel(a,registry);
    writeFileSync(join(registry,'activation.lock'),String(process.pid));
    assert.throws(()=>activateModel(a,registry),/Another activation/);
    unlinkSync(join(registry,'activation.lock'));
    const before=activeModels(registry);
    unlinkSync(`${a}.approval.json`);
    assert.throws(()=>activateModel(a,registry));
    assert.deepEqual(activeModels(registry),before);
    assert.equal(rollbackModel(registry).current,null);
    // Explicit baseline selection must also override the legacy environment setting.
    assert.equal(modelForNewMatch(registry,modelPath(first.id,registry)),null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('pinned model ids survive activation and server restarts without entering public views',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'belot-pin-')),registry=join(dir,'registry'),dbPath=join(dir,'games.sqlite');
  const a=join(dir,'a.json'),b=join(dir,'b.json'),first=qualified(a,0),second=qualified(b,1,first.id);
  activateModel(a,registry);
  let app=await createApp({dbPath,modelRegistryDir:registry,botDelay:60000});
  try{
    const initial=await app.inject({method:'POST',url:'/api/games',payload:{difficulty:'hard',requestId:'pinned-game-1'}});
    const cookies={belot:initial.cookies[0].value};
    assert.ok(!('botModelId' in initial.json().game));
    let store=new Store(dbPath);const pinned=store.load(cookies.belot)!;store.close();
    assert.equal(pinned.botModelId,first.id);
    activateModel(b,registry);
    await app.close();app=await createApp({dbPath,modelRegistryDir:registry,botDelay:60000});
    const restored=await app.inject({method:'GET',url:'/api/state',cookies});
    assert.deepEqual(restored.json().game,initial.json().game);
    store=new Store(dbPath);assert.equal(store.load(cookies.belot)!.botModelId,first.id);store.close();
    const replay=await app.inject({method:'POST',url:'/api/games',cookies,payload:{difficulty:'hard',requestId:'pinned-game-1'}});
    assert.equal(replay.json().game.id,pinned.id);
    const fresh=await app.inject({method:'POST',url:'/api/games',payload:{difficulty:'hard',requestId:'pinned-game-2'}});
    store=new Store(dbPath);assert.equal(store.load(fresh.cookies[0].value)!.botModelId,second.id);store.close();
    assert.equal(modelForNewMatch(registry,''),second.id);
    // The old match still resolves the original immutable weights.
    assert.ok(modelPath(pinned.botModelId!,registry).includes(first.id));
    const strong=view(pinned,0);strong.hand=['H-J','H-9','H-A','H-10','H-K'];
    assert.deepEqual(workerAction(strong,modelPath(first.id,registry),first.id),{type:'bid',bid:'pass'});
    assert.deepEqual(workerAction(strong,modelPath(second.id,registry),second.id),{type:'bid',bid:'AT'});
    assert.deepEqual(workerAction(strong,modelPath(second.id,registry),first.id),{type:'bid',bid:'H'}); // Digest mismatch uses the actual hard policy.
    assert.deepEqual(workerAction(strong,null),{type:'bid',bid:'H'});
    const medium=await app.inject({method:'POST',url:'/api/games',payload:{difficulty:'medium',requestId:'pinned-game-3'}});
    store=new Store(dbPath);assert.equal(store.load(medium.cookies[0].value)!.botModelId,null);store.close();
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('old stored matches stay on baseline without changes to cards or revisions',()=>{
  const store=new Store(':memory:');
  try{
    const g=newGame('hard');delete g.botModelId;
    store.save('old',g);
    const restored=store.load('old')!;
    assert.equal(restored.botModelId,null);
    assert.deepEqual(restored.hands,g.hands);
    assert.equal(restored.revision,g.revision);
    assert.ok(!('botModelId' in view(restored,0)));
  }finally{store.close();}
});
