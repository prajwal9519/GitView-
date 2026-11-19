import { z } from 'zod';

export const createPreviewSchema = z.object({
  repositoryId: z.string().trim().uuid('repositoryId must be a valid UUID'),
  commitRef: z.string().trim().min(1, 'commitRef is required').max(100, 'commitRef must not exceed 100 characters'),
});

export const previewParamsSchema = z.object({
  id: z.string().trim().uuid('Session ID must be a valid UUID'),
});

export const createTicketSchema = z.object({
  mode: z.enum(['iframe', 'toplevel']).default('iframe'),
});
