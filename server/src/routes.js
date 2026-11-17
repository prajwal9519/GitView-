// Mounts every module under /api/v1.
import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes.js';
import { adminRouter, usersRouter } from './modules/users/users.routes.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));
router.use('/auth', authRoutes);
router.use('/users', usersRouter);
router.use('/admin', adminRouter);

export default router;
