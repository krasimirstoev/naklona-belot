import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { applyAction, newGame, view } from '../game/engine.js';
import { basicAction } from '../game/bots.js';
import type { Action, Difficulty, Game, View } from '../game/types.js';
import { Store } from './storage.js';
import { TurnScheduler, type TimerClock } from './scheduler.js';
import { turnDelay } from '../game/tempo.js';
import type { Settings } from '../game/types.js';

export async function createApp(options: {dev?:boolean; dbPath?:string; botDelay?:number; logger?:boolean; clock?:TimerClock; chooseBot?:(v:View)=>Promise<Action>|Action}={}) {
  const app=Fastify({logger:options.logger??false,bodyLimit:8192,ajv:{customOptions:{removeAdditional:false}}});
  if(!options.dbPath) mkdirSync('data',{recursive:true});
  const store=new Store(options.dbPath??resolve('data/belot.sqlite'));
  const games=new Map<string,Game>();const streams=new Map<string,Set<ServerResponse>>();
  const workers=new Set<Worker>();let closing=false;
  await app.register(cookie);
  app.addHook('onRequest',async(req,reply)=>{
    if(req.url.startsWith('/api/') && req.method!=='GET' && req.headers.origin) {
      let allowed=false;try { allowed=new URL(req.headers.origin).host===req.headers.host; } catch { /* invalid origin */ }
      if(!allowed) return reply.code(403).send({error:'Заявката трябва да идва от играта.'});
    }
    if(req.url.startsWith('/api/') && !/^[a-f0-9-]{36}$/.test(req.cookies.belot??'')) {
      const id=randomUUID();req.cookies.belot=id;
      reply.setCookie('belot',id,{path:'/',httpOnly:true,sameSite:'strict',secure:req.protocol==='https',maxAge:60*60*24*365});
    }
    if(req.url.startsWith('/api/')) reply.header('Cache-Control','no-store');
  });
  const get=(session:string)=>{
    if(!games.has(session)) {const g=store.load(session);if(g) games.set(session,g);}
    return games.get(session)??null;
  };
  const response=(session:string)=>{const g=get(session);return {game:g?view(g):null,settings:store.settings(session)};};
  const broadcast=(session:string)=>{
    const payload=`data: ${JSON.stringify(response(session))}\n\n`;
    for(const stream of streams.get(session)??[])if(!stream.destroyed)stream.write(payload);
  };
  const publish=(session:string,g:Game,requestId?:string)=>{
    store.save(session,g,requestId);
    broadcast(session);
  };
  async function choose(v: View): Promise<Action> {
    if(options.chooseBot)return options.chooseBot(v);
    if(v.difficulty!=='hard') return basicAction(v);
    const ext=import.meta.url.endsWith('.ts')?'ts':'js';
    return new Promise(resolveAction=>{
      // tsx's programmatic loader also supports worker entry points in development.
      const worker=ext==='ts'
        ? new Worker(`const { workerData, parentPort } = require('node:worker_threads'); import('tsx/esm/api').then(async ({ tsImport }) => { const { hardAction } = await tsImport(${JSON.stringify(new URL('../game/bots.ts',import.meta.url).href)}, ${JSON.stringify(import.meta.url)}); parentPort.postMessage(hardAction(workerData)); });`,{eval:true,workerData:v})
        : new Worker(new URL('./bot-worker.js',import.meta.url),{workerData:v});
      workers.add(worker);let done=false;
      const finish=(action:Action)=>{if(done)return;done=true;clearTimeout(timeout);workers.delete(worker);void worker.terminate();resolveAction(action);};
      const timeout=setTimeout(()=>finish(basicAction(v)),2500);
      worker.once('message',(a:Action)=>finish(a));
      worker.once('error',(error)=>{app.log.error(error,'Bot worker failed');finish(basicAction(v));});
      worker.once('exit',()=>{if(!done)finish(basicAction(v));});
    });
  }
  const scheduler=new TurnScheduler(session=>schedule(session),options.clock);
  const delay=(session:string,g:Game)=>options.botDelay??turnDelay(g,store.settings(session).speed);
  const schedule=(session:string)=>{
    if(closing)return;
    const g=get(session);if(!g || ['roundEnd','matchEnd'].includes(g.phase) || (g.turn===0 && g.phase!=='trick'))return;
    const revision=g.revision;
    scheduler.schedule(session,delay(session,g),async()=>{
      try {
        if(get(session)!==g || g.revision!==revision)return;
        const player=g.phase==='trick'?-1:g.turn;
        const action:Action=g.phase==='trick'?{type:'collect'}:await choose(view(g,g.turn));
        if(closing || get(session)!==g || g.revision!==revision)return;
        applyAction(g,player,action);publish(session,g);
      }catch(error){app.log.error(error,'Bot action failed');}
    });
  };
  app.get('/api/state',async(req)=>{
    const session=req.cookies.belot!;schedule(session);return response(session);
  });
  app.post<{Body:{speed:Settings['speed'];requestId:string}}>('/api/settings',{
    schema:{body:{type:'object',additionalProperties:false,required:['speed','requestId'],properties:{speed:{enum:['slow','normal','fast']},requestId:{type:'string',minLength:8,maxLength:100}}}}
  },async(req)=>{
    const session=req.cookies.belot!;
    if(!store.hasRequest(session,req.body.requestId)) {
      store.saveSettings(session,{speed:req.body.speed},req.body.requestId);
      const g=get(session);if(g)scheduler.retime(session,delay(session,g));
      broadcast(session);schedule(session);
    }
    return response(session);
  });
  app.post<{Body:{difficulty:Difficulty;requestId:string}}>('/api/games',{
    schema:{body:{type:'object',additionalProperties:false,required:['difficulty','requestId'],properties:{difficulty:{type:'string',enum:['easy','medium','hard']},requestId:{type:'string',minLength:8,maxLength:100}}}}
  },async(req)=>{
    const session=req.cookies.belot!,id=req.body.requestId;
    if(store.hasRequest(session,id)) return response(session);
    scheduler.cancel(session);
    const g=newGame(req.body.difficulty);games.set(session,g);publish(session,g,id);schedule(session);
    return response(session);
  });
  app.post<{Body:{gameId:string;revision:number;requestId:string;action:Action}}>('/api/action',{
    schema:{body:{type:'object',additionalProperties:false,required:['gameId','revision','requestId','action'],properties:{gameId:{type:'string',maxLength:100},revision:{type:'integer',minimum:0},requestId:{type:'string',minLength:8,maxLength:100},action:{oneOf:[
      {type:'object',additionalProperties:false,required:['type','bid'],properties:{type:{const:'bid'},bid:{enum:['pass','C','D','H','S','NT','AT','contra','recontra']}}},
      {type:'object',additionalProperties:false,required:['type','card'],properties:{type:{const:'play'},card:{type:'string',pattern:'^[CDHS]-(7|8|9|10|J|Q|K|A)$'},declare:{type:'array',maxItems:8,items:{type:'string',maxLength:50}},belot:{type:'boolean'}}},
      {type:'object',additionalProperties:false,required:['type'],properties:{type:{const:'next'}}}
    ]}}}}
  },async(req,reply)=>{
    const session=req.cookies.belot!,g=get(session),b=req.body;
    if(!g) return reply.code(404).send({error:'Започни нова игра.'});
    if(store.hasRequest(session,b.requestId)) return response(session);
    if(b.gameId!==g.id || b.revision!==g.revision) return reply.code(409).send({error:'Масата е обновена. Опитай отново.',...response(session)});
    // Work on a copy so rejected actions can never partly change the saved game.
    const updated=structuredClone(g);
    try {applyAction(updated,0,b.action);} catch(error) {return reply.code(400).send({error:(error as Error).message});}
    games.set(session,updated);publish(session,updated,b.requestId);schedule(session);
    return response(session);
  });
  app.get('/api/events',async(req,reply)=>{
    const session=req.cookies.belot!;reply.hijack();
    // Hijacked responses need the cookie/header values prepared by onRequest.
    for(const [key,value] of Object.entries(reply.getHeaders())) if(value!==undefined)reply.raw.setHeader(key,value);
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const set=streams.get(session)??new Set<ServerResponse>();set.add(reply.raw);streams.set(session,set);
    reply.raw.write(`data: ${JSON.stringify(response(session))}\n\n`);schedule(session);
    const heartbeat=setInterval(()=>reply.raw.write(': heartbeat\n\n'),20000);
    req.raw.on('close',()=>{clearInterval(heartbeat);set.delete(reply.raw);if(!set.size)streams.delete(session);});
  });
  if(options.dev) {
    const {createServer}=await import('vite');
    const vite=await createServer({server:{middlewareMode:true,hmr:{server:app.server}},appType:'spa'});
    app.setNotFoundHandler((req,reply)=>{
      if(req.url.startsWith('/api/'))return reply.code(404).send({error:'Непознат адрес.'});
      reply.hijack();vite.middlewares(req.raw,reply.raw,()=>{reply.raw.statusCode=404;reply.raw.end('Not found');});
    });
    app.addHook('onClose',async()=>{await vite.close();});
  } else {
    await app.register(fastifyStatic,{root:resolve('dist/client'),wildcard:false});
    app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'Непознат адрес.'}):reply.sendFile('index.html'));
  }
  app.addHook('preClose',async()=>{
    closing=true;scheduler.close();
    for(const set of streams.values())for(const s of set)s.end();
    await Promise.all([...workers].map(w=>w.terminate()));
  });
  app.addHook('onClose',async()=>{store.close();});
  return app;
}
