/**
 * Vendor @wantok/core into the Supabase functions directory.
 *
 * Supabase deploys `supabase/functions/` and nothing above it, so an edge
 * function cannot import across the workspace. Rather than publish the package
 * or duplicate the rules, the source is copied in — and the copy is checked in,
 * so a deploy from a clean clone is reproducible.
 *
 * The header stamped on each file exists to stop someone editing the copy: it
 * is generated, and the next sync will silently undo their work. The package
 * is the source of truth and `npm test` runs against it.
 *
 * Run before deploying:  npm run sync:core
 */

import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'core', 'src');
const target = join(root, 'supabase', 'functions', '_shared', 'core');

const BANNER = `// GENERATED FILE — DO NOT EDIT.
// Copied from packages/core/src by \`npm run sync:core\`.
// Edit the original; this copy exists only so Supabase can deploy it.

`;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

let count = 0;
for await (const path of walk(target)) {
  const body = await readFile(path, 'utf8');
  await writeFile(path, BANNER + body);
  count += 1;
}

console.log(`Synced ${count} files -> ${relative(root, target)}`);
