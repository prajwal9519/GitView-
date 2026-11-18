import { z } from 'zod';

export const listGitHubReposQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(30),
});
