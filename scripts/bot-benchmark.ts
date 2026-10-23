// Възпроизводими сдвоени раздавания. Няма достъп до production партии или модели.
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {referenceFingerprint} from '../src/server/bot-reference.js';
import {basicAction as ntBeforeAction,decideHardCard as ntBeforeHard} from '../benchmarks/no-trump-baseline/bots.js';
import {basicAction,decideMediumCard,decideHardCard,selectDeclarations} from '../src/game/bots.js';
import {basicAction as beforeAction,decideHardCard as beforeHard} from '../benchmarks/baseline/bots.js';
import {decideCard,decideTacticalCard,type BotDecision} from '../src/game/bot-tactics.js';
import {secureTeamTrick} from '../src/game/bot-strategy.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {applyAction,newGame,points,rank,suit,team,view} from '../src/game/engine.js';
import {CONTRACTS,type Action,type Card,type View} from '../src/game/types.js';

type Policy='nt-no-endgame'|'nt-no-retention'|'nt-no-tempo'|'hard-nt-no-retention'|'hard-nt-no-tempo'|'medium-nt-before'|'hard-nt-before'|'medium'|'medium-before'|'hard'|'hard-before'|'tactics'|'hard-contract'|'hard-points'|'hard-tactics'|'hard-supported';
const policyFingerprint=referenceFingerprint();
const args=process.argv.slice(2);
function option(name:string,fallback:string){const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];}
const seedCount=Number(option('games',option('seeds',/^\d+$/.test(args[0]??'')?args[0]:'32')));
const split=option('split','development');
if(!['development','validation','heldout'].includes(split))throw Error('Invalid split');
const rotations=Number(option('rotations','1'));
if(![1,4].includes(rotations))throw Error('rotations must be 1 or 4');
const seedStart=Number(option('seed-start',split==='heldout'?'3000001':split==='validation'?'2000001':'1')), batches=Number(option('batches','4'));
const budget=Number(option('budget-ms',args.includes('--timed')?'220':'10000'));
const a=option('a','medium') as Policy,b=option('b','medium-before') as Policy;
const policies:Policy[]=['nt-no-endgame','nt-no-retention','nt-no-tempo','hard-nt-no-retention','hard-nt-no-tempo','medium-nt-before','hard-nt-before','medium','medium-before','hard','hard-before','tactics','hard-contract','hard-points','hard-tactics','hard-supported'];
if(!policies.includes(a)||!policies.includes(b)||![seedCount,seedStart,batches,budget].every(n=>Number.isInteger(n)&&n>0))throw Error('Невалидни политики, семена или бюджет.');
const multiplier=Number(option('multiplier','1')),hanging=Number(option('hanging','0'));
const scores=option('scores','0,0').split(',').map(Number);
if(![1,2,4].includes(multiplier)||!Number.isInteger(hanging)||hanging<0||scores.length!==2||scores.some(x=>!Number.isInteger(x)||x<0))throw Error('Invalid scoring context');
const contracts=option('contract',option('contracts',CONTRACTS.join(','))).split(',') as (typeof CONTRACTS)[number][];
if(contracts.some(c=>!CONTRACTS.includes(c)))throw Error('Невалиден договор.');
function seeded(seed:number){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
const latency:number[][]=[[],[]], completed:number[][]=[[],[]], searchCalls=[0,0], fallback=[0,0], aborted=[0,0];
function choose(policy:Policy,v:View,rng:()=>number,idx:number):Action {
  const start=performance.now();let result:Action;
  const noTrump={retention:!policy.endsWith('no-retention'),tempo:!policy.endsWith('no-tempo')};
  if(policy==='medium-nt-before')result=ntBeforeAction({...v,difficulty:'medium'},rng);
  else if(policy==='medium-before')result=beforeAction({...v,difficulty:'medium'},rng);
  else {
    const d:BotDecision=policy==='hard-nt-before'&&v.legalCards.length>1?ntBeforeHard(v,budget,rng,batches):
      policy==='hard-before'&&v.legalCards.length>1?beforeHard(v,budget,rng,batches):
      policy.startsWith('hard')&&v.legalCards.length>1?decideHardCard(v,budget,rng,batches,{noTrump,objective:policy==='hard-contract'?'contract':policy==='hard-points'?'points':'game-score',rollout:policy==='hard-tactics'?'tactical':'strategy',selection:policy==='hard-supported'?'supported':'mean'}):
      policy==='nt-no-endgame'?decideCard(v,v.legalCards):
      policy==='tactics'?decideTacticalCard(v,v.legalCards):decideMediumCard(v,noTrump);
    if(d.search||policy.startsWith('hard')&&v.legalCards.length>1){
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
interface Bucket {contract:string;rounds:number;wins:number;ties:number;declaringRounds:number;contractsMade:number;defendingRounds:number;contractsDefeated:number;gamePointDifference:number;cardPointDifference:number;capotsFor:number;capotsAgainst:number;lostHighCards:number[];unbeatenCardsCollected:number[];tricksWon:number[];endgamePoints:number[];lostMasters:number[];avoidableTenLosses:number[];longSuitRuns:number[]}
const results:Bucket[]=contracts.map(contract=>({contract,rounds:0,wins:0,ties:0,declaringRounds:0,contractsMade:0,defendingRounds:0,contractsDefeated:0,gamePointDifference:0,cardPointDifference:0,capotsFor:0,capotsAgainst:0,lostHighCards:[0,0],unbeatenCardsCollected:[0,0],tricksWon:[0,0],endgamePoints:[0,0],lostMasters:[0,0],avoidableTenLosses:[0,0],longSuitRuns:[0,0]}));
const groups:number[]=[];
for(let seed=seedStart;seed<seedStart+seedCount;seed++) {
  let seedWins=0,seedRounds=0;
  for(const result of results)for(let rotation=0;rotation<rotations;rotation++)for(const policyTeam of [0,1]) {
    const rng=seeded(seed),g=newGame('medium',rng),declarer=seed%4;
    g.scores=[...scores];g.hanging=hanging;
    for(let p=0;p<declarer;p++)applyAction(g,g.turn,{type:'bid',bid:'pass'});
    applyAction(g,g.turn,{type:'bid',bid:result.contract as View['contract'] & string});
    if(multiplier>=2)applyAction(g,g.turn,{type:'bid',bid:'contra'});
    if(multiplier===4)applyAction(g,g.turn,{type:'bid',bid:'recontra'});
    for(let p=0;p<3;p++)applyAction(g,g.turn,{type:'bid',bid:'pass'});
    if(rotation){
      g.hands=Array.from({length:4},(_,p)=>g.hands[(p-rotation+4)%4]);
      g.dealer=(g.dealer+rotation)%4;g.turn=(g.turn+rotation)%4;g.declarer=(g.declarer!+rotation)%4;
      g.calls=g.calls.map(c=>({...c,player:(c.player+rotation)%4}));
      g.events=g.events.map(e=>({...e,player:(e.player+rotation)%4}));
    }
    const longSuit=Array.from({length:4},(_,p)=>new Set(g.hands[p].filter(c=>g.hands[p].filter(d=>suit(c)===suit(d)).length>=3).map(suit)));
    const runs=new Map<string,number>();
    const botRng=[seeded(seed*31+1),seeded(seed*31+2)];
    let pending:{card:Card;idx:number;master:boolean;safeAlternative:boolean}[]=[];
    while(g.phase==='playing'||g.phase==='trick') {
      if(g.phase==='trick'){
        applyAction(g,-1,{type:'collect'});const won=team(g.tricks.at(-1)!.winner);
        for(const p of pending){
          const pt=p.idx===0?policyTeam:1-policyTeam;
          if(pt!==won&&p.master)result.lostMasters[p.idx]++;
          if(pt!==won&&rank(p.card)==='10'&&p.safeAlternative)result.avoidableTenLosses[p.idx]++;
          if(pt!==won&&points(p.card,g.contract!)>=10)result.lostHighCards[p.idx]++;
          if(pt===won&&p.master)result.unbeatenCardsCollected[p.idx]++;
        }
        const t=g.tricks.at(-1)!,idx=won===policyTeam?0:1;
        result.tricksWon[idx]++;
        if(g.tricks.length>=7)result.endgamePoints[idx]+=t.plays.reduce((n,p)=>n+points(p.card,g.contract!),0)+(g.tricks.length===8?(g.contract==='NT'?20:10):0);
        if(t.winner===t.plays[0].player&&longSuit[t.winner].has(suit(t.plays[0].card))){
          const key=`${t.winner}:${suit(t.plays[0].card)}`,count=(runs.get(key)??0)+1;runs.set(key,count);
          if(count===2)result.longSuitRuns[idx]++;
        }
        pending=[];
      }else{
        const v=view(g,g.turn),idx=team(g.turn)===policyTeam?0:1;
        const action=choose(idx===0?a:b,v,botRng[idx],idx);
        if(action.type==='play')pending.push({card:action.card,idx,master:buildKnowledge(v).masters.includes(action.card),safeAlternative:v.legalCards.some(c=>c!==action.card&&secureTeamTrick(v,buildKnowledge(v),c))});
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
const ntHash=createHash('sha256');
for(const file of ['bots','bot-tactics','bot-strategy','bot-analysis','bot-knowledge','bot-sampling','bot-objective'])ntHash.update(readFileSync(new URL(`../benchmarks/no-trump-baseline/${file}.ts`,import.meta.url)));
const report={split,rotations,scoringContext:{scores,hanging,multiplier},noTrumpBaselineFingerprint:ntHash.digest('hex'),metricDefinitions:{
  longSuitRuns:'Initially 3+ card suit; same player leads and wins it at least twice. Proxy, not causal proof of development.',
  lostMasters:'Public master played into an opponent-won trick; includes forced plays.',
  avoidableTenLosses:'Ten lost despite a different legal move provably securing this trick for our team; local opportunity, not proof of globally inferior play.',
  endgamePoints:'Points captured in tricks 7 and 8 including last-trick bonus; excludes capot.',
  games:'--games/--seeds counts independent deals, each with paired team assignments and optional seat rotations.'
},referenceFingerprint:policyFingerprint,baselineFingerprint:baselineHash.digest('hex'),
  description:'Сдвоени раздавания с разменени отбори; победа е изпълнен наш или провален чужд договор. Това не е оценка на цели мачове или наддаване.',
  a,b,seedCount,seedStart,mode:args.includes('--timed')?'времеви бюджет':'фиксирани сравнителни партиди',batches,budgetMs:budget,
  confidence:{mean:average,lower:bootstrap[50],upper:bootstrap[1950],unit:'семе с всички договори и разменени отбори'},contracts:results.map(r=>({...r,contractSuccessRate:r.contractsMade/Math.max(1,r.declaringRounds),
    contractDefeatRate:r.contractsDefeated/Math.max(1,r.defendingRounds),averageCardPointDifference:r.cardPointDifference/r.rounds,
    averageFinalScoreDifference:r.gamePointDifference/r.rounds,averageTricks:r.tricksWon.map(n=>n/r.rounds)})),
  computation:[a,b].map((policy,i)=>{const sorted=latency[i].sort((x,y)=>x-y);return {policy,decisions:sorted.length,
    p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),
    searchCalls:searchCalls[i],fallbacks:fallback[i],fallbackRate:searchCalls[i]?fallback[i]/searchCalls[i]:0,
    completedBatchesMean:completed[i].reduce((n,x)=>n+x,0)/Math.max(1,completed[i].length),abortedBatches:policy==='hard-before'?null:aborted[i]};})};
const output=option('output','');
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(args.includes('--json')||!output)console.log(JSON.stringify(report,null,2));
else console.log(`${a} срещу ${b}: ${(average*100).toFixed(1)}% от договорните победи; 95% интервал ${(bootstrap[50]*100).toFixed(1)}–${(bootstrap[1950]*100).toFixed(1)}%; ${seedCount*results.length*2*rotations} раздавания. Отчет: ${output}`);
