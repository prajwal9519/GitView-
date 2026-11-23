import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { importRepoLimiter } from '../../middleware/rateLimiters.js';
import {
  importRepositorySchema,
  repositoryIdParamSchema,
  getDirectoryTreeQuerySchema,
  getFileContentQuerySchema,
} from './repositories.schemas.js';
import * as repoController from './repositories.controller.js';

const router = Router();

// All repository routes require GitView authentication
router.use(authenticate);

router.post(
  '/',
  importRepoLimiter,
  validate({ body: importRepositorySchema }),
  repoController.importRepository
);

router.get('/history', repoController.getPreviewHistory);
router.get('/', repoController.listRepositories);

router.get(
  '/:id',
  validate({ params: repositoryIdParamSchema }),
  repoController.getRepository
);

router.delete(
  '/:id',
  validate({ params: repositoryIdParamSchema }),
  repoController.deleteRepository
);

router.get(
  '/:id/tree',
  validate({ params: repositoryIdParamSchema, query: getDirectoryTreeQuerySchema }),
  repoController.getDirectoryTree
);

router.get(
  '/:id/file',
  validate({ params: repositoryIdParamSchema, query: getFileContentQuerySchema }),
  repoController.getFileContent
);

router.get(
  '/:id/detect',
  validate({ params: repositoryIdParamSchema }),
  repoController.detectRepository
);

export default router;
