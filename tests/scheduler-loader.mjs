import { resolve as appleCalendarResolve } from './apple-calendar-loader.mjs';
import { resolve as emailSourceResolve } from './email-source-loader.mjs';

// Mock only the scheduler's timer registration and message index. Tests must never
// create a daemon, read the user's index, or load config/credentials from home.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/scheduler/cron.js')) {
    const mocks = {
      'node-cron': `export default { schedule(expression, callback) {
        globalThis.__calguardSchedules.push({ expression, callback });
        return { stop() { globalThis.__calguardStoppedJobs = (globalThis.__calguardStoppedJobs ?? 0) + 1; } };
      } };`,
      '../engine/indexer.js': `export class MessageIndexer {
        messages = [];
        upsert(messages) {
          if (globalThis.__calguardIndexFailure) throw new Error('synthetic index failure');
          this.messages.push(...messages);
          (globalThis.__calguardIndexedMessages ??= []).push(...messages);
        }
        search() { return this.messages; } getCount() { return this.messages.length; }
      }`,
    };
    if (Object.hasOwn(mocks, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
    }
  }
  return appleCalendarResolve(specifier, context, (specifier, context) => emailSourceResolve(specifier, context, nextResolve));
}
