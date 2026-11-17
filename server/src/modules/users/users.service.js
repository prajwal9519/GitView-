import { prisma } from '../../lib/prisma.js';
import { UnauthorizedError } from '../../utils/AppError.js';
import { toPublicUser } from '../../utils/toPublicUser.js';

export async function getById(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  // A still-valid access token for a deleted account: the session is dead.
  if (!user) throw new UnauthorizedError('TOKEN_INVALID');
  return toPublicUser(user);
}

export async function list({ page, perPage }) {
  const [users, total] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * perPage, take: perPage }),
    prisma.user.count(),
  ]);
  return { users: users.map(toPublicUser), total };
}
