import type { Notifier, NotifyParams } from "../sources/types.js";

/**
 * WorkBuddy 推送通知渠道
 * 将简报输出到 stdout（WorkBuddy 自动化系统会捕获 stdout 推送到微信）
 *
 * 注意：日志走 stderr，只有需要推送的内容走 stdout
 */
export class WorkbuddyNotifier implements Notifier {
  readonly name = "workbuddy";
  private template: "full" | "checklist";

  constructor(template: "full" | "checklist" = "full") {
    this.template = template;
  }

  async send(params: NotifyParams): Promise<void> {
    const content = this.format(params);
    // 输出到 stdout（WorkBuddy 捕获推送到微信）
    process.stdout.write(content + "\n");
  }

  private format(params: NotifyParams): string {
    const { title, event, brief, messages, remindAt } = params;
    const lines: string[] = [];

    lines.push(`# ${title}`);
    lines.push("");

    if (this.template === "checklist") {
      // 简洁模式：只输出关键信息
      lines.push(`- 时间: ${event.start.toLocaleString()}`);
      if (event.location) lines.push(`- 地点: ${event.location}`);
      lines.push(`- 参与人: ${event.attendees.join(", ") || "无"}`);

      if (messages.length > 0) {
        lines.push("\n**相关消息**:");
        for (const m of messages.slice(0, 3)) {
          const from = m.from || "未知";
          const preview = (m.subject || m.body || "").slice(0, 60);
          lines.push(`- ${from}: ${preview}`);
        }
      }

      if (brief) {
        lines.push(`\n---\n${brief}`);
      }
    } else {
      // 完整模式
      lines.push(`- **时间**: ${event.start.toLocaleString()}`);
      if (event.location) lines.push(`- **地点**: ${event.location}`);
      if (event.attendees.length > 0) lines.push(`- **参与人**: ${event.attendees.join(", ")}`);
      if (event.calendar) lines.push(`- **日历**: ${event.calendar}`);

      if (brief) {
        lines.push(`\n---\n${brief}`);
      }

      if (messages.length > 0 && this.template === "full") {
        lines.push("\n### 关联消息详情");
        for (const m of messages.slice(0, 5)) {
          const date = m.timestamp.toLocaleDateString();
          const from = m.from || "未知";
          lines.push(`- [${date}] **${from}**: ${(m.subject || m.body || "").slice(0, 100)}`);
        }
      }
    }

    return lines.join("\n");
  }
}
