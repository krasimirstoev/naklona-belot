// Paired full matches with real auctions. No policy tuning or production data.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {basicAction as current} from '../src/game/bots.js';
import {basicAction as previous} from '../benchmarks/no-trump-baseline/bots.js';
import {applyAction,newGame,team,view} from '../src/game/engine.js';
import {referenceFingerprint} from '../src/server/bot-reference.js';
import {CONTRACTS,type Bid} from '../src/game/types.js';

const args=process.argv.slice(2);
function option(name:string,fallback:string){const i=args.indexOf(`--${name}`);return i<0?fallback:args[i+1];}
const seeds=Number(option('seeds','512')),seedStart=Number(option('seed-start','6000001'));
if(![seeds,seedStart].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Invalid seeds');
function seeded(seed:number){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
const fingerprint=referenceFingerprint(),baselineHash=createHash('sha256');
for(const name of ['bots','bot-tactics','bot-strategy','bot-analysis','bot-knowledge','bot-sampling','bot-objective'])
 baselineHash.update(readFileSync(new URL(`../benchmarks/no-trump-baseline/${name}.ts`,import.meta.url)));
const auction=[0,1].map(()=>({decisions:0,passes:0,suitBids:0,noTrumpBids:0,allTrumpBids:0,contras:0,recontras:0}));
const latency:number[][]=[[],[]];
const contracts=CONTRACTS.map(contract=>({contract,rounds:0,currentWins:0,ties:0,currentDeclaring:0,currentMade:0,previousDeclaring:0,previousMade:0,cardPointDifference:0,scoreDifference:0}));
const outcomes:{seed:number;currentTeam:number;currentWon:boolean;rounds:number;allPassDeals:number;scores:number[]}[]=[];
const groups:number[]=[];
let allPassDeals=0;
const rules={allowContraEscape:false,multiplyAnnouncements:false,higherFourWins:true};
const started=performance.now();
for(let seed=seedStart;seed<seedStart+seeds;seed++){
 let pairWins=0;
 for(const currentTeam of [0,1]){
  const dealRng=seeded(seed),policyRng=[seeded(seed*31+1),seeded(seed*31+2)],g=newGame('medium',dealRng,rules);
  // Rotate the initial dealer and five-card holdings together. The stock stays
  // in relative dealing order, so both assignments start with identical cards.
  const rotation=seed%4;
  g.hands=Array.from({length:4},(_,p)=>g.hands[(p-rotation+4)%4]);
  g.dealer=(g.dealer+rotation)%4;g.turn=(g.turn+rotation)%4;
  let actions=0,passed=0;
  while(g.phase!=='matchEnd'){
   if(++actions>100000)throw Error(`Unfinished match at seed ${seed}, team ${currentTeam}`);
   if(g.phase==='trick'){applyAction(g,-1,{type:'collect'});continue;}
   if(g.phase==='roundEnd'){applyAction(g,0,{type:'next'},dealRng);continue;}
   const v=view(g,g.turn),idx=team(g.turn)===currentTeam?0:1,t=performance.now();
   const action=(idx===0?current:previous)(v,policyRng[idx]);
   latency[idx].push(performance.now()-t);
   if(action.type==='bid'){
    const a=auction[idx],bid:Bid=action.bid;a.decisions++;
    if(bid==='pass'){
     a.passes++;
     if(g.contract===null&&g.passes===3){passed++;allPassDeals++;}
    }else if(bid==='NT')a.noTrumpBids++;
    else if(bid==='AT')a.allTrumpBids++;
    else if(bid==='contra')a.contras++;
    else if(bid==='recontra')a.recontras++;
    else a.suitBids++;
   }
   applyAction(g,g.turn,action,dealRng);
  }
  const currentWon=g.scores[currentTeam]>g.scores[1-currentTeam];pairWins+=+currentWon;
  outcomes.push({seed,currentTeam,currentWon,rounds:g.results.length,allPassDeals:passed,scores:[g.scores[currentTeam],g.scores[1-currentTeam]]});
  for(const r of g.results){
   const bucket=contracts.find(b=>b.contract===r.contract)!;
   const declared=team(r.declarer)===currentTeam;bucket.rounds++;
   if(r.outcome==='hanging')bucket.ties++;
   else if((r.outcome==='made')===declared)bucket.currentWins++;
   if(declared){bucket.currentDeclaring++;if(r.outcome==='made')bucket.currentMade++;}
   else {bucket.previousDeclaring++;if(r.outcome==='made')bucket.previousMade++;}
   bucket.cardPointDifference+=r.cardPoints[currentTeam]-r.cardPoints[1-currentTeam];
   bucket.scoreDifference+=r.added[currentTeam]-r.added[1-currentTeam];
  }
 }
 groups.push(pairWins/2);
 if(args.includes('--progress')&&((seed-seedStart+1)%32===0||seed===seedStart+seeds-1))
  console.error(`${seed-seedStart+1}/${seeds} paired seeds; ${((performance.now()-started)/1000).toFixed(0)}s`);
}
const bootstrap:number[]=[],rng=seeded(71173);
for(let i=0;i<4000;i++){let sum=0;for(let j=0;j<groups.length;j++)sum+=groups[Math.floor(rng()*groups.length)];bootstrap.push(sum/groups.length);}
bootstrap.sort((a,b)=>a-b);
const wins=outcomes.filter(x=>x.currentWon).length,rounds=contracts.reduce((n,b)=>n+b.rounds,0);
function median(values:number[]){const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;}
const report={rules,ruleSourcesFingerprint:createHash('sha256').update(readFileSync(new URL('../src/game/engine.ts',import.meta.url))).update(readFileSync(new URL('../src/game/declaration-resolution.ts',import.meta.url))).digest('hex'),description:'Current Medium against frozen pre-NT Medium; complete matches through the engine matchEnd rule, real bidding, paired identical RNG streams and swapped teams. Initial dealer cycles across seeds.',
 referenceFingerprint:fingerprint,noTrumpBaselineFingerprint:baselineHash.digest('hex'),
 benchmarkFingerprint:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
 seedStart,seedCount:seeds,matches:outcomes.length,currentWins:wins,previousWins:outcomes.length-wins,
 confidence:{mean:wins/outcomes.length,lower:bootstrap[100],upper:bootstrap[3900],unit:'independent seed with both team assignments; 95% percentile bootstrap'},
 completedRounds:rounds,allPassDeals,averageRoundsPerMatch:rounds/outcomes.length,
 medianFinalScoreDifference:median(outcomes.map(x=>x.scores[0]-x.scores[1])),
 medianRoundsPerMatch:median(outcomes.map(x=>x.rounds)),
 medianFinalScores:[median(outcomes.map(x=>x.scores[0])),median(outcomes.map(x=>x.scores[1]))],
 averageFinalScoreDifference:outcomes.reduce((n,x)=>n+x.scores[0]-x.scores[1],0)/outcomes.length,
 roundOutcomeScore:(contracts.reduce((n,b)=>n+b.currentWins+b.ties*.5,0))/rounds,
 contracts,auction,computation:latency.map((values,i)=>{values.sort((a,b)=>a-b);return {policy:i===0?'current-medium':'medium-nt-before',decisions:values.length,p95Ms:values[Math.floor(values.length*.95)],maxMs:values.at(-1)};}),
 elapsedSeconds:(performance.now()-started)/1000,outcomes};
const output=option('output','');
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(!output||args.includes('--json'))console.log(JSON.stringify(report,null,2));
else console.log(`Medium: ${wins}/${outcomes.length} matches (${(report.confidence.mean*100).toFixed(1)}%), 95% CI ${(report.confidence.lower*100).toFixed(1)}–${(report.confidence.upper*100).toFixed(1)}%; ${rounds} rounds. ${output}`);
