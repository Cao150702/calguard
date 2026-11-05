import crypto from "node:crypto";
import type { Notifier, NotifyParams } from "../sources/types.js";

/**
 * 飞书机器人通知渠道
 * 通过 Webhook 发送消息卡片
 */
export class FeishuNotifier implements Notifier {
  readonly name = "feishu_bot";
  readonly deliveryId: string;
  private webhook: string;
  private secret?: string;
  private template: "full" | "checklist";

  constructor(opts: { webhook: string; secret?: string; template?: "full" | "checklist" }) {
    this.webhook = opts.webhook;
    this.deliveryId = crypto.createHash("sha256").update(opts.webhook).digest("hex");
    this.secret = opts.secret;
    this.template = opts.template || "full";
  }

  async send(params: NotifyParams): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    let sign = "";
    if (this.secret) {
      const str = `${timestamp}\n${this.secret}`;
      sign = crypto.createHmac("sha256", str).update(str).digest("base64");
    }

    const body = {
      timestamp,
      sign,
      msg_type: "interactive",
      card: {
        header: {
          title: { tag: "plain_text", content: `${params.title}` },
          template: "blue",
        },
        elements: [
          { tag: "markdown", content: this.formatMarkdown(params) },
          { tag: "hr" },
          {
            tag: "note",
            elements: [
              {
                tag: "plain_text",
                content: `CalGuard · ${new Date().toLocaleString()}`,
              },
            ],
          },
        ],
      },
    };

    const response = await fetch(this.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`[Feishu] 发送失败: HTTP ${response.status}`);
    }
    const result = await response.json();
    // Support current and legacy webhook response formats; require explicit success.
    const status = result?.code ?? result?.StatusCode;
    if (status !== 0 || (result?.StatusCode !== undefined && result.StatusCode !== 0)) {
      throw new Error(`[Feishu] API 错误: ${status ?? "缺少状态码"}`);
    }
  }

  private formatMarkdown(params: NotifyParams): string {
    const { event, brief, messages } = params;
    let md = `**时间**: ${event.start.toLocaleString()}\n`;
    if (event.location) md += `**地点**: ${event.location}\n`;
    if (event.attendees.length > 0) md += `**参与人**: ${event.attendees.join(", ")}\n`;

    if (brief) {
      md += `\n---\n${brief}`;
    }

    if (messages.length > 0 && this.template === "full") {
      md += "\n\n**关联消息**:\n";
      for (const m of messages.slice(0, 5)) {
        const from = m.from || "未知";
        md += `- ${from}: ${(m.subject || m.body || "").slice(0, 60)}\n`;
      }
    }

    return md;
  }
}
