import { execSync } from 'node:child_process';
import bcrypt from '../../server/node_modules/bcrypt/bcrypt.js';
import { prisma } from '../../server/src/lib/prisma.js';
import { encryptToken } from '../../server/src/utils/encryption.js';

export async function setupE2EUser() {
  const ghToken = execSync('gh auth token').toString().trim();
  if (!ghToken) {
    throw new Error('gh auth token not found');
  }

  const email = 'e2e_tester@gitview.dev';
  const username = 'e2e_tester';
  const password = 'Password123!';
  const passwordHash = await bcrypt.hash(password, 10);

  // Upsert user
  let user = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
  }

  // Encrypt the real GitHub token
  const accessTokenEnc = encryptToken(ghToken);

  // Upsert OAuthAccount
  const oauth = await prisma.oAuthAccount.findUnique({
    where: {
      userId_provider: {
        userId: user.id,
        provider: 'GITHUB',
      },
    },
  });

  if (!oauth) {
    await prisma.oAuthAccount.create({
      data: {
        userId: user.id,
        provider: 'GITHUB',
        providerAccountId: 'e2e_gh_id_' + user.id,
        accessTokenEnc,
        scope: 'read:user user:email repo',
      },
    });
  } else {
    await prisma.oAuthAccount.update({
      where: { id: oauth.id },
      data: {
        accessTokenEnc,
      },
    });
  }

  // Clear any previous repositories for a clean test run
  await prisma.repository.deleteMany({
    where: { userId: user.id },
  });

  console.log('E2E User successfully prepared:', user.id, user.email);
  return { user, email, password };
}

if (process.argv[1]?.endsWith('test-setup.mjs')) {
  setupE2EUser()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
