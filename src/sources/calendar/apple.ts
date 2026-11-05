import { execFileSync } from "node:child_process";
import type { CalendarEvent, CalendarSource } from "../types.js";
import { PartialFetchError } from "../errors.js";

/** Apple Calendar reads use JXA JSON and ISO timestamps, never locale-formatted dates. */
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
    const failures: unknown[] = [];
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
      throw new PartialFetchError<CalendarEvent>("日历查询时间范围无效", [new Error("无效时间范围")], []);
    }
    let calendarNames: string[];
    try {
      const script = `JSON.stringify(Application("Calendar").calendars().map(function(calendar) { return calendar.name(); }))`;
      const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
        timeout: 15000, encoding: "utf-8",
      });
      const names: unknown = JSON.parse(output);
      if (!Array.isArray(names) || !names.every((name) => typeof name === "string" && name.length > 0)) {
        throw new Error("日历名称列表格式无效");
      }
      calendarNames = names;
    } catch (err) {
      throw new PartialFetchError<CalendarEvent>("无法读取 Apple Calendar 日历列表", [err], []);
    }

    for (const calName of calendarNames) {
      if (this.skipCalendars.has(calName)) continue;
      try {
        events.push(...this.fetchCalendarEvents(calName, from, to));
      } catch (err) {
        if (err instanceof PartialFetchError) {
          events.push(...err.partialResults as CalendarEvent[]);
          failures.push(...err.errors);
        } else {
          failures.push(new Error(`日历 ${calName} 读取失败`, { cause: err }));
        }
      }
    }
    if (failures.length) throw new PartialFetchError("Apple Calendar 读取未全部完成", failures, events);
    return events;
  }

  private fetchCalendarEvents(calName: string, from: Date, to: Date): CalendarEvent[] {
    // No shell interpolation. JSON quoting preserves names containing quotes/newlines.
    const script = `(function() {
      var calendar = Application("Calendar").calendars.byName(${JSON.stringify(calName)});
      var events = [], errors = [];
      function optionalText(value) {
        if (value === null || value === undefined) return "";
        if (typeof value !== "string") throw new Error("Invalid text property");
        return value;
      }
      calendar.events().forEach(function(event, index) {
        try {
          var title = optionalText(event.summary());
          var start = event.startDate().toISOString();
          var end = event.endDate().toISOString();
          function readOptional(label, getter, fallback) {
            try { return getter(); }
            catch (err) { errors.push("Event " + index + " " + label + ": " + String(err)); return fallback; }
          }
          var location = readOptional("location", function() { return optionalText(event.location()); }, "");
          var description = readOptional("description", function() { return optionalText(event.description()); }, "");
          var attendeeList = readOptional("attendees", function() { return event.attendees(); }, []);
          var attendees = readOptional("attendees", function() {
            return attendeeList.map(function(attendee, attendeeIndex) {
              return readOptional("attendee " + attendeeIndex, function() { return optionalText(attendee.email()); }, "");
            }).filter(function(email) { return email.length > 0; });
          }, []);
          events.push({ title: title, start: start, end: end, location: location, description: description, attendees: attendees });
        } catch (err) {
          errors.push("Event " + index + ": " + String(err));
        }
      });
      return JSON.stringify({ events: events, errors: errors });
    })()`;
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
      timeout: this.timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
    });
    const payload: unknown = JSON.parse(output);
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { events?: unknown }).events)
        || !Array.isArray((payload as { errors?: unknown }).errors)) {
      throw new Error(`日历 ${calName} 返回格式无效`);
    }
    const data = payload as { events: unknown[]; errors: unknown[] };
    const failures: unknown[] = data.errors.map((error) => new Error(`日历 ${calName} 事件读取失败: ${typeof error === "string" ? error : "无效错误记录"}`));
    const events: CalendarEvent[] = [];
    for (const [index, row] of data.events.entries()) {
      try {
        if (!row || typeof row !== "object") throw new Error("事件格式无效");
        const e = row as Record<string, unknown>;
        if (typeof e.title !== "string" || !Array.isArray(e.attendees) || !e.attendees.every((a) => typeof a === "string")
            || (e.location !== undefined && typeof e.location !== "string")
            || (e.description !== undefined && typeof e.description !== "string")) throw new Error("事件字段无效");
        const start = this.parseTimestamp(e.start);
        const end = this.parseTimestamp(e.end);
        if (end < start) throw new Error("事件结束时间早于开始时间");
        if (end >= from && start <= to) {
          events.push({
            id: `apple-${calName}-${start.getTime()}`,
            title: e.title || "(无标题)", start, end,
            attendees: e.attendees.map((a: string) => a.trim()).filter(Boolean),
            location: (e.location as string | undefined) || undefined,
            description: (e.description as string | undefined) || undefined,
            source: "apple", calendar: calName,
          });
        }
      } catch (err) {
        failures.push(new Error(`日历 ${calName} 第 ${index + 1} 个事件无效`, { cause: err }));
      }
    }
    if (failures.length) throw new PartialFetchError(`日历 ${calName} 未全部读取成功`, failures, events);
    return events;
  }

  private parseTimestamp(value: unknown): Date {
    // JXA emits canonical UTC. Round-trip validation rejects normalized impossible dates.
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      throw new Error("事件时间必须是 UTC ISO 时间戳");
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("事件日期无效");
    return date;
  }
}
