/**
 * One CSV cell. Values that a spreadsheet would run as a formula
 * (=, +, -, @, tab, carriage return) are prefixed with an apostrophe.
 */
export const csvCell = (value: unknown): string => {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** A CSV document from a header row and data rows. */
export const toCsv = (header: string[], rows: unknown[][]): string =>
  [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
