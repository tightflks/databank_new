// Calculated price per unit: SALE PRICE / UNITS COMPLETED.
// Falls back to the $ UNIT PROJECT column when a value can't be calculated
// (that column is rarely populated, so calculation is the primary source).
// For industrial data the same math is used as price per SF (SALE PRICE / # SQ FT BUILT,
// falling back to PRICE PER SF BUILDING); pass decimals=2 to keep cents.
export function computePricePerUnit(salePrice: string, units: string, unitProject?: string, decimals: number = 0): number {
  const factor = Math.pow(10, decimals);
  const round = (n: number) => Math.round(n * factor) / factor;
  const price = parseFloat(String(salePrice || '').replace(/[^0-9.-]/g, '') || '0');
  const unitCount = parseInt(String(units || '').replace(/[^0-9]/g, '') || '0');
  if (price > 0 && unitCount > 0) return round(price / unitCount);
  const fallback = parseFloat(String(unitProject || '').replace(/[^0-9.-]/g, '') || '0');
  return fallback > 0 ? round(fallback) : 0;
}
