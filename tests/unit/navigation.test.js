import { describe, it, expect } from 'vitest';
import { internalPath } from '../../apps/client/src/services/navigation.js';

describe('same-application routes including iOS opaque origin', () => {
  it.each(['http://127.0.0.1:4173/today', 'https://localhost/today', 'capacitor://localhost/today'])('resolves diary paths on %s', (base) => {
    expect(internalPath('/calendar?month=2024-02', base)).toBe('/calendar?month=2024-02');
    expect(internalPath('/entries/a/edit', base)).toBe('/entries/a/edit');
    expect(internalPath('?date=2026-09-08', base)).toBe('/today?date=2026-09-08');
  });
  it.each(['https://other.example/today', '//other.example/today', 'javascript:alert(1)', 'data:text/html,hello', 'capacitor://different/today', 'capacitor://localhost:99/today', 'capacitor://user@localhost/today'])('rejects an external or executable address: %s', (input) => {
    expect(() => internalPath(input, 'capacitor://localhost/today')).toThrow('仅支持');
  });
});
