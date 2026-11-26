import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import detectActionItems from './actionItems.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export const INDUSTRY_TEMPLATES = Object.freeze({
  general: {
    id: 'general',
    name: 'General Meeting',
    description: 'Executive summary, decisions, blockers, and next steps.',
    sections: ['Executive Summary', 'Key Decisions', 'Risks & Blockers', 'Next Steps'],
    entityTypes: ['Person', 'Organization', 'Project', 'Date'],
    guidance: 'Capture concise business notes focusing on decisions, owners, timelines, and blockers.'
  },
  healthcare_soap: {
    id: 'healthcare_soap',
    name: 'Healthcare (SOAP Note)',
    description: 'Clinical Subjective, Objective, Assessment, and Plan structure.',
    sections: ['Subjective', 'Objective', 'Assessment', 'Plan'],
    entityTypes: ['Symptom', 'Medication', 'Diagnosis', 'Procedure', 'Provider'],
    guidance: 'Organize clinical encounter details strictly into Subjective (patient history/symptoms), Objective (vitals/findings), Assessment (differential/impression), and Plan (medications, labs, follow-up).'
  },
  legal_compliance: {
    id: 'legal_compliance',
    name: 'Legal & Compliance',
    description: 'Matter details, contractual obligations, compliance risks, and approvals.',
    sections: ['Matter & Parties', 'Obligations & Clauses', 'Compliance Risks', 'Approvals & Deadlines'],
    entityTypes: ['Party', 'Statute/Regulation', 'Clause', 'Jurisdiction', 'Deadline'],
    guidance: 'Highlight contractual commitments, regulatory exposure, privilege/approval gates, and exact filing or review deadlines.'
  },
  sales_meddic: {
    id: 'sales_meddic',
    name: 'Sales (MEDDIC)',
    description: 'Metrics, Economic Buyer, Decision Criteria/Process, Pain, and Champion.',
    sections: ['Metrics', 'Economic Buyer', 'Decision Criteria', 'Decision Process', 'Identify Pain', 'Champion'],
    entityTypes: ['Account', 'Stakeholder', 'Competitor', 'Metric', 'Timeline'],
    guidance: 'Map discovery and deal qualification signals cleanly to each MEDDIC pillar without fabricating unstated buyer commitments.'
  },
  finance_advisory: {
    id: 'finance_advisory',
    name: 'Financial Advisory',
    description: 'Client goals, portfolio & risk profile, recommendations, and disclosures.',
    sections: ['Client Goals', 'Portfolio & Risk Profile', 'Recommendations', 'Disclosures & Follow-ups'],
    entityTypes: ['Asset/Ticker', 'Amount', 'Goal', 'Institution', 'Regulation'],
    guidance: 'Record stated financial objectives, risk tolerance, allocation or tax recommendations, and required compliance disclosures.'
  },
  engineering_rfc: {
    id: 'engineering_rfc',
    name: 'Engineering RFC',
    description: 'Problem statement, architecture proposal, tradeoffs, and rollout plan.',
    sections: ['Problem Statement', 'Proposed Architecture', 'Tradeoffs & Risks', 'Rollout & Owners'],
    entityTypes: ['Service/Component', 'Technology', 'Metric/SLO', 'Owner', 'Milestone'],
    guidance: 'Capture technical design decisions, system boundaries, latency/reliability tradeoffs, migration risks, and rollout owners.'
  }
});

export function getTemplateById(templateId) {
  return INDUSTRY_TEMPLATES[templateId] || INDUSTRY_TEMPLATES.general;
}

export function listTemplates() {
  return Object.values(INDUSTRY_TEMPLATES).map(({ id, name, description, sections }) => ({
    id,
    name,
    description,
    sections: [...sections]
  }));
}

/**
 * Safely extracts the first valid JSON object from an LLM response string.
 */
export function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Balanced brace scan to handle trailing commentary
    const start = candidate.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(candidate.slice(start, i + 1));
              return parsed && typeof parsed === 'object' ? parsed : null;
            } catch {
              return null;
            }
          }
        }
      }
    }
    return null;
  }
}

function emptySections(template) {
  const sections = {};
  for (const name of template.sections) {
    sections[name] = [];
  }
  return sections;
}

function normalizeExtractedPayload(parsed, template) {
  const sections = emptySections(template);
  if (parsed.sections && typeof parsed.sections === 'object') {
    for (const sectionName of template.sections) {
      const value = parsed.sections[sectionName];
      if (Array.isArray(value)) {
        sections[sectionName] = value.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 10);
      } else if (typeof value === 'string' && value.trim()) {
        sections[sectionName] = [value.trim()];
      }
    }
  }

  const actionItems = Array.isArray(parsed.actionItems)
    ? parsed.actionItems
        .map((item) => {
          if (typeof item === 'string') {
            return { task: item.trim(), owner: 'Unassigned', dueDate: '', priority: 'Medium' };
          }
          if (!item || typeof item !== 'object') return null;
          const task = String(item.task || item.text || '').trim();
          if (!task) return null;
          return {
            task,
            owner: String(item.owner || 'Unassigned').trim() || 'Unassigned',
            dueDate: String(item.dueDate || '').trim(),
            priority: ['High', 'Medium', 'Low'].includes(item.priority) ? item.priority : 'Medium'
          };
        })
        .filter(Boolean)
        .slice(0, 20)
    : [];

  const topics = Array.isArray(parsed.topics)
    ? Array.from(new Set(parsed.topics.map((t) => String(t || '').trim()).filter(Boolean))).slice(0, 12)
    : [];

  const entities = Array.isArray(parsed.entities)
    ? parsed.entities
        .map((ent) => {
          if (typeof ent === 'string') {
            return { name: ent.trim(), type: template.entityTypes[0] || 'Term' };
          }
          if (!ent || typeof ent !== 'object') return null;
          const name = String(ent.name || '').trim();
          if (!name) return null;
          return { name, type: String(ent.type || 'Term').trim() || 'Term' };
        })
        .filter(Boolean)
        .slice(0, 25)
    : [];

  return {
    summary: String(parsed.summary || '').trim(),
    sections,
    actionItems,
    topics,
    entities
  };
}

/**
 * Local regex & heuristic fallback when OpenRouter is unconfigured or fails.
 */
export function buildLocalFallbackNotes({ transcriptTurns = [], templateId = 'general' }) {
  const template = getTemplateById(templateId);
  const sections = emptySections(template);
  const actionItems = [];
  const entityMap = new Map();
  const topics = new Set();

  for (const turn of transcriptTurns) {
    const text = String(turn.text || '').trim();
    const speaker = String(turn.userName || 'Speaker').trim();
    if (!text) continue;

    if (speaker && speaker !== 'Speaker') {
      entityMap.set(`person:${speaker.toLowerCase()}`, { name: speaker, type: 'Person' });
    }

    const detected = detectActionItems(text, speaker);
    actionItems.push(...detected);

    // Extract money / percentages / dates
    const metricMatches = text.match(/(?:\$\d[\d,.]*[kmb]?|\b\d+(?:\.\d+)?%|\bQ[1-4]\s*20\d{2}\b)/gi) || [];
    for (const m of metricMatches) {
      entityMap.set(`metric:${m.toLowerCase()}`, { name: m, type: 'Metric' });
    }

    // Extract proper-noun phrases (2+ capitalized words)
    const properMatches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    for (const phrase of properMatches) {
      entityMap.set(`term:${phrase.toLowerCase()}`, { name: phrase, type: template.entityTypes[1] || 'Term' });
    }

    // Simple keyword topic tagging
    const topicRules = [
      ['Budget & Finance', /\b(budget|revenue|cost|price|pricing|roi|portfolio|forecast|quarter)\b/i],
      ['Compliance & Legal', /\b(compliance|hipaa|gdpr|contract|clause|legal|audit|policy|risk)\b/i],
      ['Clinical Care', /\b(patient|symptom|diagnosis|dosage|medication|blood pressure|clinic|follow-up)\b/i],
      ['Engineering', /\b(api|latency|deploy|architecture|database|migration|service|scale|bug)\b/i],
      ['Sales & Pipeline', /\b(prospect|deal|champion|buyer|renewal|demo|pilot|contract)\b/i],
      ['Planning', /\b(roadmap|timeline|milestone|deadline|launch|schedule|owner)\b/i]
    ];
    for (const [label, regex] of topicRules) {
      if (regex.test(text)) topics.add(label);
    }
  }

  const recentSnippets = transcriptTurns
    .slice(-4)
    .map((t) => `${t.userName || 'Speaker'}: ${t.text}`)
    .filter(Boolean);

  const firstSection = template.sections[0];
  const lastSection = template.sections[template.sections.length - 1];
  if (recentSnippets.length > 0) {
    sections[firstSection] = recentSnippets.slice(0, 3);
  }
  if (actionItems.length > 0 && lastSection) {
    sections[lastSection] = actionItems.slice(0, 5).map((a) => `${a.owner}: ${a.task}`);
  }

  const summary = recentSnippets.length > 0
    ? `Local note snapshot (${template.name}) from ${transcriptTurns.length} turn(s): ${recentSnippets.slice(-2).join(' ')}`
    : '';

  return {
    summary,
    sections,
    actionItems: actionItems.slice(0, 15),
    topics: Array.from(topics).slice(0, 8),
    entities: Array.from(entityMap.values()).slice(0, 20),
    source: 'fallback'
  };
}

/**
 * Single batched structured-JSON LLM extraction call tailored to the active industry template.
 * Falls back cleanly to local extraction if API key is absent, HTTP status is not OK, or JSON is malformed.
 */
export async function extractStructuredNotes({
  transcriptTurns = [],
  templateId = 'general',
  previousState = null,
  isFinalWrapup = false,
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.OPENROUTER_MODEL || process.env.SUMMARY_MODEL || DEFAULT_MODEL,
  fetchImpl = fetch
} = {}) {
  const template = getTemplateById(templateId);

  if (!Array.isArray(transcriptTurns) || transcriptTurns.length === 0) {
    return {
      summary: previousState?.summary || '',
      sections: previousState?.sections || emptySections(template),
      actionItems: previousState?.actionItems || [],
      topics: previousState?.topics || [],
      entities: previousState?.entities || [],
      source: 'empty'
    };
  }

  if (!apiKey) {
    return buildLocalFallbackNotes({ transcriptTurns, templateId: template.id });
  }

  const transcriptBlock = transcriptTurns
    .slice(-40)
    .map((t) => `[${t.userName || 'Speaker'}]: ${t.text}`)
    .join('\n');

  const sectionSchema = Object.fromEntries(template.sections.map((s) => [s, ['Concise bullet point']]));
  const systemPrompt = `You are an expert ${template.name} meeting notetaker.
${template.guidance}
${isFinalWrapup ? 'This is the FINAL meeting wrap-up. Produce a polished, comprehensive summary.' : 'Update the structured notes incrementally based on the meeting transcript.'}
Return ONLY valid JSON (no markdown code fences) matching this exact schema:
{
  "summary": "2-3 sentence executive overview.",
  "sections": ${JSON.stringify(sectionSchema)},
  "actionItems": [
    { "task": "Clear actionable item", "owner": "Speaker or Unassigned", "dueDate": "Optional date or empty string", "priority": "High|Medium|Low" }
  ],
  "topics": ["Topic 1", "Topic 2"],
  "entities": [
    { "name": "Entity name", "type": "${template.entityTypes.join('|')}" }
  ]
}`;

  try {
    const res = await fetchImpl(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Meeting Transcript:\n${transcriptBlock}` }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[IndustryExtractor] OpenRouter HTTP ${res.status}: ${errText.slice(0, 160)}; using fallback.`);
      return buildLocalFallbackNotes({ transcriptTurns, templateId: template.id });
    }

    const data = await res.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(rawContent);
    if (!parsed) {
      console.warn('[IndustryExtractor] Model returned non-JSON response; using local fallback.');
      return buildLocalFallbackNotes({ transcriptTurns, templateId: template.id });
    }

    return {
      ...normalizeExtractedPayload(parsed, template),
      source: 'llm'
    };
  } catch (err) {
    console.warn(`[IndustryExtractor] Extraction failed (${err.message || err}); using local fallback.`);
    return buildLocalFallbackNotes({ transcriptTurns, templateId: template.id });
  }
}
