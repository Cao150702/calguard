import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CalendarEvent, CalendarSource, Notifier, NotifyParams } from "../sources/types.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Positive whole minutes/hours, with a one-year safety limit for calendar queries. */
export function parseReminderOffset(value: string): number | undefined {
  const match = /^([1-9]\d*)(m|h)$/.exec(value);
  if (!match) return undefined;
  const offset = Number(match[1]) * (match[2] === "h" ? 60 * MINUTE : MINUTE);
  return Number.isSafeInteger(offset) && offset <= 365 * DAY ? offset : undefined;
}

interface SentRecord {
  eventId: string;
  remindAt: string;
  sentAt: string;
  // Older versions wrote only the three fields above.
  eventStart?: string;
  source?: string;
  eventSource?: string;
  calendar?: string;
  notifier?: string;
}

export interface ReminderRunnerOptions {
  calendarSources: CalendarSource[];
  notifiers: Notifier[];
  remindAt: string[];
  statePath: string;
  prepareNotification: (event: CalendarEvent, remindAt: string) => Promise<NotifyParams | undefined>;
  now?: () => Date;
}

/** Shared due-only checks for daemon and one-shot execution. No timers or live sources here. */
export class ReminderRunner {
  private readonly now: () => Date;
  private readonly reminders: Array<{ label: string; offset: number }>;
  private sentRecords: SentRecord[];
  private inFlight?: Promise<void>;
  private persistenceError?: Error;

  constructor(private readonly options: ReminderRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    const offsets = new Set<number>();
    this.reminders = options.remindAt.flatMap((label) => {
      const offset = parseReminderOffset(label);
      if (offset === undefined) throw new Error(`无效提醒时间: ${label}`);
      if (offsets.has(offset)) return [];
      offsets.add(offset);
      return [{ label, offset }];
    });
    this.sentRecords = this.loadState();
    this.pruneState();
  }

  get sentCount(): number {
    return this.sentRecords.length;
  }

  /** Coalesce overlapping startup, cron and manual checks within this process. */
  check(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.checkOnce().finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  /** Graceful shutdown waits for delivery and its durable state update. */
  waitForIdle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private async checkOnce(): Promise<void> {
    if (this.persistenceError) throw this.persistenceError;
    if (this.reminders.length === 0 || this.options.notifiers.length === 0) return;
    const lockPath = `${this.options.statePath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    let lock: number;
    try {
      lock = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`提醒检查锁已存在: ${lockPath}；请勿并行运行。若上次进程异常退出，请先核对发送状态再移除锁文件`);
      }
      throw err;
    }
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() }));
      // Another daemon/one-shot instance may have saved deliveries since construction.
      this.sentRecords = this.loadState();
      await this.checkLocked();
    } finally {
      closeSync(lock);
      // If delivery succeeded but persistence failed, a restart must not silently
      // replay it. Keep the lock until an operator reconciles the uncertain send.
      if (!this.persistenceError) rmSync(lockPath);
    }
  }

  private async checkLocked(): Promise<void> {
    this.pruneState();
    if (this.reminders.length === 0 || this.options.notifiers.length === 0) return;
    const maxOffset = Math.max(...this.reminders.map((r) => r.offset));
    const failures: Error[] = [];

    for (const source of this.options.calendarSources) {
      const from = this.now();
      // Include the exact boundary even for adapters whose end range is exclusive.
      const to = new Date(from.getTime() + maxOffset + MINUTE);
      let events: CalendarEvent[];
      try {
        events = await source.fetchEvents(from, to);
      } catch (err) {
        failures.push(new Error(`日历源 ${source.name} 检查失败`, { cause: err }));
        console.error(`[Scheduler] ${source.name} 检查失败:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      for (const event of events) {
        const start = event.start.getTime();
        if (!Number.isFinite(start)) continue;
        for (const { label, offset } of this.reminders) {
          const now = this.now().getTime();
          // Catch up after delays/restarts, but never send early or after a meeting starts.
          if (start <= now || start - offset > now) continue;
          const counts = new Map<string, number>();
          const destinations = new Set<string>();
          const pending = this.options.notifiers.flatMap((notifier) => {
            const ordinal = counts.get(notifier.name) ?? 0;
            counts.set(notifier.name, ordinal + 1);
            const key = notifier.deliveryId === undefined
              ? `${notifier.name}:${ordinal}`
              : JSON.stringify([notifier.name, notifier.deliveryId]);
            if (destinations.has(key) || this.alreadySent(event, source.name, offset, key)) return [];
            destinations.add(key);
            return [{ notifier, key }];
          });
          if (pending.length === 0) continue;

          let params: NotifyParams | undefined;
          try {
            params = await this.options.prepareNotification(event, label);
          } catch (err) {
            failures.push(new Error(`日程 ${event.title} (${label}) 简报失败`, { cause: err }));
            console.error(`[Scheduler] ${event.title} 简报失败:`, err instanceof Error ? err.message : String(err));
            continue;
          }
          if (!params) continue;
          for (const { notifier, key } of pending) {
            const sendTime = this.now().getTime();
            if (start <= sendTime || start - offset > sendTime) break;
            try {
              await notifier.send(params);
            } catch (err) {
              failures.push(new Error(`通知渠道 ${notifier.name} 发送日程 ${event.title} (${label}) 失败`, { cause: err }));
              console.error(`[Scheduler] ${notifier.name} 发送失败:`, err instanceof Error ? err.message : String(err));
              continue; // Retry only failed channels on the next check.
            }
            this.sentRecords.push({
              eventId: event.id,
              remindAt: label,
              sentAt: this.now().toISOString(),
              eventStart: event.start.toISOString(),
              source: source.name,
              eventSource: event.source,
              calendar: event.calendar ?? "",
              notifier: key,
            });
            // Persist each successful channel before attempting another delivery.
            try {
              this.saveState();
            } catch (err) {
              failures.push(new Error("通知已发送但状态保存失败，停止后续发送并保留核对锁", { cause: err }));
              throw new AggregateError(failures, `提醒检查中断，共 ${failures.length} 项失败`);
            }
            console.error(`[Scheduler] 已通过 ${notifier.name} 发送通知: ${event.title} (${label})`);
          }
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `提醒检查完成，共 ${failures.length} 项失败`);
    }
  }

  private alreadySent(event: CalendarEvent, source: string, offset: number, notifier: string): boolean {
    return this.sentRecords.some((record) => {
      if (record.eventId !== event.id || parseReminderOffset(record.remindAt) !== offset) return false;
      if (record.eventStart === undefined) {
        // Legacy records used a +/-30 minute window and lack occurrence/source/channel IDs.
        return Math.abs(event.start.getTime() - offset - Date.parse(record.sentAt)) <= 30 * MINUTE;
      }
      return record.eventStart === event.start.toISOString()
        && record.source === source
        && record.eventSource === event.source
        && record.calendar === (event.calendar ?? "")
        && record.notifier === notifier;
    });
  }

  private pruneState(): void {
    const now = this.now().getTime();
    this.sentRecords = this.sentRecords.filter((record) => record.eventStart
      ? Date.parse(record.eventStart) > now
      : Date.parse(record.sentAt) > now - 7 * DAY);
  }

  private loadState(): SentRecord[] {
    let contents: string;
    try {
      contents = readFileSync(this.options.statePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: unknown = JSON.parse(contents);
    if (!Array.isArray(records) || !records.every((record) => {
      if (!record || typeof record !== "object") return false;
      const r = record as SentRecord;
      if (typeof r.eventId !== "string" || typeof r.remindAt !== "string"
          || parseReminderOffset(r.remindAt) === undefined
          || typeof r.sentAt !== "string" || !Number.isFinite(Date.parse(r.sentAt))) return false;
      return r.eventStart === undefined || (typeof r.eventStart === "string"
        && Number.isFinite(Date.parse(r.eventStart))
        && [r.source, r.eventSource, r.calendar, r.notifier].every((value) => typeof value === "string"));
    })) {
      throw new Error("提醒状态文件无效；请先备份并检查，避免重复发送通知");
    }
    return records;
  }

  private saveState(): void {
    const temporary = `${this.options.statePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.options.statePath), { recursive: true });
      writeFileSync(temporary, JSON.stringify(this.sentRecords, null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(temporary, this.options.statePath);
    } catch (err) {
      // A delivered notification cannot be rolled back. Stop further sends if state cannot be saved.
      this.persistenceError = err as Error;
      throw err;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
