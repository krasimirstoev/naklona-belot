import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { referenceFingerprint } from './bot-reference.js';
import { hardAction } from '../game/bots.js';
import { learnedAction, validateModel, type LearnedModel } from '../game/learning.js';
import type { Action, View } from '../game/types.js';

export interface EvaluationReport {
  version: number; modelSha256: string; referenceFingerprint: string;
  split: 'validation' | 'final'; partner: 'medium' | 'hard';
  namespace?: string; opponentSha256?: string;
  seedsRequested: number; completedSeeds: number; games: number; complete: boolean;
  confidence: { mean: number; lower: number; upper: number };
  latency: { count: number; p95Ms: number };
}
export interface ModelApproval { version: number; modelSha256: string; primary: EvaluationReport; crossplay: EvaluationReport; champion?: EvaluationReport }
export const modelDigest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
export function readModel(path: string): { model: LearnedModel; digest: string } {
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error('Model exceeds size limit');
  const bytes = readFileSync(path, 'utf8');
  return { model: validateModel(JSON.parse(bytes)), digest: modelDigest(bytes) };
}
function completeReport(r: EvaluationReport, digest: string, partner: string, seeds: number) {
  return r && r.version === 1 && r.modelSha256 === digest && r.partner === partner && r.complete === true &&
    Number.isInteger(r.seedsRequested) && r.seedsRequested >= seeds && r.completedSeeds === r.seedsRequested &&
    r.games === r.seedsRequested * 4 && typeof r.referenceFingerprint === 'string' && r.referenceFingerprint.length === 64 &&
    [r.confidence?.lower, r.confidence?.upper, r.confidence?.mean].every(x => Number.isFinite(x) && x >= 0 && x <= 1) &&
    r.confidence.lower <= r.confidence.mean && r.confidence.mean <= r.confidence.upper &&
    r.latency?.count > 0 && Number.isFinite(r.latency.p95Ms) && r.latency.p95Ms >= 0 && r.latency.p95Ms <= 220;
}
export function validateApproval(a: ModelApproval, digest: string): void {
  if (!a || a.version !== 1 || a.modelSha256 !== digest || !completeReport(a.primary, digest, 'hard', 1000) ||
    a.primary.split !== 'final' || a.primary.confidence.lower <= .5 || !!a.primary.opponentSha256 || !!a.crossplay.opponentSha256 ||
    !completeReport(a.crossplay, digest, 'medium', 200) || a.crossplay.referenceFingerprint !== a.primary.referenceFingerprint) {
    throw new Error('Model has not passed independent evaluation and crossplay');
  }
  if (a.champion && (!completeReport(a.champion, digest, 'hard', 1000) || a.champion.split !== 'final' ||
    a.champion.confidence.lower <= .5 || !/^[a-f0-9]{64}$/.test(a.champion.opponentSha256 ?? '') ||
    a.champion.referenceFingerprint !== a.primary.referenceFingerprint)) throw new Error('Invalid comparison against the active model');
}
export function loadApprovedModel(path: string, expectedDigest?: string | null): LearnedModel {
  const { model, digest } = readModel(path);
  if (expectedDigest && digest !== expectedDigest) throw new Error('Pinned model bytes changed');
  if (statSync(`${path}.approval.json`).size > 4 * 1024 * 1024) throw new Error('Approval exceeds size limit');
  const approval: ModelApproval = JSON.parse(readFileSync(`${path}.approval.json`, 'utf8'));
  validateApproval(approval, digest);
  if (approval.primary.referenceFingerprint !== referenceFingerprint()) throw new Error('Reference bot changed after evaluation');
  return model;
}
/** Model failures are contained in the worker; the previous hard policy stays available. */
export function workerAction(v: View, path: string | null | undefined = process.env.BELOT_MODEL_PATH, expectedDigest?: string | null): Action {
  if (path) try {
    const start = performance.now();
    const action = learnedAction(v, loadApprovedModel(path, expectedDigest));
    if (performance.now() - start <= 220) return action;
  } catch { /* Missing, incompatible, unqualified or failing models fall back to the hard bot. */ }
  return hardAction(v);
}
