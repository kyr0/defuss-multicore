import { expose } from 'defuss-multicore/worker';
import { tasks } from '../shared/tasks.mjs';
await expose(tasks);
