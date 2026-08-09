import { describe, expect, it } from 'vitest';
import { allocateAddress, PoolExhaustedError, poolCapacity } from '../src/services/ipam.js';

const pool = (taken: string[]) =>
  allocateAddress({ poolCidr: '10.8.0.0/24', reserved: ['10.8.0.1'], taken });

describe('allocateAddress', () => {
  it('hands out the lowest free host address', () => {
    expect(pool([])).toBe('10.8.0.2/32');
  });

  it('skips addresses held by live peers', () => {
    expect(pool(['10.8.0.2/32', '10.8.0.3/32'])).toBe('10.8.0.4/32');
  });

  it('fills the gap left by a revoked peer', () => {
    expect(pool(['10.8.0.2/32', '10.8.0.4/32'])).toBe('10.8.0.3/32');
  });

  it('never returns the reserved server address', () => {
    expect(pool([])).not.toBe('10.8.0.1/32');
  });

  it('accepts taken addresses with or without a prefix', () => {
    expect(pool(['10.8.0.2', '10.8.0.3/32'])).toBe('10.8.0.4/32');
  });

  it('excludes network and broadcast addresses', () => {
    const taken = Array.from({ length: 252 }, (_, i) => `10.8.0.${i + 2}/32`);
    expect(pool(taken)).toBe('10.8.0.254/32');
  });

  it('throws once the pool is full', () => {
    const taken = Array.from({ length: 253 }, (_, i) => `10.8.0.${i + 2}/32`);
    expect(() => pool(taken)).toThrow(PoolExhaustedError);
  });

  it('rejects prefixes with no usable host range', () => {
    expect(() => allocateAddress({ poolCidr: '10.8.0.1/32', reserved: [], taken: [] })).toThrow();
  });
});

describe('poolCapacity', () => {
  it('counts hosts minus network, broadcast and the server address', () => {
    expect(poolCapacity('10.8.0.0/24')).toBe(253);
    expect(poolCapacity('10.8.0.0/30')).toBe(1);
  });
});
