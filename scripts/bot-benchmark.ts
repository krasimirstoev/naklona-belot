// Възпроизводими сдвоени раздавания. Няма достъп до production партии или модели.
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {referenceFingerprint} from '../src/server/bot-reference.js';
import {basicAction,decideHardCard,selectDeclarations} from '../src/game/bots.js';
import {basicAction as beforeAction,decideHardCard as beforeHard} from '../benchmarks/baseline/bots.js';
import {decideCard,decideTacticalCard,type BotDecision} from '../src/game/bot-tactics.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {applyAction,newGame,points,team,view} from '../src/game/engine.js';
import {CONTRACTS,type Action,type Card,type View} from '../src/game/types.js';

type Policy='medium'|'medium-before'|'hard'|'hard-before'|'tactics'|'hard-contract'|'hard-points'|'hard-tactics'|'hard-supported';
const args=process.argv.slice(2);
function option(name:string,fallback:string){const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];}
const seedCount=Number(option('seeds',/^\d+$/.test(args[0]??'')?args[0]:'32'));
const seedStart=Number(option('seed-start','1')), batches=Number(option('batches','4'));
const budget=Number(option('budget-ms',args.includes('--timed')?'220':'10000'));
const a=option('a','medium') as Policy,b=option('b','medium-before') as Policy;
const policies:Policy[]=['medium','medium-before','hard','hard-before','tactics','hard-contract','hard-points','hard-tactics','hard-supported'];
if(!policies.includes(a)||!policies.includes(b)||![seedCount,seedStart,batches,budget].every(n=>Number.isInteger(n)&&n>0))throw Error('Невалидни политики, семена или бюджет.');
const contracts=option('contracts',CONTRACTS.join(',')).split(',') as (typeof CONTRACTS)[number][];
if(contracts.some(c=>!CONTRACTS.includes(c)))throw Error('Невалиден договор.');
function seeded(seed:number){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
const latency:number[][]=[[],[]], completed:number[][]=[[],[]], searchCalls=[0,0], fallback=[0,0], aborted=[0,0];
function choose(policy:Policy,v:View,rng:()=>number,idx:number):Action {
  const start=performance.now();let result:Action;
  if(policy==='medium-before')result=beforeAction({...v,difficulty:'medium'},rng);
  else {
    const d:BotDecision=policy==='hard-before'&&v.legalCards.length>1?beforeHard(v,budget,rng,batches):
      policy.startsWith('hard')&&v.legalCards.length>1?decideHardCard(v,budget,rng,batches,{objective:policy==='hard-contract'?'contract':policy==='hard-points'?'points':'game-score',rollout:policy==='hard-tactics'?'tactical':'strategy',selection:policy==='hard-supported'?'supported':'mean'}):
      policy==='tactics'?decideTacticalCard(v,v.legalCards):decideCard(v,v.legalCards);
    if(policy.startsWith('hard')&&v.legalCards.length>1){
      searchCalls[idx]++;const search='search' in d?d.search:undefined;
      const usedFallback=search?.fallback??d.reasons.some(r=>r.id==='search.fallback');
      if(usedFallback)fallback[idx]++;
      const count=search?.completedBatches??Number(d.reasons.find(r=>r.id==='search.sampled-points')?.facts[0].match(/^\d+/)?.[0]??0);
      completed[idx].push(count);aborted[idx]+=search?.abortedBatches??0;
    }
    result={type:'play',card:d.card,declare:selectDeclarations(v.declarations),belot:v.belotCards.includes(d.card)};
  }
  latency[idx].push(performance.now()-start);return result;
}
interface Bucket {contract:string;rounds:number;wins:number;ties:number;declaringRounds:number;contractsMade:number;defendingRounds:number;contractsDefeated:number;gamePointDifference:number;cardPointDifference:number;capotsFor:number;capotsAgainst:number;lostHighCards:number[];unbeatenCardsCollected:number[]}
const results:Bucket[]=contracts.map(contract=>({contract,rounds:0,wins:0,ties:0,declaringRounds:0,contractsMade:0,defendingRounds:0,contractsDefeated:0,gamePointDifference:0,cardPointDifference:0,capotsFor:0,capotsAgainst:0,lostHighCards:[0,0],unbeatenCardsCollected:[0,0]}));
const groups:number[]=[];
for(let seed=seedStart;seed<seedStart+seedCount;seed++) {
  let seedWins=0,seedRounds=0;
  for(const result of results)for(const policyTeam of [0,1]) {
    const rng=seeded(seed),g=newGame('medium',rng),declarer=seed%4;
    for(let p=0;p<declarer;p++)applyAction(g,g.turn,{type:'bid',bid:'pass'});
    applyAction(g,g.turn,{type:'bid',bid:result.contract as View['contract'] & string});
    for(let p=0;p<3;p++)applyAction(g,g.turn,{type:'bid',bid:'pass'});
    const botRng=[seeded(seed*31+1),seeded(seed*31+2)];
    let pending:{card:Card;idx:number;master:boolean}[]=[];
    while(g.phase==='playing'||g.phase==='trick') {
      if(g.phase==='trick'){
        applyAction(g,-1,{type:'collect'});const won=team(g.tricks.at(-1)!.winner);
        for(const p of pending){
          const pt=p.idx===0?policyTeam:1-policyTeam;
          if(pt!==won&&points(p.card,g.contract!)>=10)result.lostHighCards[p.idx]++;
          if(pt===won&&p.master)result.unbeatenCardsCollected[p.idx]++;
        }
        pending=[];
      }else{
        const v=view(g,g.turn),idx=team(g.turn)===policyTeam?0:1;
        const action=choose(idx===0?a:b,v,botRng[idx],idx);
        if(action.type==='play')pending.push({card:action.card,idx,master:buildKnowledge(v).masters.includes(action.card)});
        applyAction(g,g.turn,action,rng);
      }
    }
    const r=g.results[0],declaring=team(r.declarer),own=declaring===policyTeam;
    const won=r.outcome==='hanging'?null:r.outcome==='made'?declaring:1-declaring;
    result.rounds++;seedRounds++;
    if(won===null){result.ties++;seedWins+=.5;}else if(won===policyTeam){result.wins++;seedWins++;}
    if(own){result.declaringRounds++;if(r.outcome==='made')result.contractsMade++;}
    else {result.defendingRounds++;if(r.outcome==='failed')result.contractsDefeated++;}
    result.gamePointDifference+=r.added[policyTeam]-r.added[1-policyTeam];
    result.cardPointDifference+=r.cardPoints[policyTeam]-r.cardPoints[1-policyTeam];
    if(r.capot){if(r.cardPoints[policyTeam]>0)result.capotsFor++;else result.capotsAgainst++;}
  }
  groups.push(seedWins/seedRounds);
}
const average=groups.reduce((n,x)=>n+x,0)/groups.length,bootstrap:number[]=[],random=seeded(71173);
for(let i=0;i<2000;i++){let sum=0;for(let j=0;j<groups.length;j++)sum+=groups[Math.floor(random()*groups.length)];bootstrap.push(sum/groups.length);}
bootstrap.sort((x,y)=>x-y);
const baselineHash=createHash('sha256');
for(const file of ['bots.ts','bot-tactics.ts'])baselineHash.update(readFileSync(new URL(`../benchmarks/baseline/${file}`,import.meta.url)));
const report={referenceFingerprint:referenceFingerprint(),baselineFingerprint:baselineHash.digest('hex'),
  description:'Сдвоени раздавания с разменени отбори; победа е изпълнен наш или провален чужд договор. Това не е оценка на цели мачове или наддаване.',
  a,b,seedCount,seedStart,mode:args.includes('--timed')?'времеви бюджет':'фиксирани сравнителни партиди',batches,budgetMs:budget,
  confidence:{mean:average,lower:bootstrap[50],upper:bootstrap[1950],unit:'семе с всички договори и разменени отбори'},contracts:results,
  computation:[a,b].map((policy,i)=>{const sorted=latency[i].sort((x,y)=>x-y);return {policy,decisions:sorted.length,
    p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),
    searchCalls:searchCalls[i],fallbacks:fallback[i],fallbackRate:searchCalls[i]?fallback[i]/searchCalls[i]:0,
    completedBatchesMean:completed[i].reduce((n,x)=>n+x,0)/Math.max(1,completed[i].length),abortedBatches:policy==='hard-before'?null:aborted[i]};})};
const output=option('output','');
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(args.includes('--json')||!output)console.log(JSON.stringify(report,null,2));
else console.log(`${a} срещу ${b}: ${(average*100).toFixed(1)}% от договорните победи; 95% интервал ${(bootstrap[50]*100).toFixed(1)}–${(bootstrap[1950]*100).toFixed(1)}%; ${seedCount*results.length*2} раздавания. Отчет: ${output}`);
