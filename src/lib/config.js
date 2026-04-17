// =====================================================================
// config/*.json 로더.
// =====================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, '..', '..', 'config');

let _taxonomy;
let _keywords;

export async function loadTaxonomy() {
  if (_taxonomy) return _taxonomy;
  const raw = await readFile(resolve(CONFIG_DIR, 'taxonomy.json'), 'utf8');
  _taxonomy = JSON.parse(raw);
  return _taxonomy;
}

export async function loadKeywords() {
  if (_keywords) return _keywords;
  const raw = await readFile(resolve(CONFIG_DIR, 'keywords.json'), 'utf8');
  _keywords = JSON.parse(raw);
  return _keywords;
}
