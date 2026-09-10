import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localesDir = path.join(root, 'locales');
const languagesPath = path.join(root, 'languages.json');

const BAD_PATTERNS = [/<script/i, /javascript\s*:/i, /on\w+\s*=/i];
const DEFAULT_MODELS = {
  gemini: 'gemini-2.0-flash',
  groq: 'openai/gpt-oss-20b',
};
const CHUNK_SIZE = 50;
const ATTEMPTS_PER_CHUNK = 3;

let fallbacks = [];

const args = process.argv.slice(2);
const code = args[0];
const dotenv = await loadDotenv();
const name = argValue(args, '--name');
const nativeName = argValue(args, '--native');

if (!code || args.includes('--help')) {
  console.log(
    'usage: node scripts/translate.mjs <lang-code> [--ai <gemini|groq>] [--model <model>] [--name <english-name>] [--native <native-name>]'
  );
  console.log('  --ai <provider>   AI provider: gemini or groq (auto-detected from env keys)');
  console.log(
    `  --model <model>   Model override (default: ${DEFAULT_MODELS.gemini} for gemini, ${DEFAULT_MODELS.groq} for groq)`
  );
  console.log('  --name <name>     English name, also registers the language in languages.json');
  console.log('  --native <name>   native name (self name), also registers the language');
  process.exit(code ? 0 : 1);
}

const geminiKey = dotenv.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
const groqKey = dotenv.GROQ_API_KEY ?? process.env.GROQ_API_KEY;

const providerArg = argValue(args, '--ai');
const provider = await resolveProvider(providerArg);

const model =
  argValue(args, '--model') ??
  dotenv[`${provider.toUpperCase()}_MODEL`] ??
  process.env[`${provider.toUpperCase()}_MODEL`] ??
  DEFAULT_MODELS[provider];
const apiKey = provider === 'gemini' ? geminiKey : groqKey;

try {
  await run();
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
}

async function run() {
  if (!/^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(code)) {
    fail(`"${code}" is not a valid language code (e.g. fr, pt-BR)`);
  }

  if (!apiKey) {
    const envVar = provider === 'gemini' ? 'GEMINI_API_KEY' : 'GROQ_API_KEY';
    fail(`${envVar} env var is required — set it in .env or your shell and run again`);
  }

  console.log(`Using ${provider} (${model})`);

  const en = await readJson('en.json');

  let existing = {};
  const targetPath = path.join(localesDir, `${code}.json`);
  try {
    existing = await readJson(`${code}.json`);
  } catch {
    existing = {};
  }

  const missing = Object.keys(en).filter((key) => !(key in existing));
  const result = { ...existing };
  fallbacks = [];

  if (missing.length > 0) {
    console.log(`translating ${missing.length} key(s) into "${code}"...`);
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      const chunkKeys = missing.slice(i, i + CHUNK_SIZE);
      const chunk = Object.fromEntries(chunkKeys.map((k) => [k, en[k]]));
      const translated = await translateObject(chunk);
      for (const key of chunkKeys) {
        result[key] = translated[key] ?? en[key];
      }
      console.log(`  done ${Math.min(i + CHUNK_SIZE, missing.length)}/${missing.length}`);
      if (i + CHUNK_SIZE < missing.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  await writeFile(targetPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote locales/${code}.json (${Object.keys(result).length} keys)`);

  if (fallbacks.length > 0) {
    console.log(
      `WARNING: ${fallbacks.length} key(s) fell back to English: ${fallbacks.slice(0, 10).join(', ')}`
    );
  }

  await registerLanguage();

  execFileSync(process.execPath, [path.join(root, 'scripts', 'validate.mjs')], {
    stdio: 'inherit',
  });
}

async function resolveProvider(arg) {
  if (arg) {
    const p = arg.toLowerCase();
    if (p !== 'gemini' && p !== 'groq') {
      fail(`Unknown AI provider "${arg}" — use "gemini" or "groq"`);
    }
    return p;
  }

  if (geminiKey && !groqKey) return 'gemini';
  if (groqKey && !geminiKey) return 'groq';

  if (geminiKey && groqKey) {
    return promptChoice();
  }

  fail('No AI API key found — set GEMINI_API_KEY or GROQ_API_KEY in .env or your shell');
}

function promptChoice() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Multiple AI providers available:');
    console.log('  1) Gemini');
    console.log('  2) Groq');
    rl.question('Which one do you want to use? [1/2]: ', (answer) => {
      rl.close();
      const choice = answer.trim();
      if (choice === '2') {
        resolve('groq');
      } else {
        resolve('gemini');
      }
    });
  });
}

async function translateObject(chunk) {
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CHUNK; attempt++) {
    const parsed = parseJsonText(await callAI(chunk, attempt));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out = {};
      for (const [key, value] of Object.entries(chunk)) {
        const translated = parsed[key];
        if (
          typeof translated === 'string' &&
          translated.trim() &&
          keepsPlaceholders(value, translated) &&
          !isUnsafe(translated)
        ) {
          out[key] = translated.trim();
        } else {
          out[key] = value;
          if (!isUnsafe(translated ?? '') && translated !== value) {
            fallbacks.push(key);
          }
        }
      }
      return out;
    }
  }
  for (const key of Object.keys(chunk)) {
    fallbacks.push(key);
  }
  return chunk;
}

async function callAI(chunk, attempt) {
  const label = name ? `${name} (${code})` : `the language identified by code "${code}"`;
  const prompt = [
    `Translate this JSON map of English UI strings into ${label}.`,
    'Rules:',
    '- Keys must stay exactly the same.',
    '- Keep placeholders like {{count}}, {{tag}} or {1} unchanged.',
    '- Keep HTML exactly as-is; never translate inside tags.',
    '- Values are concise UI labels and messages; keep them short and natural.',
    '- Output ONLY a JSON object with the same keys.',
    attempt < ATTEMPTS_PER_CHUNK ? 'Translate every single value.' : '',
    JSON.stringify(chunk, null, 2),
  ]
    .filter(Boolean)
    .join('\n');

  if (provider === 'gemini') {
    return callGemini(prompt);
  }
  return callGroq(prompt);
}

async function callGemini(prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const hint =
      response.status === 400 || response.status === 403
        ? ' — check that GEMINI_API_KEY in .env is a valid key'
        : '';
    fail(`Gemini API error (HTTP ${response.status}): ${body.slice(0, 300)}${hint}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    fail('Gemini response contained no text');
  }
  return text;
}

async function callGroq(prompt) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  };

  let response = await fetchWithRetries('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, response_format: { type: 'json_object' } }),
  });

  if (response.status === 400) {
    response = await fetchWithRetries('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    fail('Groq response contained no text');
  }
  return text;
}

async function fetchWithRetries(url, options, retries = 6) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, options);
    if (response.ok || response.status === 400) return response;
    if (response.status !== 429 || attempt > retries) {
      const body = await response.text().catch(() => '');
      const hint =
        response.status === 401 || response.status === 403
          ? ' — check that GROQ_API_KEY in .env is a valid key'
          : '';
      fail(`Groq API error (HTTP ${response.status}): ${body.slice(0, 300)}${hint}`);
    }
    const body = await response.text().catch(() => '');
    const seconds = Math.max(1, Number(body.match(/in (\d+(?:\.\d+)?)s/)?.[1] ?? 15));
    console.error(
      `  rate limited — retrying in ${Math.ceil(seconds)}s (attempt ${attempt}/${retries})`
    );
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 1000));
  }
}

async function registerLanguage() {
  let index = [];
  try {
    const parsed = parseJsonText(await readFile(languagesPath, 'utf8'));
    if (Array.isArray(parsed)) index = parsed;
  } catch {
    /* no index yet */
  }
  if (index.some((l) => l.code === code)) {
    console.log(`languages.json already contains "${code}" — not modified`);
    return;
  }
  index.push({ code, name: name ?? code, nativeName: nativeName ?? name ?? code });
  index.sort((a, b) => a.code.localeCompare(b.code));
  await writeFile(languagesPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`languages.json: added "${code}"`);
}

async function loadDotenv() {
  try {
    const text = await readFile(path.join(root, '.env'), 'utf8');
    const parsed = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.replace(/^\uFEFF/, '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (key && value) parsed[key] = value;
    }
    return parsed;
  } catch {
    return {};
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(localesDir, file), 'utf8'));
}

function parseJsonText(text) {
  let value = text.trim();
  const fence = value.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) value = fence[1].trim();
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function placeholderTokens(value) {
  return [...value.matchAll(/\{\{[\w]+\}\}|\{\d+\}/g)].map((m) => m[0]);
}

function keepsPlaceholders(source, translated) {
  const from = placeholderTokens(source);
  const to = placeholderTokens(translated);
  return from.every((token) => to.includes(token));
}

function isUnsafe(value) {
  return BAD_PATTERNS.some((re) => re.test(value));
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}

function fail(message) {
  throw new Error(message);
}
