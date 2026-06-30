/**
 * Timezone helper — converts an IANA timezone name to a UTC offset so the
 * scheduler can respect per-member time zones when sending standup prompts.
 *
 * ALL time checks route through `now()` so tests can drive this
 * deterministically via setClock().
 */
import { now } from "./clock.js";

/**
 * Get the UTC offset for a given IANA timezone at the given instant (defaults
 * to the current time). Returns the offset in MINUTES (positive = ahead of UTC,
 * negative = behind).
 *
 * Uses Intl.DateTimeFormat (available in Node 14+) for reliable
 * timezone offset resolution without an external library.
 *
 * Falls back to 0 (UTC) for unknown timezones.
 *
 * IMPORTANT: for DST-correct cutoff/deadline computation, pass the target date
 * + time (anchored to the run's date), NOT `now()`. Calling this at a different
 * calendar day than the run date can return the wrong offset during a DST
 * transition window.
 */
export function getUtcOffsetMinutes(tz: string, at?: Date): number {
  try {
    const n = at ?? now();
    // Build a locale-specific formatter for the target timezone and parse the
    // offset from the formatted string.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(n);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (!tzPart) return 0;
    const match = tzPart.value.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!match) return 0;
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] ?? "0", 10);
    return hours * 60 + (hours < 0 ? -minutes : minutes);
  } catch {
    return 0;
  }
}

/**
 * Check whether the given time (defaults to now) is at or past HH:MM in the
 * given timezone. `targetLocal` is a string like "09:00" (24h format).
 */
export function isPastLocalTime(targetLocal: string, tz: string, at?: Date): boolean {
  const offsetMin = getUtcOffsetMinutes(tz, at);
  const n = at ?? now();
  // Convert current UTC to the target timezone's local time
  const localMs = n.getTime() + offsetMin * 60_000;
  const localDate = new Date(localMs);

  const [hh, mm] = targetLocal.split(":").map(Number);
  const targetMin = hh * 60 + mm;
  const currentMin = localDate.getUTCHours() * 60 + localDate.getUTCMinutes();

  return currentMin >= targetMin;
}

/**
 * Get the local day-of-week (Sun=0 … Sat=6) in the given timezone at the given
 * instant (defaults to now). Used by the scheduler to check if today is a
 * scheduled standup day for each member individually.
 */
export function getLocalDay(tz: string, at?: Date): number {
  const offsetMin = getUtcOffsetMinutes(tz, at);
  const n = at ?? now();
  const localMs = n.getTime() + offsetMin * 60_000;
  const localDate = new Date(localMs);
  return localDate.getUTCDay();
}

/** Commonly-used timezones for member selection UI. */
export const COMMON_TIMEZONES: { code: string; label: string }[] = [
  { code: "UTC", label: "UTC (Universal)" },
  { code: "America/New_York", label: "US Eastern (UTC-5/-4)" },
  { code: "America/Chicago", label: "US Central (UTC-6/-5)" },
  { code: "America/Denver", label: "US Mountain (UTC-7/-6)" },
  { code: "America/Los_Angeles", label: "US Pacific (UTC-8/-7)" },
  { code: "America/Sao_Paulo", label: "São Paulo (UTC-3)" },
  { code: "Europe/London", label: "London (UTC+0/+1)" },
  { code: "Europe/Berlin", label: "Berlin/CET (UTC+1/+2)" },
  { code: "Europe/Moscow", label: "Moscow (UTC+3)" },
  { code: "Asia/Dubai", label: "Dubai (UTC+4)" },
  { code: "Asia/Kolkata", label: "India (UTC+5:30)" },
  { code: "Asia/Shanghai", label: "China (UTC+8)" },
  { code: "Asia/Tokyo", label: "Tokyo (UTC+9)" },
  { code: "Australia/Sydney", label: "Sydney (UTC+10/+11)" },
  { code: "Pacific/Auckland", label: "Auckland (UTC+12/+13)" },
];
