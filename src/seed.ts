/**
 * Seeds the system roles and the first super admin.
 *
 * Staff are invite-only and there is no self-registration, so a brand new Admin DB
 * needs exactly one account created out of band. Everyone else is invited from the
 * console afterwards.
 *
 *   npm run build
 *   ADMIN_SEED_EMAIL=you@zapiack.com ADMIN_SEED_PASSWORD='...' npm run prisma:seed
 *
 * It lives under src/ rather than prisma/ so it compiles with the rest of the app and
 * shares the same generated client, instead of needing a second TypeScript runner.
 */
import 'dotenv/config';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/admin/client';
import { SYSTEM_ROLES } from './common/auth/permissions';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 2 ** 16 * 8 * 2 };

async function hash(password: string) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.ADMIN_DATABASE_URL }),
  });

  for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
    await prisma.role.upsert({
      where: { key },
      create: {
        key,
        name: role.name,
        description: role.description,
        permissions: [...role.permissions],
        isSystem: true,
      },
      // Permissions are refreshed so a deploy that adds a permission reaches the
      // roles that should have it; ipAllowlist is left alone as it is operational.
      update: {
        name: role.name,
        description: role.description,
        permissions: [...role.permissions],
      },
    });
    console.log(`role ${key}: ${role.permissions.length} permissions`);
  }

  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;

  if (!email || !password) {
    console.log(
      '\nSet ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD to create the first super admin.',
    );
    await prisma.$disconnect();
    return;
  }

  if (password.length < 12)
    throw new Error('ADMIN_SEED_PASSWORD must be at least 12 characters');

  const superAdmin = await prisma.role.findUniqueOrThrow({
    where: { key: 'super_admin' },
  });
  const existing = await prisma.staff.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existing) {
    console.log(`\nStaff ${email} already exists; leaving it untouched.`);
  } else {
    await prisma.staff.create({
      data: {
        email: email.toLowerCase(),
        name: process.env.ADMIN_SEED_NAME ?? 'Super Admin',
        passwordHash: await hash(password),
        roleId: superAdmin.id,
        status: 'ACTIVE',
        // totpEnabled stays false: the first sign-in hands over the enrolment QR and
        // the session is unusable until a code is verified.
      },
    });
    console.log(`\nCreated super admin ${email}. Enrol 2FA at first sign-in.`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
