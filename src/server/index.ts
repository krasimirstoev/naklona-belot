import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
const port=Number(process.env.PORT??3000),host=process.env.HOST??'0.0.0.0';
const app=await createApp({dev:process.argv.includes('--dev'),logger:true});
await app.listen({port,host});
console.log(`\n  НАКЛОНА · http://localhost:${port}`);
if(host==='0.0.0.0'||host==='::')for(const entries of Object.values(networkInterfaces()))for(const address of entries??[])if(address.family==='IPv4'&&!address.internal)console.log(`  Телефон в същата мрежа: http://${address.address}:${port}`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
