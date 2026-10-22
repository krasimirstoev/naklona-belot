import type { Game, Speed } from './types.js';
export const TEMPO: Record<Speed,{announcement:number;card:number;trick:number}> = {
  slow: {announcement:3000,card:1500,trick:3000},
  normal: {announcement:1800,card:750,trick:1800},
  fast: {announcement:950,card:300,trick:900}
};
export function turnDelay(game: Game, speed: Speed): number {
  const tempo=TEMPO[speed];
  const announced=game.events.at(-1)?.revision===game.revision;
  if(game.phase==='trick')return Math.max(tempo.trick,announced?tempo.announcement:0);
  return game.phase==='bidding'||announced?tempo.announcement:tempo.card;
}
