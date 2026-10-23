import type {Announced} from './types.js';

export type DeclarationStatus='counted'|'beaten'|'tied';
/** Compare each category by team. Every declaration of the winning team counts. */
export function resolveDeclarations(announcements:Announced[],higherFourWins=true):DeclarationStatus[]{
 return announcements.map(a=>{
  if(a.kind==='four'&&!higherFourWins)return 'counted';
  const subset=announcements.filter(other=>other.kind===a.kind);
  const maxima=[0,1].map(t=>Math.max(-1,...subset.filter(other=>other.player%2===t).map(other=>other.strength)));
  if(maxima[0]===maxima[1])return 'tied';
  return maxima[a.player%2]>maxima[1-a.player%2]?'counted':'beaten';
 });
}
