import crypto from "node:crypto";
import type { Notifier, NotifyParams } from "../sources/types.js";

/**
 * 企业微信应用消息通知渠道
 * 通过企业微信 API 发送 Markdown 消息
 */
export class WecomNotifier implements Notifier {
  readonly name = "wecom";
  readonly deliveryId: string;
  private corpId: string;
  private agentId: string;
  private secret: string;
  private toUser: string;
  private accessToken = "";
  private tokenExpiresAt = 0;

  constructor(opts: {
    corp_id: string;
    agent_id: string;
    secret: string;
    to_user?: string;
  }) {
    this.corpId = opts.corp_id;
    this.agentId = opts.agent_id;
    this.secret = opts.secret;
    this.toUser = opts.to_user || "@all";
    this.deliveryId = crypto.createHash("sha256")
      .update(JSON.stringify([this.corpId, this.agentId, this.toUser])).digest("hex");
  }

  async send(params: NotifyParams): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new Error("[WeCom] 获取 access_token 失败");
    }

    const markdown = this.formatMarkdown(params);

    const body = {
      touser: this.toUser,
      msgtype: "markdown",
      agentid: parseInt(this.agentId, 10),
      markdown: {
        content: markdown,
      },
    };

    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`[WeCom] 发送失败: HTTP ${response.status}`);
    }
    const result = (await response.json()) as { errcode?: number } | null;
    if (result?.errcode !== 0) {
      // Re-fetch a rejected token on the next scheduled attempt, never resend here.
      if (result?.errcode === 40001 || result?.errcode === 40014 || result?.errcode === 42001) {
        this.accessToken = "";
        this.tokenExpiresAt = 0;
      }
      throw new Error(`[WeCom] 发送失败: ${result?.errcode ?? "缺少状态码"}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    // 缓存 token，有效期内不重复获取
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.secret}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`[WeCom] 获取 token 失败: HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      errcode: number;
      errmsg: string;
    };

    if (data?.errcode !== 0 || typeof data.access_token !== "string" || !data.access_token.trim()) {
      throw new Error(`[WeCom] 获取 token 失败: ${data?.errcode ?? "缺少状态码或 token"}`);
    }

    this.accessToken = data.access_token;
    // 提前 5 分钟过期
    this.tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
    return this.accessToken;
  }

  private formatMarkdown(params: NotifyParams): string {
    const { event, brief, messages } = params;
    let md = `## ${params.title}\n`;
    md += `>时间：${event.start.toLocaleString()}\n`;
    if (event.location) md += `>地点：${event.location}\n`;
    if (event.attendees.length > 0) md += `>参与人：${event.attendees.join(", ")}\n`;

    if (brief) {
      md += `\n${brief}`;
    }

    if (messages.length > 0) {
      md += `\n\n**关联消息**:\n`;
      for (const m of messages.slice(0, 5)) {
        const from = m.from || "未知";
        md += `- ${from}: ${(m.subject || m.body || "").slice(0, 60)}\n`;
      }
    }

    return md;
  }
}
