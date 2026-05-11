import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import cron from "node-cron";
import type { CalendarSource, MessageSource, Notifier, NotifyParams } from "../sources/types.js";
import type { CalGuardConfig } from "../config/schema.js";
import { MessageIndexer } from "../engine/indexer.js";
import { extractKeywords } from "../engine/extractor.js";
import { generateBrief, type SummaryMode } from "../engine/summarizer.js";

/** 状态文件路径（用于去重） */
const STATE_PATH = join(homedir(), ".calguard", "state.json");

interface SentRecord {
  eventId: string;
  remindAt: string;
  sentAt: string;
}

/**
 * CalGuard 调度器
 * 负责定时拉取消息、检查日程、触发提醒
 */
export class CalGuardScheduler {
  private indexer: MessageIndexer;
  private calendarSources: CalendarSource[] = [];
  private messageSources: MessageSource[] = [];
  private notifiers: Notifier[] = [];
  private config: CalGuardConfig;
  private sentRecords: SentRecord[] = [];

  constructor(
    config: CalGuardConfig,
    calendarSources: CalendarSource[],
    messageSources: MessageSource[],
    notifiers: Notifier[]
  ) {
    this.config = config;
    this.calendarSources = calendarSources;
    this.messageSources = messageSources;
    this.notifiers = notifiers;
    this.indexer = new MessageIndexer();
    this.loadState();
  }

  /** 启动守护进程 */
  start() {
    const interval = this.config.engine.fetch_interval_minutes;

    // 任务一：定时拉取消息，更新索引（高频，纯 I/O）
    const fetchCron = `*/${interval} * * * *`;
    cron.schedule(fetchCron, async () => {
      console.error("[Scheduler] 开始拉取消息...");
      await this.fetchAndUpdateIndex();
    });

    // 任务二：每小时检查日历，安排提醒任务
    cron.schedule("0 * * * *", async () => {
      await this.checkAndNotify();
    });

    // 立即执行一次
    console.error("[CalGuard] 守护进程已启动");
    console.error(`[CalGuard] 消息拉取间隔: 每 ${interval} 分钟`);
    console.error(`[CalGuard] 提醒检查: 每小时整点`);

    // 首次运行立即执行一次完整流程
    this.runOnce().catch((err) => {
      console.error("[CalGuard] 首次运行失败:", err);
    });
  }

  /** 首次运行完整流程（用于 WorkBuddy 自动化一次性执行） */
  async runOnce() {
    console.error("[CalGuard] 执行单次完整流程...");

    // Step 1: 拉取消息更新索引
    await this.fetchAndUpdateIndex();

    // Step 2: 拉取日程事件
    const now = new Date();
    const lookforwardMs = 25 * 3600 * 1000; // 未来 25 小时
    const lookahead = new Date(now.getTime() + lookforwardMs);

    const allEvents: Array<{ event: any; source: string }> = [];
    for (const calSource of this.calendarSources) {
      try {
        console.error(`[CalGuard] 从 ${calSource.name} 拉取日程...`);
        const events = await calSource.fetchEvents(now, lookahead);
        for (const e of events) {
          allEvents.push({ event: e, source: calSource.name });
        }
        console.error(`[CalGuard] ${calSource.name}: 找到 ${events.length} 个日程`);
      } catch (err) {
        console.error(`[CalGuard] ${calSource.name} 拉取失败:`, (err as Error).message);
      }
    }

    if (allEvents.length === 0) {
      console.error("[CalGuard] 没有即将到来的日程");
      return;
    }

    // Step 3: 逐个事件检查是否需要提醒
    for (const { event } of allEvents) {
      for (const remindAt of this.config.notifications.remind_at) {
        const triggerTime = this.calcTriggerTime(event.start, remindAt);
        const diff = Math.abs(triggerTime.getTime() - now.getTime());

        // 30 分钟容差窗口
        if (diff <= 30 * 60 * 1000) {
          await this.processEvent(event, remindAt);
        }
      }
    }

    this.saveState();
    console.error("[CalGuard] 单次流程完成");
  }

  /** 拉取消息并更新索引 */
  private async fetchAndUpdateIndex() {
    const since = new Date(Date.now() - this.config.engine.lookback_days * 86400000);

    for (const source of this.messageSources) {
      try {
        console.error(`[Scheduler] 从 ${source.name} 拉取消息 (since ${since.toLocaleDateString()})...`);
        const messages = await source.fetchMessages(since);
        if (messages.length > 0) {
          this.indexer.upsert(messages);
        }
        console.error(`[Scheduler] ${source.name}: 拉取 ${messages.length} 条消息`);
      } catch (err) {
        console.error(`[Scheduler] ${source.name} 拉取失败:`, (err as Error).message);
      }
    }
  }

  /** 检查日程并触发提醒 */
  private async checkAndNotify() {
    const now = new Date();
    const lookahead = new Date(now.getTime() + 25 * 3600000);

    for (const calSource of this.calendarSources) {
      try {
        const events = await calSource.fetchEvents(now, lookahead);
        for (const event of events) {
          for (const remindAt of this.config.notifications.remind_at) {
            const triggerTime = this.calcTriggerTime(event.start, remindAt);
            const diff = Math.abs(triggerTime.getTime() - now.getTime());
            if (diff <= 5 * 60 * 1000) {
              await this.processEvent(event, remindAt);
            }
          }
        }
      } catch (err) {
        console.error(`[Scheduler] ${calSource.name} 检查失败:`, (err as Error).message);
      }
    }
  }

  /** 计算触发时间 */
  private calcTriggerTime(eventStart: Date, remindAt: string): Date {
    const offsetMap: Record<string, number> = {
      "24h": 24 * 3600000,
      "12h": 12 * 3600000,
      "2h": 2 * 3600000,
      "1h": 3600000,
      "30m": 30 * 60 * 1000,
    };
    const offset = offsetMap[remindAt] || 3600000;
    return new Date(eventStart.getTime() - offset);
  }

  /** 处理单个事件的提醒 */
  private async processEvent(event: any, remindAt: string) {
    // 去重检查
    if (this.alreadySent(event.id, remindAt)) {
      console.error(`[Scheduler] 跳过已发送: ${event.title} (${remindAt})`);
      return;
    }

    console.error(`[Scheduler] 处理事件: ${event.title} (${remindAt} 提醒)`);

    // 提取关键词
    const keywords = extractKeywords(event);
    console.error(`[Scheduler] 关键词: ${keywords.slice(0, 10).join(", ")}`);

    // 本地检索
    const since = new Date(Date.now() - this.config.engine.lookback_days * 86400000);
    const related = this.indexer.search(keywords, since);

    // 无相关消息检查
    if (related.length === 0 && this.config.engine.skip_summary_if_no_match) {
      console.error(`[Scheduler] 无相关消息，跳过摘要: ${event.title}`);
      return;
    }

    // 生成摘要
    const mode: SummaryMode = remindAt === "1h" ? "concise" : this.config.engine.summary_mode;
    const brief = await generateBrief(event, related, mode, this.config.llm);

    // 推送通知
    const title = `${remindAt === "24h" ? "明日" : remindAt === "1h" ? "1小时后" : remindAt}: ${event.title}`;

    const notifyParams: NotifyParams = {
      title,
      event,
      brief,
      messages: related,
      remindAt,
    };

    for (const notifier of this.notifiers) {
      try {
        await notifier.send(notifyParams);
        console.error(`[Scheduler] 已通过 ${notifier.name} 发送通知`);
      } catch (err) {
        console.error(`[Scheduler] ${notifier.name} 发送失败:`, (err as Error).message);
      }
    }

    // 标记已发送
    this.markSent(event.id, remindAt);
  }

  /** 检查是否已发送过 */
  private alreadySent(eventId: string, remindAt: string): boolean {
    return this.sentRecords.some(
      (r) => r.eventId === eventId && r.remindAt === remindAt
    );
  }

  /** 标记已发送 */
  private markSent(eventId: string, remindAt: string) {
    this.sentRecords.push({
      eventId,
      remindAt,
      sentAt: new Date().toISOString(),
    });
    this.saveState();
  }

  /** 加载状态 */
  private loadState() {
    if (existsSync(STATE_PATH)) {
      try {
        const data = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as SentRecord[];
        // 清理 7 天前的记录
        const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
        this.sentRecords = data.filter((r) => r.sentAt > cutoff);
      } catch {
        this.sentRecords = [];
      }
    }
  }

  /** 保存状态 */
  private saveState() {
    writeFileSync(STATE_PATH, JSON.stringify(this.sentRecords, null, 2), "utf-8");
  }

  /** 获取状态信息 */
  getStatus() {
    return {
      messageCount: this.indexer.getCount(),
      sentCount: this.sentRecords.length,
      calendars: this.calendarSources.map((s) => s.name),
      messages: this.messageSources.map((s) => s.name),
      notifiers: this.notifiers.map((n) => n.name),
    };
  }
}
