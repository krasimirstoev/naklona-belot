import manifest from './learning-manifest.json' with { type: 'json' };
import { buildKnowledge, type BotKnowledge } from './bot-knowledge.js';
import { analyzeCardTactics, analyzeTacticalContext } from './bot-tactics.js';
import { rank, suit } from './engine.js';
import { CONTRACTS, RANKS, SUITS, type Action, type Bid, type Card, type View } from './types.js';

export const ENCODING_VERSION = manifest.encodingVersion;
export const MODEL_VERSION = manifest.modelVersion;
export const BIDS: Bid[] = ['pass', ...CONTRACTS, 'contra', 'recontra'];
const CALL_SLOTS = 80; // At most 18 non-pass calls, three passes before each, then three: 75.
export const OBSERVATION_SIZE = manifest.observation.reduce((n,b) => n+b.size,0);
export const ACTION_SIZE = manifest.action.reduce((n,b) => n+b.size,0);
export const INPUT_SIZE = OBSERVATION_SIZE + ACTION_SIZE;
const fourRanks = ['Q', 'K', '10', 'A', '9', 'J'];
const cardIndex = (c: Card) => SUITS.indexOf(suit(c)) * 8 + RANKS.indexOf(rank(c));
const relative = (seat: number, own: number) => (seat - own + 4) % 4;
function oneHot(size: number, index: number): number[] { return Array.from({ length: size }, (_, i) => +(i === index)); }
function cardBits(cards: Card[]): number[] { const bits = Array(32).fill(0); for (const c of cards) bits[cardIndex(c)] = 1; return bits; }

/** Full legal actions, including the empty announcement and optional belot. */
export function learningActions(v: View): Action[] {
  if (v.phase === 'bidding') return v.legalBids.map(bid => ({ type: 'bid', bid }));
  if (v.phase !== 'playing') return [];
  const subsets: string[][] = [];
  const options = [...v.declarations].sort((a, b) => a.id.localeCompare(b.id));
  function visit(i: number, chosen: string[], used: Set<Card>) {
    if (i === options.length) { subsets.push(chosen); return; }
    visit(i + 1, chosen, used);
    const d = options[i];
    if (d.cards.every(c => !used.has(c))) visit(i + 1, [...chosen, d.id], new Set([...used, ...d.cards]));
  }
  visit(0, [], new Set());
  return v.legalCards.flatMap(card => subsets.flatMap(declare => {
    const action: Action = { type: 'play', card, declare, belot: false };
    return v.belotCards.includes(card) ? [action, { ...action, belot: true }] : [action];
  }));
}
export function actionKey(a: Action): string {
  return a.type === 'play' ? JSON.stringify([a.type, a.card, [...(a.declare ?? [])].sort(), !!a.belot]) : JSON.stringify(a);
}
export function encodeAction(v: View, a: Action, knowledge = v.phase === 'playing' ? buildKnowledge(v) : undefined, facts?: ReturnType<typeof analyzeCardTactics>): number[] {
  const sequence: Card[] = [], fours: number[] = Array(6).fill(0);
  let value = 0;
  if (a.type === 'play') for (const id of a.declare ?? []) {
    const d = v.declarations.find(d => d.id === id);
    if (!d) throw new Error('Unknown declaration');
    value += d.value;
    if (d.kind === 'sequence') sequence.push(...d.cards);
    else fours[fourRanks.indexOf(rank(d.cards[0]))] = 1;
  }
  const extra = a.type === 'play' && knowledge ? actionConditions(v, a.card, knowledge, facts) : Array(19).fill(0);
  return [...cardBits(a.type === 'play' ? [a.card] : []), ...oneHot(9, a.type === 'bid' ? BIDS.indexOf(a.bid) : -1),
    +(a.type === 'play' && !!a.belot), ...cardBits(sequence), ...fours, value / 200, ...extra];
}

/** Only View fields; no Game, hidden hands, stock, arbitrary text or historic private declarations. */
export function encodeObservation(v: View, knowledge = v.phase === 'playing' ? buildKnowledge(v) : undefined): number[] {
  if (v.calls.length > CALL_SLOTS) throw new Error('Bidding history exceeds encoding capacity');
  const rel = (p: number) => relative(p, v.seat);
  const out = [...cardBits(v.hand), ...Array.from({ length: 4 }, (_, i) => v.counts[(v.seat + i) % 4] / 8),
    ...oneHot(2, v.phase === 'bidding' ? 0 : 1), ...oneHot(4, rel(v.dealer)),
    ...oneHot(7, v.contract === null ? 0 : CONTRACTS.indexOf(v.contract) + 1),
    ...oneHot(5, v.declarer === null ? 4 : rel(v.declarer)), ...oneHot(3, [1, 2, 4].indexOf(v.multiplier)),
    v.scores[v.seat % 2] / 151, v.scores[1 - v.seat % 2] / 151, v.hanging / 151];
  for (let i = 0; i < CALL_SLOTS; i++) {
    const c = v.calls[i]; out.push(+(!!c), ...oneHot(4, c ? rel(c.player) : -1), ...oneHot(9, c ? BIDS.indexOf(c.bid) : -1));
  }
  const history = [...v.tricks.flatMap(t => t.plays), ...v.trick];
  for (let i = 0; i < 32; i++) {
    const n = history.findIndex(p => cardIndex(p.card) === i), p = history[n];
    out.push(...oneHot(4, p ? rel(p.player) : -1), n < 0 ? 0 : (n + 1) / 32, n < 0 ? 0 : Math.floor(n / 4) / 8, +(n >= 0));
  }
  for (let i = 0; i < 4; i++) {
    const p = v.trick[i]; out.push(...cardBits(p ? [p.card] : []), ...oneHot(4, p ? rel(p.player) : -1), +(!!p));
  }
  for (let i = 0; i < 8; i++) out.push(...oneHot(5, v.tricks[i] ? rel(v.tricks[i].winner) : 4));
  for (let i = 0; i < 4; i++) {
    const announcements = v.announcements.filter(a => rel(a.player) === i);
    out.push(...cardBits(announcements.flatMap(a => a.cards)),
      announcements.filter(a => a.kind === 'sequence').length / 8,
      announcements.filter(a => a.kind === 'four').length / 8,
      announcements.reduce((n, a) => n + a.value, 0) / 200,
      announcements.reduce((n, a) => n + a.strength, 0) / 100);
  }
  for (let i = 0; i < 4; i++) for (const s of SUITS) out.push(+v.belots.some(b => rel(b.player) === i && b.suit === s));
  if (knowledge) {
    const k = knowledge;
    out.push(1);
    for (let i=0;i<4;i++) for (const s of SUITS) out.push(+k.voidSuits[(v.seat+i)%4].includes(s));
    for (const s of SUITS) for (const r of RANKS) for (let i=0;i<4;i++) out.push(+(k.possibleOwners[`${s}-${r}`]?.includes((v.seat+i)%4) ?? false));
    out.push(...cardBits(k.remainingTrumps), ...cardBits(Object.values(k.highestRemaining).filter((c): c is Card => !!c)), ...cardBits(k.masters),
      ...oneHot(5, k.currentWinner === null ? 4 : rel(k.currentWinner)));
  } else out.push(...Array(OBSERVATION_SIZE-1752).fill(0));
  if (out.length !== OBSERVATION_SIZE || out.some(x => !Number.isFinite(x))) throw new Error('Invalid observation encoding');
  return out;
}
function actionConditions(v: View, card: Card, k: BotKnowledge, facts = analyzeCardTactics(v, card, k)): number[] {
  const relMask = (players: number[]) => Array.from({length:4}, (_,i) => +players.includes((v.seat+i)%4));
  return [1, +facts.trump, +(facts.suitContract && !facts.trump), +facts.wins, +facts.partnerWinning,
    ...relMask(facts.targets), ...relMask(facts.certainTargets), +facts.ruffRisk, facts.stakes/162,
    +(facts.suitContract && !!facts.ruffSuit && facts.trumps.length>0 && facts.trumps.length<=2),
    +(facts.suitContract && facts.preservePartner), +(facts.trump && facts.control), facts.enemyTrumps.length/8];
}
/** One public knowledge reconstruction and one analysis per distinct card, shared by announcement variants. */
export function prepareLearningDecision(v: View) {
  const knowledge = v.phase === 'playing' ? buildKnowledge(v) : undefined;
  const actions = learningActions(v);
  const context = knowledge ? analyzeTacticalContext(v,knowledge) : undefined;
  const cache = new Map<Card, ReturnType<typeof analyzeCardTactics>>();
  const actionFeatures = actions.map(a => {
    if (a.type === 'play' && knowledge && !cache.has(a.card)) cache.set(a.card, analyzeCardTactics(v,a.card,knowledge,context));
    return encodeAction(v,a,knowledge,a.type === 'play' ? cache.get(a.card) : undefined);
  });
  return {actions, observation:encodeObservation(v,knowledge), actionFeatures, knowledge};
}
export interface Layer { weight: number[][]; bias: number[] }
export interface LearnedModel {
  formatVersion: number; encodingVersion: number; observationSize: number; actionSize: number;
  hiddenSizes: number[]; layers: Layer[];
  metadata?: Record<string, unknown>;
}
export function validateModel(value: unknown): LearnedModel {
  const m = value as LearnedModel;
  if (!m || m.formatVersion !== MODEL_VERSION || m.encodingVersion !== ENCODING_VERSION ||
    m.observationSize !== OBSERVATION_SIZE || m.actionSize !== ACTION_SIZE ||
    JSON.stringify(m.hiddenSizes) !== '[128,128]' || !Array.isArray(m.layers) || m.layers.length !== 3) throw new Error('Incompatible learned model');
  const sizes = [INPUT_SIZE, 128, 128, 1];
  m.layers.forEach((l, i) => {
    if (!l || !Array.isArray(l.weight) || l.weight.length !== sizes[i + 1] || !Array.isArray(l.bias) || l.bias.length !== sizes[i + 1] ||
      l.bias.some(x => typeof x !== 'number' || !Number.isFinite(x)) || l.weight.some(row => !Array.isArray(row) || row.length !== sizes[i] ||
        row.some(x => typeof x !== 'number' || !Number.isFinite(x)))) throw new Error('Invalid model weights');
  });
  return m;
}
export function scoreActions(model: LearnedModel, observation: number[], actions: number[][]): number[] {
  if (observation.length !== OBSERVATION_SIZE || actions.some(a => a.length !== ACTION_SIZE)) throw new Error('Invalid feature dimensions');
  const first = model.layers[0];
  // Share the observation multiplication across all candidate actions.
  const base = first.weight.map((row, j) => observation.reduce((n, x, i) => n + x * row[i], first.bias[j]));
  return actions.map(action => {
    let x = first.weight.map((row, j) => Math.max(0, action.reduce((n, a, i) => n + a * row[OBSERVATION_SIZE + i], base[j])));
    for (let layer = 1; layer < 3; layer++) {
      const l = model.layers[layer];
      x = l.weight.map((row, j) => {
        const sum = row.reduce((n, w, i) => n + w * x[i], l.bias[j]);
        return layer < 2 ? Math.max(0, sum) : sum;
      });
    }
    if (!Number.isFinite(x[0])) throw new Error('Non-finite model output');
    return x[0];
  });
}
export function learnedAction(v: View, model: LearnedModel): Action {
  const {actions, observation, actionFeatures} = prepareLearningDecision(v);
  if (!actions.length) throw new Error('No learned action available');
  const scores = scoreActions(model, observation, actionFeatures);
  return actions[scores.reduce((best, score, i) => score > scores[best] ? i : best, 0)];
}
