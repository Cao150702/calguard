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
        upsert() {} search() { return []; } getCount() { return 0; }
      }`,
    };
    if (Object.hasOwn(mocks, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
