import { Networks } from '@stellar/stellar-sdk';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('pglite://memory'),
  JWT_SECRET: z.string().min(32),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),

  STELLAR_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  STELLAR_NETWORK_PASSPHRASE: z.string().default(Networks.TESTNET),
  CONTRACT_ID: z.string().startsWith('C'),
  PAY_ASSET: z.string().regex(/^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/, 'CODE:ISSUER'),

  FEE_SECRET: z.string().startsWith('S'),
  ADMIN_SECRET: z.string().startsWith('S'),
  PLATFORM_SECRET: z.string().startsWith('S'),
  TREASURY_SECRET: z.string().startsWith('S'),
  RECEIVER_KEY_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, '32 bytes, base64'),
  MOCK_ANCHOR_ACCOUNT: z.string().startsWith('G').optional(),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),

  /** [N hours] — how long an offline-signed check-in stays submittable. */
  OFFLINE_MAX_HOURS: z.coerce.number().positive().default(12),
  /** [threshold] — device-vs-receipt gap that marks a check-in as offline / flags it. */
  OFFLINE_GAP_FLAG_SECONDS: z.coerce.number().positive().default(600),
  /** [threshold] — fee-account XLM alert. */
  FEE_ALERT_XLM: z.coerce.number().nonnegative().default(50),
  /** [N days] — proof link expiry. */
  PROOF_LINK_DAYS: z.coerce.number().positive().default(30),
  INDEXER_INTERVAL_MS: z.coerce.number().nonnegative().default(15_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
