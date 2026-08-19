// Calculated price per unit: SALE PRICE / UNITS COMPLETED.
// Falls back to the $ UNIT PROJECT column when a value can't be calculated
// (that column is rarely populated, so calculation is the primary source).
export function computePricePerUnit(salePrice: string, units: string, unitProject?: string): number {
  const price = parseFloat(String(salePrice || '').replace(/[^0-9.-]/g, '') || '0');
  const unitCount = parseInt(String(units || '').replace(/[^0-9]/g, '') || '0');
  if (price > 0 && unitCount > 0) return Math.round(price / unitCount);
  const fallback = parseFloat(String(unitProject || '').replace(/[^0-9.-]/g, '') || '0');
  return fallback > 0 ? Math.round(fallback) : 0;
}
