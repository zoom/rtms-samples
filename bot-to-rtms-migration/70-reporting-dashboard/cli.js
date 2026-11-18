#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readTrace } from '../shared/trace.js';
import { generateSampleEvents } from './sample-data/generate.js';
import { buildReport } from './src/report.js';
import { renderHtml, renderText } from './src/render.js';

const { values } = parseArgs({
  options: {
    sample: { type: 'boolean' }, trace: { type: 'string' }, out: { type: 'string' }, print: { type: 'boolean' }, json: { type: 'boolean' },
    'write-sample': { type: 'string' }, streams: { type: 'string' }, hours: { type: 'string' }, help: { type: 'boolean' }
  }
});

if (values.help) {
  console.log(`Reporting dashboard
  --sample               use the seeded sample events (no setup needed)
  --trace <file>         read a trace written by the 50, 61 and 62 samples (default TRACE_FILE or .data/events.jsonl)
  --hours <n>            only the last n hours of the trace
  --out <file>           write the HTML page (default .data/report.html)
  --print                also print a terminal summary
  --json                 print the report as JSON instead
  --write-sample <file>  write the sample events as a trace file and exit (--streams <n>, default 24)`);
  process.exit(0);
}

if (values['write-sample']) {
  const file = values['write-sample'];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${generateSampleEvents({ streams: Number(values.streams) || 24 }).map((e) => JSON.stringify(e)).join('\n')}\n`);
  console.log(`wrote ${file}`);
  process.exit(0);
}

let events;
let source;
if (values.sample) {
  events = generateSampleEvents();
  source = 'Seeded sample data.';
} else {
  const file = values.trace || process.env.TRACE_FILE || '.data/events.jsonl';
  const read = readTrace(file);
  events = read.events;
  source = `Trace ${file}${read.malformed ? `, ${read.malformed} malformed line(s) skipped` : ''}.`;
  if (!events.length) {
    console.error(`No events in ${file}. Run a demo with --write-trace first, or use --sample.`);
    process.exit(1);
  }
}

const report = buildReport(events, { windowMs: values.hours ? Number(values.hours) * 3_600_000 : null });
if (values.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const out = values.out || '.data/report.html';
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, renderHtml(report, { source }));
console.log(`wrote ${out}`);
if (values.print || values.sample) console.log(`\n${renderText(report)}`);
