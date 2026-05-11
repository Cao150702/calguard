import nodemailer from "nodemailer";
import type { Notifier, NotifyParams } from "../sources/types.js";

/**
 * 邮件通知渠道
 * 通过 SMTP 发送 HTML 邮件给自己
 */
export class EmailNotifier implements Notifier {
  readonly name = "email";
  private smtpConfig: {
    host: string;
    port: number;
    user: string;
    password: string;
    to: string;
    subject_prefix: string;
  };
  private transporter: nodemailer.Transporter | null = null;

  constructor(smtpConfig: {
    host: string;
    port: number;
    user: string;
    password: string;
    to: string;
    subject_prefix?: string;
  }) {
    this.smtpConfig = {
      ...smtpConfig,
      subject_prefix: smtpConfig.subject_prefix || "[CalGuard]",
    };
  }

  private getTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.smtpConfig.host,
        port: this.smtpConfig.port,
        secure: this.smtpConfig.port === 465,
        auth: {
          user: this.smtpConfig.user,
          pass: this.smtpConfig.password,
        },
      });
    }
    return this.transporter;
  }

  async send(params: NotifyParams): Promise<void> {
    const html = this.formatHtml(params);

    await this.getTransporter().sendMail({
      from: this.smtpConfig.user,
      to: this.smtpConfig.to,
      subject: `${this.smtpConfig.subject_prefix} ${params.title}`,
      html,
    });
  }

  private formatHtml(params: NotifyParams): string {
    const { event, brief, messages } = params;

    let messageHtml = "";
    if (messages.length > 0) {
      messageHtml = messages
        .slice(0, 8)
        .map((m) => {
          const from = m.from || "未知";
          const date = m.timestamp.toLocaleDateString();
          const subject = m.subject ? `<strong>${m.subject}</strong>` : "";
          const body = (m.body || "").slice(0, 200).replace(/\n/g, "<br>");
          return `<p style="margin:8px 0;padding:8px;background:#f9fafb;border-radius:4px;font-size:13px">
            [${date}] <strong>${from}</strong> ${subject}<br>${body}
          </p>`;
        })
        .join("");
    }

    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1A56DB;color:white;padding:16px 20px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">${event.title}</h2>
          <p style="margin:4px 0 0;opacity:0.85">${event.start.toLocaleString()}</p>
        </div>
        <div style="border:1px solid #E5E7EB;border-top:none;padding:20px;border-radius:0 0 8px 8px">
          <p style="margin:0 0 12px">
            ${event.location ? `<strong>地点:</strong> ${event.location}<br>` : ""}
            ${event.attendees.length > 0 ? `<strong>参与人:</strong> ${event.attendees.join(", ")}` : ""}
          </p>
          <pre style="white-space:pre-wrap;font-family:Arial;font-size:14px;margin:0">${brief}</pre>
          ${messageHtml ? `<h3 style="margin-top:16px">关联消息</h3>${messageHtml}` : ""}
        </div>
        <p style="color:#9CA3AF;font-size:12px;text-align:center;margin-top:12px">
          由 CalGuard 自动生成 · ${new Date().toLocaleString()}
        </p>
      </div>
    `;
  }
}
