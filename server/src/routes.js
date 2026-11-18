// Mounts every module under /api/v1.
import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes.js';
import { adminRouter, usersRouter } from './modules/users/users.routes.js';
import githubRoutes from './modules/github/github.routes.js';
import repositoriesRoutes from './modules/repositories/repositories.routes.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));
router.use('/auth', authRoutes);
router.use('/users', usersRouter);
router.use('/admin', adminRouter);
router.use('/github', githubRoutes);
router.use('/repositories', repositoriesRoutes);

export default router;
