import { z } from 'zod';

/** Task-list bounds are instants: require an ISO date-time with Z or an explicit offset. */
export const taskListDateTime = z.string().datetime({ offset: true });
