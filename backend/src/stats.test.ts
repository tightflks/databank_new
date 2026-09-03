import { computeStats } from './stats';

const header = ['PROPERTY NAME', 'CITY', 'INSIDER DATE', 'SALE DATE', 'SALE PRICE'];
const y = new Date().getFullYear();

describe('computeStats', () => {
  it('counts the latest insider week, biggest sale and quarterly volume', () => {
    const s = computeStats(
      [
        {
          type: 'APTS',
          week: '20260827',
          data: [
            header,
            ['Cielo@Vinings/Windwood', 'Smyrna', '08/21/2026', `03/02/${y}`, 14000000],
            ['Small Place', 'Austell', '08/21/2026', `03/15/${y}`, 2000000],
            ['Old One', 'Marietta', '08/14/2026', `01/10/${y - 1}`, 5000000],
          ],
        },
      ],
      []
    );
    expect(s.totalProperties).toBe(3);
    expect(s.thisWeek.count).toBe(2);
    expect(s.thisWeek.volume).toBe(16000000);
    expect(s.thisWeek.biggest?.name).toBe('Cielo@Vinings');
    expect(s.quarters.find((q) => q.label === `Q1 ${y}`)?.volume).toBe(16000000);
  });
});
