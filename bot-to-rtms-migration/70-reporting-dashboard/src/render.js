import { FUNNEL, SPAN_NAMES } from './report.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmtMs = (ms) => (ms === null || ms === undefined ? 'n/a' : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
export const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} KB` : `${b} B`);
const fmtTime = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : 'n/a');
const pretty = (s) => String(s).replaceAll('_', ' ');

const SPAN_LABEL = {
  webhook_to_signaling_connected: 'Webhook to signaling connected',
  signaling_ping_rtt: 'Signaling ping round trip',
  signaling_to_media_handshake: 'Signaling to media handshake',
  media_handshake_to_first_packet: 'Media handshake to first packet',
  reconnect: 'Socket reconnect time'
};
const FUNNEL_LABEL = { claimed: 'Webhook claimed', signaling_connected: 'Signaling connected', media_connected: 'Media connected', client_ready_sent: 'Client ready sent', streaming: 'Streaming', finalized: 'Finalized' };

function table(caption, head, rows, empty = 'No data in this window.') {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<table><caption class="sr">${esc(caption)}</caption><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function counts(obj, empty) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(pretty(k)), v]);
  return table('counts', ['Name', 'Count'], rows, empty);
}

function concurrencyChart(series, limit) {
  if (series.length < 2) return '<p class="empty">Not enough stream activity to draw a chart.</p>';
  const w = 600, h = 130, pad = 22;
  const t0 = series[0].t, t1 = series.at(-1).t || t0 + 1;
  const top = Math.max(limit || 0, ...series.map((p) => p.level), 1);
  const x = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  const y = (v) => h - pad - (v / top) * (h - pad * 2);
  let d = `M ${x(series[0].t).toFixed(1)} ${y(0).toFixed(1)}`;
  let prev = 0;
  for (const p of series) { d += ` L ${x(p.t).toFixed(1)} ${y(prev).toFixed(1)} L ${x(p.t).toFixed(1)} ${y(p.level).toFixed(1)}`; prev = p.level; }
  const limitLine = limit ? `<line x1="${pad}" x2="${w - pad}" y1="${y(limit).toFixed(1)}" y2="${y(limit).toFixed(1)}" class="limit"/><text x="${w - pad}" y="${(y(limit) - 4).toFixed(1)}" text-anchor="end" class="axis">limit ${limit}</text>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Concurrent streams over time, peak ${Math.max(...series.map((p) => p.level))}${limit ? ` of ${limit}` : ''}"><line x1="${pad}" x2="${w - pad}" y1="${y(0)}" y2="${y(0)}" class="baseline"/>${limitLine}<path d="${d}" class="line"/><text x="${pad}" y="${h - 6}" class="axis">${esc(fmtTime(t0).slice(11, 16))}</text><text x="${w - pad}" y="${h - 6}" text-anchor="end" class="axis">${esc(fmtTime(t1).slice(11, 16))}</text></svg>`;
}

export function renderHtml(report, { title = 'RTMS migration report', source = '' } = {}) {
  const r = report;
  const degraded = r.artifacts.filter((a) => a.degraded).length;
  const rejected = Object.values(r.webhooks.rejected).reduce((a, b) => a + b, 0);
  const dupTotal = r.duplicates.webhook + r.duplicates.stream + r.duplicates.lateStream + r.duplicates.refresh;
  const kpi = (label, value, note = '', tone = '') => `<div class="kpi ${tone}"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="n">${esc(note)}</div></div>`;

  const funnel = r.funnel.map((f) => `<div class="frow"><span class="fl">${esc(FUNNEL_LABEL[f.stage])}</span><span class="bar" role="img" aria-label="${f.pct ?? 0} percent"><i style="width:${f.pct ?? 0}%"></i></span><span class="fv">${f.count}<small> ${f.pct === null ? '' : `${f.pct}%`}</small></span></div>`).join('');

  const latencyRows = SPAN_NAMES.map((n) => {
    const s = r.latency[n];
    return [esc(SPAN_LABEL[n]), s.count, fmtMs(s.p50), fmtMs(s.p95), fmtMs(s.p99), fmtMs(s.max)];
  });
  const mediaRows = Object.entries(r.latencyByMedia).filter(([k]) => k.startsWith('media_handshake_to_first_packet')).map(([k, s]) => [esc(k.split(':')[1]), s.count, fmtMs(s.p50), fmtMs(s.p95), fmtMs(s.p99), fmtMs(s.max)]);

  const usageRows = r.usage.map((u) => [esc(u.tenantId), u.streams, fmtMs(u.durationMs), u.packets.toLocaleString('en-US'), fmtBytes(u.bytes), u.degraded]);
  const artifactRows = r.artifacts.slice(0, 25).map((a) => [
    `<code>${esc(a.streamId)}</code>`, esc(a.tenantId || 'unknown'), `gen ${a.generation}`,
    `schema ${esc(a.schemaVersion ?? '?')} / writer ${esc(a.writerVersion ?? '?')}`,
    a.consentRef ? `<code>${esc(a.consentRef)}</code>` : '<span class="bad">missing</span>',
    a.degraded ? `<span class="warn">degraded${a.gaps ? `, ${a.gaps} gap(s)` : ''}</span>` : 'clean'
  ]);
  const stopRows = Object.entries(r.stops.byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(pretty(k)), v]);
  const alerts = r.alerts.slice(0, 12).map((a) => `<li class="${esc(a.level)}"><time>${esc(fmtTime(a.at))}</time> ${esc(a.text)}</li>`).join('');
  const c = r.concurrency;
  const crmTotal = Object.values(r.crm.byStatus).reduce((a, b) => a + b, 0);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f5f6f8;--panel:#fff;--ink:#1b1f24;--mute:#5b6570;--line:#dfe3e8;--accent:#0b6e6e;--ok:#1e7b34;--warn:#a85a00;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:18px 24px;border-bottom:1px solid var(--line);background:var(--panel)}h1{margin:0;font-size:18px}header p{margin:4px 0 0;color:var(--mute)}
main{padding:16px 24px 40px;max-width:1280px;margin:0 auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 12px}.kpi .k{color:var(--mute);font-size:12px}.kpi .v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}.kpi .n{color:var(--mute);font-size:12px;min-height:16px}
.kpi.warn .v{color:var(--warn)}.kpi.bad .v{color:var(--bad)}.kpi.ok .v{color:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px;min-width:0}section.wide{grid-column:1/-1}
h2{margin:0 0 10px;font-size:14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mute);font-weight:600;font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.sr{position:absolute;left:-9999px}code{font:12px ui-monospace,Menlo,monospace}
.empty{color:var(--mute);margin:4px 0}.frow{display:grid;grid-template-columns:170px 1fr 90px;gap:10px;align-items:center;margin:6px 0}
.bar{display:block;height:10px;background:#e8ecef;border-radius:5px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.fv{text-align:right;font-variant-numeric:tabular-nums}.fv small{color:var(--mute)}
.warn{color:var(--warn)}.bad{color:var(--bad);font-weight:600}ul.alerts{list-style:none;margin:0;padding:0}ul.alerts li{padding:6px 0;border-bottom:1px solid var(--line)}ul.alerts li.critical{color:var(--bad)}ul.alerts li.warning{color:var(--warn)}ul.alerts time{color:var(--mute);margin-right:8px;font-size:12px}
svg{width:100%;height:auto}.line{fill:none;stroke:var(--accent);stroke-width:2}.limit{stroke:var(--bad);stroke-dasharray:4 4}.baseline{stroke:var(--line)}.axis{fill:var(--mute);font-size:10px}
.hint{color:var(--mute);font-size:12px;margin:8px 0 0}
@media(max-width:520px){main{padding:12px}header{padding:14px 12px}.frow{grid-template-columns:1fr auto}.frow .bar{grid-column:1/-1;order:3}table{font-size:12px}th,td{padding:5px 4px}section{padding:12px}}
</style></head><body>
<header><h1>${esc(title)}</h1><p>${esc(source)} ${r.window.from ? `Window ${esc(fmtTime(r.window.from))} to ${esc(fmtTime(r.window.to))} UTC, ${r.window.events} events.` : 'No events.'}</p></header>
<main>
<div class="kpis">
${kpi('Streams', r.streams.total, `${r.streams.tenants} tenant(s)`)}
${kpi('Peak concurrency', c.limit ? `${c.peak} / ${c.limit}` : c.peak, c.utilization !== null ? `${c.utilization}% of limit` : 'limit not reported', c.utilization >= 90 ? 'bad' : c.utilization >= 70 ? 'warn' : '')}
${kpi('Open now', c.openNow, 'streams with no stop yet')}
${kpi('Degraded captures', degraded, `${r.artifacts.length ? Math.round((degraded / r.artifacts.length) * 100) : 0}% of finalized`, degraded ? 'warn' : 'ok')}
${kpi('Webhooks rejected', rejected, 'bad signature or stale', rejected ? 'warn' : '')}
${kpi('Duplicates dropped', dupTotal + r.duplicates.chunks, `${r.duplicates.chunks} media chunks`)}
</div>
<div class="grid">
<section><h2>Start funnel</h2>${funnel}<p class="hint">Streams that reached each stage. A drop between stages is where captures fail to start.</p>
<h2 style="margin-top:14px">Start requests</h2>${counts(r.starts.attempts, 'No REST start requests.')}
${r.starts.watchdogFired ? `<p class="hint warn">${r.starts.watchdogFired} start request(s) never produced a started webhook.</p>` : ''}</section>
<section><h2>Latency</h2>${table('latency', ['Span', 'n', 'p50', 'p95', 'p99', 'max'], latencyRows)}
<h2 style="margin-top:14px">Time to first packet by media</h2>${table('first packet by media', ['Media', 'n', 'p50', 'p95', 'p99', 'max'], mediaRows)}<p class="hint">Alert on p95 and p99, not averages.</p></section>
<section><h2>Concurrency</h2>${concurrencyChart(c.series, c.limit)}<p class="hint">Peak ${c.peak}${c.limit ? ` of ${c.limit}` : ''}. Near-limit events: ${c.nearEvents}. Limit reached: ${c.limitedEvents}.</p></section>
<section><h2>Reconnects, pauses and gaps</h2>${table('recovery', ['Measure', 'Count'], [
    ['Socket closes (each failed reconnect attempt counts)', r.recovery.socketsClosed], ['Sockets recovered', r.recovery.socketsRecovered], ['Reconnect failed (generation ended)', r.recovery.reconnectFailed],
    ['Keep-alive silence detected', r.recovery.keepAliveSilence], ['Stream interrupted', r.recovery.interrupted], ['Paused / resumed', `${r.recovery.paused} / ${r.recovery.resumed}`],
    ['Median / p95 recovery time', `${fmtMs(r.recovery.downSummary.p50)} / ${fmtMs(r.recovery.downSummary.p95)}`], ['Captures with gaps', r.artifacts.filter((a) => a.gaps).length]
  ])}</section>
<section><h2>Stop reasons</h2>${table('stop reasons', ['Reason', 'Streams'], stopRows)}<p class="hint">Every stop is terminal for that stream. Restart policy decides what happens next.</p></section>
<section><h2>Duplicates dropped</h2>${table('duplicates', ['Layer', 'Count'], [
    ['Webhook retries (first attempt wins)', r.duplicates.webhook], ['Second worker on a live stream', r.duplicates.stream], ['Late started after stop', r.duplicates.lateStream],
    ['Started refresh on a live stream', r.duplicates.refresh], ['Media chunks replayed after reconnect', r.duplicates.chunks]
  ])}</section>
<section><h2>Usage per tenant</h2>${table('usage', ['Tenant', 'Streams', 'Stream time', 'Packets', 'Data', 'Degraded'], usageRows)}</section>
<section><h2>Webhook intake</h2>${counts(r.webhooks.rejected, 'No rejected webhooks.')}${Object.keys(r.webhooks.refused).length ? `<h2 style="margin-top:14px">Refused by tenant gate</h2>${counts(r.webhooks.refused)}` : ''}
<h2 style="margin-top:14px">Request status codes</h2>${counts(r.starts.requestStatus, 'None received.')}</section>
<section class="wide"><h2>Artifacts: version and consent</h2>${table('artifacts', ['Stream', 'Tenant', 'Generation', 'Versions', 'Consent reference', 'Quality'], artifactRows)}<p class="hint">Showing the latest ${Math.min(25, r.artifacts.length)} of ${r.artifacts.length}. An artifact without a consent reference is an audit finding.</p></section>
<section><h2>CRM sync</h2>${table('crm sync', ['Status', 'Streams'], [...Object.entries(r.crm.byStatus).map(([k, v]) => [esc(k), v]), ['not queued', r.crm.notQueued.length]].filter((row) => row[1] > 0), 'No CRM events.')}<p class="hint">Status comes from crm_sync events your own pipeline writes. ${crmTotal ? '' : 'None found.'}</p></section>
<section><h2>Alerts</h2>${alerts ? `<ul class="alerts">${alerts}</ul>` : '<p class="empty">No alerts.</p>'}</section>
</div></main></body></html>`;
}

export function renderText(report) {
  const r = report;
  const lines = [];
  lines.push(`Streams ${r.streams.total}, tenants ${r.streams.tenants}, events ${r.window.events}`);
  lines.push(`Peak concurrency ${r.concurrency.peak}${r.concurrency.limit ? ` of ${r.concurrency.limit}` : ''}, open now ${r.concurrency.openNow}`);
  lines.push('', 'Funnel');
  for (const f of r.funnel) lines.push(`  ${FUNNEL_LABEL[f.stage].padEnd(22)} ${String(f.count).padStart(4)}  ${f.pct ?? ''}%`);
  lines.push('', 'Latency (p50 / p95 / p99)');
  for (const n of SPAN_NAMES) {
    const s = r.latency[n];
    lines.push(`  ${SPAN_LABEL[n].padEnd(34)} n=${String(s.count).padStart(3)}  ${fmtMs(s.p50)} / ${fmtMs(s.p95)} / ${fmtMs(s.p99)}`);
  }
  lines.push('', `Stop reasons: ${Object.entries(r.stops.byReason).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  lines.push(`Duplicates dropped: webhook ${r.duplicates.webhook}, stream ${r.duplicates.stream}, late ${r.duplicates.lateStream}, refresh ${r.duplicates.refresh}, chunks ${r.duplicates.chunks}`);
  lines.push(`Recovery: closed ${r.recovery.socketsClosed}, recovered ${r.recovery.socketsRecovered}, failed ${r.recovery.reconnectFailed}`);
  lines.push(`Artifacts without consent reference: ${r.artifacts.filter((a) => !a.consentRef).length} of ${r.artifacts.length}`);
  lines.push(`CRM: ${Object.entries(r.crm.byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; not queued ${r.crm.notQueued.length}`);
  lines.push(`Alerts: ${r.alerts.length}`);
  return lines.join('\n');
}
