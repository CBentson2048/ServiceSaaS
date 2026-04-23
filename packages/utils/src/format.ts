export interface FormatCurrencyOptions {
  currency?: string;
  locale?: string;
  minorUnits?: boolean;
}

/**
 * Format a numeric amount as a localized currency string.
 *
 * By default assumes `amount` is in major units (e.g. 12.50 GBP).
 * Pass `minorUnits: true` when the source value is in minor units (e.g. pence/cents).
 */
export function formatCurrency(amount: number, options: FormatCurrencyOptions = {}): string {
  const { currency = 'GBP', locale = 'en-GB', minorUnits = false } = options;
  const value = minorUnits ? amount / 100 : amount;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(value);
}

export interface FormatDateOptions {
  locale?: string;
  timeZone?: string;
  dateStyle?: Intl.DateTimeFormatOptions['dateStyle'];
  timeStyle?: Intl.DateTimeFormatOptions['timeStyle'];
}

/**
 * Format a Date or ISO string for display.
 */
export function formatDate(value: Date | string, options: FormatDateOptions = {}): string {
  const { locale = 'en-GB', timeZone, dateStyle = 'medium', timeStyle } = options;
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, {
    dateStyle,
    timeStyle,
    timeZone,
  }).format(date);
}
