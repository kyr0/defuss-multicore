import { expose } from 'defuss-multicore/worker';
import { tasks } from '../shared/tasks.mjs';
export type Tasks = typeof tasks;
await expose(tasks);
