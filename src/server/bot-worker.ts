import { parentPort, workerData } from 'node:worker_threads';
import { workerAction } from './learned-bot.js';
import type { View } from '../game/types.js';
const action='view' in workerData
  ? workerAction(workerData.view as View,workerData.modelPath,workerData.modelId)
  : workerAction(workerData as View);
parentPort!.postMessage(action);
