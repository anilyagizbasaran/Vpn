/** Minimal IPv4 CIDR maths for the address pool. IPv6 is out of scope (see README). */

export interface Cidr {
  /** Network address as an unsigned 32-bit integer. */
  network: number;
  prefix: number;
  /** Total addresses in the block. */
  size: number;
}

export function ipToInt(ip: string): number {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) throw new Error(`invalid IPv4 address: ${ip}`);

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`invalid IPv4 address: ${ip}`);
    const octet = Number(part);
    if (octet > 255) throw new Error(`invalid IPv4 address: ${ip}`);
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function intToIp(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

export function parseCidr(cidr: string): Cidr {
  const [addr, prefixPart] = cidr.trim().split('/');
  if (!addr || prefixPart === undefined) throw new Error(`invalid CIDR: ${cidr}`);

  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    // /31 and /32 have no usable host range; /8 upward is already 16M addresses.
    throw new Error(`unsupported CIDR prefix /${prefixPart} (expected /8 to /30)`);
  }

  const size = 2 ** (32 - prefix);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(addr) & mask) >>> 0;
  return { network, prefix, size };
}

/**
 * Usable host addresses in a block: excludes the network and broadcast
 * addresses. Inclusive on both ends.
 */
export function hostRange(cidr: Cidr): { first: number; last: number } {
  return { first: (cidr.network + 1) >>> 0, last: (cidr.network + cidr.size - 2) >>> 0 };
}

export function isInCidr(ip: string, cidr: Cidr): boolean {
  const value = ipToInt(ip);
  return value >= cidr.network && value < cidr.network + cidr.size;
}

/** Strips a `/32` suffix if present — peers are stored as `10.8.0.5/32`. */
export function stripPrefix(address: string): string {
  const slash = address.indexOf('/');
  return slash === -1 ? address : address.slice(0, slash);
}
