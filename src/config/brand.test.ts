import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from './brand';

describe('brand', () => {
  it('uses the approved Top Writer product name', () => {
    expect(PRODUCT_NAME).toBe('Top Writer');
  });
});
