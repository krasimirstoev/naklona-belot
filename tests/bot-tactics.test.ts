import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicAction, decideHardCard, hardAction, sampleHands } from '../src/game/bots.js';
import { buildKnowledge, type BotPosition } from '../src/game/bot-knowledge.js';
import { decideCard } from '../src/game/bot-tactics.js';
import { applyAction, deck, legalCards, newGame, suit, view, winner } from '../src/game/engine.js';
import { CONTRACTS, type Card, type Contract, type Play, type View } from '../src/game/types.js';

const cards = (text: string) => text.split(' ') as Card[];
const plays = (text: string, leader = 0): Play[] => cards(text).map((card, i) => ({ player: (leader + i) % 4, card }));
function position(hand: string, history: Play[][] = [], declarer = 0): BotPosition {
  return { hand: cards(hand), seat: 0, counts: Array(4).fill(cards(hand).length), contract: 'H', declarer,
    trick: [], tricks: history.map(plays => ({ plays, winner: winner(plays, 'H') })), announcements: [], belots: [] };
}
function gameView(contract: Contract = 'H'): { g: ReturnType<typeof newGame>; v: View } {
  const g = newGame('hard', seeded(9));
  applyAction(g, 0, { type: 'bid', bid: contract });
  for (const p of [1, 2, 3]) applyAction(g, p, { type: 'bid', bid: 'pass' });
  return { g, v: view(g, 0) };
}
function seeded(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const forcingHistory = [plays('C-8 H-7 C-9 C-J'), plays('D-7 D-8 D-9 D-A', 1)];

test('draw a controlling trump to protect side winners; diagnostics explain the decision', () => {
  const v = position('H-J H-9 H-7 C-A C-7 D-A D-7 S-A');
  const d = decideCard(v);
  assert.equal(d.card, 'H-J');
  assert.ok(d.reasons.some(r => r.id === 'trump.draw' && r.contribution > 0));
  assert.equal(d.candidates.length, v.hand.length);
  assert.ok(d.candidates.every(c => c.score === c.reasons.reduce((n, r) => n + r.contribution, 0)));
});

test('preserve short trump for ruffing and avoid drawing without control', () => {
  const short = decideCard(position('H-J H-7 C-A C-7 C-8 D-A D-7 D-8'));
  assert.notEqual(suit(short.card), 'H');
  assert.ok(short.candidates.find(c => c.card === 'H-J')!.reasons.some(r => r.id === 'trump.preserve-ruff'));
  const weak = decideCard(position('H-9 H-7 C-A C-7 D-A D-7 S-A S-7'));
  assert.notEqual(suit(weak.card), 'H');
});

test('do not draw when all remaining trumps are ours', () => {
  const v = position('H-J H-9 C-A C-8 D-A S-7', [plays('H-7 H-8 H-Q H-K'), plays('H-10 H-A C-7 D-7', 3)]);
  const k = buildKnowledge(v), d = decideCard(v);
  assert.deepEqual(new Set(k.remainingTrumps), new Set(['H-J', 'H-9']));
  assert.notEqual(suit(d.card), 'H');
  assert.ok(d.candidates.filter(c => suit(c.card) === 'H').every(c => !c.reasons.some(r => r.id === 'trump.draw')));
});

test('lead a cheap void suit to shorten the opposing declarer, instead of sacrificing its ace', () => {
  const v = position('C-7 C-A D-Q D-K S-K S-Q', forcingHistory, 1);
  const d = decideCard(v);
  assert.equal(d.card, 'C-7');
  assert.ok(d.reasons.some(r => r.id === 'trump.force-ruff'));
  assert.ok(!d.candidates.find(c => c.card === 'C-A')!.reasons.some(r => r.id === 'trump.force-ruff'));
  const costly = decideCard(position('C-A D-Q D-K S-7 S-8 S-Q', forcingHistory, 1));
  assert.notEqual(costly.card, 'C-A');
});

test('partner-winning exception and intervening enemy winners remove the forcing claim', () => {
  const v = position('C-7 C-A S-7 S-8 S-K S-Q', [plays('D-7 H-7 D-8 D-9'), plays('C-8 C-9 C-K C-J', 1)], 1);
  v.trick = [{ player: 3, card: 'D-A' }];
  v.counts[3]--;
  assert.ok(decideCard(v).candidates.every(c => !c.reasons.some(r => r.id === 'trump.force-ruff')));
  const later = position('C-7 C-K D-Q D-K S-K S-Q', [plays('C-8 C-J C-9 H-7'), plays('D-7 D-A D-8 D-9', 3)], 3);
  assert.ok(decideCard(later).candidates.every(c => !c.reasons.some(r => r.id === 'trump.force-ruff')));
});

test('knowledge distinguishes voids, mandatory ruffs, overtrumps, declarations and assumptions', () => {
  const v = position('C-A C-10 C-Q C-K S-A S-10', [plays('H-A H-7 H-J H-8'), plays('D-7 D-8 C-7 D-9', 2)], 1);
  const k = buildKnowledge(v);
  assert.ok(!k.possibleOwners['H-9']!.includes(1)); // Could not beat the ace.
  assert.ok(k.voidSuits[0].includes('C') === false);
  assert.ok(k.voidSuits[0].includes('H'));
  assert.ok(k.assumptions.some(a => a.player === 1));
  const f = position('C-7 C-A D-Q D-K S-K S-Q', forcingHistory, 1);
  f.belots = [{ player: 1, suit: 'H' }];
  const known = buildKnowledge(f);
  assert.deepEqual(known.possibleOwners['H-K'], [1]);
  assert.deepEqual(known.possibleOwners['H-Q'], [1]);
  assert.ok(known.voidSuits[1].includes('C'));
  f.announcements = [{ id: 'known', kind: 'sequence', value: 20, strength: 1, label: 'known', cards: ['S-7', 'S-8', 'S-9'], player: 3 }];
  assert.deepEqual(buildKnowledge(f).possibleOwners['S-9'], [3]);
});

test('public knowledge is pure and independent of hidden hands', () => {
  const { g, v } = gameView();
  const before = structuredClone(v), k = buildKnowledge(v);
  [g.hands[1][0], g.hands[3][0]] = [g.hands[3][0], g.hands[1][0]];
  assert.deepEqual(buildKnowledge(view(g, 0)), k);
  assert.deepEqual(v, before);
  assert.deepEqual(decideCard(v), decideCard(view(g, 0)));
});

test('sampled hands satisfy every historical legal play for every contract', () => {
  for (const contract of CONTRACTS) {
    const { g } = gameView(contract), rng = seeded(42);
    for (let i = 0; i < 19; i++) {
      if (g.phase === 'trick') applyAction(g, -1, { type: 'collect' });
      else applyAction(g, g.turn, basicAction(view(g, g.turn), rng));
    }
    if (g.phase === 'trick') applyAction(g, -1, { type: 'collect' });
    const v = view(g, g.turn), original = structuredClone(v);
    for (let attempt = 0; attempt < 3; attempt++) {
      const sampled = sampleHands(v, rng);
      assert.ok(sampled, contract);
      assert.deepEqual(sampled.map(h => h.length), v.counts);
      assert.deepEqual(sampled[v.seat], v.hand);
      const history = [...v.tricks.map(t => t.plays), v.trick];
      const restored = sampled.map((h, p) => [...h, ...history.flat().filter(x => x.player === p).map(x => x.card)]);
      assert.equal(new Set(restored.flat()).size, 32);
      for (const trick of history) for (let i = 0; i < trick.length; i++) {
        const p = trick[i];
        assert.ok(legalCards(restored[p.player], trick.slice(0, i), contract, p.player).includes(p.card), `${contract}: ${p.card}`);
        restored[p.player].splice(restored[p.player].indexOf(p.card), 1);
      }
    }
    assert.deepEqual(v, original);
  }
});

test('medium and hard fallback use the same legal policy; hard does not mutate public state', () => {
  const { v } = gameView();
  const before = structuredClone(v);
  assert.deepEqual(hardAction(v, 0, seeded(1)), basicAction(v, seeded(1)));
  const a = hardAction(v, 60, seeded(1));
  assert.equal(a.type, 'play');
  if (a.type === 'play') assert.ok(v.legalCards.includes(a.card));
  assert.deepEqual(v, before);
});

test('suit-contract tactics are disabled for no trump and all trump', () => {
  for (const contract of ['NT', 'AT'] as const) {
    const { v } = gameView(contract);
    assert.ok(decideCard(v).candidates.every(c => c.reasons.every(r => !r.id.startsWith('trump.'))));
  }
});


test("preserve the partner's known last trump when they can ruff a side suit", () => {
  const v = position('H-J H-9 C-7 D-Q D-8 S-7', [plays('H-7 H-8 H-Q H-10'), plays('C-8 C-10 C-9 D-7', 3)]);
  v.belots = [{ player: 2, suit: 'H' }];
  v.announcements = [{ id: 'four-aces', kind: 'four', value: 100, strength: 1, label: 'Каре',
    cards: ['C-A', 'D-A', 'H-A', 'S-A'], player: 1 }];
  const d = decideCard(v);
  assert.notEqual(suit(d.card), 'H');
  assert.ok(d.candidates.find(c => c.card === 'H-J')!.reasons.some(r => r.id === 'trump.preserve-partner'));
});

test('no forcing bonus against an opponent who is known to have no trump', () => {
  const v = position('C-7 C-A D-Q D-K S-K S-Q', [plays('C-8 D-7 C-9 C-J'), plays('D-8 D-9 D-10 D-A', 1)], 1);
  const k = buildKnowledge(v);
  assert.ok(k.voidSuits[1].includes('H'));
  assert.ok(decideCard(v).candidates.every(c => !c.reasons.some(r => r.id === 'trump.force-ruff')));
});

test('hard endgame counts the last trick and resolves equal simulations using tactics', () => {
  const { g } = gameView();
  g.hands = ['C', 'D', 'H', 'S'].map(s => deck().filter(c => suit(c) === s));
  const history = [plays('C-A D-A H-A S-A'), plays('H-10 S-10 C-10 D-10', 2),
    plays('H-K S-K C-K D-K', 2), plays('H-Q S-Q C-Q D-Q', 2),
    plays('H-8 S-J C-J D-J', 2), plays('H-7 S-9 C-9 D-9', 2)];
  for (const trick of history) {
    for (const p of trick) applyAction(g, p.player, { type: 'play', card: p.card });
    applyAction(g, -1, { type: 'collect' });
  }
  const v = view(g, 2), before = structuredClone(v);
  assert.deepEqual(v.legalCards, ['H-9', 'H-J']);
  const d = decideHardCard(v, 2000, seeded(2));
  assert.equal(d.card, 'H-J');
  assert.ok(d.reasons.some(r => r.id === 'search.sampled-points'));
  assert.deepEqual(d.candidates.map(c => c.score), [44, 44]); // Nine + jack + last trick.
  assert.deepEqual(v, before);
});

test('invalid sampling capacity falls back with an explanation', () => {
  const { v } = gameView();
  v.counts[1]++;
  assert.equal(sampleHands(v, seeded(1)), null);
  const d = decideHardCard(v, 100, seeded(1));
  assert.equal(d.card, decideCard(v).card);
  assert.ok(d.reasons.some(r => r.id === 'search.fallback'));
});
