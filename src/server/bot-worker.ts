import { parentPort, workerData } from 'node:worker_threads';
import { hardAction } from '../game/bots.js';
import type { View } from '../game/types.js';
parentPort!.postMessage(hardAction(workerData as View));
