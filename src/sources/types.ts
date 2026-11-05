/** 日历事件统一数据模型 */
export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  attendees: string[];       // 邮箱或姓名列表
  location?: string;
  description?: string;
  source: string;            // "apple" | "google" | "feishu" | "dingtalk" | "outlook"
  calendar?: string;         // 所属日历名称
}

/** 消息统一数据模型 */
export interface Message {
  id: string;
  from: string;
  to: string[];
  subject?: string;          // 邮件主题或消息标题
  body: string;
  timestamp: Date;
  attachments?: string[];    // 附件名列表
  source: string;            // "email" | "feishu" | "wechat" | "sms" | "mac_mail"
}

/** 关联结果 */
export interface CorrelatedItem {
  event: CalendarEvent;
  messages: Message[];
  score: number;             // 关联度 0~1
  keywords: string[];        // 匹配的关键词
}

/** 日历数据源接口 */
export interface CalendarSource {
  readonly name: string;

  /** 拉取指定时间范围内的日程事件 */
  fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
}

/** 消息数据源接口 */
export interface MessageSource {
  readonly name: string;

  /** 增量拉取消息；不完整读取应抛出带部分结果的 PartialFetchError，不能冒充完整成功。 */
  fetchMessages(since: Date): Promise<Message[]>;
}

/** 通知渠道接口 */
export interface Notifier {
  readonly name: string;
  /** Stable destination identity for restart-safe per-channel deduplication. */
  readonly deliveryId?: string;

  /** 发送日程简报通知；失败必须 reject，只有渠道确认接受后才能 resolve。 */
  send(params: NotifyParams): Promise<void>;
}

/** 通知参数 */
export interface NotifyParams {
  title: string;             // 通知标题，如 "明日：产品评审会"
  event: CalendarEvent;
  brief: string;             // 摘要内容（Markdown）
  messages: Message[];       // 关联的原始消息
  remindAt: string;          // "24h" | "1h"
}
