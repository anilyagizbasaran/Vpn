import { hostRange, intToIp, ipToInt, parseCidr, stripPrefix } from '../utils/ip.js';

export class PoolExhaustedError extends Error {
  constructor(poolCidr: string) {
    super(`address pool ${poolCidr} has no free addresses left`);
    this.name = 'PoolExhaustedError';
  }
}

export interface AllocateOptions {
  poolCidr: string;
  /** Addresses that must never be handed out (the server's own tunnel IP). */
  reserved: string[];
  /** Addresses currently held by live peers, with or without a `/32` suffix. */
  taken: readonly string[];
}

/**
 * Allocation policy — stated explicitly because it has security consequences:
 *
 *  - Lowest free host address wins, so pools stay dense and `wg show` is
 *    readable. The predictability is harmless: peers are authenticated by
 *    public key, not by address.
 *  - A revoked peer's address is returned to the pool immediately and may be
 *    reassigned to a *different* user. That is safe because the old peer's key
 *    is removed from the interface in the same operation, so it can no longer
 *    complete a handshake. Anything that correlates users to addresses after
 *    the fact (traffic logs, abuse reports) must therefore be timestamped.
 *  - Network and broadcast addresses are excluded; the server address is
 *    reserved.
 *
 * The value returned here is only a *candidate*. Two concurrent requests can
 * compute the same address; the partial UNIQUE index on peers is the authority
 * and the loser retries.
 */
export function allocateAddress({ poolCidr, reserved, taken }: AllocateOptions): string {
  const cidr = parseCidr(poolCidr);
  const { first, last } = hostRange(cidr);

  const used = new Set<number>();
  for (const address of taken) used.add(ipToInt(stripPrefix(address)));
  for (const address of reserved) used.add(ipToInt(stripPrefix(address)));

  for (let candidate = first; candidate <= last; candidate += 1) {
    if (!used.has(candidate)) return `${intToIp(candidate)}/32`;
  }

  throw new PoolExhaustedError(poolCidr);
}

/** Total addresses a pool can hand out, minus the server's own. */
export function poolCapacity(poolCidr: string, reservedCount = 1): number {
  const cidr = parseCidr(poolCidr);
  const { first, last } = hostRange(cidr);
  return Math.max(0, last - first + 1 - reservedCount);
}
