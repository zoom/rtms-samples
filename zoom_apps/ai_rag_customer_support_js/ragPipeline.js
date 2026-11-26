import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

import { loadDocuments } from './loaders/index.js';
import { splitDocuments, createRetriever } from './langchain/embedUtils.js';
import { chatWithOpenRouter } from './chatWithOpenrouter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

let retriever = null;
let loadedDocuments = [];
let lastLoadedAt = null;
let activeDocsDir = path.resolve(__dirname, './docs');

const FILLER_PATTERNS = [
  /^(hi|hello|hey|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|okay|ok|alright|sure|yep|yeah|yes|no|nope|uh\s*huh|mm\s*hmm|got\s+it|sounds\s+good|great|cool|awesome|bye|goodbye|see\s+you|take\s+care)[.!?\s]*$/i
];

const INTENT_REGEX = /\?|\b(how|what|when|where|why|which|who|can\s+i|could\s+you|do\s+you|is\s+there|are\s+there|does|help|issue|problem|error|fail|cannot|can't|unable|reset|setup|set\s+up|install|configure|download|policy|refund|cancel|billing|price|cost|account|email|password|login|sign\s+in|access|support|upgrade|deadline|scholarship|sync)\b/i;

/**
 * Determines whether an utterance looks like a customer question or support intent
 * worthy of triggering automatic RAG retrieval (filtering out greetings & filler).
 */
export function shouldTriggerAutoRag(text, options = {}) {
  const minChars = Number(options.minChars ?? process.env.RAG_MIN_QUERY_CHARS) || 12;
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length < minChars) return false;
  if (FILLER_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return INTENT_REGEX.test(trimmed) || trimmed.split(/\s+/).length >= 6;
}

/**
 * Loads document files from docsDir, chunks them, and builds the hybrid retriever.
 */
export async function preloadRetrieverOnce(options = {}) {
  if (retriever && !options.forceReload) {
    return getKnowledgeBaseStatus();
  }

  const docsDir = options.docsDir || activeDocsDir;
  activeDocsDir = docsDir;

  const entries = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir).map((file) => path.join(docsDir, file))
    : [];

  const rawDocs = await loadDocuments(entries);
  const chunks = await splitDocuments(rawDocs, {
    chunkSize: options.chunkSize,
    chunkOverlap: options.chunkOverlap
  });

  const chunksPerFile = new Map();
  for (const chunk of chunks) {
    const name = chunk.metadata?.fileName || 'unknown';
    chunksPerFile.set(name, (chunksPerFile.get(name) || 0) + 1);
  }

  retriever = await createRetriever(chunks, {
    topK: options.topK,
    minScore: options.minScore,
    enableRemoteEmbeddings: options.enableRemoteEmbeddings,
    fetchImpl: options.fetchImpl
  });

  lastLoadedAt = Date.now();
  loadedDocuments = rawDocs.map((doc) => ({
    fileName: doc.fileName || path.basename(doc.file),
    ext: doc.ext || path.extname(doc.file).toLowerCase(),
    charCount: doc.content.length,
    chunkCount: chunksPerFile.get(doc.fileName || path.basename(doc.file)) || 0,
    loadedAt: lastLoadedAt
  }));

  console.log(
    `[RAG] Loaded ${loadedDocuments.length} document(s), ${chunks.length} chunk(s), mode=${retriever.getStats().mode}`
  );

  return getKnowledgeBaseStatus();
}

export async function reloadKnowledgeBase(options = {}) {
  return preloadRetrieverOnce({ ...options, forceReload: true });
}

export function getKnowledgeBaseStatus() {
  return {
    documents: loadedDocuments.map((d) => ({ ...d })),
    stats: retriever
      ? { ...retriever.getStats(), loadedAt: lastLoadedAt }
      : { chunkCount: 0, mode: 'uninitialized', embeddingModel: null, minScore: 0.12, loadedAt: null }
  };
}

export function setRetrieverForTesting(customRetriever, docs = []) {
  retriever = customRetriever;
  loadedDocuments = docs;
  lastLoadedAt = Date.now();
}

function formatCitations(contextDocs) {
  return contextDocs.map((doc, idx) => ({
    index: idx + 1,
    fileName: doc.metadata?.fileName || path.basename(doc.metadata?.source || 'Unknown source'),
    source: doc.metadata?.source || 'Unknown source',
    chunkIndex: doc.metadata?.chunkIndex ?? 0,
    totalChunks: doc.metadata?.totalChunks ?? 1,
    score: doc.score ?? 0,
    snippet: doc.metadata?.snippet || String(doc.pageContent || '').slice(0, 220),
    content: doc.pageContent
  }));
}

function buildExtractiveFallback(citations) {
  return citations.slice(0, 3).map((cite) => `[${cite.index}] ${cite.fileName}: ${cite.snippet}`);
}

/**
 * Retrieves relevant KB chunks and generates a grounded Agent Assist suggestion
 * with confidence and verifiable source citations.
 */
export async function askLLMWithTranscript(query, options = {}) {
  if (!retriever) {
    throw new Error('Retriever is not initialized. Call preloadRetrieverOnce() first.');
  }

  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) {
    throw new Error('Query text is empty.');
  }

  const startedAt = Date.now();
  const conversationContext = Array.isArray(options.conversationContext) ? options.conversationContext : [];

  // Enrich short follow-up questions with the last customer turn for better retrieval
  const lastCustomerTurn = [...conversationContext]
    .reverse()
    .find((t) => t.role === 'customer' && t.text !== trimmedQuery);
  const retrievalQuery = trimmedQuery.length < 36 && lastCustomerTurn
    ? `${lastCustomerTurn.text} ${trimmedQuery}`
    : trimmedQuery;

  const contextDocs = await retriever.getRelevantDocuments(retrievalQuery, {
    topK: options.topK,
    minScore: options.minScore
  });
  const citations = formatCitations(contextDocs);
  const stats = retriever.getStats();

  if (citations.length === 0) {
    return {
      question: trimmedQuery,
      bullets: ['No matching documentation was found in the loaded knowledge base for this question.'],
      answer: '• No matching documentation was found in the loaded knowledge base for this question.',
      confidence: 'low',
      grounded: false,
      citations: [],
      retrievalMode: stats.mode,
      model: null,
      latencyMs: Date.now() - startedAt
    };
  }

  const topScore = citations[0]?.score || 0;
  const retrievalConfidence = topScore >= 0.45 ? 'high' : topScore >= 0.22 ? 'medium' : 'low';

  try {
    const llmResult = await chatWithOpenRouter({
      question: trimmedQuery,
      contextDocs,
      conversationContext,
      model: options.model,
      fetchImpl: options.fetchImpl
    });

    const citedSet = new Set(llmResult.citedSources || []);
    const orderedCitations = citedSet.size > 0
      ? citations.map((c) => ({ ...c, cited: citedSet.has(c.index) }))
      : citations.map((c) => ({ ...c, cited: true }));

    return {
      question: trimmedQuery,
      bullets: llmResult.bullets,
      answer: llmResult.answer,
      confidence: llmResult.confidence || retrievalConfidence,
      grounded: llmResult.grounded,
      citations: orderedCitations,
      retrievalMode: stats.mode,
      model: llmResult.model,
      latencyMs: Date.now() - startedAt
    };
  } catch (err) {
    console.warn(`[RAG] OpenRouter synthesis unavailable (${err.message}); returning grounded KB excerpts.`);
    const fallbackBullets = buildExtractiveFallback(citations);
    return {
      question: trimmedQuery,
      bullets: fallbackBullets,
      answer: fallbackBullets.map((b) => `• ${b}`).join('\n'),
      confidence: retrievalConfidence,
      grounded: true,
      fallbackExtractive: true,
      llmError: err.message,
      citations: citations.map((c) => ({ ...c, cited: true })),
      retrievalMode: stats.mode,
      model: null,
      latencyMs: Date.now() - startedAt
    };
  }
}
