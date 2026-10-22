import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { applyAction, deck, newGame, view } from '../src/game/engine.js';
import { ACTION_SIZE, ENCODING_VERSION, INPUT_SIZE, OBSERVATION_SIZE, encodeAction, encodeObservation, learnedAction, learningActions, scoreActions, validateModel, type LearnedModel } from '../src/game/learning.js';
import { referenceFingerprint } from '../src/server/bot-reference.js';
import { loadApprovedModel, modelDigest, validateApproval, workerAction, type EvaluationReport, type ModelApproval } from '../src/server/learned-bot.js';
import type { Card, Contract, View } from '../src/game/types.js';

function game(contract: Contract = 'H') {
  const g = newGame('hard', () => .3);
  applyAction(g, 0, { type: 'bid', bid: contract });
  for (const p of [1, 2, 3]) applyAction(g, p, { type: 'bid', bid: 'pass' });
  return g;
}
function arrange(hand: Card[], contract: Contract) {
  const g = game(contract), rest = deck().filter(c => !hand.includes(c));
  g.hands = [hand, rest.slice(0, 8), rest.slice(8, 16), rest.slice(16)];
  return g;
}
function zeroModel(): LearnedModel {
  return { formatVersion: 1, encodingVersion: ENCODING_VERSION, observationSize: OBSERVATION_SIZE,
    actionSize: ACTION_SIZE, hiddenSizes: [128, 128], layers: [INPUT_SIZE, 128, 128].map((n, i) => ({
      weight: Array.from({ length: i === 2 ? 1 : 128 }, () => Array(n).fill(0)), bias: Array(i === 2 ? 1 : 128).fill(0)
    })) };
}
function report(digest: string, partner: 'hard' | 'medium'): EvaluationReport {
  const seeds = partner === 'hard' ? 1000 : 200;
  return { version: 1, modelSha256: digest, referenceFingerprint: referenceFingerprint(), split: 'final', partner,
    seedsRequested: seeds, completedSeeds: seeds, games: seeds * 4, complete: true,
    confidence: { mean: .6, lower: .55, upper: .65 }, latency: { count: 100, p95Ms: 10 } };
}
function approval(digest: string): ModelApproval { return { version: 1, modelSha256: digest, primary: report(digest, 'hard'), crossplay: report(digest, 'medium') }; }
class Environment {
  child = spawn(process.execPath, ['--import', 'tsx', 'training/environment.ts'], { stdio: ['pipe', 'pipe', 'inherit'] });
  lines = createInterface({ input: this.child.stdout });
  iterator = this.lines[Symbol.asyncIterator]();
  async call(command: string, args: Record<string, unknown> = {}): Promise<any> {
    this.child.stdin.write(JSON.stringify({ command, ...args }) + '\n');
    const line = await this.iterator.next();
    assert.ok(!line.done, 'environment exited');
    const result = JSON.parse(line.value);
    assert.ok(result.ok, result.error);
    return result.result;
  }
  close() { this.child.stdin.end(); this.lines.close(); this.child.kill(); }
}

test('learning enumerates only legal bids, non-overlapping declarations and optional belot', () => {
  const bidding = newGame('hard');
  for (const a of learningActions(view(bidding, 0))) applyAction(structuredClone(bidding), 0, a);
  for (const g of [arrange(['H-7', 'H-8', 'H-9', 'H-10', 'H-J', 'C-J', 'D-J', 'S-J'], 'AT'),
    arrange(['H-Q', 'H-K', 'H-7', 'H-8', 'C-7', 'D-7', 'S-7', 'C-A'], 'H')]) {
    const v = view(g, 0), actions = learningActions(v);
    assert.ok(actions.some(a => a.type === 'play' && !a.declare?.length));
    for (const a of actions) {
      applyAction(structuredClone(g), 0, a);
      assert.equal(encodeAction(v, a).length, ACTION_SIZE);
    }
    if (g.contract === 'AT') {
      assert.equal(v.declarations.length, 2);
      assert.equal(actions.length, 24); // Eight cards times empty / sequence / four.
    } else {
      assert.ok(actions.some(a => a.type === 'play' && a.card === 'H-Q' && a.belot));
      assert.ok(actions.some(a => a.type === 'play' && a.card === 'H-Q' && !a.belot));
    }
  }
});

test('observation is private, preserves order and normalizes seating and team scores', () => {
  const g = game(); g.scores = [34, 71]; const v = view(g, 0);
  const observation = encodeObservation(v);
  assert.equal(observation.length, OBSERVATION_SIZE);
  [g.hands[1][0], g.hands[3][0]] = [g.hands[3][0], g.hands[1][0]];
  assert.deepEqual(encodeObservation(view(g, 0)), observation);
  const reversed = structuredClone(v);
  reversed.calls.reverse();
  assert.notDeepEqual(encodeObservation(reversed), observation);
  const rotated: View = { ...structuredClone(v), seat: 1, dealer: (v.dealer + 1) % 4, turn: (v.turn + 1) % 4,
    declarer: v.declarer === null ? null : (v.declarer + 1) % 4,
    scores: [...v.scores].reverse(), counts: [v.counts[3], ...v.counts.slice(0, 3)],
    calls: v.calls.map(c => ({ ...c, player: (c.player + 1) % 4 })) };
  assert.deepEqual(encodeObservation(rotated), observation);
  const publicAnn = structuredClone(v);
  publicAnn.announcements = [{ id: 'hidden', kind: 'four', cards: [], player: 1, value: 0, strength: 0, label: 'Каре' }];
  const hidden = structuredClone(publicAnn) as View & { hands?: Card[][]; stock?: Card[] };
  hidden.hands = g.hands; hidden.stock = ['H-J']; hidden.message = 'arbitrary private text';
  assert.deepEqual(encodeObservation(hidden), encodeObservation(publicAnn));
});

test('model inference is legal and rejects incompatible or non-finite artifacts', () => {
  const model = validateModel(zeroModel()), v = view(game(), 0);
  const start = performance.now();
  const action = learnedAction(v, model);
  assert.deepEqual(action, learningActions(v)[0]);
  assert.ok(performance.now() - start < 220);
  assert.deepEqual(scoreActions(model, encodeObservation(v), [encodeAction(v, action)]), [0]);
  assert.throws(() => validateModel({ ...model, encodingVersion: 99 }));
  model.layers[0].weight[0][0] = Infinity;
  assert.throws(() => validateModel(model));
  assert.throws(() => validateModel({}));
});

test('activation requires complete held-out primary and crossplay reports tied to the exact artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belot-model-'));
  try {
    const path = join(dir, 'model.json'), bytes = JSON.stringify(zeroModel()), digest = modelDigest(bytes);
    writeFileSync(path, bytes);
    assert.throws(() => loadApprovedModel(path));
    const valid = approval(digest);
    validateApproval(valid, digest);
    for (const mutate of [
      (a: ModelApproval) => { a.primary.completedSeeds = 999; },
      (a: ModelApproval) => { a.primary.complete = false; },
      (a: ModelApproval) => { a.primary.split = 'validation'; },
      (a: ModelApproval) => { a.primary.confidence.lower = .5; },
      (a: ModelApproval) => { a.crossplay.games--; },
      (a: ModelApproval) => { a.primary.latency.p95Ms = 221; },
      (a: ModelApproval) => { a.modelSha256 = 'wrong'; }
    ]) { const a = structuredClone(valid); mutate(a); assert.throws(() => validateApproval(a, digest)); }
    writeFileSync(`${path}.approval.json`, JSON.stringify(valid));
    assert.ok(loadApprovedModel(path));
    const stale = structuredClone(valid);
    stale.primary.referenceFingerprint = stale.crossplay.referenceFingerprint = '0'.repeat(64);
    writeFileSync(`${path}.approval.json`, JSON.stringify(stale));
    assert.throws(() => loadApprovedModel(path));
    writeFileSync(`${path}.approval.json`, JSON.stringify(valid));
    const v = view(newGame('hard'), 0);
    assert.deepEqual(workerAction(v, path), { type: 'bid', bid: 'pass' });
    writeFileSync(path, bytes + ' ');
    assert.throws(() => loadApprovedModel(path));
    assert.ok(v.legalBids.includes((workerAction(v, path) as { bid: any }).bid));
    assert.ok(v.legalBids.includes((workerAction(v, join(dir, 'missing')) as { bid: any }).bid));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persistent environment resumes game and random stream, with no fabricated terminal rewards', async () => {
  const a = new Environment(), b = new Environment();
  try {
    const info = await a.call('info');
    assert.equal(info.observationSize, OBSERVATION_SIZE);
    const first = await a.call('reset', { namespace: 'test-v1', seed: 12 });
    assert.equal(first.done, false);
    assert.ok(!('rewards' in first));
    for (let i = 0; i < 12; i++) await a.call('act', { policy: 'medium' });
    const snapshot = await a.call('snapshot');
    await b.call('restore', { snapshot });
    for (let i = 0; i < 25; i++) {
      const x = await a.call('act', { policy: 'medium' }), y = await b.call('act', { policy: 'medium' });
      delete x.elapsedMs; delete y.elapsedMs;
      assert.deepEqual(x, y);
    }
    assert.deepEqual(await a.call('snapshot'), await b.call('snapshot'));
    const other = await b.call('reset', { namespace: 'validation-v1', seed: 12 });
    assert.notDeepEqual(other.observation, first.observation);
  } finally { a.close(); b.close(); }
});

test('environment awards the full match result and advances capot instead of inventing a win', async () => {
  const env = new Environment();
  try {
    await env.call('reset', { namespace: 'test-v1', seed: 0 });
    const snapshot = await env.call('snapshot');
    const g = snapshot.game;
    const remaining: Card[] = ['C-A', 'C-7', 'C-8', 'C-9'];
    const played = deck().filter(c => !remaining.includes(c));
    g.hands = [['C-A'], [], [], []]; g.stock = []; g.phase = 'playing'; g.turn = 0;
    g.contract = 'H'; g.declarer = 0; g.multiplier = 4; g.hanging = 20; g.scores = [150, 0];
    g.trick = remaining.slice(1).map((card, i) => ({ player: i + 1, card }));
    g.tricks = Array.from({ length: 7 }, (_, i) => ({ winner: i === 0 ? 1 : 0,
      plays: played.slice(i * 4, i * 4 + 4).map((card, player) => ({ card, player })) }));
    g.announcements = []; g.belots = [];
    const nonCapot = structuredClone(snapshot);
    await env.call('restore', { snapshot: nonCapot });
    const ended = await env.call('step', { index: 0 });
    assert.equal(ended.done, true);
    assert.deepEqual(ended.rewards, [1, -1]);
    assert.equal(ended.results.at(-1).multiplier, 4);
    assert.equal(ended.results.at(-1).hanging, 0);
    for (const t of g.tricks) t.winner = 0;
    await env.call('restore', { snapshot });
    const capot = await env.call('step', { index: 0 });
    assert.equal(capot.done, false);
    assert.ok(!('rewards' in capot));
    assert.equal((await env.call('snapshot')).game.results.at(-1).capot, true);
  } finally { env.close(); }
});
