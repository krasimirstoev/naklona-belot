import { createApp } from '../../src/server/app.js';
const app=await createApp({dbPath:':memory:',botDelay:40});
await app.listen({port:3100,host:'127.0.0.1'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
