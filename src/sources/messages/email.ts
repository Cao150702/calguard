import Imap from "imap";
import { simpleParser } from "mailparser";
import type { ParsedMail } from "mailparser";
import { PartialFetchError } from "../errors.js";
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
    const failures: unknown[] = [];
    for (const folder of this.config.folders) {
      try {
        allMessages.push(...await this.fetchFromFolder(folder, since));
      } catch (err) {
        if (err instanceof PartialFetchError) {
          allMessages.push(...err.partialResults as Message[]);
          failures.push(...err.errors);
        } else {
          failures.push(err);
        }
      }
    }
    if (failures.length) throw new PartialFetchError("邮件读取未全部完成", failures, allMessages);
    return allMessages;
  }

  private fetchFromFolder(folder: string, since: Date): Promise<Message[]> {
    return new Promise((resolve, reject) => {
      const messages: Message[] = [];
      const failures: unknown[] = [];
      const imap = new Imap({
        user: this.config.user, password: this.config.password,
        host: this.config.host, port: this.config.port, tls: this.config.tls,
        connTimeout: 15000, authTimeout: 10000,
      });
      let settled = false;
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err !== undefined) failures.push(err);
        // Settle before closing: end/close may be emitted synchronously by cleanup.
        try {
          // A stalled IMAP command can prevent queued LOGOUT from completing.
          if (failures.length) imap.destroy();
          else imap.end();
        } catch { /* The fetch outcome is already known. */ }
        if (failures.length) reject(new PartialFetchError(`邮件文件夹 ${folder} 读取失败`, failures, messages));
        else resolve([...messages]);
      };
      const fail = (err: unknown) => done(new Error(`邮件文件夹 ${folder} 读取失败`, { cause: err }));
      const timeout = setTimeout(() => fail(new Error("邮件文件夹读取超过 60 秒")), 60_000);
      // Keep guarded error handlers after settlement to absorb late transport events.
      imap.on("error", fail);
      imap.once("end", () => { if (!settled) fail(new Error("IMAP 连接提前结束")); });
      imap.once("close", () => { if (!settled) fail(new Error("IMAP 连接提前关闭")); });
      imap.once("ready", () => {
        if (settled) return;
        try {
          imap.openBox(folder, true, (openErr) => {
            if (settled) return;
            if (openErr) { fail(openErr); return; }
            try {
              const sinceDate = since.toISOString().slice(0, 10);
              imap.search([["SINCE", sinceDate]], (searchErr, uids) => {
                if (settled) return;
                if (searchErr) { fail(searchErr); return; }
                if (!uids?.length) { done(); return; }
                let processed = 0;
                const processBatch = () => {
                  if (settled) return;
                  const batchUids = uids.slice(processed, processed + 50);
                  if (!batchUids.length) { done(); return; }
                  let pending = 0;
                  let ended = false;
                  let fetchFailed = false;
                  let advanced = false;
                  const complete = () => {
                    if (settled || advanced || !ended || pending !== 0) return;
                    advanced = true;
                    if (fetchFailed) { done(); return; }
                    processed += batchUids.length;
                    processBatch();
                  };
                  try {
                    const fetch = imap.fetch(batchUids, { bodies: "", markSeen: false });
                    fetch.on("error", (err: Error) => {
                      if (settled || advanced) return;
                      failures.push(new Error(`邮件文件夹 ${folder} 拉取失败`, { cause: err }));
                      fetchFailed = true;
                      ended = true;
                      complete();
                    });
                    fetch.once("end", () => { ended = true; complete(); });
                    fetch.on("message", (msg) => {
                      if (settled || ended) return;
                      let parsed = false;
                      let messageFinished = false;
                      pending++;
                      msg.on("error", (err: Error) => { if (!settled) fail(err); });
                      msg.on("body", (stream: NodeJS.ReadableStream) => {
                        if (settled || parsed || messageFinished) return;
                        parsed = true;
                        const parsedMessage = (parseErr: Error | null, mail?: ParsedMail) => {
                          if (settled || messageFinished) return;
                          messageFinished = true;
                          try {
                            if (parseErr || !mail) throw parseErr || new Error("邮件解析结果缺失");
                            const toRaw = mail.to;
                            const toArr = toRaw ? (Array.isArray(toRaw) ? toRaw : [toRaw]).flatMap((a) => a.value) : [];
                            const timestamp = mail.date || new Date();
                            if (!Number.isFinite(timestamp.getTime())) throw new Error("邮件日期无效");
                            const message: Message = {
                              id: mail.messageId || `email-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                              from: mail.from?.text || "",
                              to: toArr.map((a) => a.address || "").filter(Boolean),
                              subject: mail.subject || undefined,
                              body: mail.text || mail.html || "",
                              timestamp,
                              attachments: (mail.attachments || []).map((a) => a.filename || "").filter(Boolean),
                              source: "email",
                            };
                            messages.push(message);
                          } catch (err) {
                            failures.push(new Error(`邮件文件夹 ${folder} 解析失败`, { cause: err }));
                          } finally {
                            pending--;
                            complete();
                          }
                        };
                        try { simpleParser(stream as any, parsedMessage); }
                        catch (err) { parsedMessage(new Error("邮件解析失败", { cause: err })); }
                      });
                      msg.once("end", () => {
                        if (settled || parsed || messageFinished) return;
                        messageFinished = true;
                        failures.push(new Error(`邮件文件夹 ${folder} 的邮件缺少正文`));
                        pending--;
                        complete();
                      });
                    });
                  } catch (err) { fail(err); }
                };
                processBatch();
              });
            } catch (err) { fail(err); }
          });
        } catch (err) { fail(err); }
      });
      try { imap.connect(); } catch (err) { fail(err); }
    });
  }
}
