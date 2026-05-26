import { useEffect, useState } from "react";

const TIMEZONE_KEY = "memory_router_timezone";

export interface TimezoneOption {
  value: string;
  label: string;
}

export const timezoneOptions: TimezoneOption[] = [
  { value: "system", label: "System Default" },
  { value: "UTC", label: "UTC (Coordinated Universal Time)" },
  { value: "Pacific/Pago_Pago", label: "UTC-11:00 (Pago Pago / American Samoa)" },
  { value: "Pacific/Honolulu", label: "UTC-10:00 (Honolulu / Hawaii)" },
  { value: "America/Anchorage", label: "UTC-09:00 (Anchorage / Alaska)" },
  { value: "America/Los_Angeles", label: "UTC-08:00 (Los Angeles / Pacific Time)" },
  { value: "America/Denver", label: "UTC-07:00 (Denver / Mountain Time)" },
  { value: "America/Chicago", label: "UTC-06:00 (Chicago / Central Time)" },
  { value: "America/New_York", label: "UTC-05:00 (New York / Eastern Time)" },
  { value: "America/Halifax", label: "UTC-04:00 (Halifax / Atlantic Time)" },
  { value: "America/Sao_Paulo", label: "UTC-03:00 (São Paulo / Brazil)" },
  { value: "America/Noronha", label: "UTC-02:00 (Fernando de Noronha)" },
  { value: "Atlantic/Cape_Verde", label: "UTC-01:00 (Cape Verde)" },
  { value: "Europe/London", label: "UTC+00:00 (London / GMT)" },
  { value: "Europe/Paris", label: "UTC+01:00 (Paris / Central European)" },
  { value: "Europe/Kyiv", label: "UTC+02:00 (Kyiv / Eastern European)" },
  { value: "Europe/Moscow", label: "UTC+03:00 (Moscow / Baghdad)" },
  { value: "Asia/Dubai", label: "UTC+04:00 (Dubai / Baku)" },
  { value: "Asia/Karachi", label: "UTC+05:00 (Karachi / Tashkent)" },
  { value: "Asia/Dhaka", label: "UTC+06:00 (Dhaka / Almaty)" },
  { value: "Asia/Bangkok", label: "UTC+07:00 (Bangkok / Jakarta)" },
  { value: "Asia/Singapore", label: "UTC+08:00 (Singapore / Beijing / Taipei)" },
  { value: "Asia/Tokyo", label: "UTC+09:00 (Tokyo / Seoul)" },
  { value: "Australia/Sydney", label: "UTC+10:00 (Sydney / Melbourne)" },
  { value: "Pacific/Noumea", label: "UTC+11:00 (Noumea / Solomon Islands)" },
  { value: "Pacific/Auckland", label: "UTC+12:00 (Auckland / Fiji)" },
  { value: "Pacific/Apia", label: "UTC+13:00 (Apia / Samoa)" },
  { value: "Pacific/Kiritimati", label: "UTC+14:00 (Kiritimati / Kiribati)" },
];

export function getRawTimezoneSetting(): string {
  return localStorage.getItem(TIMEZONE_KEY) || "system";
}

export function getTimezone(): string {
  const setting = getRawTimezoneSetting();
  if (setting === "system") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  return setting;
}

export function setTimezoneSetting(tz: string): void {
  localStorage.setItem(TIMEZONE_KEY, tz);
  window.dispatchEvent(new Event("timezonechange"));
}

export function useTimezone(): string {
  const [tz, setTz] = useState(getTimezone());

  useEffect(() => {
    const handleTimezoneChange = () => {
      setTz(getTimezone());
    };
    window.addEventListener("timezonechange", handleTimezoneChange);
    return () => {
      window.removeEventListener("timezonechange", handleTimezoneChange);
    };
  }, []);

  return tz;
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;

  let str = value.trim();
  if (!str.endsWith("Z") && !str.includes("+") && !/[-+]\d{2}:?\d{2}$/.test(str)) {
    str = str.replace(" ", "T");
    if (!str.includes("T")) {
      str += "T00:00:00Z";
    } else {
      str += "Z";
    }
  }

  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type TimezoneParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
};

function extractTimezoneParts(
  value: string | Date | null | undefined,
  tz: string,
): TimezoneParts | null {
  const date = parseDate(value);
  if (!date) return null;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    if (!year || !month || !day || !hour || !minute) return null;
    return { year, month, day, hour, minute };
  } catch {
    return null;
  }
}

function formatMonthDay(parts: TimezoneParts): string {
  return `${Number(parts.month)}/${Number(parts.day)}`;
}

function formatHourMinute(parts: TimezoneParts): string {
  return `${parts.hour}:${parts.minute}`;
}

export function formatInTimezone(
  value: string | Date | null | undefined,
  tz: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = parseDate(value);
  if (!date) return "-";

  try {
    return date.toLocaleString("ja-JP", {
      timeZone: tz,
      hour12: false,
      ...options,
    });
  } catch (error) {
    // タイムゾーンが不正な場合のフォールバック
    return date.toLocaleString("ja-JP", {
      hour12: false,
      ...options,
    });
  }
}

export function formatDate(value: string | Date | null | undefined, tz: string): string {
  const date = parseDate(value);
  if (!date) return "-";

  try {
    const formatter = new Intl.DateTimeFormat("ja-JP", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch (e) {
    const formatter = new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  }
}

export function formatDateTimeShort(value: string | Date | null | undefined, tz: string): string {
  const parts = extractTimezoneParts(value, tz);
  if (!parts) return "-";
  return `${parts.year}/${Number(parts.month)}/${Number(parts.day)} ${formatHourMinute(parts)}`;
}

export function formatDateTimeCompact(value: string | Date | null | undefined, tz: string): string {
  const parts = extractTimezoneParts(value, tz);
  if (!parts) return "-";
  const currentParts = extractTimezoneParts(new Date(), tz);
  if (
    currentParts &&
    currentParts.year === parts.year &&
    currentParts.month === parts.month &&
    currentParts.day === parts.day
  ) {
    return formatHourMinute(parts);
  }
  return formatMonthDay(parts);
}

export function formatDateTime(value: string | Date | null | undefined, tz: string): string {
  const date = parseDate(value);
  if (!date) return "-";

  try {
    const formatter = new Intl.DateTimeFormat("ja-JP", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return formatter.format(date);
  } catch (e) {
    const formatter = new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return formatter.format(date);
  }
}
