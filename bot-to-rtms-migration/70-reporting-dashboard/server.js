import 'dotenv/config';
import { statSync } from 'node:fs';
import express from 'express';
import { readTrace } from '../shared/trace.js';
import { generateSampleEvents } from './sample-data/generate.js';
import { buildReport } from './src/report.js';
import { renderHtml } from './src/render.js';

const sample = process.argv.includes('--sample');
const file = process.env.TRACE_FILE || '.data/events.jsonl';
const port = Number(process.env.PORT_06 || 4806);
const host = process.env.HOST || '127.0.0.1';
const hours = Number(process.env.REPORT_HOURS || 0);

let cache = { key: null, report: null, html: null, source: '' };
function current() {
  let key = 'sample';
  if (!sample) {
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = 'missing';
    }
  }
  if (cache.key !== key) {
    const read = sample ? { events: generateSampleEvents(), malformed: 0 } : readTrace(file);
    const source = sample ? 'Seeded sample data.' : `Trace ${file}${read.malformed ? `, ${read.malformed} malformed line(s) skipped` : ''}.`;
    const report = buildReport(read.events, { windowMs: hours ? hours * 3_600_000 : null });
    cache = { key, report, source, html: renderHtml(report, { source }) };
  }
  return cache;
}

const app = express();
app.disable('x-powered-by');
app.get('/', (_req, res) => res.type('html').send(current().html));
app.get('/api/report', (_req, res) => res.json(current().report));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.listen(port, host, () => console.log(`Reporting dashboard on http://${host}:${port}/ (${sample ? 'sample data' : file})`));
