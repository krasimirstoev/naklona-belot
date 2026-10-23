import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Source hashes are shipped at build time so development and compiled workers agree. */
export function referenceFingerprint(): string {
  if (import.meta.url.endsWith('.js')) {
    const value = JSON.parse(readFileSync(new URL('../bot-reference.json', import.meta.url), 'utf8')).fingerprint;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid reference fingerprint');
    return value;
  }
  const hash = createHash('sha256');
  for (const name of ['engine', 'types', 'bots', 'bot-knowledge', 'bot-tactics', 'bot-analysis', 'bot-strategy', 'bot-sampling', 'bot-objective', 'bot-no-trump', 'learning']) {
    hash.update(readFileSync(new URL(`../game/${name}.ts`, import.meta.url)));
  }
  hash.update(readFileSync(new URL('../game/learning-manifest.json', import.meta.url)));
  return hash.digest('hex');
}
