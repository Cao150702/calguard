import { execSync } from "node:child_process";
import type { CalendarEvent, CalendarSource } from "../types.js";

/**
 * Apple Calendar 数据源
 * 通过 AppleScript 读取 macOS 日历事件
 *
 * 注意：不使用 whose 子句（会导致超时），而是获取全部事件后在 JS 中过滤
 * AppleScript 中文日期格式：2026年5月11日 星期一 13:40:00
 */
export class AppleCalendarSource implements CalendarSource {
  readonly name = "apple";
  private skipCalendars: Set<string>;
  private timeoutMs: number;

  constructor(opts?: { skipCalendars?: string[]; timeoutSeconds?: number }) {
    this.skipCalendars = new Set(opts?.skipCalendars || ["个人", "香港節日"]);
    this.timeoutMs = (opts?.timeoutSeconds || 30) * 1000;
  }

  async fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];

    try {
      // 获取所有日历名称
      const calendarsScript = `
        tell application "Calendar"
          set calList to name of every calendar
          set output to ""
          repeat with c in calList
            set output to output & c & "|"
          end repeat
          return output
        end tell
      `;
      const calOutput = execSync(`osascript -e '${calendarsScript}'`, {
        timeout: 15000,
        encoding: "utf-8",
      }).trim();
      const calendarNames = calOutput.split("|").filter(Boolean);

      console.error(`[AppleCalendar] 找到 ${calendarNames.length} 个日历`);

      // 逐个日历获取事件
      for (const calName of calendarNames) {
        if (this.skipCalendars.has(calName)) {
          console.error(`[AppleCalendar] 跳过: "${calName}"`);
          continue;
        }
        try {
          const calEvents = await this.fetchCalendarEvents(calName, from, to);
          events.push(...calEvents);
          if (calEvents.length > 0) {
            console.error(`[AppleCalendar] "${calName}": ${calEvents.length} 个事件`);
          }
        } catch (err) {
          console.error(`[AppleCalendar] "${calName}" 读取超时或失败，已跳过`);
        }
      }
    } catch (err) {
      console.error("[AppleCalendar] 无法访问 Calendar 应用:", (err as Error).message);
    }

    return events;
  }

  private async fetchCalendarEvents(
    calName: string,
    from: Date,
    to: Date
  ): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];

    const escapedName = calName.replace(/"/g, '\\"');
    const script = `
      tell application "Calendar"
        set cal to calendar "${escapedName}"
        set eventList to every event of cal
        set output to ""
        repeat with e in eventList
          set eTitle to summary of e
          set eStart to start date of e
          set eEnd to end date of e
          set eLoc to ""
          try
            set eLoc to location of e
          end try
          set eDesc to ""
          try
            set eDesc to description of e
          end try
          set eAttendees to ""
          try
            set aList to every attendee of e
            repeat with a in aList
              set eAttendees to eAttendees & email of a & "|"
            end repeat
          end try
          set output to output & eTitle & "\\t" & eStart & "\\t" & eEnd & "\\t" & (eLoc as text) & "\\t" & (eDesc as text) & "\\t" & eAttendees & "\\n"
        end repeat
        return output
      end tell
    `;

    const output = execSync(`osascript -e '${script}'`, {
      timeout: this.timeoutMs,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });

    for (const line of output.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 4) continue;

      const title = parts[0] || "(无标题)";
      let startDate: Date;
      let endDate: Date;
      try {
        startDate = new Date(parts[1]);
        endDate = new Date(parts[2]);
      } catch {
        continue; // 日期解析失败
      }
      const location = parts[3] && parts[3] !== "missing value" ? parts[3] : undefined;
      const description = parts[4] && parts[4] !== "missing value" ? parts[4] : undefined;
      const attendees = (parts[5] || "")
        .split("|")
        .filter(Boolean)
        .map((a) => a.trim());

      // 时间范围过滤
      if (endDate >= from && startDate <= to) {
        events.push({
          id: `apple-${calName}-${startDate.getTime()}`,
          title,
          start: startDate,
          end: endDate,
          attendees,
          location,
          description,
          source: "apple",
          calendar: calName,
        });
      }
    }

    return events;
  }
}
