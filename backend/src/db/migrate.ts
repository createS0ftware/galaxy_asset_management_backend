import { openDb } from './client.js';

const url = process.env.DATABASE_URL ?? 'pglite://memory';
const { close } = await openDb(url);
await close();
console.log('migrations applied');
