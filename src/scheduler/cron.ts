import { join } from "node:path";
import { homedir } from "node:os";
import cron from "node-cron";
import { ReminderRunner } from "./reminders.js";
import type { CalendarEvent, CalendarSource, MessageSource, Notifier, NotifyParams } from "../sources/types.js";
import type { CalGuardConfig } from "../config/schema.js";
import { MessageIndexer } from "../engine/indexer.js";
import { extractKeywords } from "../engine/extractor.js";
import { generateBrief, type SummaryMode } from "../engine/summarizer.js";

/** 状态文件路径（用于去重） */
const STATE_PATH = join(homedir(), ".calguard", "state.json");

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
  private reminders: ReminderRunner;
  private now: () => Date;
  private jobs: Array<ReturnType<typeof cron.schedule>> = [];
  private startup?: Promise<void>;
  private stopping = false;

  constructor(
    config: CalGuardConfig,
    calendarSources: CalendarSource[],
    messageSources: MessageSource[],
    notifiers: Notifier[],
    options: { now?: () => Date; statePath?: string } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.config = config;
    this.calendarSources = calendarSources;
    this.messageSources = messageSources;
    this.notifiers = notifiers;
    this.indexer = new MessageIndexer();
    this.reminders = new ReminderRunner({
      calendarSources: this.calendarSources,
      notifiers: this.notifiers,
      remindAt: config.notifications.remind_at,
      statePath: options.statePath ?? STATE_PATH,
      now: this.now,
      prepareNotification: (event, remindAt) => this.prepareNotification(event, remindAt),
    });
  }

  /** 启动守护进程 */
  start() {
    if (this.jobs.length > 0) return;
    this.stopping = false;
    const interval = this.config.engine.fetch_interval_minutes;

    // 任务一：定时拉取消息，更新索引（高频，纯 I/O）
    const fetchCron = `*/${interval} * * * *`;
    this.jobs.push(cron.schedule(fetchCron, async () => {
      if (this.stopping) return;
      console.error("[Scheduler] 开始拉取消息...");
      await this.fetchAndUpdateIndex();
    }));

    // 任务二：每分钟检查到期提醒；延迟检查会在日程开始前补发。
    this.jobs.push(cron.schedule("* * * * *", () => {
      if (this.stopping) return;
      this.reminders.check().catch((err) => {
        console.error("[Scheduler] 提醒检查失败:", err);
      });
    }));

    // 立即执行一次
    console.error("[CalGuard] 守护进程已启动");
    console.error(`[CalGuard] 消息拉取间隔: 每 ${interval} 分钟`);
    console.error(`[CalGuard] 提醒检查: 每分钟（到期后发送，日程开始前补发）`);

    // 首次运行立即执行一次完整流程
    this.startup = this.runOnce().catch((err) => {
      console.error("[CalGuard] 首次运行失败:", err);
    });
  }

  /** Stop future ticks and let in-flight sends finish before the CLI exits. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const job of this.jobs) job.stop();
    this.jobs = [];
    await this.startup;
    await this.reminders.waitForIdle();
  }

  /** 首次运行完整流程（用于 WorkBuddy 自动化一次性执行） */
  async runOnce() {
    console.error("[CalGuard] 执行单次完整流程...");

    // Step 1: 拉取消息更新索引
    await this.fetchAndUpdateIndex();

    // 单次和守护模式共用到期判断与持久化去重逻辑。
    await this.reminders.check();
    console.error("[CalGuard] 单次流程完成");
  }

  /** 拉取消息并更新索引 */
  private async fetchAndUpdateIndex() {
    const since = new Date(this.now().getTime() - this.config.engine.lookback_days * 86400000);

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

  /** 为到期提醒准备简报；发送和去重由 ReminderRunner 统一负责。 */
  private async prepareNotification(event: CalendarEvent, remindAt: string): Promise<NotifyParams | undefined> {
    console.error(`[Scheduler] 处理事件: ${event.title} (${remindAt} 提醒)`);

    // 提取关键词
    const keywords = extractKeywords(event);
    console.error(`[Scheduler] 关键词: ${keywords.slice(0, 10).join(", ")}`);

    // 本地检索
    const since = new Date(this.now().getTime() - this.config.engine.lookback_days * 86400000);
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
    const title = `日程提醒 (${remindAt}): ${event.title}`;

    const notifyParams: NotifyParams = {
      title,
      event,
      brief,
      messages: related,
      remindAt,
    };

    return notifyParams;
  }

  /** 获取状态信息 */
  getStatus() {
    return {
      messageCount: this.indexer.getCount(),
      sentCount: this.reminders.sentCount,
      calendars: this.calendarSources.map((s) => s.name),
      messages: this.messageSources.map((s) => s.name),
      notifiers: this.notifiers.map((n) => n.name),
    };
  }
}
