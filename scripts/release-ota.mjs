// Safe over-the-air release for the Android app.
//
// `eas update` does not load the env block from eas.json, so a plain publish can
// ship a bundle with no Firebase config and lock every installed app out. This
// script loads that env itself, exports the bundle, proves the config is inside
// it, and only then publishes that exact bundle.
//
//   node scripts/release-ota.mjs                      export and verify only
//   node scripts/release-ota.mjs --publish -m "..."   also publish to production
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const messageIndex = args.findIndex((arg) => arg === '-m' || arg === '--message');
const message = messageIndex >= 0 ? args[messageIndex + 1] : undefined;
const channel = 'production';

function fail(reason) {
  console.error(`\nRelease stopped: ${reason}`);
  process.exit(1);
}

if (publish && !message) fail('--publish needs a message: -m "what changed"');

const profile = JSON.parse(readFileSync('eas.json', 'utf8')).build?.[channel];
const publicEnv = Object.fromEntries(
  Object.entries(profile?.env ?? {}).filter(([name]) => name.startsWith('EXPO_PUBLIC_')),
);
const required = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
];
const missing = required.filter((name) => !publicEnv[name]);
if (missing.length > 0) fail(`eas.json production env is missing ${missing.join(', ')}`);

function run(command, commandArgs, env) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: true, env });
  if (result.status !== 0) fail(`${command} exited with code ${result.status}`);
}

// Production values win over anything in the shell or a local .env file.
const env = { ...process.env, ...publicEnv, EXPO_NO_DOTENV: '1', EXPO_PUBLIC_USE_EMULATORS: 'false' };
const outputDir = mkdtempSync(join(tmpdir(), 'harvest-ota-'));
run('npx', ['expo', 'export', '--platform', 'android', '--output-dir', `"${outputDir}"`], env);

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const bundles = files(outputDir).filter((path) => /\.(hbc|js|bundle)$/.test(path));
if (bundles.length === 0) fail('the export produced no JavaScript bundle');
const bundleText = bundles.map((path) => readFileSync(path, 'latin1')).join('\n');
const absent = required.filter((name) => !bundleText.includes(publicEnv[name]));
if (absent.length > 0) fail(`the exported bundle does not contain ${absent.join(', ')}`);
console.log(`\nVerified: the bundle contains the production Firebase and Google config.\nExport: ${outputDir}`);

if (!publish) {
  console.log('\nNothing was published. Re-run with --publish -m "what changed" to release.');
  process.exit(0);
}

run('npx', [
  'eas', 'update', '--channel', channel, '--platform', 'android',
  '--skip-bundler', '--input-dir', `"${outputDir}"`, '--message', JSON.stringify(message),
], env);
