import { resolve } from 'node:path';
import { createPool } from '../db.js';
import { SEED_DIR } from '../paths.js';
import { seedAll } from '../seed/registry.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = createPool(url, 2);
try {
  const stats = await seedAll(pool, {
    registries: [resolve(SEED_DIR, 'registry.json'), resolve(SEED_DIR, 'registry-payments.json'), resolve(SEED_DIR, 'registry-families.json')],
    offers: resolve(SEED_DIR, 'offers.json'),
  });
  console.log(JSON.stringify(stats, null, 2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
