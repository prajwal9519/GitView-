import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import * as usersController from './users.controller.js';
import { listUsersQuery } from './users.schemas.js';

// Mounted at /api/v1/users
export const usersRouter = Router();
usersRouter.get('/me', authenticate, usersController.me);

// Mounted at /api/v1/admin. Exists to demonstrate role-based access:
// authenticate (who are you?) -> requireRole (are you an admin?) -> validate -> handler.
export const adminRouter = Router();
adminRouter.get(
  '/users',
  authenticate,
  requireRole('ADMIN'),
  validate({ query: listUsersQuery }),
  usersController.list,
);
