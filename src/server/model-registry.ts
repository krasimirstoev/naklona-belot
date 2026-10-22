import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadApprovedModel, modelDigest, type ModelApproval } from './learned-bot.js';

export interface ActiveModels { version: 1; current: string | null; previous: string | null; revision: number }
export const registryDirectory = () => resolve(process.env.BELOT_MODEL_REGISTRY ?? 'data/models');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export function modelPath(id: string, directory = registryDirectory()): string {
  if (!validId(id)) throw new Error('Invalid model identifier');
  return join(directory, 'versions', id, 'model.json');
}
export function activeModels(directory = registryDirectory()): ActiveModels {
  const path = join(directory, 'active.json');
  if (!existsSync(path)) return { version: 1, current: null, previous: null, revision: 0 };
  const state: ActiveModels = JSON.parse(readFileSync(path, 'utf8'));
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    (state.current !== null && !validId(state.current)) || (state.previous !== null && !validId(state.previous))) throw new Error('Invalid active model registry');
  return state;
}
function immutableFile(path: string, bytes: string) {
  try { writeFileSync(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw new Error('Immutable model version already exists with different contents');
  }
}
export function registerModel(source: string, directory = registryDirectory()): string {
  loadApprovedModel(source);
  const bytes = readFileSync(source, 'utf8'), approval = readFileSync(`${source}.approval.json`, 'utf8');
  const id = modelDigest(bytes), target = modelPath(id, directory);
  // Validate the exact captured pair, not files that might change between reads.
  const temp = join(directory, `.register-${randomUUID()}.json`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temp, bytes, { flag: 'wx' });
    writeFileSync(`${temp}.approval.json`, approval, { flag: 'wx' });
    loadApprovedModel(temp, id);
    mkdirSync(join(directory, 'versions', id), { recursive: true });
    immutableFile(target, bytes); immutableFile(`${target}.approval.json`, approval);
  } finally {
    for (const p of [temp, `${temp}.approval.json`]) if (existsSync(p)) unlinkSync(p);
  }
  return id;
}
function locked<T>(directory: string, run: () => T): T {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'activation.lock');
  let fd: number;
  try { fd = openSync(path, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid activation lock');
    try { process.kill(pid, 0); throw new Error('Another activation is running'); }
    catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
    unlinkSync(path); fd = openSync(path, 'wx');
  }
  writeFileSync(fd, String(process.pid));
  try { return run(); } finally { closeSync(fd); unlinkSync(path); }
}
function writeActive(directory: string, state: ActiveModels) {
  const temp = join(directory, `.active-${randomUUID()}.json`);
  try { writeFileSync(temp, JSON.stringify(state), { flag: 'wx' }); renameSync(temp, join(directory, 'active.json')); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function activateModel(source: string, directory = registryDirectory()): ActiveModels {
  return locked(directory, () => {
    const state = activeModels(directory);
    loadApprovedModel(source);
    const id = modelDigest(readFileSync(source, 'utf8'));
    const approval: ModelApproval = JSON.parse(readFileSync(`${source}.approval.json`, 'utf8'));
    if (state.current && state.current !== id && approval.champion?.opponentSha256 !== state.current) throw new Error('A successful final comparison against the current active model is required');
    const registered = registerModel(source, directory);
    if (registered !== id) throw new Error('Source model changed during activation');
    if (state.current === id) return state;
    const next = { version: 1 as const, current: id, previous: state.current, revision: state.revision + 1 };
    writeActive(directory, next); return next;
  });
}
export function rollbackModel(directory = registryDirectory()): ActiveModels {
  return locked(directory, () => {
    const state = activeModels(directory);
    if (!state.revision) throw new Error('No activation to roll back');
    if (state.previous) loadApprovedModel(modelPath(state.previous, directory), state.previous);
    const next = { version: 1 as const, current: state.previous, previous: state.current, revision: state.revision + 1 };
    writeActive(directory, next); return next;
  });
}
/** Called once at match creation. Restored matches always retain their saved identifier. */
export function modelForNewMatch(directory = registryDirectory(), legacyPath = process.env.BELOT_MODEL_PATH): string | null {
  try {
    if (existsSync(join(directory, 'active.json'))) {
      const id = activeModels(directory).current;
      if (id) loadApprovedModel(modelPath(id, directory), id);
      return id;
    }
    return legacyPath ? registerModel(legacyPath, directory) : null;
  } catch { return null; }
}
