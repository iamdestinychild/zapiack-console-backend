/**
 * Sets a new password for a staff member, straight in the Admin DB.
 *
 *   ADMIN_DATABASE_URL='postgresql://...' node dist/cli/reset-password.js you@example.com
 *   ADMIN_DATABASE_URL='...' node dist/cli/reset-password.js you@example.com --reset-2fa
 *
 * For when the only super admin has lost their password, so nobody is left who could
 * reset it from the console. A random password is generated and printed ONCE, to this
 * terminal only; it is never stored anywhere but as a hash.
 *
 * Every live session for the account is ended, any lockout is cleared, and the reset is
 * written to the audit log. `--reset-2fa` additionally removes the authenticator, so the
 * next sign-in enrols a new one.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/admin/client';
import { PasswordService } from '../modules/auth/password.service';

/** 20+ characters, with upper, lower, digit and symbol so the console's own rules pass. */
function generatePassword(): string {
  return `${randomBytes(15).toString('base64').replace(/[/+=]/g, '')}Aa1!`;
}

async function main() {
  const email = process.argv
    .slice(2)
    .find((a) => !a.startsWith('--'))
    ?.toLowerCase();
  const reset2fa = process.argv.includes('--reset-2fa');
  const url = process.env.ADMIN_DATABASE_URL;

  if (!email) {
    console.error(
      'Usage: node dist/cli/reset-password.js <email> [--reset-2fa]',
    );
    process.exit(1);
  }
  if (!url) {
    console.error('ADMIN_DATABASE_URL is not set.');
    process.exit(1);
  }

  // The host only, never the credentials: enough to notice you are pointed at the wrong
  // database before changing anything.
  const host = new URL(url).hostname;
  console.error(`Database: ${host}`);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    const staff = await prisma.staff.findUnique({ where: { email } });
    if (!staff) {
      console.error(`No staff member with the email ${email} on ${host}.`);
      process.exit(1);
    }

    const password = generatePassword();
    await prisma.staff.update({
      where: { id: staff.id },
      data: {
        passwordHash: await new PasswordService().hash(password),
        failedLoginCount: 0,
        lockedUntil: null,
        // Ends every live session: the guard rejects a session from an older epoch.
        sessionEpoch: { increment: 1 },
        ...(reset2fa ? { totpSecret: null, totpEnabled: false } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        action: 'staff.password_reset_cli',
        targetType: 'staff',
        targetId: staff.id,
        actorEmail: 'cli',
        metadata: { email, reset2fa, via: 'reset-password.js' },
      },
    });

    console.error(
      `Password reset for ${email}${reset2fa ? ' (2FA also reset)' : ''}.`,
    );
    console.error('Shown once. Save it in a password manager now:\n');
    // stdout only for the password itself, so `... > file` captures nothing else.
    console.log(password);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: Error) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
