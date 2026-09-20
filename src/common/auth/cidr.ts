/**
 * IPv4 CIDR matching for the per-role network allowlist. A bare address is treated
 * as /32. Anything malformed returns false: an allowlist that fails open is not an
 * allowlist.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);

  const target = toInt(ip);
  const base = toInt(range);
  if (target === null || base === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;

  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (target & mask) === (base & mask);
}

function toInt(addr: string): number | null {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4) return null;
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  // >>> 0 keeps addresses above 127.x positive.
  return parts.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
}

export function normaliseIp(ip?: string): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
