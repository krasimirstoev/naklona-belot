import {test} from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { applyAction,newGame,view } from '../src/game/engine.js';
import type {Action} from '../src/game/types.js';

test('development worker runs hard bot with public-only input',async()=>{
  const g=newGame('hard');applyAction(g,0,{type:'bid',bid:'AT'});for(const p of [1,2,3])applyAction(g,p,{type:'bid',bid:'pass'});
  const v=view(g,0);
  const action=await new Promise<Action>((resolve,reject)=>{
    const worker=new Worker(`const { workerData,parentPort }=require('node:worker_threads');import('tsx/esm/api').then(async({tsImport})=>{const {hardAction}=await tsImport(${JSON.stringify(new URL('../src/game/bots.ts',import.meta.url).href)},${JSON.stringify(import.meta.url)});parentPort.postMessage(hardAction(workerData));});`,{eval:true,workerData:v});
    const timeout=setTimeout(()=>{void worker.terminate();reject(new Error('worker timed out'));},5000);
    worker.once('message',a=>{clearTimeout(timeout);void worker.terminate();resolve(a);});worker.once('error',e=>{clearTimeout(timeout);reject(e);});
  });
  assert.equal(action.type,'play');if(action.type==='play')assert.ok(v.legalCards.includes(action.card));
  assert.ok(!('hands'in v));assert.ok(!('stock'in v));
});
