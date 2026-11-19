/**
 * GitView Phase 5 — Milestone 7, Task 1: Public Preview API Routes
 * Mounted under /api/v1/previews
 */

import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import {
  previewCreateLimiter,
  previewStatusLimiter,
  previewStopLimiter,
  previewTicketLimiter,
} from '../../middleware/rateLimiters.js';
import { previewCsrf, validateHostHeader } from '../../middleware/previewCsrf.js';
import {
  createPreviewSchema,
  previewParamsSchema,
  createTicketSchema,
} from './preview.schemas.js';
import * as previewController from './previewController.js';

const router = Router();

// 1. Enforce Host header integrity across all preview endpoints
router.use(validateHostHeader);

// 2. All preview routes require authentication
router.use(authenticate);

// POST /api/v1/previews - Starts a new preview
router.post(
  '/',
  previewCsrf,
  previewCreateLimiter,
  validate({ body: createPreviewSchema }),
  previewController.createPreview
);

// GET /api/v1/previews/:id - Polls session lifecycle state
router.get(
  '/:id',
  previewStatusLimiter,
  validate({ params: previewParamsSchema }),
  previewController.getPreviewStatus
);

// POST /api/v1/previews/:id/stop - Stops an active preview session
router.post(
  '/:id/stop',
  previewCsrf,
  previewStopLimiter,
  validate({ params: previewParamsSchema }),
  previewController.stopPreview
);

// POST /api/v1/previews/:id/ticket - Generates single-use bootstrap ticket
router.post(
  '/:id/ticket',
  previewCsrf,
  previewTicketLimiter,
  validate({ params: previewParamsSchema, body: createTicketSchema }),
  previewController.createTicket
);

export default router;
