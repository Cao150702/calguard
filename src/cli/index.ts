#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, ensureDataDir } from "../config/loader.js";
import { AppleCalendarSource } from "../sources/calendar/apple.js";
import { MacMailSource } from "../sources/messages/mac_mail.js";
import { EmailSource } from "../sources/messages/email.js";
import { WorkbuddyNotifier } from "../notifiers/workbuddy.js";
import { FeishuNotifier } from "../notifiers/feishu.js";
import { EmailNotifier } from "../notifiers/email.js";
import { DingtalkNotifier } from "../notifiers/dingtalk.js";
import { WecomNotifier } from "../notifiers/wecom.js";
import { PartialFetchError } from "../sources/errors.js";
import { CalGuardScheduler } from "../scheduler/cron.js";
import { MessageIndexer } from "../engine/indexer.js";
import { extractKeywords } from "../engine/extractor.js";
import { generateBrief } from "../engine/summarizer.js";
import type { CalendarEvent, CalendarSource, MessageSource, Notifier } from "../sources/types.js";
import type { CalGuardConfig } from "../config/schema.js";

const program = new Command()
  .name("calguard")
  .description("智能日程守护助手 - CalGuard Agent")
  .version("1.0.0");

/**
 * 根据配置创建数据源和通知渠道
 */
function createPlugins(config: CalGuardConfig) {
  const calendarSources: CalendarSource[] = [];
  const messageSources: MessageSource[] = [];
  const notifiers: Notifier[] = [];

  // ── 日历数据源 ──
  for (const cal of config.sources.calendars) {
    if (!cal.enabled) continue;
    switch (cal.type) {
      case "apple":
        calendarSources.push(
          new AppleCalendarSource({
            skipCalendars: cal.skip_calendars,
            timeoutSeconds: cal.timeout_seconds,
          })
        );
        break;
      // 其他日历源待实现：google, feishu, dingtalk, outlook
      default:
        console.error(`[Config] 日历源 "${(cal as any).type}" 尚未实现`);
    }
  }

  // ── 消息数据源 ──
  for (const msg of config.sources.messages) {
    if (!msg.enabled) continue;
    switch (msg.type) {
      case "mac_mail":
        messageSources.push(new MacMailSource(msg.db_path));
        break;
      case "email":
        messageSources.push(
          new EmailSource({
            host: msg.imap.host,
            port: msg.imap.port,
            tls: msg.imap.tls,
            user: msg.imap.user,
            password: msg.imap.password,
            folders: msg.imap.folders,
          })
        );
        break;
      // 其他消息源待实现：feishu_message, dingtalk_message, wechat_local, sms_local
      default:
        console.error(`[Config] 消息源 "${(msg as any).type}" 尚未实现`);
    }
  }

  // ── 通知渠道 ──
  for (const ch of config.notifications.channels) {
    if (!ch.enabled) continue;
    switch (ch.type) {
      case "workbuddy":
        notifiers.push(new WorkbuddyNotifier(ch.template));
        break;
      case "feishu_bot":
        notifiers.push(
          new FeishuNotifier({
            webhook: ch.webhook,
            secret: ch.secret,
            template: ch.template,
          })
        );
        break;
      case "email":
        notifiers.push(
          new EmailNotifier(ch.smtp)
        );
        break;
      case "dingtalk_bot":
        notifiers.push(
          new DingtalkNotifier({
            webhook: ch.webhook,
            secret: ch.secret,
          })
        );
        break;
      case "wecom":
        notifiers.push(
          new WecomNotifier({
            corp_id: ch.corp_id,
            agent_id: ch.agent_id,
            secret: ch.secret,
            to_user: ch.to_user,
          })
        );
        break;
      default:
        console.error(`[Config] 通知渠道 "${(ch as any).type}" 尚未实现`);
    }
  }

  return { calendarSources, messageSources, notifiers };
}

/** Display valid partial results, while keeping collection failure visible to the CLI. */
async function readCalendarEvents(
  source: CalendarSource, from: Date, to: Date, failures: Error[]
): Promise<CalendarEvent[]> {
  try {
    return await source.fetchEvents(from, to);
  } catch (err) {
    failures.push(new Error(`日历源 ${source.name} 读取失败`, { cause: err }));
    console.error(`[Calendar] ${source.name} 读取失败:`, err instanceof Error ? err.message : String(err));
    return err instanceof PartialFetchError ? err.partialResults as CalendarEvent[] : [];
  }
}

// ── calguard start ──
program
  .command("start")
  .description("启动守护进程")
  .option("-c, --config <path>", "配置文件路径", "./config.yaml")
  .option("--once", "执行一次后退出（适合 WorkBuddy 自动化）", false)
  .action(async (opts) => {
    ensureDataDir();
    const config = loadConfig(opts.config);
    const { calendarSources, messageSources, notifiers } = createPlugins(config);

    if (notifiers.length === 0) {
      console.error("[CalGuard] 警告：没有启用任何通知渠道");
    }

    const scheduler = new CalGuardScheduler(config, calendarSources, messageSources, notifiers);

    if (opts.once) {
      // 单次执行模式
      await scheduler.runOnce();
    } else {
      // 守护进程模式
      scheduler.start();
      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error("\n[CalGuard] 正在等待当前提醒保存后停止...");
        scheduler.stop().then(() => {
          console.error("[CalGuard] 已停止");
          process.exit(0);
        }).catch((err) => {
          console.error("[CalGuard] 停止失败，请检查提醒状态:", err);
          process.exit(1);
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
  });

// ── calguard fetch ──
program
  .command("fetch")
  .description("手动拉取消息并更新索引")
  .option("-c, --config <path>", "配置文件路径", "./config.yaml")
  .option("--source <type>", "指定数据源（email/mac_mail/all）", "all")
  .action(async (opts) => {
    ensureDataDir();
    const config = loadConfig(opts.config);
    const { messageSources } = createPlugins(config);
    const indexer = new MessageIndexer();
    const since = new Date(Date.now() - config.engine.lookback_days * 86400000);
    const failures: Error[] = [];

    for (const source of messageSources) {
      if (opts.source !== "all" && source.name !== opts.source) continue;
      console.error(`[Fetch] 从 ${source.name} 拉取消息...`);
      try {
        const messages = await source.fetchMessages(since);
        indexer.upsert(messages);
        console.error(`[Fetch] ${source.name}: ${messages.length} 条消息`);
      } catch (err) {
        failures.push(new Error(`消息源 ${source.name} 拉取或索引失败`, { cause: err }));
        if (err instanceof PartialFetchError && err.partialResults.length > 0) {
          try {
            indexer.upsert(err.partialResults);
            console.error(`[Fetch] ${source.name}: 已保留 ${err.partialResults.length} 条部分结果，本次读取仍标记为失败`);
          } catch (indexError) {
            failures.push(new Error(`消息源 ${source.name} 部分结果索引失败`, { cause: indexError }));
          }
        }
        console.error(`[Fetch] ${source.name} 失败:`, err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `消息拉取结束，共 ${failures.length} 项失败`);
    }
  });

// ── calguard events ──
program
  .command("events")
  .description("查看日程事件")
  .option("-c, --config <path>", "配置文件路径", "./config.yaml")
  .option("--hours <n>", "查看未来 N 小时的日程", "24")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const { calendarSources } = createPlugins(config);
    const hours = parseInt(opts.hours, 10);
    const now = new Date();
    const to = new Date(now.getTime() + hours * 3600000);
    const failures: Error[] = [];

    for (const source of calendarSources) {
      console.error(`\n[${source.name}] 未来 ${hours} 小时日程:`);
      const previousFailures = failures.length;
      const events = await readCalendarEvents(source, now, to, failures);
      if (events.length === 0) {
        console.error(failures.length === previousFailures ? "  (无日程)" : "  (读取失败，无可用日程)");
        continue;
      }
      for (const e of events) {
        console.error(`  📅 ${e.start.toLocaleString()} - ${e.title}`);
        if (e.location) console.error(`     📍 ${e.location}`);
        if (e.attendees.length > 0) console.error(`     👥 ${e.attendees.join(", ")}`);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `日历读取结束，共 ${failures.length} 项失败`);
  });

// ── calguard preview ──
program
  .command("preview")
  .description("预览指定事件的日程简报（不发送通知）")
  .option("-c, --config <path>", "配置文件路径", "./config.yaml")
  .option("--mode <mode>", "摘要模式 (concise/standard/detailed)", "standard")
  .action(async (opts) => {
    ensureDataDir();
    const config = loadConfig(opts.config);
    const { calendarSources, messageSources } = createPlugins(config);
    const indexer = new MessageIndexer();

    // 先拉取消息
    const since = new Date(Date.now() - config.engine.lookback_days * 86400000);
    for (const source of messageSources) {
      const messages = await source.fetchMessages(since);
      indexer.upsert(messages);
    }

    // 拉取即将到来的日程
    const now = new Date();
    const lookahead = new Date(now.getTime() + 25 * 3600000);
    const failures: Error[] = [];

    for (const source of calendarSources) {
      const events = await readCalendarEvents(source, now, lookahead, failures);
      for (const event of events) {
        console.error(`\n── 日程简报预览: ${event.title} ──`);
        console.error(`时间: ${event.start.toLocaleString()}`);
        console.error(`参与人: ${event.attendees.join(", ") || "无"}`);

        const keywords = extractKeywords(event);
        console.error(`关键词: ${keywords.join(", ")}`);

        const related = indexer.search(keywords, since);
        console.error(`关联消息: ${related.length} 条`);

        const brief = await generateBrief(
          event,
          related,
          opts.mode as "concise" | "standard" | "detailed",
          config.llm
        );
        if (brief) {
          console.log(brief);
        } else {
          console.error("(无相关消息，跳过摘要)");
        }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `日历预览结束，共 ${failures.length} 项失败`);
  });

// ── calguard status ──
program
  .command("status")
  .description("查看 CalGuard 状态")
  .option("-c, --config <path>", "配置文件路径", "./config.yaml")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const { calendarSources, messageSources, notifiers } = createPlugins(config);
    const indexer = new MessageIndexer();
    const status = {
      消息索引数: indexer.getCount(),
      日历源: calendarSources.map((s) => s.name).join(", ") || "(无)",
      消息源: messageSources.map((s) => s.name).join(", ") || "(无)",
      通知渠道: notifiers.map((n) => n.name).join(", ") || "(无)",
      摘要模式: config.engine.summary_mode,
      LLM提供商: config.llm.provider,
      拉取间隔: `${config.engine.fetch_interval_minutes} 分钟`,
      回溯天数: `${config.engine.lookback_days} 天`,
      提醒时间: config.notifications.remind_at.join(", "),
    };

    console.error("\n── CalGuard 状态 ──");
    for (const [key, value] of Object.entries(status)) {
      console.error(`  ${key}: ${value}`);
    }
  });

// ── calguard config validate ──
program
  .command("config")
  .description("配置管理")
  .addCommand(
    new Command("validate")
      .description("校验配置文件")
      .option("-c, --config <path>", "配置文件路径", "./config.yaml")
      .action((opts) => {
        try {
          const config = loadConfig(opts.config);
          console.error("✅ config.yaml 格式正确");

          const enabledCals = config.sources.calendars.filter((c) => c.enabled);
          const enabledMsgs = config.sources.messages.filter((m) => m.enabled);
          const enabledChs = config.notifications.channels.filter((ch) => ch.enabled);

          console.error(`✅ 日历源: ${enabledCals.length} 个已启用`);
          console.error(`✅ 消息源: ${enabledMsgs.length} 个已启用`);
          console.error(`✅ 通知渠道: ${enabledChs.length} 个已启用`);
          console.error(`✅ LLM: ${config.llm.provider}`);
        } catch (err) {
          console.error(`❌ 配置错误: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  );

program.parseAsync().catch((err) => {
  console.error("[CalGuard] 执行失败:", err);
  // Let pending stdout writes flush; do not report a successful one-shot run.
  process.exitCode = 1;
});
