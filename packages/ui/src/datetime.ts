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

/**
 * Value string of an input of `type` for a number like `valueAsNumber` (milliseconds since
 * 1970 UTC; months since 1970 for 'month'; milliseconds of the day for 'time'), converted by
 * the host browser. '' for numbers that are no valid value.
 */
export function valueFromNumber(doc: Document, type: string, number: number): string {
  const input = doc.createElement('input');
  input.type = dateTimeType(type);
  try {
    input.valueAsNumber = number;
    return input.value;
  } catch {
    return '';
  }
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
