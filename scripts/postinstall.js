#!/usr/bin/env node

/**
 * Post-install cleanup script
 * Removes unnecessary files after plugin installation
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

// Files and directories to remove
const filesToRemove = [
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.github',
  'plans',
];

console.log('[agents-conversation] Running post-install cleanup...');

for (const file of filesToRemove) {
  const filePath = join(projectRoot, file);
  try {
    rmSync(filePath, { recursive: true, force: true });
    console.log(`[agents-conversation] Removed: ${file}`);
  } catch (err) {
    // Silently ignore errors for non-existent files
    if (err.code !== 'ENOENT') {
      console.warn(`[agents-conversation] Warning: Failed to remove ${file}:`, err.message);
    }
  }
}

console.log('[agents-conversation] Post-install cleanup completed');
