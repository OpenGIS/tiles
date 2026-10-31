import { BuildError } from './errors.mjs';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function normaliseCalendarDate(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') {
    throw new BuildError(`${label} must be a string`);
  }

  const date = value.trim();

  if (date === '') {
    if (allowEmpty) {
      return '';
    }

    throw new BuildError(`${label} must be a real calendar date in YYYY-MM-DD format`);
  }

  if (!isRealCalendarDate(date)) {
    throw new BuildError(`${label} must be a real calendar date in YYYY-MM-DD format`);
  }

  return date;
}
