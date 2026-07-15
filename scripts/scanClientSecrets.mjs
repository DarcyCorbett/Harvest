import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const defaultTargets = [
  'app',
  'components',
  'config',
  'contexts',
  'services',
  'eas.json',
];
const requestedTargets = process.argv.slice(2);
const targets = (requestedTargets.length > 0 ? requestedTargets : defaultTargets)
  .map((target) => resolve(target));
const textExtensions = new Set([
  '.bundle',
  '.cjs',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.ts',
  '.tsx',
]);
const forbidden = [
  {
    label: 'EXPO_PUBLIC_GEMINI_API_KEY',
    pattern: /\bEXPO_PUBLIC_GEMINI_API_KEY\b/,
  },
  {
    label: 'GEMINI_API_KEY',
    pattern: /\bGEMINI_API_KEY\b/,
  },
  {
    label: 'EXPO_PUBLIC_DEEPSEEK_API_KEY',
    pattern: /\bEXPO_PUBLIC_DEEPSEEK_API_KEY\b/,
  },
  {
    label: 'DEEPSEEK_API_KEY',
    pattern: /\bDEEPSEEK_API_KEY\b/,
  },
  {
    label: 'EXPO_PUBLIC_DEEPSEEK_MODEL',
    pattern: /\bEXPO_PUBLIC_DEEPSEEK_MODEL\b/,
  },
  {
    label: 'generativelanguage.googleapis.com',
    pattern: /\bgenerativelanguage\.googleapis\.com\b/i,
  },
  {
    label: 'api.deepseek.com',
    pattern: /\bapi\.deepseek\.com\b/i,
  },
  {
    label: 'generateContent?key=',
    pattern: /:generateContent\?key=/i,
  },
  {
    label: 'DeepSeek-style sk- credential',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
];

function filesAt(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesAt(resolve(path, entry.name))
  );
}

const missing = targets.filter((target) => !existsSync(target));
if (missing.length > 0) {
  console.error('Client secret scan target does not exist:');
  missing.forEach((target) => console.error(`- ${relative(process.cwd(), target)}`));
  process.exit(2);
}

const findings = [];
for (const target of targets) {
  for (const file of filesAt(target)) {
    if (!textExtensions.has(extname(file).toLowerCase())) continue;
    const text = readFileSync(file, 'utf8');
    for (const { label, pattern } of forbidden) {
      if (pattern.test(text)) {
        findings.push(`${relative(process.cwd(), file)}: ${label}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Paid-provider material found in client artifacts:');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log(`Client secret scan clean (${targets.length} target(s)).`);
