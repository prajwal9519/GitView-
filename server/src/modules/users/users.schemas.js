import { z } from 'zod';

// Query strings are always text, so z.coerce turns "2" into 2.
export const listUsersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});
