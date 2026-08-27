#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set([
  '.data', '.git', '.gradle', '.venv', 'bin', 'build', 'dist', 'logs', 'node_modules',
  'obj', 'recordings', 'target', 'temp', 'test', 'tests', 'venv', 'vendor'
]);
const sourceExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.cxx', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
  '.mjs', '.py', '.sh', '.ts', '.tsx'
]);
const ignoredEnvironmentKeys = new Set(['GST_DEBUG', 'GST_DEBUG_FILE']);
const keyPattern = '[A-Za-z_][A-Za-z0-9_]*';
const sourcePatterns = [
  new RegExp(`process\\.env\\.(${keyPattern})`, 'g'),
  new RegExp(`process\\.env\\[['\"](${keyPattern})['\"]\\]`, 'g'),
  new RegExp(`os\\.(?:getenv|environ\\.get)\\(\\s*['\"](${keyPattern})['\"]`, 'g'),
  new RegExp(`os\\.environ\\[\\s*['\"](${keyPattern})['\"]\\s*\\]`, 'g'),
  new RegExp(`os\\.(?:Getenv|LookupEnv)\\(\\s*\"(${keyPattern})\"`, 'g'),
  new RegExp(`Environment\\.GetEnvironmentVariable\\(\\s*\"(${keyPattern})\"`, 'g'),
  new RegExp(`System\\.getenv\\(\\s*\"(${keyPattern})\"`, 'g'),
  new RegExp(`(?:std::)?getenv\\(\\s*\"(${keyPattern})\"`, 'g'),
  new RegExp(`(?:config_value|envBoolean|envNumber|envPositiveNumber|requireEnvironmentVariable)\\(\\s*['\"](${keyPattern})['\"]`, 'g')
];

function walk(directory, predicate, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'EACCES') return results;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, predicate, results);
    else if (entry.isFile() && predicate(fullPath)) results.push(fullPath);
  }
  return results;
}

function parseEnvKeys(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const keys = new Set();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function assignmentKey(line) {
  return line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] || null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferDefault(directory, key) {
  const escapedKey = escapeRegExp(key);
  const files = walk(directory, (filePath) => sourceExtensions.has(path.extname(filePath)));
  const patterns = [
    new RegExp(`process\\.env\\.${escapedKey}\\s*(?:\\|\\||\\?\\?)\\s*['\"]([^'\"]*)['\"]`),
    new RegExp(`process\\.env\\.${escapedKey}\\s*(?:\\|\\||\\?\\?)\\s*(-?\\d+(?:\\.\\d+)?|true|false)`),
    new RegExp(`os\\.(?:getenv|environ\\.get)\\(\\s*['\"]${escapedKey}['\"]\\s*,\\s*['\"]([^'\"]*)['\"]`),
    new RegExp(`os\\.(?:getenv|environ\\.get)\\(\\s*['\"]${escapedKey}['\"]\\s*,\\s*(-?\\d+(?:\\.\\d+)?|True|False)`),
    new RegExp(`GetEnvironmentVariable\\(\\s*\"${escapedKey}\"\\s*\\)\\s*\\?\\?\\s*\"([^\"]*)\"`),
    new RegExp(`getOrDefault\\(\\s*\"${escapedKey}\"\\s*,\\s*\"([^\"]*)\"`),
    new RegExp(`(?:envBoolean|envNumber|envPositiveNumber)\\(\\s*['\"]${escapedKey}['\"]\\s*,\\s*['\"]([^'\"]*)['\"]`),
    new RegExp(`(?:envBoolean|envNumber|envPositiveNumber)\\(\\s*['\"]${escapedKey}['\"]\\s*,\\s*(-?\\d+(?:\\.\\d+)?|true|false)`)
  ];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match) return match[1];
    }
  }
  const explicitDefaults = {
    EXIT_AFTER_STOP: 'true',
    OPENAI_REALTIME_DEBUG_EVENTS: 'false',
    PROCESS_EVERY_N_FRAMES: '50',
    RTMS_PARTICIPANT_USER_ID: '',
    ZM_RTMS_PORT: '8080'
  };
  if (Object.hasOwn(explicitDefaults, key)) return explicitDefaults[key];
  return null;
}

function isPlaceholder(value) {
  return /(?:x{3,}|y{3,}|change[_ -]?me|replace[_ -]?with|your[_ -])/i.test(value);
}

function isCredentialKey(key) {
  if (/ROUTING_KEY$/i.test(key)) return false;
  return /(?:ACCOUNT_ID|API_KEY|ACCESS_KEY|CLIENT_ID|CLIENT_SECRET|KEY|PASSWORD|SECRET|TOKEN|USER_ID)$/i.test(key);
}

function placeholderFor(key) {
  if (key === 'zoomWSURLForEvents') {
    return '"wss://ws.zoom.us/ws?subscriptionId=YOUR_SUBSCRIPTION_ID_HERE"';
  }
  return `"YOUR_${key.toUpperCase()}_HERE"`;
}

function formatExampleValue(directory, key, existingValue = null) {
  if (isCredentialKey(key)) return placeholderFor(key);
  if (existingValue != null && !isPlaceholder(existingValue)) return existingValue.trim();
  const inferred = inferDefault(directory, key);
  if (inferred != null) {
    if (isPlaceholder(inferred)) return placeholderFor(key);
    if (/^-?\d+(?:\.\d+)?$|^(?:true|false)$/i.test(inferred)) return inferred;
    return `"${inferred.replaceAll('"', '\\"')}"`;
  }
  return placeholderFor(key);
}

function normalizeExample(directory, content) {
  return content.split(/\r?\n/).map((line) => {
    const key = assignmentKey(line);
    if (!key) return line;
    const separator = line.indexOf('=');
    const value = line.slice(separator + 1);
    const normalizedValue = !isCredentialKey(key) && !isPlaceholder(value)
      ? value.trim()
      : formatExampleValue(directory, key, value);
    return `${key}=${normalizedValue}`;
  }).join('\n');
}

function appendAssignments(content, heading, assignments) {
  if (!assignments.length) return content;
  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}\n\n# ${heading}\n${assignments.join('\n')}\n`;
}

function reconcileFiles(directory, examplePath, envPath, sourceKeys) {
  let exampleContent = normalizeExample(directory, fs.readFileSync(examplePath, 'utf8'));
  exampleContent = exampleContent.split(/\r?\n/)
    .filter((line) => !ignoredEnvironmentKeys.has(assignmentKey(line)))
    .join('\n');
  fs.writeFileSync(examplePath, exampleContent);
  let exampleKeys = parseEnvKeys(examplePath);
  const missingSourceKeys = difference(sourceKeys, exampleKeys);
  exampleContent = appendAssignments(
    exampleContent,
    'Additional runtime configuration',
    missingSourceKeys.map((key) => `${key}=${formatExampleValue(directory, key)}`)
  );
  fs.writeFileSync(examplePath, exampleContent);
  exampleKeys = parseEnvKeys(examplePath);

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, exampleContent);
    return;
  }

  let envContent = fs.readFileSync(envPath, 'utf8');
  envContent = envContent.split(/\r?\n/)
    .filter((line) => !ignoredEnvironmentKeys.has(assignmentKey(line)))
    .join('\n');
  fs.writeFileSync(envPath, envContent);
  const envKeys = parseEnvKeys(envPath);
  const staleKeys = difference(envKeys, new Set([...sourceKeys, ...exampleKeys]));
  if (staleKeys.length) {
    const stale = new Set(staleKeys);
    envContent = envContent.split(/\r?\n/)
      .filter((line) => !stale.has(assignmentKey(line)))
      .join('\n');
  }

  const retainedEnvKeys = new Set([...envKeys].filter((key) => !staleKeys.includes(key)));
  const missingEnvKeys = difference(exampleKeys, retainedEnvKeys);
  const exampleValues = new Map();
  for (const line of exampleContent.split(/\r?\n/)) {
    const key = assignmentKey(line);
    if (key) exampleValues.set(key, line.slice(line.indexOf('=') + 1));
  }
  envContent = envContent.split(/\r?\n/).map((line) => {
    const key = assignmentKey(line);
    if (!key) return line;
    const separator = line.indexOf('=');
    const value = line.slice(separator + 1);
    if (!isPlaceholder(value) || !exampleValues.has(key)) return line;
    return `${line.slice(0, separator + 1)}${exampleValues.get(key)}`;
  }).join('\n');
  envContent = appendAssignments(
    envContent,
    'Added to match .env.example',
    missingEnvKeys.map((key) => `${key}=${exampleValues.get(key)}`)
  );
  fs.writeFileSync(envPath, envContent);
}

function extractSourceKeys(directory) {
  const keys = new Set();
  const files = walk(directory, (filePath) => sourceExtensions.has(path.extname(filePath)));
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const pattern of sourcePatterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const trailingSource = source.slice(match.index + match[0].length);
        if (/^\s*=(?!=)/.test(trailingSource)) continue;
        if (!ignoredEnvironmentKeys.has(match[1])) keys.add(match[1]);
      }
    }
  }
  return keys;
}

function difference(left, right) {
  return [...left].filter((key) => !right.has(key)).sort();
}

const examples = walk(root, (filePath) => path.basename(filePath) === '.env.example').sort();
const shouldFix = process.argv.includes('--fix');
let failures = 0;

for (const examplePath of examples) {
  const directory = path.dirname(examplePath);
  const envPath = path.join(directory, '.env');
  const sourceKeys = extractSourceKeys(directory);
  if (shouldFix) reconcileFiles(directory, examplePath, envPath, sourceKeys);
  const missingEnvFile = !fs.existsSync(envPath);
  const exampleKeys = parseEnvKeys(examplePath);
  const envKeys = parseEnvKeys(envPath);
  const missingFromExample = difference(sourceKeys, exampleKeys);
  const missingFromEnv = fs.existsSync(envPath) ? difference(exampleKeys, envKeys) : [];
  const localOnly = fs.existsSync(envPath) ? difference(envKeys, exampleKeys) : [];

  if (missingEnvFile || missingFromExample.length || missingFromEnv.length || localOnly.length) {
    failures += 1;
    console.log(path.relative(root, directory));
    if (missingEnvFile) console.log('  missing_env_file: .env');
    if (missingFromExample.length) console.log(`  code_only: ${missingFromExample.join(',')}`);
    if (missingFromEnv.length) console.log(`  example_only: ${missingFromEnv.join(',')}`);
    if (localOnly.length) console.log(`  env_only: ${localOnly.join(',')}`);
  }
}

console.log(`env_examples=${examples.length} inconsistent_projects=${failures}`);
process.exitCode = failures ? 1 : 0;
