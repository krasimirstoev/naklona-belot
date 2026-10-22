import { createHash } from 'node:crypto';
import catalog from './scenarios/catalog.json' with {type:'json'};
import {applyAction, deck, newGame, view} from '../src/game/engine.js';
import {decideCard} from '../src/game/bot-tactics.js';
import {prepareLearningDecision, scoreActions, type LearnedModel} from '../src/game/learning.js';
import type {Action, Card} from '../src/game/types.js';

export type TacticalScenario = {id:string;topic:string;split:'train'|'control';sourceSeed:number;baseId:string;rationale:string;hands:Card[][];bids:Action[];history:Action[];preferredCards:Card[]};
export const scenarios = catalog.cases as TacticalScenario[];
const baseSplits = new Map<string,string>();
const ids = new Set<string>();
for(const s of scenarios) {
  if(ids.has(s.id) || !['train','control'].includes(s.split) || (baseSplits.has(s.baseId) && baseSplits.get(s.baseId)!==s.split)) throw Error('Invalid scenario split or duplicate ID');
  ids.add(s.id); baseSplits.set(s.baseId,s.split);
}
export const scenarioDigest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
/** Reconstruct the full deal and replay through exactly the same public rules as live games. */
export function scenarioPosition(s: Pick<TacticalScenario,'id'|'hands'|'bids'|'history'|'preferredCards'>) {
  const all = s.hands.flat();
  if (s.hands.length!==4 || s.hands.some(h=>h.length!==8) || all.length!==32 || new Set(all).size!==32 || all.some(c=>!deck().includes(c))) throw Error(`Invalid deal: ${s.id}`);
  const g=newGame('medium',()=>.5);
  g.hands=s.hands.map(h=>h.slice(0,5)); g.stock=s.hands.flatMap(h=>h.slice(5));
  for(const a of s.bids) applyAction(g,g.turn,a);
  if(JSON.stringify(g.hands)!==JSON.stringify(s.hands)) throw Error(`Invalid bidding: ${s.id}`);
  for(const a of s.history) {
    if(g.phase==='trick') applyAction(g,-1,{type:'collect'});
    if(a.type!=='play') throw Error(`Invalid replay: ${s.id}`);
    applyAction(g,g.turn,a);
  }
  if(g.phase==='trick') applyAction(g,-1,{type:'collect'});
  if(g.phase!=='playing') throw Error(`Not a decision: ${s.id}`);
  const v=view(g,g.turn);
  if(!s.preferredCards.length || s.preferredCards.some(c=>!v.legalCards.includes(c))) throw Error(`Illegal preference: ${s.id}`);
  return v;
}
export function scenarioExamples() {
  // Deliberately no split argument: control examples cannot enter pretraining through this API.
  return {catalogDigest:scenarioDigest, examples:scenarios.filter(s=>s.split==='train').map(s=> {
    const v=scenarioPosition(s), p=prepareLearningDecision(v);
    return {id:s.id,observation:p.observation, actionFeatures:p.actionFeatures,
      preferred:p.actions.flatMap((a,i)=>a.type==='play'&&s.preferredCards.includes(a.card)?[i]:[])};
  })};
}
export function scenarioReport(model: LearnedModel) {
  const cases=scenarios.filter(s=>s.split==='control').map(s=> {
    const v=scenarioPosition(s), p=prepareLearningDecision(v), scores=scoreActions(model,p.observation,p.actionFeatures);
    const index=scores.reduce((best,score,i)=>score>scores[best]?i:best,0), chosen=p.actions[index];
    const heuristic=decideCard(v,v.legalCards,p.knowledge).card;
    const success=chosen.type==='play'&&s.preferredCards.includes(chosen.card);
    return {id:s.id,topic:s.topic,rationale:s.rationale,preferredCards:s.preferredCards,chosen,success,heuristic,heuristicSuccess:s.preferredCards.includes(heuristic),
      ...(success?{}:{publicFacts:{seat:v.seat,hand:v.hand,contract:v.contract,declarer:v.declarer,trick:v.trick,tricks:v.tricks,knowledge:p.knowledge},
        candidates:p.actions.map((action,i)=>({action,score:scores[i]}))})};
  });
  const topics=Object.fromEntries([...new Set(cases.map(c=>c.topic))].map(topic=> {
    const group=cases.filter(c=>c.topic===topic);
    return [topic,{cases:group.length,successes:group.filter(c=>c.success).length,heuristicSuccesses:group.filter(c=>c.heuristicSuccess).length,rate:group.filter(c=>c.success).length/group.length}];
  }));
  return {version:1,catalogDigest:scenarioDigest,split:'control',diagnosticOnly:true,topics,cases};
}
