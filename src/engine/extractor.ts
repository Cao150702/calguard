import type { CalendarEvent } from "../sources/types.js";

/** 中文停用词 */
const STOPWORDS_CN = new Set([
  "会议", "讨论", "沟通", "同步", "安排", "确认", "更新", "通知",
  "关于", "的", "了", "和", "与", "在", "对", "进行",
]);

/** 英文停用词 */
const STOPWORDS_EN = new Set([
  "meeting", "call", "sync", "catch", "up", "with", "the", "a", "an",
  "about", "for", "and", "to", "of", "in", "on", "at",
]);

/**
 * 从日历事件中提取检索关键词
 *
 * 提取来源：
 * 1. 事件标题分词
 * 2. 参会人姓名 + 邮箱前缀
 * 3. 描述中的实体（公司名、项目名等）
 */
export function extractKeywords(event: CalendarEvent): string[] {
  const keywords: string[] = [];

  // 1. 事件标题分词
  keywords.push(...tokenize(event.title));

  // 2. 参会人
  for (const attendee of event.attendees) {
    const name = attendee.split("@")[0].trim();
    if (name.length >= 2) {
      keywords.push(name);
    }
    if (attendee.includes("@") && attendee.length >= 3) {
      keywords.push(attendee.toLowerCase());
    }
  }

  // 3. 描述中的关键词
  if (event.description) {
    keywords.push(...tokenize(event.description));
  }

  // 4. 地点（如果有意义的话）
  if (event.location && event.location.length >= 2) {
    keywords.push(...tokenize(event.location));
  }

  // 去重 + 过滤停用词 + 过滤太短的词
  return [...new Set(keywords)]
    .filter((k) => !STOPWORDS_CN.has(k) && !STOPWORDS_EN.has(k.toLowerCase()))
    .filter((k) => k.length >= 2);
}

/**
 * 简单分词函数
 * 按空格、标点切分，提取长度 >= 2 的词
 * 中文文本按 2-gram 滑动窗口提取
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // 英文分词：按空格和标点
  const englishWords = text.split(/[\s,，。.!！?？;；:：、\[\]()（）【】""''「」]+/);
  for (const word of englishWords) {
    if (word.length >= 2 && /^[\x00-\x7F]+$/.test(word)) {
      tokens.push(word);
    }
  }

  // 中文分词：2-gram 滑动窗口
  const chineseOnly = text.replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i <= chineseOnly.length - 2; i++) {
    tokens.push(chineseOnly.slice(i, i + 2));
  }

  // 也尝试 3-gram
  for (let i = 0; i <= chineseOnly.length - 3; i++) {
    tokens.push(chineseOnly.slice(i, i + 3));
  }

  // 提取 @提及 和邮箱
  const mentions = text.match(/@[\w.-]+@[\w.-]+\.\w+/g);
  if (mentions) tokens.push(...mentions.map((m) => m.toLowerCase()));

  const emails = text.match(/[\w.-]+@[\w.-]+\.\w+/g);
  if (emails) tokens.push(...emails.map((e) => e.toLowerCase()));

  return tokens;
}
