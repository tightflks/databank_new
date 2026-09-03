import { photoKey } from './photos';

describe('photoKey', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(photoKey('3108 Piedmont Rd.', 'Atlanta', '30305')).toBe(photoKey('3108  piedmont rd', 'ATLANTA', '30305'));
  });
  it('differs for different addresses', () => {
    expect(photoKey('3108 Piedmont Rd', 'Atlanta', '30305')).not.toBe(photoKey('3110 Piedmont Rd', 'Atlanta', '30305'));
  });
});
