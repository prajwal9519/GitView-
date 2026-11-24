/**
 * GitView Phase 5 — Milestone 7, Task 1: Public Preview API Controller
 *
 * Implements public preview REST API controllers:
 * - createPreview: Starts a new preview session (delegates to previewManager)
 * - getPreviewStatus: Polls preview session status (delegates to previewManager)
 * - stopPreview: Stops an active preview session idempotently (delegates to previewManager)
 *
 * Strict architectural constraints:
 * - Controllers NEVER contain direct Prisma queries or state machine transitions
 * - Sensitive internal fields (tokens, hashes, Docker IDs, ports, networks) are NEVER exposed
 */

import { previewManager } from './previewManager.js';
import { sanitizeSessionForClient } from './sessionService.js';

export async function createPreview(req, res, next) {
  try {
    const { repositoryId, commitRef } = req.body;
    const result = await previewManager.createAndStartSession({
      userId: req.user.id,
      repositoryId,
      commitRef,
    });

    res.status(201).json({
      data: sanitizeSessionForClient(result.session || result),
    });
  } catch (err) {
    next(err);
  }
}

export async function getActivePreview(req, res, next) {
  try {
    const active = await previewManager.getActivePreviewForUser(req.user.id);
    res.status(200).json({
      data: active,
    });
  } catch (err) {
    next(err);
  }
}

export async function getPreviewStatus(req, res, next) {
  try {
    const session = await previewManager.getPreviewSessionStatus(req.params.id, req.user.id);
    res.status(200).json({
      data: sanitizeSessionForClient(session),
    });
  } catch (err) {
    next(err);
  }
}

export async function stopPreview(req, res, next) {
  try {
    const session = await previewManager.stopPreviewSession(req.params.id, req.user.id);
    res.status(200).json({
      data: sanitizeSessionForClient(session),
    });
  } catch (err) {
    next(err);
  }
}

export async function createTicket(req, res, next) {
  try {
    const { id } = req.params;
    const { mode } = req.body || {};
    const result = await previewManager.createBootstrapTicket(id, req.user.id, mode);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
