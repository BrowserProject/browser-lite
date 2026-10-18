const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Input types of the date and time picker. */
export const dateTimeTypes = ['date', 'time', 'datetime-local', 'month', 'week'] as const;

/** One of {@link dateTimeTypes}. */
export type DateTimeType = (typeof dateTimeTypes)[number];

/** The request type when it is supported, else 'date'. */
export function dateTimeType(type: string): DateTimeType {
  return (dateTimeTypes as readonly string[]).includes(type) ? (type as DateTimeType) : 'date';
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

function year(value: number): string {
  return value < 0 ? `-${pad(-value, 4)}` : pad(value, 4);
}

/** Chrome keeps three fraction digits for time but trims trailing zeros for datetime-local. */
function timeOfDay(ms: number, trim = false): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  const millis = ms % 1000;
  let text = `${pad(hours)}:${pad(minutes)}`;
  if (seconds || millis) text += `:${pad(seconds)}`;
  if (millis) {
    const fraction = pad(millis, 3);
    text += `.${trim ? fraction.replace(/0+$/, '') : fraction}`;
  }
  return text;
}

function calendarDate(date: Date): string {
  return `${year(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** ISO 8601 week of a UTC time: [week-numbering year, week]. */
export function isoWeek(ms: number): [number, number] {
  const date = new Date(Math.floor(ms / DAY) * DAY);
  // Thursday of the same week decides the year
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = date.getTime() + (3 - day) * DAY;
  const weekYear = new Date(thursday).getUTCFullYear();
  const january4 = Date.UTC(weekYear, 0, 4);
  const firstThursday = january4 + (3 - ((new Date(january4).getUTCDay() + 6) % 7)) * DAY;
  return [weekYear, 1 + Math.round((thursday - firstThursday) / WEEK)];
}

/**
 * Value string of an input of `type` for a number like `valueAsNumber` (milliseconds since
 * 1970 UTC; months since 1970 for 'month'; milliseconds of the day for 'time').
 * '' for numbers that are no valid value.
 */
export function valueFromNumber(type: string, number: number): string {
  if (!Number.isFinite(number)) return '';
  const kind = dateTimeType(type);
  if (kind === 'month') {
    const months = Math.floor(number);
    const y = 1970 + Math.floor(months / 12);
    return `${year(y)}-${pad((((months % 12) + 12) % 12) + 1)}`;
  }
  const ms = Math.round(number);
  if (kind === 'time') return timeOfDay(((ms % DAY) + DAY) % DAY);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  if (kind === 'date') return calendarDate(date);
  if (kind === 'week') {
    const [weekYear, week] = isoWeek(ms);
    return `${year(weekYear)}-W${pad(week)}`;
  }
  return `${calendarDate(date)}T${timeOfDay(((ms % DAY) + DAY) % DAY, true)}`;
}

/** Milliseconds (months for 'month') of one unit of the `step` attribute. */
const STEP_UNIT: Record<DateTimeType, number> = {
  date: DAY,
  week: WEEK,
  month: 1,
  time: 1000,
  'datetime-local': 1000,
};

/**
 * Value of the `step` attribute for the step the engine sends (in `valueAsNumber` units).
 * 'any' for steps below one unit of a date type, '' when there is no step.
 */
export function stepAttribute(type: string, step: number): string {
  if (!Number.isFinite(step) || step <= 0) return '';
  const kind = dateTimeType(type);
  const value = step / STEP_UNIT[kind];
  if (kind === 'time' || kind === 'datetime-local') return String(value);
  return Number.isInteger(value) ? String(value) : 'any';
}
