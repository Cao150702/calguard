import type { CalendarEvent, Message } from "../sources/types.js";
import type { LlmConfig } from "../config/schema.js";

export type SummaryMode = "concise" | "standard" | "detailed";

const TOKEN_BUDGETS: Record<SummaryMode, number> = {
  concise: 200,
  standard: 500,
  detailed: 1200,
};

const PROMPTS: Record<SummaryMode, string> = {
  concise: `你是日程助理。请用 3-5 条 bullet 列出最关键的待办和注意事项。
不需要背景介绍，直接给出行动项。`,
  standard: `你是日程助理。请根据提供的消息，为即将到来的日程生成简报。
格式如下：
【背景】1-2句话说明来龙去脉
【待确认】列出对方尚未回复或未确认的事项
【我要做的】列出行动项，每条以动词开头`,
  detailed: `你是日程助理。请根据提供的消息，生成详细日程简报。
包含：背景、时间线、关键决策、待确认事项、行动项、附件清单`,
};

/**
 * 调用 Claude API 生成日程简报
 */
export async function generateBrief(
  event: CalendarEvent,
  relatedMessages: Message[],
  mode: SummaryMode,
  llmConfig: LlmConfig
): Promise<string> {
  if (relatedMessages.length === 0) return "";
  if (llmConfig.provider === "none" || !llmConfig.api_key) {
    return generateLocalBrief(event, relatedMessages, mode);
  }

  const messagesText = relatedMessages
    .slice(0, 10)
    .map(
      (m) =>
        `[${m.source}] ${m.from} (${m.timestamp.toLocaleDateString()}): ${m.body.slice(0, 500)}`
    )
    .join("\n---\n");

  const userPrompt = `
即将到来的日程：${event.title}
时间：${event.start.toLocaleString()}
参与人：${event.attendees.join(", ")}

相关消息：
${messagesText}
`;

  try {
    const apiUrl =
      llmConfig.provider === "openai"
        ? "https://api.openai.com/v1/chat/completions"
        : "https://api.anthropic.com/v1/messages";

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    let body: Record<string, unknown>;

    if (llmConfig.provider === "openai") {
      headers["Authorization"] = `Bearer ${llmConfig.api_key}`;
      body = {
        model: llmConfig.model,
        max_tokens: TOKEN_BUDGETS[mode],
        messages: [
          { role: "system", content: PROMPTS[mode] },
          { role: "user", content: userPrompt },
        ],
      };
    } else {
      headers["x-api-key"] = llmConfig.api_key;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: llmConfig.model,
        max_tokens: TOKEN_BUDGETS[mode],
        system: PROMPTS[mode],
        messages: [{ role: "user", content: userPrompt }],
      };
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as {
      content?: Array<{ text: string }>;
      choices?: Array<{ message: { content: string } }>;
    };

    if (llmConfig.provider === "openai") {
      return data.choices?.[0]?.message?.content || "";
    }
    return data.content?.[0]?.text || "";
  } catch (err) {
    console.error("[Summarizer] LLM 调用失败，回退到本地摘要:", (err as Error).message);
    return generateLocalBrief(event, relatedMessages, mode);
  }
}

/**
 * 本地摘要（不调用 LLM）
 * 直接列出相关消息的关键信息
 */
function generateLocalBrief(
  event: CalendarEvent,
  relatedMessages: Message[],
  mode: SummaryMode
): string {
  if (mode === "concise") {
    const lines = relatedMessages.slice(0, 5).map((m) => {
      const from = m.from || "未知";
      const preview = (m.subject || m.body || "").slice(0, 80);
      return `- ${from}: ${preview}`;
    });
    return `## ${event.title}\n${lines.join("\n")}`;
  }

  const sections: string[] = [];
  sections.push(`## ${event.title}`);
  sections.push(`- **时间**: ${event.start.toLocaleString()}`);
  if (event.location) sections.push(`- **地点**: ${event.location}`);
  sections.push(`- **参与人**: ${event.attendees.join(", ") || "无"}`);

  if (relatedMessages.length > 0) {
    sections.push("\n### 相关消息");
    for (const m of relatedMessages.slice(0, 8)) {
      const date = m.timestamp.toLocaleDateString();
      const from = m.from || "未知";
      const subject = m.subject ? `**${m.subject}**` : "";
      const body = (m.body || "").slice(0, 200);
      sections.push(`- [${date}] ${from} ${subject}\n  ${body}`);
    }
  }

  return sections.join("\n");
}
