import { geocode } from './geocode';

describe('geocode', () => {
  it('places a known city', () => {
    const p = geocode('NG', 'Lagos');
    expect(p?.precision).toBe('city');
    expect(p!.lat).toBeCloseTo(6.5, 0);
    expect(p!.lng).toBeCloseTo(3.4, 0);
  });

  it('ignores case and accents', () => {
    expect(geocode('ng', 'lagos')?.precision).toBe('city');
    expect(geocode('BR', 'São Paulo')?.precision).toBe('city');
  });

  it('falls back to the country when the city is unknown or missing', () => {
    expect(geocode('NG', 'Nowhereville')?.precision).toBe('country');
    expect(geocode('GB', null)?.precision).toBe('country');
  });

  it('returns null with no country or an unknown one', () => {
    expect(geocode(null, 'Lagos')).toBeNull();
    expect(geocode('ZZ', 'Lagos')).toBeNull();
  });
});
