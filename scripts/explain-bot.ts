// Преглед на реалното решение върху валидна позиция; не разкрива чуждите ръце.
import catalog from '../tests/fixtures/strategy-positions.json' with {type:'json'};
import {scenarioPosition,type TacticalScenario} from '../training/scenarios.js';
import {decideCard} from '../src/game/bot-tactics.js';
import {decideHardCard,basicAction,selectDeclarations} from '../src/game/bots.js';
import {buildKnowledge} from '../src/game/bot-knowledge.js';
import {suitLengthBounds} from '../src/game/bot-strategy.js';
import {UTILITY_FIELDS} from '../src/game/bot-objective.js';
import {decideCard as before} from '../benchmarks/baseline/bot-tactics.js';
import {applyAction,newGame,view,rank,suit} from '../src/game/engine.js';
import {CONTRACT_LABEL,SYMBOL,SUITS,type Card,type View} from '../src/game/types.js';

const args=process.argv.slice(2),id=args[args.indexOf('--scenario')+1];
const fixture=(catalog.cases as unknown as Pick<TacticalScenario,'id'|'hands'|'bids'|'history'|'preferredCards'>[]).find(c=>c.id===id);
if(!fixture)throw Error(`Избери --scenario от: ${catalog.cases.map(c=>c.id).join(', ')}`);
const card=(c:Card)=>`${rank(c)}${SYMBOL[suit(c)]}`;
function explain(v:View){
 const d=args.includes('--hard')?decideHardCard(v):decideCard(v,v.legalCards);
 console.log(`Договор: ${CONTRACT_LABEL[v.contract!]}; място: ${v.seat}. Ръка: ${v.hand.map(card).join(' ')}.`);
 console.log(`Предишна политика: ${card(before(v).card)}. Нов избор: ${card(d.card)}.`);
 const knowledge=buildKnowledge(v);
 for(let seat=0;seat<4;seat++)if(seat!==v.seat)console.log(`  Публични граници за място ${seat}: ${SUITS.map(s=>{const bounds=suitLengthBounds(v,knowledge,seat,s);return `${SYMBOL[s]} ${bounds.min}–${bounds.max}`;}).join('; ')}.`);
 console.log(`${d.search?'Базов план преди симулациите':'План'}: ${d.strategy?.plan}. Цел: ${d.strategy?.objective}`);
 if(d.search){console.log(`Полета на вектора: ${UTILITY_FIELDS.join('; ')}. Ред на целите: ${d.search.objective.join(' > ')}.`);
  if(!d.strategy?.preferred.includes(d.card))console.log('Симулациите предпочетоха друга карта според крайната цел; базовият план е преодолян.');}
 for(const fact of d.strategy?.facts??[])console.log(`  Факт: ${fact}`);
 for(const assumption of d.strategy?.assumptions??[])console.log(`  Предположение: ${assumption}`);
 for(const condition of d.strategy?.invalidatedBy??[])console.log(`  Планът се преоценява при: ${condition}`);
 for(const c of d.candidates)console.log(`  ${c.card===d.card?'*':' '} ${card(c.card)}: ${d.search?'обща разлика в картови точки':'тактическа оценка'} ${c.score.toFixed(2)}${c.utility?`; краен вектор ${c.utility.map(n=>n.toFixed(2)).join(', ')}`:''}`);
 if(d.search)console.log(`Симулации: ${d.search.completedBatches} завършени, ${d.search.abortedBatches} прекъснати; резервен избор: ${d.search.fallback?'да':'не'}.`);
 return d;
}
console.log(`Сценарий: ${fixture.id}`);
const initial=scenarioPosition(fixture),old=explain(initial);
if(args.includes('--trace')){
 const g=newGame('medium',()=>.5);g.hands=fixture.hands.map(h=>h.slice(0,5));g.stock=fixture.hands.flatMap(h=>h.slice(5));
 for(const a of [...fixture.bids,...fixture.history]){if(g.phase==='trick')applyAction(g,-1,{type:'collect'});applyAction(g,g.turn,a);}
 if(g.phase==='trick')applyAction(g,-1,{type:'collect'});
 applyAction(g,g.turn,{type:'play',card:old.card,declare:selectDeclarations(initial.declarations),belot:initial.belotCards.includes(old.card)});
 let shown=false;
 while(g.phase==='playing'||g.phase==='trick'){
  if(g.phase==='trick'){applyAction(g,-1,{type:'collect'});continue;}
  if(g.turn===initial.seat){
   const next=view(g,g.turn),assessment=explain(next);
   if(initial.trick.length===0&&next.trick.length>0&&['DEVELOP_SUIT','DRAW_TRUMPS','PRESERVE_TRUMPS','CASH_WINNERS','STOP_DRAWING'].includes(old.strategy?.plan??''))
    console.log('Причина за преоценката: вече отговаряме във взятка, вместо да излизаме първи; условията на водещия план са отпаднали.');
   shown=true;console.log(`Преоценка след публичните ходове: ${old.strategy?.plan} → ${assessment.strategy?.plan}. Основанията са фактите на новия план.`);
   break;
  }
  applyAction(g,g.turn,basicAction(view(g,g.turn)));
 }
 if(!shown)console.log('Раздаването завърши; няма следващ ход на същия играч.');
}
