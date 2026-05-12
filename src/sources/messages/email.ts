import Imap from "imap";
import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";
import type { Message, MessageSource } from "../../sources/types.js";

/**
 * IMAP 邮件数据源
 * 通过 IMAP 协议读取 Gmail / 企业邮箱 / Outlook 等邮件
 */
export class EmailSource implements MessageSource {
  readonly name = "email";
  private config: {
    host: string;
    port: number;
    tls: boolean;
    user: string;
    password: string;
    folders: string[];
  };

  constructor(config: {
    host: string;
    port?: number;
    tls?: boolean;
    user: string;
    password: string;
    folders?: string[];
  }) {
    this.config = {
      port: config.port || 993,
      tls: config.tls !== false,
      folders: config.folders || ["INBOX"],
      ...config,
    };
  }

  async fetchMessages(since: Date): Promise<Message[]> {
    const allMessages: Message[] = [];

    for (const folder of this.config.folders) {
      const messages = await this.fetchFromFolder(folder, since);
      allMessages.push(...messages);
    }

    return allMessages;
  }

  private fetchFromFolder(folder: string, since: Date): Promise<Message[]> {
    return new Promise((resolve, reject) => {
      const messages: Message[] = [];

      const imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.host,
        port: this.config.port,
        tls: this.config.tls,
        connTimeout: 15000,
        authTimeout: 10000,
      });

      let settled = false;
      const done = (err: Error | null, result?: Message[]) => {
        if (settled) return;
        settled = true;
        try { imap.end(); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve(result || messages);
      };

      imap.once("error", (err: Error) => done(err));
      imap.once("end", () => done(null));
      imap.once("ready", () => {
        imap.openBox(folder, true, (openErr) => {
          if (openErr) {
            done(openErr as Error);
            return;
          }

          // IMAP SINCE 只比较日期部分
          const sinceDate = since.toISOString().slice(0, 10);

          imap.search([["SINCE", sinceDate]], (searchErr, uids) => {
            if (searchErr) {
              done(searchErr as Error);
              return;
            }

            if (!uids || uids.length === 0) {
              done(null);
              return;
            }

            // 分批拉取，每批 50 条
            const batchSize = 50;
            let processed = 0;

            const processBatch = () => {
              const batchUids = uids.slice(processed, processed + batchSize);
              if (batchUids.length === 0) {
                done(null);
                return;
              }

              const fetch = imap.fetch(batchUids, {
                bodies: "",
                markSeen: false,
              });

              fetch.on("message", (msg) => {
                let parsed = false;
                msg.on("body", (stream: NodeJS.ReadableStream) => {
                  if (parsed) return;
                  parsed = true;
                  simpleParser(stream as any, (parseErr, parsedMail: ParsedMail) => {
                    if (parseErr || !parsedMail) {
                      console.error(`[Email] 解析邮件失败: ${parseErr?.message || "unknown"}`);
                      return;
                    }
                    const toRaw = parsedMail.to;
                    const toArr = toRaw
                      ? (Array.isArray(toRaw) ? toRaw : [toRaw]).flatMap((a) => a.value)
                      : [];
                    messages.push({
                      id: parsedMail.messageId || `email-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      from: parsedMail.from?.text || "",
                      to: toArr.map((a) => a.address || "").filter(Boolean),
                      subject: parsedMail.subject || undefined,
                      body: parsedMail.text || parsedMail.html || "",
                      timestamp: parsedMail.date || new Date(),
                      attachments: (parsedMail.attachments || []).map((a: any) => a.filename || "").filter(Boolean),
                      source: "email",
                    });
                  });
                });
              });

              fetch.once("error", (fetchErr: Error) => {
                console.error(`[Email] 拉取失败 (${folder}): ${fetchErr.message}`);
              });

              fetch.once("end", () => {
                processed += batchSize;
                processBatch();
              });
            };

            processBatch();
          });
        });
      });

      imap.connect();
    });
  }
}
