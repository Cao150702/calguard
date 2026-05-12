import crypto from "node:crypto";
import type { Notifier, NotifyParams } from "../sources/types.js";

/**
 * 钉钉机器人通知渠道
 * 通过 Webhook 发送 Markdown 消息
 * 签名算法：HmacSHA256(timestamp + "\n" + secret)
 */
export class DingtalkNotifier implements Notifier {
  readonly name = "dingtalk_bot";
  private webhook: string;
  private secret?: string;

  constructor(opts: { webhook: string; secret?: string }) {
    this.webhook = opts.webhook;
    this.secret = opts.secret;
  }

  async send(params: NotifyParams): Promise<void> {
    let url = this.webhook;

    // 钉钉加签：timestamp + "\n" + secret
    if (this.secret) {
      const timestamp = Date.now().toString();
      const stringToSign = `${timestamp}\n${this.secret}`;
      const sign = crypto
        .createHmac("sha256", this.secret)
        .update(stringToSign)
        .digest("base64");
      url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }

    const markdown = this.formatMarkdown(params);

    const body = {
      msgtype: "markdown",
      markdown: {
        title: params.title,
        text: markdown,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Dingtalk] 发送失败: ${response.status} ${text}`);
    } else {
      const result = await response.json();
      if (result.errcode !== 0) {
        console.error(`[Dingtalk] API 错误: ${result.errmsg}`);
      }
    }
  }

  private formatMarkdown(params: NotifyParams): string {
    const { event, brief, messages } = params;
    let md = `## ${params.title}\n\n`;
    md += `**时间**: ${event.start.toLocaleString()}\n`;
    if (event.location) md += `**地点**: ${event.location}\n`;
    if (event.attendees.length > 0) md += `**参与人**: ${event.attendees.join(", ")}\n`;

    if (brief) {
      md += `\n---\n\n${brief}`;
    }

    if (messages.length > 0) {
      md += `\n\n---\n\n**关联消息**:\n`;
      for (const m of messages.slice(0, 5)) {
        const from = m.from || "未知";
        md += `- ${from}: ${(m.subject || m.body || "").slice(0, 60)}\n`;
      }
    }

    md += `\n\n> CalGuard · ${new Date().toLocaleString()}`;

    return md;
  }
}
