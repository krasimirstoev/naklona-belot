import { mkdirSync, writeFileSync } from 'node:fs';
import { referenceFingerprint } from '../src/server/bot-reference.js';
mkdirSync('dist/server', { recursive: true });
writeFileSync('dist/server/bot-reference.json', JSON.stringify({ fingerprint: referenceFingerprint() }));
