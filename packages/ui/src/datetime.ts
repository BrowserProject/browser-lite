const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Last year of a date input (the end of the ECMAScript time range). */
const MAX_YEAR = 275760;

/** Input types of the date and time picker. */
export const dateTimeTypes = ['date', 'time', 'datetime-local', 'month', 'week'] as const;

/** One of {@link dateTimeTypes}. */
export type DateTimeType = (typeof dateTimeTypes)[number];

/** The request type when it is supported, else 'date'. */
export function dateTimeType(type: string): DateTimeType {
  return (dateTimeTypes as readonly string[]).includes(type) ? (type as DateTimeType) : 'date';
}

const pad = (value: number, length: number) => String(value).padStart(length, '0');

/** 'YYYY-MM' of a number of months since January 1970, '' outside the years of a date input. */
function monthValue(months: number): string {
  if (!Number.isFinite(months)) return '';
  const date = new Date(Date.UTC(1970, Math.floor(months), 1));
  const year = date.getUTCFullYear();
  return year >= 1 && year <= MAX_YEAR ? `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}` : '';
}

/** 'YYYY-Www' of the ISO week that contains the time (ms since 1970 UTC), '' when invalid. */
function weekValue(time: number): string {
  const day = new Date(time).getUTCDay();
  if (Number.isNaN(day)) return '';
  // An ISO week belongs to the year of its Thursday
  const thursday = new Date(time + (3 - ((day + 6) % 7)) * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - new Date(0).setUTCFullYear(year, 0, 1)) / WEEK);
  return year >= 1 && year <= MAX_YEAR ? `${pad(year, 4)}-W${pad(week + 1, 2)}` : '';
}

/**
 * Value string of an input of `type` for a number like `valueAsNumber` (milliseconds since
 * 1970 UTC; months since 1970 for 'month'; milliseconds of the day for 'time'). Month and week
 * are converted here (not every host browser has these inputs), the others by the host browser.
 * '' for numbers that are no valid value.
 */
export function valueFromNumber(doc: Document, type: string, number: number): string {
  const kind = dateTimeType(type);
  if (kind === 'month') return monthValue(number);
  if (kind === 'week') return weekValue(number);
  const input = doc.createElement('input');
  input.type = kind;
  try {
    input.valueAsNumber = number;
    return input.value;
  } catch {
    return '';
  }
}

/**
 * A date picker in place of a month or week input that the host browser does not have (Firefox
 * and Safari have neither): the values of the field as dates and the chosen date back.
 */
export interface DateFallback {
  /** Date value for a value of the field, '' when it is none. */
  toDate(value: string): string;
  /** Date value for min (first day) or max (last day) of the field, as `valueAsNumber`. */
  limit(number: number, last: boolean): string;
  /** Value of the field for the date the picker shows. */
  fromDate(date: HTMLInputElement): string;
}

/** The {@link DateFallback} for type, null when the host browser has its input. */
export function dateFallback(doc: Document, type: DateTimeType): DateFallback | null {
  if (type !== 'month' && type !== 'week') return null;
  const probe = doc.createElement('input');
  probe.type = type;
  if (probe.type === type) return null;
  const date = (time: number) => valueFromNumber(doc, 'date', time);
  if (type === 'month')
    return {
      toDate: (value) => (/^\d{4,}-\d\d$/.test(value) ? `${value}-01` : ''),
      limit: (months, last) =>
        date(Date.UTC(1970, Math.floor(months) + (last ? 1 : 0), last ? 0 : 1)),
      fromDate: (input) => input.value.slice(0, -3),
    };
  return {
    toDate(value) {
      const match = /^(\d{4,})-W(\d\d)$/.exec(value);
      if (!match) return '';
      const january4 = new Date(0).setUTCFullYear(Number(match[1]), 0, 4);
      const firstMonday = january4 - ((new Date(january4).getUTCDay() + 6) % 7) * DAY;
      return date(firstMonday + (Number(match[2]) - 1) * WEEK);
    },
    limit: (time, last) => date(time + (last ? 6 * DAY : 0)),
    fromDate: (input) => (input.value ? weekValue(input.valueAsNumber) : ''),
  };
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
