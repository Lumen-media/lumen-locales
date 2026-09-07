import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localesDir = path.join(root, 'locales');
const MAX_BYTES = 1_000_000;
const BAD_PATTERNS = [/<script/i, /javascript\s*:/i, /on\w+\s*=/i];

const files = (await readdir(localesDir)).filter((f) => f.endsWith('.json'));

if (!files.includes('en.json')) {
  fail('en.json (canonical) missing');
}

const parsed = {};
for (const file of files) {
  const raw = await readFile(path.join(localesDir, file), 'utf8');
  if (Buffer.byteLength(raw) > MAX_BYTES) {
    fail(`${file} exceeds ${MAX_BYTES} bytes`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`${file} is not valid JSON: ${err.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`${file} must be a flat JSON object`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      fail(`${file}: "${key}" is not a string`);
    }
    for (const re of BAD_PATTERNS) {
      if (re.test(value)) {
        fail(`${file}: value for "${key}" looks like active content`);
      }
    }
  }
  parsed[file] = data;
}

const enKeys = Object.keys(parsed['en.json']);
for (const [file, data] of Object.entries(parsed)) {
  if (file === 'en.json') continue;
  const missing = enKeys.filter((key) => !(key in data));
  if (missing.length > 0) {
    const preview = missing.slice(0, 5).join(', ');
    fail(
      `${file} is missing ${missing.length} key(s) present in en.json: ${preview}${missing.length > 5 ? ', …' : ''}`
    );
  }
}

console.log(`OK: ${files.length} locale file(s) validated against en.json (${enKeys.length} keys)`);
process.exit(0);

function fail(message) {
  console.error(`Validation failed: ${message}`);
  process.exit(1);
}
