import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { applyAction, newGame, view } from '../src/game/engine.js';
import { basicAction, hardAction } from '../src/game/bots.js';
import { ACTION_SIZE, ENCODING_VERSION, OBSERVATION_SIZE, actionKey, encodeAction, encodeObservation, learnedAction, learningActions, scoreActions, validateModel, type LearnedModel } from '../src/game/learning.js';
import { referenceFingerprint as getReferenceFingerprint } from '../src/server/bot-reference.js';
import { activeModels, activateModel, modelPath, rollbackModel } from '../src/server/model-registry.js';
import { loadApprovedModel, readModel, validateApproval, type ModelApproval } from '../src/server/learned-bot.js';
import type { Action, Game } from '../src/game/types.js';

const referenceFingerprint = getReferenceFingerprint();
let game: Game | undefined, randomState = 1, botState = 1;
let model: LearnedModel | undefined, opponent: LearnedModel | undefined;
let namespace = '', seed = 0;
function random(): number { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; }
function botRandom(): number { botState = (Math.imul(botState, 1664525) + 1013904223) >>> 0; return botState / 4294967296; }
function advance() {
  if (!game) throw new Error('Environment not initialized');
  while (game.phase === 'trick' || game.phase === 'roundEnd') applyAction(game, game.phase === 'trick' ? -1 : 0, { type: game.phase === 'trick' ? 'collect' : 'next' }, random);
}
function observation() {
  if (!game) throw new Error('Environment not initialized');
  if (game.phase === 'matchEnd') {
    const won = game.scores[0] > game.scores[1] ? 0 : 1;
    return { done: true, rewards: won === 0 ? [1, -1] : [-1, 1], scores: game.scores, results: game.results };
  }
  const v = view(game, game.turn), actions = learningActions(v);
  return { done: false, seat: v.seat, team: v.seat % 2, observation: encodeObservation(v), actions,
    actionFeatures: actions.map(a => encodeAction(v, a)), phase: v.phase, contract: v.contract };
}
function info() { return { version: 1, encodingVersion: ENCODING_VERSION, observationSize: OBSERVATION_SIZE, actionSize: ACTION_SIZE, referenceFingerprint }; }
function recommendation(policy: string, budgetMs = 220) {
  if (!game) throw new Error('Environment not initialized');
  const v = view(game, game.turn), actions = learningActions(v);
  let action: Action;
  const start = performance.now();
  if (policy === 'model' || policy === 'opponent') {
    const selected=policy==='model'?model:opponent;
    if (!selected) throw new Error('Model not loaded');
    action = learnedAction(v, selected);
  } else if (policy === 'medium') action = basicAction({ ...v, difficulty: 'medium' }, botRandom);
  else if (policy === 'hard') action = namespace.startsWith('train-')
    ? hardAction({ ...v, difficulty: 'hard' }, 10000, botRandom, 4)
    : hardAction({ ...v, difficulty: 'hard' }, budgetMs, botRandom);
  else throw new Error('Unknown policy');
  const index = actions.findIndex(a => actionKey(a) === actionKey(action));
  if (index < 0) throw new Error('Policy produced an action outside the legal enumeration');
  return { index, elapsedMs: performance.now() - start };
}
function step(index: number) {
  if (!game) throw new Error('Environment not initialized');
  const actions = learningActions(view(game, game.turn));
  if (!Number.isInteger(index) || !actions[index]) throw new Error('Invalid action index');
  applyAction(game, game.turn, actions[index], random); advance();
  return observation();
}
function command(c: Record<string, any>): unknown {
  switch (c.command) {
    case 'info': return info();
    case 'reset': {
      if (!(typeof c.namespace==='string' && /^(train-collect-v1|train-selfplay-v1|profile-v1|test-v1|(?:validation-v1|final-v1)(?::[a-f0-9]{32})?)$/.test(c.namespace)) || !Number.isSafeInteger(c.seed) || c.seed < 0) throw new Error('Invalid seed namespace');
      namespace = c.namespace; seed = c.seed;
      const bytes = createHash('sha256').update(`${namespace}:${seed}`).digest();
      randomState = bytes.readUInt32LE(0); botState = bytes.readUInt32LE(4);
      game = newGame('hard', random); return observation();
    }
    case 'observe': return observation();
    case 'step': return step(c.index);
    case 'recommend': return recommendation(c.policy, c.budgetMs);
    case 'act': { const r = recommendation(c.policy, c.budgetMs); return { ...step(r.index), elapsedMs: r.elapsedMs }; }
    case 'snapshot': return { version: 1, referenceFingerprint, game, randomState, botState, namespace, seed };
    case 'restore': {
      const s = c.snapshot;
      if (s.version !== 1 || s.referenceFingerprint !== referenceFingerprint || !s.game || !Number.isInteger(s.randomState) || !Number.isInteger(s.botState)) throw new Error('Incompatible environment checkpoint');
      game = s.game; randomState = s.randomState; botState = s.botState; namespace = s.namespace; seed = s.seed;
      return observation();
    }
    case 'loadModel': { const loaded = readModel(c.path); model = loaded.model; return { loaded: true, digest: loaded.digest }; }
    case 'loadOpponent': { const loaded=readModel(c.path); opponent=loaded.model; return {loaded:true,digest:loaded.digest}; }
    case 'registryStatus': return activeModels(c.directory);
    case 'registryModel': { const path=modelPath(c.id,c.directory); loadApprovedModel(path,c.id); return {path}; }
    case 'activate': return activateModel(c.path,c.directory);
    case 'rollback': return rollbackModel(c.directory);
    case 'score': return { scores: scoreActions(validateModel(c.model), c.observation, c.actions) };
    case 'validateApproval': validateApproval(c.approval as ModelApproval, c.digest); return { valid: true };
    default: throw new Error('Unknown environment command');
  }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  try { process.stdout.write(`${JSON.stringify({ ok: true, result: command(JSON.parse(line)) })}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`); }
}
