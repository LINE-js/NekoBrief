/**
 * All stored times are wall-clock strings `YYYY-MM-DD HH:MM:SS` in the configured
 * time zone, so hour/day boundaries are plain string prefixes and compare lexically.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function localDateTime(ms: number, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(ms)) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Shift a wall-clock `YYYY-MM-DD HH:MM:SS` by whole hours without applying any time zone. */
export function shiftHours(dateTime: string, hours: number): string {
  const ms = Date.parse(`${dateTime.replace(' ', 'T')}Z`) + hours * 3_600_000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Milliseconds until the next local hour boundary. */
export function msUntilNextHour(ms: number, timeZone: string): number {
  const time = localDateTime(ms, timeZone);
  const minute = Number(time.slice(14, 16));
  const second = Number(time.slice(17, 19));
  return ((59 - minute) * 60 + (59 - second)) * 1000 + (1000 - (ms % 1000));
}
