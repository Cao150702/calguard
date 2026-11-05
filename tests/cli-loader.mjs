import { resolve as schedulerResolve } from './scheduler-loader.mjs';

const fakeCommander = `
export class Command {
  constructor(name = '') { this.commandName = name; this.commands = []; }
  name() { return this; } description() { return this; } version() { return this; }
  option() { return this; } addCommand(command) { this.commands.push(command); return this; }
  command(name) { const command = new Command(name); this.commands.push(command); return command; }
  action(callback) { this.callback = callback; return this; }
  parse() { throw new Error('Async CLI actions must use parseAsync'); }
  async parseAsync() { await this.commands.find(c => c.commandName === 'start').callback({ once: true, config: 'fake-config' }); }
}`;
const fakeConfig = `
export function ensureDataDir() {}
export function loadConfig() { return {
  sources: { calendars: [{ type: 'apple', enabled: true }], messages: [{ type: 'mac_mail', enabled: true }] },
  engine: { fetch_interval_minutes: 30, lookback_days: 3, summary_mode: 'standard', skip_summary_if_no_match: false, correlation_threshold: 0.3 },
  notifications: { remind_at: ['1h'], channels: [{ type: 'feishu_bot', enabled: true }, { type: 'workbuddy', enabled: true }] },
  llm: { provider: 'none', api_key: '', model: '', max_tokens: 1000 }
}; }`;
const fakePlugins = `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const scenario = process.env.CALGUARD_TEST_SCENARIO;
function record(value) { appendFileSync(join(process.env.CALGUARD_TEST_DIR, 'calls'), value + '\\n'); }
export class AppleCalendarSource {
  name = 'fake-calendar';
  async fetchEvents() {
    record('calendar');
    if (scenario === 'calendar-failure') throw new Error('synthetic calendar failure');
    if (scenario === 'empty') return [];
    const start = new Date(process.env.CALGUARD_TEST_EVENT_START);
    return [{ id: 'synthetic', title: 'Synthetic event', start, end: new Date(start.getTime() + 3600000), attendees: [], source: 'fake' }];
  }
}
export class MacMailSource {
  name = 'fake-mail';
  async fetchMessages() { record('mail'); if (scenario === 'combined') throw new Error('synthetic mail failure'); return []; }
}
export class EmailSource extends MacMailSource {}
export class FeishuNotifier {
  name = 'fake-feishu'; deliveryId = 'synthetic-feishu';
  async send() { record('feishu'); if (['all-notifiers-fail', 'combined'].includes(scenario)) throw new Error('synthetic feishu failure'); }
}
export class WorkbuddyNotifier {
  name = 'fake-workbuddy'; deliveryId = 'synthetic-workbuddy';
  async send() { record('workbuddy'); if (scenario === 'all-notifiers-fail') throw new Error('synthetic output failure'); }
}
export class EmailNotifier extends WorkbuddyNotifier {}
export class DingtalkNotifier extends WorkbuddyNotifier {}
export class WecomNotifier extends WorkbuddyNotifier {}
`;
function mocked(source) { return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }; }
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/cli/index.js')) {
    if (specifier === 'commander') return mocked(fakeCommander);
    if (specifier === '../config/loader.js') return mocked(fakeConfig);
    if (specifier.startsWith('../sources/') || specifier.startsWith('../notifiers/')) return mocked(fakePlugins);
    if (specifier === '../engine/indexer.js') return mocked('export class MessageIndexer {}');
  }
  if (context.parentURL?.endsWith('/dist/scheduler/cron.js') && specifier === 'node:os') {
    return mocked('export function homedir() { return process.env.CALGUARD_TEST_DIR; }');
  }
  return schedulerResolve(specifier, context, nextResolve);
}
