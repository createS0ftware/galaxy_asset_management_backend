import { eq } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { schema } from './db/client.js';
import { buildApp } from './http/app.js';
import { hashPassword } from './lib/crypto.js';
import { startIndexer } from './services/indexer.js';

const config = loadConfig();
const ctx = await createContext(config);

if (config.SEED_ADMIN_EMAIL && config.SEED_ADMIN_PASSWORD) {
  const existing = await ctx.db.query.staffUsers.findFirst({ where: eq(schema.staffUsers.email, config.SEED_ADMIN_EMAIL) });
  if (!existing) {
    await ctx.db.insert(schema.staffUsers).values({
      email: config.SEED_ADMIN_EMAIL,
      name: 'Ops Admin',
      role: 'admin',
      passwordHash: await hashPassword(config.SEED_ADMIN_PASSWORD),
    });
    console.log(`seeded staff user ${config.SEED_ADMIN_EMAIL}`);
  }
}

const app = await buildApp(ctx, { logger: true });
ctx.log = app.log;
const stopIndexer = startIndexer(ctx);
await app.listen({ port: config.PORT, host: config.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    stopIndexer();
    await app.close();
    await ctx.close();
    process.exit(0);
  });
}
