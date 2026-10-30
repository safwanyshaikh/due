import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server package root (works from both src/ under tests and dist/ in production). */
export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = resolve(SERVER_ROOT, 'migrations');
export const SEED_DIR = resolve(SERVER_ROOT, 'seed');
