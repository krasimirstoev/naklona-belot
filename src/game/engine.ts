import { randomUUID } from 'node:crypto';
import { SUITS, RANKS, CONTRACTS, type Card, type Contract, type Suit, type Rank, type Play, type Game, type View, type Action, type Bid, type Difficulty, type Declaration, type RoundResult, type AnnouncementEvent, BID_LABEL, NAMES } from './types.js';

export const suit = (c: Card) => c.split('-')[0] as Suit;
export const rank = (c: Card) => c.split('-')[1] as Rank;
export const deck = (): Card[] => SUITS.flatMap(s => RANKS.map(r => `${s}-${r}` as Card));
export const team = (p: number) => p % 2;
export const next = (p: number) => (p + 1) % 4; // Seats run counter-clockwise: south, east, north, west.
export function shuffle<T>(items: T[], rng = Math.random): T[] {
  const a = [...items]; for (let i=a.length-1;i>0;i--) { const j=Math.floor(rng()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a;
}
export function isTrump(c: Card, contract: Contract) { return contract === 'AT' || suit(c) === contract; }
export function strength(c: Card, contract: Contract) {
  return (isTrump(c,contract) ? ['7','8','Q','K','10','A','9','J'] : ['7','8','9','J','Q','K','10','A']).indexOf(rank(c));
}
export function points(c: Card, contract: Contract) {
  const values: Record<Rank,number> = isTrump(c,contract) ? {'7':0,'8':0,'9':14,'10':10,J:20,Q:3,K:4,A:11} : {'7':0,'8':0,'9':0,'10':10,J:2,Q:3,K:4,A:11};
  return values[rank(c)] * (contract === 'NT' ? 2 : 1);
}
export function winner(plays: Play[], contract: Contract): number {
  if (!plays.length) throw new Error('Няма карти на масата.');
  let best=plays[0]; const lead=suit(best.card);
  for (const p of plays.slice(1)) {
    const trump = contract !== 'NT' && contract !== 'AT';
    if ((trump && suit(p.card)===contract && suit(best.card)!==contract) ||
      (suit(p.card)===suit(best.card) && strength(p.card,contract)>strength(best.card,contract)) ||
      (suit(p.card)===lead && suit(best.card)!==lead && !(trump && suit(best.card)===contract))) best=p;
  } return best.player;
}
export function legalCards(hand: Card[], trick: Play[], contract: Contract, player: number): Card[] {
  if (!trick.length) return [...hand];
  const lead=suit(trick[0].card), following=hand.filter(c=>suit(c)===lead);
  const best=trick.find(p=>p.player===winner(trick,contract))!;
  if (following.length) {
    if (contract==='AT' || lead===contract) {
      const highest=Math.max(...trick.filter(p=>suit(p.card)===lead).map(p=>strength(p.card,contract)));
      const higher=following.filter(c=>strength(c,contract)>highest); if (higher.length) return higher;
    } return following;
  }
  if (contract==='NT' || contract==='AT' || team(best.player)===team(player)) return [...hand];
  const trumps=hand.filter(c=>suit(c)===contract);
  if (!trumps.length) return [...hand];
  if (suit(best.card)!==contract) return trumps;
  const higher=trumps.filter(c=>strength(c,contract)>strength(best.card,contract));
  return higher.length ? higher : [...hand];
}
export function declarations(hand: Card[], contract: Contract): Declaration[] {
  if (contract==='NT') return [];
  const found: Declaration[]=[];
  for (const s of SUITS) {
    let run: Card[]=[];
    const flush=()=>{ if(run.length>=3) { const top=RANKS.indexOf(rank(run.at(-1)!)); found.push({id:`seq-${s}-${top}-${run.length}`,kind:'sequence',value:run.length===3?20:run.length===4?50:100,strength:run.length*10+top,label:run.length===3?'Терца':run.length===4?'Петдесет':'Сто',cards:[...run]}); } run=[]; };
    for (const r of RANKS) { const c=`${s}-${r}` as Card; if(hand.includes(c)) run.push(c); else flush(); } flush();
  }
  const fourOrder: Rank[]=['Q','K','10','A','9','J'];
  for (const r of fourOrder) {
    const cards=SUITS.map(s=>`${s}-${r}` as Card);
    if(cards.every(c=>hand.includes(c))) found.push({id:`four-${r}`,kind:'four',value:r==='J'?200:r==='9'?150:100,strength:fourOrder.indexOf(r),label:`Каре ${r}`,cards});
  } return found;
}
export function declarationPoints(ann: Game['announcements']): number[] {
  const result=[0,0];
  for(const kind of ['sequence','four']) {
    const subset=ann.filter(a=>a.kind===kind);
    const maxima=[0,1].map(t=>Math.max(-1,...subset.filter(a=>team(a.player)===t).map(a=>a.strength)));
    if(maxima[0]===maxima[1]) continue;
    const t=maxima[0]>maxima[1]?0:1;
    result[t]+=subset.filter(a=>team(a.player)===t).reduce((sum,a)=>sum+a.value,0);
  } return result;
}
export function availableBelots(hand: Card[], trick: Play[], contract: Contract, announced: Game['belots'], player: number): Card[] {
  if(contract==='NT') return [];
  return hand.filter(c=>['K','Q'].includes(rank(c)) && isTrump(c,contract) &&
    hand.includes(`${suit(c)}-${rank(c)==='K'?'Q':'K'}` as Card) &&
    !announced.some(b=>b.player===player && b.suit===suit(c)) &&
    (contract!=='AT' || !trick.length || suit(c)===suit(trick[0].card)));
}
export function legalBids(g: Pick<Game,'contract'|'declarer'|'multiplier'>, player: number): Bid[] {
  const bids: Bid[]=['pass',...CONTRACTS.filter(c=>!g.contract || CONTRACTS.indexOf(c)>CONTRACTS.indexOf(g.contract))];
  if(g.declarer!==null) {
    if(g.multiplier===1 && team(player)!==team(g.declarer)) bids.push('contra');
    if(g.multiplier===2 && team(player)===team(g.declarer)) bids.push('recontra');
  } return bids;
}
export function deal(g: Game, rng=Math.random) {
  const cards=shuffle(deck(),rng); g.hands=[[],[],[],[]];
  let pos=0;
  for(const n of [3,2]) for(let i=1;i<=4;i++) { const p=(g.dealer+i)%4; g.hands[p].push(...cards.slice(pos,pos+n)); pos+=n; }
  g.stock=cards.slice(pos); g.turn=next(g.dealer); g.phase='bidding'; g.contract=null; g.declarer=null;
  g.multiplier=1;g.passes=0;g.calls=[];g.trick=[];g.tricks=[];g.announcements=[];g.belots=[];
  g.message='Пет карти. Време е за обявяване.';
}
export function newGame(difficulty: Difficulty, rng=Math.random): Game {
  const g: Game={botModelId:null,events:[],eventSeq:0,id:randomUUID(),revision:0,difficulty,phase:'bidding',dealer:3,turn:0,round:1,hands:[],stock:[],contract:null,declarer:null,multiplier:1,passes:0,calls:[],trick:[],tricks:[],announcements:[],belots:[],scores:[0,0],hanging:0,results:[],message:''};
  deal(g,rng); return g;
}
export function roundedPair(raw: number[], contract: Contract, declarer: number): number[] {
  const threshold=contract==='AT'?5:contract==='NT'?6:7;
  const out=raw.map(n=>Math.floor(n/10)+(n%10>=threshold?1:0));
  const boundary=contract==='AT'?4:contract==='NT'?-1:6;
  if(raw.every(n=>n%10===boundary)) out[raw[0]===raw[1]?declarer:raw[0]<raw[1]?0:1]++;
  return out;
}
export function calculateResult(g: Game): RoundResult {
  const contract=g.contract!, declaring=team(g.declarer!), defending=1-declaring;
  const cardPoints=[0,0],belotPoints=[0,0];
  for(const t of g.tricks) cardPoints[team(t.winner)]+=t.plays.reduce((n,p)=>n+points(p.card,contract),0);
  cardPoints[team(g.tricks.at(-1)!.winner)]+=contract==='NT'?20:10;
  const capot=g.tricks.every(t=>team(t.winner)===team(g.tricks[0].winner));
  if(capot) cardPoints[team(g.tricks[0].winner)]+=90;
  const dp=declarationPoints(g.announcements);
  for(const b of g.belots) belotPoints[team(b.player)]+=20;
  const raw=cardPoints.map((n,i)=>n+dp[i]+belotPoints[i]);
  const outcome=raw[declaring]>raw[defending]?'made':raw[declaring]<raw[defending]?'failed':'hanging';
  const added=[0,0]; let hanging=g.hanging;
  const all=Math.round((raw[0]+raw[1])*g.multiplier/10);
  if(outcome==='hanging') {
    if(g.multiplier>1) hanging+=all;
    else { const pair=roundedPair(raw,contract,declaring); added[defending]=pair[defending]; hanging+=pair[declaring]; }
  } else {
    const won=outcome==='made'?declaring:defending;
    if(g.multiplier>1 || outcome==='failed') added[won]=all;
    else { const pair=roundedPair(raw,contract,declaring); added[0]=pair[0];added[1]=pair[1]; }
    added[won]+=hanging; hanging=0;
  }
  return {number:g.round,contract,declarer:g.declarer!,multiplier:g.multiplier,cardPoints,declarationPoints:dp,belotPoints,raw,added,total:g.scores.map((n,i)=>n+added[i]),hanging,outcome,capot};
}
function announce(g: Game, player: number, kind: AnnouncementEvent['kind'], text: string, bid?: Bid) {
  g.events.push({id:++g.eventSeq,round:g.round,revision:g.revision+1,player,kind,text,...(bid?{bid}:{})});
}
// Older saves contain the full game but no public event journal. Reconstruct only
// information that was public, preserving the original state and revision.
export function hydrateGame(g: Game): Game {
  g.botModelId ??= null;
  if(Array.isArray(g.events)) {g.eventSeq??=Math.max(0,...g.events.map(e=>e.id));return g;}
  g.events=[];g.eventSeq=0;
  for(const c of g.calls)announce(g,c.player,'bid',BID_LABEL[c.bid],c.bid);
  const declared=new Set<number>(),belots=new Set<number>();
  for(const p of [...g.tricks.flatMap(t=>t.plays),...g.trick]) {
    if(!declared.has(p.player)) {
      for(const d of g.announcements.filter(d=>d.player===p.player))announce(g,p.player,'declaration',d.kind==='four'?'Каре':d.label);
      declared.add(p.player);
    }
    g.belots.forEach((b,i)=>{
      if(!belots.has(i)&&b.player===p.player&&b.suit===suit(p.card)&&['K','Q'].includes(rank(p.card))) {
        announce(g,p.player,'belot','Белот');belots.add(i);
      }
    });
  }
  for(const e of g.events)e.revision=-1;
  return g;
}
export function applyAction(g: Game, player: number, action: Action, rng=Math.random): void {
  if(action.type==='next') {
    if(player!==0 || g.phase!=='roundEnd') throw new Error('Следващото раздаване още не е достъпно.');
    g.round++;g.dealer=next(g.dealer);deal(g,rng);g.revision++;return;
  }
  if(action.type==='collect') {
    if(player!==-1 || g.phase!=='trick') throw new Error('Ръката още не е завършена.');
    const w=winner(g.trick,g.contract!);g.tricks.push({plays:[...g.trick],winner:w});g.trick=[];g.turn=w;
    g.message=`${NAMES[w]} взема ръката.`;
    if(g.tricks.length===8) {
      const r=calculateResult(g);g.results.push(r);g.scores=r.total;g.hanging=r.hanging;
      g.phase= !r.capot && r.outcome!=='hanging' && Math.max(...g.scores)>=151 && g.scores[0]!==g.scores[1] ? 'matchEnd':'roundEnd';
      g.message=r.outcome==='made'?'Обявата е изпълнена.':r.outcome==='failed'?'Обявилият отбор е вътре.':'Точките висят за следващото раздаване.';
    } else g.phase='playing';
    g.revision++;return;
  }
  if(player!==g.turn) throw new Error('Сега е ред на друг играч.');
  if(action.type==='bid') {
    if(g.phase!=='bidding' || !legalBids(g,player).includes(action.bid)) throw new Error('Тази обява не е разрешена.');
    announce(g,player,'bid',BID_LABEL[action.bid],action.bid);
    g.calls.push({player,bid:action.bid});g.message=`${NAMES[player]}: ${BID_LABEL[action.bid]}.`;
    if(action.bid==='pass') g.passes++;
    else {g.passes=0;if(action.bid==='contra') g.multiplier=2;else if(action.bid==='recontra') g.multiplier=4;else {g.contract=action.bid;g.declarer=player;g.multiplier=1;}}
    g.turn=next(player);
    if(!g.contract && g.passes===4) {g.dealer=next(g.dealer);g.round++;deal(g,rng);g.message='Четири паса. Ново раздаване.';}
    else if(g.contract && g.passes===3) {
      for(let i=1;i<=4;i++) {const p=(g.dealer+i)%4;g.hands[p].push(...g.stock.splice(0,3));}
      g.turn=next(g.dealer);g.phase='playing';g.message='Картите са раздадени. На добър час!';
    }
  } else if(action.type==='play') {
    if(g.phase!=='playing' || !legalCards(g.hands[player],g.trick,g.contract!,player).includes(action.card)) throw new Error('Отговори на боята и качи или цакай, когато правилата го изискват.');
    const options=g.tricks.length===0?declarations(g.hands[player],g.contract!):[];
    const ids=action.declare??[];
    if(new Set(ids).size!==ids.length || ids.some(id=>!options.some(d=>d.id===id))) throw new Error('Невалиден или закъснял анонс.');
    const chosen=options.filter(d=>ids.includes(d.id));
    const declarationCards=chosen.flatMap(d=>d.cards);
    if(new Set(declarationCards).size!==declarationCards.length) throw new Error('Една карта не може да участва едновременно в поредица и каре. Избери един от анонсите.');
    if(action.belot && !availableBelots(g.hands[player],g.trick,g.contract!,g.belots,player).includes(action.card)) throw new Error('С тази карта не може да се обяви белот.');
    for(const d of chosen)announce(g,player,'declaration',d.kind==='four'?'Каре':d.label);
    if(action.belot)announce(g,player,'belot','Белот');
    g.announcements.push(...options.filter(d=>ids.includes(d.id)).map(d=>({...d,player})));
    if(action.belot) g.belots.push({player,suit:suit(action.card)});
    g.hands[player].splice(g.hands[player].indexOf(action.card),1);g.trick.push({player,card:action.card});g.turn=next(player);
    g.message=action.belot?`${NAMES[player]}: Белот!`:ids.length?`${NAMES[player]}: ${options.filter(d=>ids.includes(d.id)).map(d=>d.kind==='four'?'Каре':d.label).join(', ')}.`:`${NAMES[player]} играе.`;
    if(g.trick.length===4) {g.phase='trick';g.message=`${NAMES[winner(g.trick,g.contract!)]} взема ръката.`;}
  } else throw new Error('Непознато действие.');
  g.revision++;
}
export function view(g: Game, seat=0): View {
  const own=g.hands[seat];
  return {events:g.events.map(e=>({...e})),id:g.id,revision:g.revision,difficulty:g.difficulty,phase:g.phase,dealer:g.dealer,turn:g.turn,round:g.round,
    hand:[...own].sort((a,b)=>SUITS.indexOf(suit(a))-SUITS.indexOf(suit(b)) || RANKS.indexOf(rank(a))-RANKS.indexOf(rank(b))),
    counts:g.hands.map(h=>h.length),contract:g.contract,declarer:g.declarer,multiplier:g.multiplier,
    calls:g.calls,trick:g.trick,tricks:g.tricks,
    announcements:g.announcements.map(a=>a.player===seat || ['roundEnd','matchEnd'].includes(g.phase)?a:{...a,cards:[],id:'hidden',strength:0,label:a.kind==='four'?'Каре':a.label,value:a.kind==='four'?0:a.value}),
    belots:g.belots,scores:g.scores,hanging:g.hanging,results:g.results,message:g.message,seat,
    legalCards:g.phase==='playing' && g.turn===seat?legalCards(own,g.trick,g.contract!,seat):[],
    legalBids:g.phase==='bidding' && g.turn===seat?legalBids(g,seat):[],
    declarations:g.phase==='playing' && g.turn===seat && g.tricks.length===0?declarations(own,g.contract!):[],
    belotCards:g.phase==='playing' && g.turn===seat?availableBelots(own,g.trick,g.contract!,g.belots,seat):[]};
}
