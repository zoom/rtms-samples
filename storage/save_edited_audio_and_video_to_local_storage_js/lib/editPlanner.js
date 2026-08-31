import fs from 'fs/promises';
import path from 'path';

const EDIT_STYLES = new Set(['hard-cut', 'fade', 'dissolve']);

export async function generateEditPlan({ transcript, media, brief, config }) {
  if (!config.apiUrl || !config.apiKey || !config.model) {
    throw new Error('AI_API_URL, AI_API_KEY, and AI_MODEL are required to generate an edit plan');
  }

  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(config) },
        { role: 'user', content: JSON.stringify({ brief, media, transcript }) },
      ],
    }),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`AI edit planning failed (${response.status}): ${rawBody.slice(0, 1000)}`);
  }
  const envelope = JSON.parse(rawBody);
  const content = envelope.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI response did not include choices[0].message.content');

  const rawPlan = parseJsonContent(content);
  return {
    rawResponse: envelope,
    plan: validateEditPlan(rawPlan, media.durationMs, config),
  };
}

export function validateEditPlan(rawPlan, sourceDurationMs, config = {}) {
  if (!rawPlan || !Array.isArray(rawPlan.segments)) {
    throw new Error('Edit plan must contain a segments array');
  }

  const minSegmentMs = Number(config.minSegmentMs || 800);
  const maxOutputMs = Number(config.maxOutputMs || 300000);
  const style = EDIT_STYLES.has(rawPlan.style) ? rawPlan.style : 'hard-cut';
  const segments = rawPlan.segments.map((segment, index) => {
    const startMs = Math.max(0, Math.round(Number(segment.startMs)));
    const endMs = Math.min(sourceDurationMs, Math.round(Number(segment.endMs)));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < minSegmentMs) {
      throw new Error(`Segment ${index + 1} is invalid or shorter than ${minSegmentMs}ms`);
    }
    return {
      startMs,
      endMs,
      label: String(segment.label || `Segment ${index + 1}`).slice(0, 120),
      reason: String(segment.reason || '').slice(0, 500),
    };
  });

  segments.sort((a, b) => a.startMs - b.startMs);
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startMs < segments[index - 1].endMs) {
      throw new Error(`Segments ${index} and ${index + 1} overlap`);
    }
  }

  const selectedDurationMs = segments.reduce(
    (total, segment) => total + segment.endMs - segment.startMs,
    0
  );
  if (!segments.length) throw new Error('Edit plan must select at least one segment');
  if (selectedDurationMs > maxOutputMs) {
    throw new Error(`Selected duration exceeds AI_MAX_OUTPUT_SECONDS (${maxOutputMs / 1000}s)`);
  }

  return {
    version: 1,
    title: String(rawPlan.title || 'AI meeting edit').slice(0, 160),
    summary: String(rawPlan.summary || '').slice(0, 1000),
    style,
    transitionMs: style === 'hard-cut'
      ? 0
      : clamp(Number(rawPlan.transitionMs || 350), 100, 1000),
    aspectRatio: ['source', '16:9', '9:16', '1:1'].includes(rawPlan.aspectRatio)
      ? rawPlan.aspectRatio
      : 'source',
    selectedDurationMs,
    segments,
  };
}

export async function savePlanArtifacts(directory, { rawResponse, plan, brief }) {
  const editDirectory = path.join(directory, 'edits');
  await fs.mkdir(editDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(editDirectory, 'edit-plan.json'), `${JSON.stringify(plan, null, 2)}\n`),
    fs.writeFile(path.join(editDirectory, 'ai-response.json'), `${JSON.stringify(rawResponse, null, 2)}\n`),
    fs.writeFile(path.join(editDirectory, 'editing-brief.txt'), `${brief.trim()}\n`),
  ]);
  return editDirectory;
}

function systemPrompt(config) {
  return `You are a meeting video editor. Return JSON only. Select coherent transcript-backed moments from one synchronized source recording. Never invent timestamps. Remove dead air, repetition, setup chatter, and false starts unless the brief asks to preserve them. Preserve enough context that statements are not misleading. Schema: {"title":"...","summary":"...","style":"hard-cut|fade|dissolve","transitionMs":350,"aspectRatio":"source|16:9|9:16|1:1","segments":[{"startMs":0,"endMs":5000,"label":"...","reason":"..."}]}. Segments must be chronological, non-overlapping, at least ${config.minSegmentMs}ms, and total no more than ${config.maxOutputMs}ms.`;
}

function parseJsonContent(content) {
  const cleaned = String(content).trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
