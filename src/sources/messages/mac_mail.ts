import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Message, MessageSource } from "../types.js";
import { PartialFetchError } from "../errors.js";

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
    // Absolute paths cannot be mistaken for sqlite3 options (for example -cmd).
    this.dbPath = resolve(dbPath || this.getDefaultDbPath());
  }

  private getDefaultDbPath(): string {
    const home = process.env.HOME || "/tmp";
    return `${home}/Library/Mail/V10/MailData/Envelope Index`;
  }

  async fetchMessages(since: Date): Promise<Message[]> {
    const messages: Message[] = [];

    const errors: unknown[] = [];
    if (!Number.isFinite(since.getTime())) {
      throw new PartialFetchError<Message>("Mac Mail 读取失败", [new Error("无效的增量起始时间")], []);
    }

    // Preserve the existing Core Data epoch assumption (2001-01-01, seconds).
    // Apple Mail schema/epoch compatibility still requires native macOS validation.
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
      if (!existsSync(this.dbPath)) {
        throw new Error("Mac Mail 数据库文件不存在");
      }
      const query = sql.replace(/\n/g, " ").trim();
      const output = execFileSync("sqlite3", ["-readonly", "-json", this.dbPath, query], {
        timeout: 30000,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      });

      // sqlite3 emits no JSON at all when a SELECT has no rows.
      if (!output.trim()) return messages;
      const rows: unknown = JSON.parse(output);
      if (!Array.isArray(rows)) throw new Error("Mac Mail 查询结果不是数组");

      for (const [index, row] of rows.entries()) {
        try {
          if (row === null || typeof row !== "object" || Array.isArray(row)) {
            throw new Error("记录不是对象");
          }
          // Validate every field used by the index before constructing a message.
          // msg_id is deliberately unused: stable IDs remain based on ROWID.
          if (!Number.isSafeInteger(row.ROWID) ||
              typeof row.sender_addr !== "string" || typeof row.subject !== "string" ||
              typeof row.summary !== "string" || typeof row.date_received !== "number" ||
              !Number.isFinite(row.date_received)) {
            throw new Error("记录字段类型无效");
          }
          const timestamp = new Date((row.date_received + 978307200) * 1000);
          if (!Number.isFinite(timestamp.getTime())) throw new Error("记录时间无效");

          messages.push({
            id: `macmail-${row.ROWID}`,
            from: row.sender_addr,
            to: [],
            subject: row.subject,
            body: row.summary,
            timestamp,
            source: "mac_mail",
          });
        } catch (err) {
          errors.push(new Error(`Mac Mail 第 ${index + 1} 条记录无效`, { cause: err }));
        }
      }
    } catch (err) {
      errors.push(err);
    }

    if (errors.length > 0) {
      throw new PartialFetchError<Message>("Mac Mail 读取不完整", errors, messages);
    }
    return messages;
  }
}
