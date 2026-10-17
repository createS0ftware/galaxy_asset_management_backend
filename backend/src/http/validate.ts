import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { toStroops } from '../lib/money.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'VALIDATION',
      'Invalid request',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

/** Decimal amount string ("18.00") → stroops. */
export const money = z
  .union([z.string(), z.number()])
  .transform((v, c) => {
    try {
      return toStroops(v);
    } catch {
      c.addIssue({ code: 'custom', message: 'Invalid amount' });
      return z.NEVER;
    }
  });

export const phone = z.string().regex(/^\+?[0-9]{7,15}$/, 'E.164 phone number');
export const hex32 = z.string().regex(/^[0-9a-f]{64}$/, '64 hex chars (sha256)');
