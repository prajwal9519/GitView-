import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { listGitHubReposQuerySchema } from './github.schemas.js';
import * as githubController from './github.controller.js';

const router = Router();

router.get(
  '/repos',
  authenticate,
  validate({ query: listGitHubReposQuerySchema }),
  githubController.listUserGitHubRepos
);

export default router;
