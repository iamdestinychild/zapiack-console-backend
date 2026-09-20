/**
 * Emails, phone numbers and IP addresses are personal data under Nigeria's Data
 * Protection Act 2023. Everything leaves admin-core masked unless the caller holds
 * pii.reveal and supplies a reason, and every reveal is audited separately.
 */
export function maskEmail(email?: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const tail = phone.slice(-3);
  return `${'*'.repeat(Math.max(phone.length - 3, 0))}${tail}`;
}

/** IPv4 keeps two octets, IPv6 keeps the routing prefix — enough to spot a pattern. */
export function maskIp(ip?: string | null): string | null {
  if (!ip) return null;

  // Node reports IPv4 clients over a dual-stack socket as ::ffff:1.2.3.4. That is an
  // IPv4 address, and masking it as IPv6 would throw away the octets that matter.
  const normalised = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  if (normalised.includes(':')) {
    return `${normalised.split(':').slice(0, 3).join(':')}::/48`;
  }
  const parts = normalised.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : 'x.x.x.x';
}

export function maskApiKeyPrefix(prefix?: string | null): string | null {
  if (!prefix) return null;
  return `${prefix.slice(0, 8)}…`;
}

/** Applied to campaign recipient destinations held at rest. */
export function maskDestination(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return value.includes('@') ? maskEmail(value) : maskPhone(value);
}
