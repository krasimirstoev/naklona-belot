import type { Card } from './types.js';
import type { BotKnowledge, BotPosition } from './bot-knowledge.js';

/** Равномерно сред пълните разпределения, допускащи публичните ограничения и бройките. */
export function createHandSampler(v: BotPosition,k: BotKnowledge): {distributions:number; sample:(rng:()=>number)=>Card[][]}|null {
  if(v.hand.length!==v.counts[v.seat]||v.counts.some(n=>!Number.isInteger(n)||n<0||n>8)||
    k.unknown.length!==v.counts.reduce((n,c,p)=>n+(p===v.seat?0:c),0)) return null;
  const seats=[0,1,2,3].filter(p=>p!==v.seat);
  const cards=[...k.unknown].sort((a,b)=>(k.possibleOwners[a]?.length??0)-(k.possibleOwners[b]?.length??0)||a.localeCompare(b));
  const owners=cards.map(c=>seats.map((seat,i)=>k.possibleOwners[c]?.includes(seat)?i:-1).filter(i=>i>=0));
  const capacities=seats.map(p=>v.counts[p]),memo=new Map<string,number>();
  function completions(i:number,left:number[]):number {
    if(i===cards.length) return +left.every(n=>n===0);
    const key=`${i}:${left.join(',')}`;
    const cached=memo.get(key);if(cached!==undefined)return cached;
    let total=0;
    for(const p of owners[i]) if(left[p]>0) {left[p]--;total+=completions(i+1,left);left[p]++;}
    memo.set(key,total);return total;
  }
  const distributions=completions(0,[...capacities]);
  if(!distributions) return null;
  return {distributions,sample(rng){
    const hands:Card[][]=[[],[],[],[]],left=[...capacities];hands[v.seat]=[...v.hand];
    for(let i=0;i<cards.length;i++) {
      let ticket=rng()*completions(i,left);
      for(const p of owners[i]) if(left[p]>0) {
        left[p]--;const count=completions(i+1,left);
        if(ticket<count) {hands[seats[p]].push(cards[i]);break;}
        ticket-=count;left[p]++;
      }
    }
    return hands;
  }};
}
