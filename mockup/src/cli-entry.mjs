import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Managed hosting invokes scripts through hbuilds/current, a symlink. ESM's
// import.meta.url is already canonical, while process.argv[1] retains that alias.
// Resolve both sides so CLI imports stay passive and actual cron invocations run.
export async function isMainModule(moduleUrl, argv = process.argv) {
  if (typeof moduleUrl !== 'string' || !moduleUrl.startsWith('file:') || typeof argv?.[1] !== 'string' || !argv[1]) return false;
  try {
    const [entry, module] = await Promise.all([realpath(resolve(argv[1])), realpath(fileURLToPath(moduleUrl))]);
    return process.platform === 'win32' ? entry.toLowerCase() === module.toLowerCase() : entry === module;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
