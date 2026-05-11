import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Message, MessageSource } from "../types.js";

/**
 * Mac Mail 本地 SQLite 数据源
 * 直接读取 ~/Library/Mail/V10/MailData/Envelope Index
 *
 * Apple Mail 的 SQLite schema 中:
 * - messages.sender 是 FK -> senders.ROWID
 * - messages.subject 是 FK -> subjects.ROWID
 * - senders -> sender_addresses -> addresses 链式 JOIN
 * - summaries 表包含邮件摘要
 */
export class MacMailSource implements MessageSource {
  readonly name = "mac_mail";
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || this.getDefaultDbPath();
  }

  private getDefaultDbPath(): string {
    const home = process.env.HOME || "/tmp";
    return `${home}/Library/Mail/V10/MailData/Envelope Index`;
  }

  async fetchMessages(since: Date): Promise<Message[]> {
    const messages: Message[] = [];

    if (!existsSync(this.dbPath)) {
      console.error(`[MacMail] 数据库文件不存在: ${this.dbPath}`);
      return messages;
    }

    // Apple Mail 的 date_received 是 Core Data timestamp (2001-01-01 基准，秒级)
    const sinceAppleEpoch = Math.floor(since.getTime() / 1000) - 978307200;

    const sql = `
      SELECT m.ROWID,
             COALESCE(m.message_id, CAST(m.ROWID AS TEXT)) as msg_id,
             COALESCE(s.subject, '') as subject,
             m.date_received,
             COALESCE(a.address, '') as sender_addr,
             COALESCE(sm.summary, '') as summary
      FROM messages m
      LEFT JOIN subjects s ON m.subject = s.ROWID
      LEFT JOIN senders snd ON m.sender = snd.ROWID
      LEFT JOIN sender_addresses sa ON sa.sender = snd.ROWID
      LEFT JOIN addresses a ON sa.address = a.ROWID
      LEFT JOIN summaries sm ON m.summary = sm.ROWID
      WHERE m.date_received >= ${sinceAppleEpoch}
      ORDER BY m.date_received DESC
      LIMIT 500
    `;

    try {
      const query = sql.replace(/\n/g, " ").trim();
      const output = execSync(
        `sqlite3 -json '${this.dbPath}' "${query}"`,
        {
          timeout: 30000,
          encoding: "utf-8",
          maxBuffer: 50 * 1024 * 1024,
        }
      );

      if (!output.trim()) return messages;

      const rows = JSON.parse(output) as Array<{
        ROWID: number;
        msg_id: string;
        subject: string;
        date_received: number;
        sender_addr: string;
        summary: string;
      }>;

      for (const row of rows) {
        // Apple epoch -> Unix timestamp
        const unixTimestamp = row.date_received + 978307200;
        const timestamp = new Date(unixTimestamp * 1000);

        messages.push({
          id: `macmail-${row.ROWID}`,
          from: row.sender_addr,
          to: [],
          subject: row.subject,
          body: row.summary,
          timestamp,
          source: "mac_mail",
        });
      }
    } catch (err) {
      console.error(`[MacMail] SQLite 查询失败:`, (err as Error).message);
    }

    return messages;
  }
}
