// Избира реално достигнати позиции; запазените предпочитания се преглеждат като отделни тестове.
import {writeFileSync} from 'node:fs';
import {applyAction,newGame,view,points,suit,team} from '../src/game/engine.js';
import {selectDeclarations,basicAction} from '../src/game/bots.js';
import {decideCard} from '../src/game/bot-tactics.js';
import {decideCard as before} from '../benchmarks/baseline/bot-tactics.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {secureTeamTrick,tenGuardDiscard} from '../src/game/bot-strategy.js';
import {CONTRACTS,type Action} from '../src/game/types.js';
const cases:any[]=[];
const themes=['feed-preserve-winner','feed-before-last','unsafe-partner','protect-ten','ten-no-guard-needed','develop-entry','develop-no-entry','develop-insufficient-entries','draw-control','preserve-draw-conflict'];
for(let seed=1;seed<=3000&&cases.length<themes.length*2;seed++) for(const contract of CONTRACTS){
 let state=seed;const rng=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 const g=newGame('medium',rng),bids:Action[]=[{type:'bid',bid:contract},...Array.from({length:3},()=>({type:'bid',bid:'pass'}as Action))];
 for(const a of bids)applyAction(g,g.turn,a);
 const hands=structuredClone(g.hands),history:Action[]=[];
 while(g.phase==='playing'||g.phase==='trick'){
  if(g.phase==='trick'){applyAction(g,-1,{type:'collect'});continue;}
  const v=view(g,g.turn),k=buildKnowledge(v),d=decideCard(v),old=before(v),plan=d.strategy!;
  if(v.legalCards.length>=2)for(const theme of themes){
   if(cases.filter(c=>c.topic===theme).length>=2||cases.some(c=>c.sourceSeed===seed&&c.contract===contract))continue;
   let matches=false;
   if(theme==='feed-preserve-winner')matches=plan.plan==='SUPPORT_PARTNER'&&v.trick.length===3&&k.masters.includes(old.card)&&!k.masters.includes(d.card)&&points(d.card,contract)>=10;
   if(theme==='feed-before-last')matches=plan.plan==='SUPPORT_PARTNER'&&v.trick.length<3&&secureTeamTrick(v,k,d.card)&&points(d.card,contract)>points(old.card,contract);
   if(theme==='unsafe-partner')matches=plan.plan==='SUPPORT_PARTNER'&&!v.legalCards.some(c=>secureTeamTrick(v,k,c))&&v.legalCards.some(c=>points(c,contract)>=10)&&points(d.card,contract)===0;
   if(theme==='protect-ten')matches=plan.plan==='PROTECT_TEN'&&tenGuardDiscard(v,k,old.card)&&!tenGuardDiscard(v,k,d.card)&&old.card!==d.card;
   if(theme==='ten-no-guard-needed')matches=v.trick.length>0&&contract==='NT'&&v.hand.some(c=>c.endsWith('-10')&&k.played.includes(`${suit(c)}-A`))&&!v.legalCards.some(c=>tenGuardDiscard(v,k,c))&&plan.plan!=='PROTECT_TEN';
   if(theme==='develop-entry')matches=plan.plan==='DEVELOP_SUIT'&&k.masters.includes(old.card)&&!k.masters.includes(d.card);
   if(theme==='develop-no-entry')matches=!v.trick.length&&contract==='NT'&&!k.masters.length&&v.hand.some(c=>v.hand.filter(o=>suit(o)===suit(c)).length>=3)&&plan.plan!=='DEVELOP_SUIT';
   if(theme==='develop-insufficient-entries')matches=!v.trick.length&&contract==='NT'&&k.masters.length>0&&v.hand.some(c=>v.hand.filter(o=>suit(o)===suit(c)).length>=3)&&plan.plan!=='DEVELOP_SUIT'&&!v.hand.some(c=>k.masters.includes(c)&&v.hand.filter(o=>suit(o)===suit(c)).length>=3);
   if(theme==='draw-control')matches=plan.plan==='DRAW_TRUMPS'&&k.remainingTrumps.some(c=>k.possibleOwners[c]?.some(p=>team(p)!==team(v.seat)));
   if(theme==='preserve-draw-conflict')matches=plan.plan==='PRESERVE_TRUMPS'&&v.legalCards.some(c=>suit(c)===contract&&k.masters.includes(c));
   if(matches)cases.push({id:`${theme}-${cases.filter(c=>c.topic===theme).length+1}`,topic:theme,sourceSeed:seed,contract,hands,bids,history:structuredClone(history),preferredCards:plan.preferred,oldCard:old.card,exampleCard:d.card});
  }
  const action=basicAction(v,rng);
  if(action.type!=='play')throw Error('Невалидна фаза');
  const card=rng()<.8?action.card:v.legalCards[Math.floor(rng()*v.legalCards.length)];
  const play:Action={type:'play',card,declare:selectDeclarations(v.declarations),belot:v.belotCards.includes(card)};
  history.push(play);applyAction(g,g.turn,play);
 }
}
writeFileSync('tests/fixtures/strategy-positions.json',JSON.stringify({version:1,cases},null,2)+'\n');
console.log(cases.map(c=>({id:c.id,seed:c.sourceSeed,contract:c.contract,plays:c.history.length,old:c.oldCard,now:c.exampleCard,preferred:c.preferredCards})));
if(cases.length!==themes.length*2)throw Error('Липсват сценарии.');
