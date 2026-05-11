import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getDbPath } from "../config/loader.js";
import type { Message } from "../sources/types.js";

/**
 * 本地消息索引器
 * 使用 SQLite FTS5 全文检索引擎
 *
 * 由于 better-sqlite3 在 Node 24 下编译失败，使用 sql.js（纯 WASM SQLite）
 * sql.js 的 FTS5 支持需要编译时启用，因此回退到纯 JSON 文件索引
 */
export class MessageIndexer {
  private indexPath: string;
  private messages: Map<string, Message> = new Map();

  constructor(dataDir?: string) {
    const dir = dataDir || (() => {
      const path = getDbPath().replace("index.db", "");
      if (!existsSync(path)) mkdirSync(path, { recursive: true });
      return path;
    })();
    this.indexPath = `${dir}/messages.json`;
    this.load();
  }

  /** 从磁盘加载已有索引 */
  private load() {
    if (existsSync(this.indexPath)) {
      try {
        const data = JSON.parse(readFileSync(this.indexPath, "utf-8")) as Array<{
          id: string;
          from: string;
          to: string[];
          subject: string;
          body: string;
          timestamp: string;
          source: string;
        }>;
        for (const m of data) {
          this.messages.set(m.id, {
            ...m,
            timestamp: new Date(m.timestamp),
          });
        }
        console.error(`[Indexer] 已加载 ${this.messages.size} 条消息`);
      } catch {
        console.error("[Indexer] 索引文件损坏，重新开始");
      }
    }
  }

  /** 保存索引到磁盘 */
  private save() {
    const data = Array.from(this.messages.values()).map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
    }));
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** 新增或更新消息到索引 */
  upsert(messages: Message[]) {
    let added = 0;
    for (const m of messages) {
      if (!this.messages.has(m.id)) {
        added++;
      }
      this.messages.set(m.id, m);
    }
    this.save();
    console.error(`[Indexer] 新增 ${added} 条，总计 ${this.messages.size} 条消息`);
  }

  /**
   * 关键词检索
   * 在 subject, body, from 字段中搜索关键词（OR 逻辑）
   */
  search(keywords: string[], since: Date, limit = 20): Message[] {
    const sinceTs = since.getTime();
    const scored: Array<{ message: Message; score: number }> = [];

    for (const msg of this.messages.values()) {
      if (msg.timestamp.getTime() < sinceTs) continue;

      let score = 0;
      const searchFields = [
        (msg.subject || "").toLowerCase(),
        msg.body.toLowerCase(),
        msg.from.toLowerCase(),
        ...msg.to.map((t) => t.toLowerCase()),
      ].join(" ");

      for (const keyword of keywords) {
        const kw = keyword.toLowerCase();
        if (searchFields.includes(kw)) {
          score += 3; // 完全匹配
        } else if (searchFields.includes(kw)) {
          score += 1; // 包含匹配
        }
      }

      if (score > 0) {
        scored.push({ message: msg, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.message);
  }

  /** 获取所有消息（用于调试） */
  getAll(): Message[] {
    return Array.from(this.messages.values());
  }

  /** 获取消息数量 */
  getCount(): number {
    return this.messages.size;
  }

  /** 清空索引 */
  clear() {
    this.messages.clear();
    this.save();
  }
}
