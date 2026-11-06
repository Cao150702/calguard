// Offline CLI delivery tests: real Commander, fail-closed stand-ins for every
// application dependency. Unknown entrypoint imports are rejected, not loaded.
import { pathToFileURL } from 'node:url';

const dependencies = new Map([
  ['../config/loader.js', ['loadConfig', 'ensureDataDir']],
  ['../sources/calendar/apple.js', ['AppleCalendarSource']],
  ['../sources/messages/mac_mail.js', ['MacMailSource']],
  ['../sources/messages/email.js', ['EmailSource']],
  ['../notifiers/workbuddy.js', ['WorkbuddyNotifier']],
  ['../notifiers/feishu.js', ['FeishuNotifier']],
  ['../notifiers/email.js', ['EmailNotifier']],
  ['../notifiers/dingtalk.js', ['DingtalkNotifier']],
  ['../notifiers/wecom.js', ['WecomNotifier']],
  ['../sources/errors.js', ['PartialFetchError']],
  ['../scheduler/cron.js', ['CalGuardScheduler']],
  ['../engine/indexer.js', ['MessageIndexer']],
  ['../engine/extractor.js', ['extractKeywords']],
  ['../engine/summarizer.js', ['generateBrief']],
]);

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === process.env.CALGUARD_TEST_ENTRY_URL) {
    if (specifier === 'commander') {
      if (!process.env.CALGUARD_TEST_COMMANDER_ENTRY) throw new Error('Real Commander path required');
      return { url: pathToFileURL(process.env.CALGUARD_TEST_COMMANDER_ENTRY).href, shortCircuit: true };
    }
    const names = dependencies.get(specifier);
    if (!names) throw new Error(`Unexpected CLI dependency: ${specifier}`);
    const source = `
      import { appendFileSync } from 'node:fs';
      function forbidden(name) {
        appendFileSync(process.env.CALGUARD_TEST_CALLS, name + '\\n');
        throw new Error('CLI help must not initialize application dependency: ' + name);
      }
      ${names.map(name => `export function ${name}() { forbidden(${JSON.stringify(name)}); }`).join('\n')}
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
