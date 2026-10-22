import { calculateResult, team } from './engine.js';
import type { Game, RoundResult, View } from './types.js';

export type ScoringPosition=Pick<Game,'contract'|'declarer'|'multiplier'|'announcements'|'belots'|'tricks'|'scores'|'hanging'|'round'>;
export type RoundUtility=[matchOutcome:number,contractOutcome:number,scoreDifference:number,cardPointDifference:number];
export type UtilityObjective='game-score'|'contract'|'points';
export const UTILITY_FIELDS=['Изход на мача','Изпълнен наш или провален чужд договор','Разлика в записаните игрови точки','Разлика в картовите точки'];
export const objectiveOrder=(objective:UtilityObjective='game-score')=>objective==='contract'?[0,1,2,3]:objective==='points'?[3,2,1,0]:[0,2,1,3];
export const objectiveLabels=(objective:UtilityObjective='game-score')=>objectiveOrder(objective).map(i=>UTILITY_FIELDS[i]);
export function compareUtility(a:RoundUtility,b:RoundUtility,objective:UtilityObjective='game-score'):number {
  for(const i of objectiveOrder(objective)) if(a[i]!==b[i])return a[i]>b[i]?1:-1;
  return 0;
}
export function resultUtility(r:RoundResult,perspective:number):RoundUtility {
  const declaring=team(r.declarer),other=1-perspective;
  const ended=!r.capot&&r.outcome!=='hanging'&&Math.max(...r.total)>=151&&r.total[0]!==r.total[1];
  const match=ended?(r.total[perspective]>r.total[other]?1:-1):0;
  const made=r.outcome==='hanging'?0:((r.outcome==='made')===(declaring===perspective)?1:-1);
  return [match,made,r.added[perspective]-r.added[other],r.cardPoints[perspective]-r.cardPoints[other]];
}
export function scorePosition(v:Pick<View,'contract'|'declarer'|'multiplier'|'announcements'|'belots'|'scores'|'hanging'|'round'>, tricks:Game['tricks'], perspective:number):RoundUtility {
  return resultUtility(calculateResult({...v,tricks}),perspective);
}
