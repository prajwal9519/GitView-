import { z } from 'zod';

export const importRepositorySchema = z.object({
  repo: z.string().trim().min(1, 'Repository identifier or URL is required'),
});

export const repositoryIdParamSchema = z.object({
  id: z.string().trim().min(1, 'Repository ID is required'),
});

export const getDirectoryTreeQuerySchema = z.object({
  path: z.string().max(500, 'Path must not exceed 500 characters').default(''),
  ref: z.string().trim().max(100).optional(),
});

export const getFileContentQuerySchema = z.object({
  path: z.string().trim().min(1, 'File path is required').max(500, 'Path must not exceed 500 characters'),
  ref: z.string().trim().max(100).optional(),
});
