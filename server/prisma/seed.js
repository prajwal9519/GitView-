// Creates (or promotes) the first ADMIN user. Run: npm run db:seed
// Credentials come from .env (SEED_ADMIN_*), never from source code.
// Admins can ONLY be created this way; the public API cannot make one.
import bcrypt from 'bcrypt';
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { registerSchema } from '../src/modules/auth/auth.schemas.js';

// Reuse the same validation rules as the register endpoint.
const parsed = registerSchema.safeParse({
  email: process.env.SEED_ADMIN_EMAIL,
  username: process.env.SEED_ADMIN_USERNAME ?? 'admin',
  password: process.env.SEED_ADMIN_PASSWORD,
});

if (!parsed.success) {
  console.error('Set valid SEED_ADMIN_EMAIL, SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD in .env:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const { email, username, password } = parsed.data;
const passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);

const admin = await prisma.user.upsert({
  where: { email },
  update: { role: 'ADMIN' }, // existing account: promote, never touch its password
  create: { email, username, passwordHash, role: 'ADMIN' },
});

console.log(`Admin ready: ${admin.email} (${admin.id})`);
await prisma.$disconnect();
