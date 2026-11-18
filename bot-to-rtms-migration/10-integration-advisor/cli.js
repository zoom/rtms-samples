#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_REQUIREMENTS, REQUIREMENT_HELP, SCENARIOS, advise } from './src/advisor.js';
import { ASSUMPTION_CHANGES, CAPABILITY_MATRIX, MEDIA_PARITY, WHERE_IT_BELONGS } from './src/capabilities.js';

const USAGE = `Integration advisor: Meeting SDK bot to RTMS

  --scenario <name>        one of: ${Object.keys(SCENARIOS).join(', ')}
  --profile <file.json>    requirements as JSON, for example { "botSpeaks": true }
  --set a,b,c              turn requirement flags on (for example --set visibleBot,sendsChat)
  --unset a,b              turn default-true flags off (for example --unset approvalAcceptable)
  --requirements           list every flag and its default
  --capabilities | --media | --assumptions | --belongs    reference tables
  --json                   machine readable output`;

const table = (rows, cols) => {
  const widths = cols.map(([key, title]) => Math.max(title.length, ...rows.map((r) => String(r[key]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(cols.map(([, t]) => t)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map(([k]) => (typeof r[k] === 'boolean' ? (r[k] ? 'Yes' : 'No') : r[k]))));
};

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: 'string' }, profile: { type: 'string' }, set: { type: 'string' }, unset: { type: 'string' },
      requirements: { type: 'boolean' }, capabilities: { type: 'boolean' }, media: { type: 'boolean' },
      assumptions: { type: 'boolean' }, belongs: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' }
    }
  });

  if (values.help || !argv.length) return void console.log(USAGE);
  if (values.requirements) {
    for (const [k, v] of Object.entries(DEFAULT_REQUIREMENTS)) console.log(`${k.padEnd(36)} default ${String(v).padEnd(5)} ${REQUIREMENT_HELP[k]}`);
    return;
  }
  if (values.capabilities) return table(CAPABILITY_MATRIX, [['capability', 'Former bot capability'], ['rtms', 'RTMS?'], ['approach', 'Correct approach']]);
  if (values.media) return table(MEDIA_PARITY, [['media', 'Media'], ['rtms', 'RTMS'], ['note', 'Note']]);
  if (values.assumptions) return table(ASSUMPTION_CHANGES, [['sdk', 'Meeting SDK assumption'], ['rtms', 'RTMS requirement']]);
  if (values.belongs) return table(WHERE_IT_BELONGS, [['capability', 'Capability'], ['rtms', 'RTMS'], ['meetingSdk', 'Meeting SDK'], ['zoomApps', 'Zoom Apps'], ['webhooksRest', 'Webhooks/REST']]);

  let input = {};
  let title = 'Custom requirements';
  if (values.scenario) {
    const scenario = SCENARIOS[values.scenario];
    if (!scenario) throw new Error(`Unknown scenario "${values.scenario}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
    input = { ...scenario.requirements };
    title = scenario.title;
  }
  if (values.profile) input = { ...input, ...JSON.parse(readFileSync(values.profile, 'utf8')) };
  for (const flag of (values.set || '').split(',').filter(Boolean)) input[flag] = true;
  for (const flag of (values.unset || '').split(',').filter(Boolean)) input[flag] = false;

  const result = advise(input);
  if (values.json) return void console.log(JSON.stringify({ title, input, ...result }, null, 2));
  console.log(`${title}\n\nRecommendation: ${result.label}\n`);
  console.log('Why:');
  for (const r of result.reasons) console.log(`  - ${r}`);
  if (result.conditions.length) {
    console.log('\nBefore you commit:');
    for (const c of result.conditions) console.log(`  - ${c}`);
  }
  console.log('\nWho does what:');
  for (const [name, p] of Object.entries(result.pieces)) {
    if (p.uses.length) console.log(`  ${name.padEnd(13)} ${p.uses.join('; ')}`);
  }
  console.log('\nNext:');
  for (const n of result.next) console.log(`  - ${n}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
