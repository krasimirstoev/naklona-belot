import { deck, legalCards, points, rank, shuffle, strength, suit, team, winner } from './engine.js';
import { CONTRACTS, SUITS, type Action, type Card, type Contract, type Play, type View, type Declaration } from './types.js';

function bidValue(hand: Card[], contract: Contract): number {
  const value=hand.reduce((n,c)=>n+points(c,contract)+(strength(c,contract)>=6?8:0),0);
  if(contract==='NT') return value/2 + SUITS.filter(s=>hand.includes(`${s}-A`)).length*5;
  if(contract==='AT') return value*.61 + hand.filter(c=>rank(c)==='J').length*5;
  const trumps=hand.filter(c=>suit(c)===contract);
  return value + trumps.length*8 + (trumps.some(c=>rank(c)==='J')?9:0) - (trumps.length<2?25:0);
}
export function basicAction(v: View, rng=Math.random): Action {
  if(v.phase==='bidding') {
    const candidates=CONTRACTS.filter(c=>v.legalBids.includes(c)).map(c=>({c,value:bidValue(v.hand,c)})).sort((a,b)=>b.value-a.value);
    const jitter=v.difficulty==='easy'?(rng()-.5)*24:0;
    const threshold=v.difficulty==='easy'?62:v.difficulty==='medium'?59:55;
    if(v.legalBids.includes('recontra') && bidValue(v.hand,v.contract!)>85) return {type:'bid',bid:'recontra'};
    if(v.legalBids.includes('contra') && bidValue(v.hand,v.contract!)>95) return {type:'bid',bid:'contra'};
    if(candidates[0] && candidates[0].value+jitter>threshold && !(v.declarer!==null && team(v.declarer)===team(v.seat))) return {type:'bid',bid:candidates[0].c};
    return {type:'bid',bid:'pass'};
  }
  let card: Card;
  if(v.difficulty==='easy') card=v.legalCards[Math.floor(rng()*v.legalCards.length)];
  else card=heuristicCard(v.hand,v.trick,v.contract!,v.seat,v.legalCards,v.tricks.flatMap(t=>t.plays));
  return playAction(v,card);
}
export function selectDeclarations(options: Declaration[]): string[] {
  let best: Declaration[]=[],bestValue=-1;
  for(let mask=0;mask<(1<<options.length);mask++) {
    const chosen=options.filter((_,i)=>mask&(1<<i));
    const cards=chosen.flatMap(d=>d.cards);
    if(new Set(cards).size!==cards.length)continue;
    const value=chosen.reduce((n,d)=>n+d.value,0);
    if(value>bestValue){bestValue=value;best=chosen;}
  }
  return best.map(d=>d.id);
}
function playAction(v: View, card: Card): Action {
  return {type:'play',card,declare:selectDeclarations(v.declarations),belot:v.belotCards.includes(card)};
}

export function heuristicCard(hand: Card[], trick: Play[], contract: Contract, seat: number, legal=legalCards(hand,trick,contract,seat), seen: Play[]=[]): Card {
  const cheap=(cards: Card[])=>[...cards].sort((a,b)=>points(a,contract)-points(b,contract) || strength(a,contract)-strength(b,contract))[0];
  if(!trick.length) {
    const masters=legal.filter(c=>!deck().some(other=>suit(other)===suit(c) && strength(other,contract)>strength(c,contract) && !hand.includes(other) && !seen.some(p=>p.card===other)));
    if(masters.length) return [...masters].sort((a,b)=>points(b,contract)-points(a,contract))[0];
    return cheap(legal);
  }
  const best=winner(trick,contract);
  if(team(best)===team(seat)) {
    if(trick.length===3) return [...legal].sort((a,b)=>points(b,contract)-points(a,contract))[0];
    return cheap(legal);
  }
  const winning=legal.filter(c=>winner([...trick,{player:seat,card:c}],contract)===seat);
  return cheap(winning.length?winning:legal);
}

// Each candidate assignment respects every public play, including inferred voids and
// mandatory overtrumps, as well as combinations revealed after the first trick.
export function sampleHands(v: View, rng=Math.random): Card[][] | null {
  const played=[...v.tricks.flatMap(t=>t.plays),...v.trick];
  const unknown=shuffle(deck().filter(c=>!v.hand.includes(c) && !played.some(p=>p.card===c)),rng);
  const other=[0,1,2,3].filter(p=>p!==v.seat);
  const events: {play: Play; prior: Play[]}[]=[];
  for(const plays of [...v.tricks.map(t=>t.plays),v.trick]) plays.forEach((play,i)=>events.push({play,prior:plays.slice(0,i)}));
  const allowed=new Map<Card,number[]>();
  for(const c of unknown) {
    const revealed=v.announcements.find(a=>a.cards.includes(c));
    const seats=other.filter(p=>(!revealed || revealed.player===p) && events.every(e=>e.play.player!==p || legalCards([e.play.card,c],e.prior,v.contract!,p).includes(e.play.card)));
    if(!seats.length) return null;
    allowed.set(c,shuffle(seats,rng));
  }
  unknown.sort((a,b)=>allowed.get(a)!.length-allowed.get(b)!.length);
  const hands: Card[][]=[[],[],[],[]];hands[v.seat]=[...v.hand]; let nodes=0;
  function assign(i: number): boolean {
    if(++nodes>5000) return false;
    if(i===unknown.length) return true;
    const c=unknown[i];
    for(const p of allowed.get(c)!) if(hands[p].length<v.counts[p]) {hands[p].push(c);if(assign(i+1)) return true;hands[p].pop();}
    return false;
  }
  return assign(0)?hands:null;
}
function simulation(hands: Card[][], trick: Play[], turn: number, contract: Contract, perspective: number, deadline: number, seen: Play[]): number {
  const total=hands.reduce((n,h)=>n+h.length,0);
  // Perfect-information partnership search in the small sampled endgame.
  if(total<=7) return search(hands,trick,turn,contract,perspective,deadline);
  let value=0;
  while(hands.some(h=>h.length)) {
    if(performance.now()>deadline) break;
    const c=heuristicCard(hands[turn],trick,contract,turn,undefined,seen);
    hands[turn].splice(hands[turn].indexOf(c),1);trick.push({player:turn,card:c});
    if(trick.length===4) {const w=winner(trick,contract);value+=(team(w)===perspective?1:-1)*trick.reduce((n,p)=>n+points(p.card,contract),0);seen.push(...trick);trick=[];turn=w;} else turn=(turn+1)%4;
  }
  return value;
}
function search(hands: Card[][], trick: Play[], turn: number, contract: Contract, perspective: number, deadline: number, alpha=-Infinity, beta=Infinity): number {
  if(trick.length===4) {
    const w=winner(trick,contract);const end=hands.every(h=>h.length===0);
    const value=(team(w)===perspective?1:-1)*(trick.reduce((n,p)=>n+points(p.card,contract),0)+(end?(contract==='NT'?20:10):0));
    return end?value:value+search(hands,[],w,contract,perspective,deadline,alpha-value,beta-value);
  }
  if(performance.now()>deadline) return 0;
  const maximize=team(turn)===perspective;let best=maximize?-Infinity:Infinity;
  for(const c of legalCards(hands[turn],trick,contract,turn)) {
    const index=hands[turn].indexOf(c);hands[turn].splice(index,1);
    const value=search(hands,[...trick,{player:turn,card:c}],(turn+1)%4,contract,perspective,deadline,alpha,beta);
    hands[turn].splice(index,0,c);
    best=maximize?Math.max(best,value):Math.min(best,value);
    if(maximize) alpha=Math.max(alpha,best);else beta=Math.min(beta,best);
    if(beta<=alpha) break;
  }
  return Number.isFinite(best)?best:0;
}
export function hardAction(v: View, budgetMs=220, rng=Math.random): Action {
  if(v.phase!=='playing' || v.legalCards.length<=1) return basicAction(v,rng);
  const deadline=performance.now()+budgetMs;
  const totals=v.legalCards.map(()=>0);let iterations=0;
  // Complete each batch to compare cards on the same hidden distribution.
  while(iterations<100 && performance.now()<deadline-15) {
    const sampled=sampleHands(v,rng);if(!sampled) break;
    const scores: number[]=[];let complete=true;
    for(const c of v.legalCards) {
      if(performance.now()>deadline-2) {complete=false;break;}
      const hands=sampled.map(h=>[...h]);hands[v.seat].splice(hands[v.seat].indexOf(c),1);
      let trick=[...v.trick,{player:v.seat,card:c}],turn=(v.seat+1)%4,value=0;
      if(trick.length===4) {turn=winner(trick,v.contract!);value=(team(turn)===team(v.seat)?1:-1)*trick.reduce((n,p)=>n+points(p.card,v.contract!),0);trick=[];}
      value+=simulation(hands,trick,turn,v.contract!,team(v.seat),deadline,v.tricks.flatMap(t=>t.plays));scores.push(value);
    }
    if(!complete) break;
    scores.forEach((n,i)=>totals[i]+=n);iterations++;
  }
  if(!iterations) return basicAction(v,rng);
  let best=0;for(let i=1;i<totals.length;i++) if(totals[i]>totals[best]) best=i;
  return playAction(v,v.legalCards[best]);
}
