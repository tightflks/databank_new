import { describe, it, expect } from 'vitest';
import { formatExcelDate } from './excelDate';

describe('formatExcelDate', () => {
  it('should handle Excel serial dates', () => {
    // Excel serial date 45000 = 2023-03-15
    const result = formatExcelDate(45000);
    expect(result).toMatch(/2023/);
  });

  it('should handle ISO date strings', () => {
    const result = formatExcelDate('2024-01-15');
    expect(result).toContain('2024');
  });

  it('should handle MM/DD/YYYY format', () => {
    const result = formatExcelDate('01/15/2024');
    expect(result).toBeTruthy();
  });

  it('should return empty string for empty input', () => {
    expect(formatExcelDate('')).toBe('');
    expect(formatExcelDate(null as any)).toBe('');
    expect(formatExcelDate(undefined as any)).toBe('');
  });

  it('should handle Date objects', () => {
    const date = new Date('2024-06-15');
    const result = formatExcelDate(date);
    expect(result).toContain('2024');
  });
});
