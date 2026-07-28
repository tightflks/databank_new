// Converts an Excel date serial number to MM/DD/YYYY.
// Falls back to the original value (trimmed) if it isn't a serial number.
export function formatExcelDate(value: any): string {
  if (value === undefined || value === null || value === '') return '';

  let num: number | null = null;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string' && /^\d{4,6}(\.\d+)?$/.test(value.trim())) {
    num = parseFloat(value.trim());
  }

  // Valid Excel serial date range (1900-01-01 to 9999-12-31)
  if (num === null || num < 1 || num > 2958465) {
    return String(value).trim();
  }

  // Excel epoch is 1899-12-30 (serial 25569 = 1970-01-01 UTC)
  const date = new Date(Math.round((num - 25569) * 86400000));
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${m}/${d}/${date.getUTCFullYear()}`;
}
