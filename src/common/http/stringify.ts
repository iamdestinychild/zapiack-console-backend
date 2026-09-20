/**
 * Turns an unknown value into something printable without ever producing
 * "[object Object]", which in a CSV cell or a customer message hides a real bug
 * rather than reporting it.
 */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '';
  return JSON.stringify(value) ?? '';
}
