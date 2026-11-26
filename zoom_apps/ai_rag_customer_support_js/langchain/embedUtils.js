import path from 'path';

const DEFAULT_CHUNK_SIZE = 900;
const DEFAULT_CHUNK_OVERLAP = 150;
const DEFAULT_TOP_K = 4;
const DEFAULT_MIN_SCORE = 0.12;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 12000;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here',
  'him', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my',
  'no', 'not', 'of', 'on', 'or', 'our', 'out', 'she', 'should', 'so', 'some',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'up', 'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', 'your'
]);

function lightStem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const tokens = [];
  for (const part of raw) {
    const clean = part.replace(/^-+|-+$/g, '');
    if (clean.length < 2 || STOP_WORDS.has(clean)) continue;
    tokens.push(lightStem(clean));
  }
  return tokens;
}

function splitTextRecursively(text, chunkSize, chunkOverlap) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const paragraphs = normalized
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Break oversized paragraphs down into sentences or word spans.
  const units = [];
  for (const para of paragraphs) {
    if (para.length <= chunkSize) {
      units.push(para);
      continue;
    }
    const sentences = para.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length <= chunkSize) {
        units.push(sentence);
      } else {
        for (let i = 0; i < sentence.length; i += Math.max(1, chunkSize - chunkOverlap)) {
          units.push(sentence.slice(i, i + chunkSize).trim());
        }
      }
    }
  }

  const chunks = [];
  let current = '';

  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }

    if (current.length + unit.length + 2 <= chunkSize) {
      current = `${current}\n\n${unit}`;
    } else {
      chunks.push(current);
      const overlapText = chunkOverlap > 0 ? current.slice(-chunkOverlap).trim() : '';
      if (overlapText && overlapText.length + unit.length + 2 <= chunkSize) {
        current = `${overlapText}\n${unit}`;
      } else {
        current = unit;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits loaded documents into overlapping chunks with clean citation metadata.
 * @param {Array<{ file: string, content: string }>} docs
 * @param {{ chunkSize?: number, chunkOverlap?: number }} options
 */
export async function splitDocuments(docs, options = {}) {
  const chunkSize = Number(options.chunkSize) || DEFAULT_CHUNK_SIZE;
  const chunkOverlap = Math.min(
    Number(options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP),
    Math.floor(chunkSize / 2)
  );

  const allChunks = [];

  for (const doc of docs || []) {
    const file = doc?.file || 'unknown';
    const fileName = path.basename(file);
    const content = String(doc?.content || '');
    const textChunks = splitTextRecursively(content, chunkSize, chunkOverlap);
    const totalChunks = textChunks.length;

    textChunks.forEach((pageContent, chunkIndex) => {
      const compact = pageContent.replace(/\s+/g, ' ').trim();
      const snippet = compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
      allChunks.push({
        pageContent,
        metadata: {
          source: file,
          fileName,
          chunkIndex,
          totalChunks,
          snippet
        }
      });
    });
  }

  return allChunks;
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function isPlaceholderKey(key) {
  const value = String(key || '').trim();
  return !value || value.startsWith('YOUR_') || value === 'changeme';
}

function resolveEmbeddingConfig(options = {}) {
  const env = options.env || process.env;
  if (options.enableRemoteEmbeddings === false || String(env.ENABLE_REMOTE_EMBEDDINGS || '').toLowerCase() === 'false') {
    return null;
  }

  const model = String(options.embeddingModel || env.EMBEDDING_MODEL_ID || '').trim();
  if (!model) return null;

  const openAiKey = !isPlaceholderKey(env.OPENAI_API_KEY) ? String(env.OPENAI_API_KEY).trim() : '';
  const embeddingKey = !isPlaceholderKey(env.EMBEDDING_API_KEY) ? String(env.EMBEDDING_API_KEY).trim() : '';
  const openRouterKey = !isPlaceholderKey(env.OPENROUTER_API_KEY) ? String(env.OPENROUTER_API_KEY).trim() : '';

  const apiKey = options.apiKey || embeddingKey || openAiKey || openRouterKey;
  if (isPlaceholderKey(apiKey)) return null;

  const defaultUrl = openAiKey && !embeddingKey
    ? 'https://api.openai.com/v1/embeddings'
    : 'https://openrouter.ai/api/v1/embeddings';

  return {
    model,
    apiKey,
    endpoint: options.embeddingEndpoint || env.EMBEDDING_API_URL || defaultUrl,
    timeoutMs: Number(options.timeoutMs || env.EMBEDDING_TIMEOUT_MS) || DEFAULT_EMBEDDING_TIMEOUT_MS
  };
}

async function fetchEmbeddings(texts, config, fetchImpl = globalThis.fetch) {
  if (!config || !Array.isArray(texts) || texts.length === 0) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        input: texts
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Embeddings API HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const payload = await res.json();
    if (!Array.isArray(payload?.data) || payload.data.length !== texts.length) {
      throw new Error('Embeddings API returned unexpected payload shape');
    }

    return payload.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Builds a deterministic BM25 + TF-IDF cosine lexical index, optionally upgraded
 * with OpenAI/OpenRouter dense embeddings for hybrid retrieval.
 */
export async function createRetriever(chunks, options = {}) {
  const normalizedOptions = typeof options === 'number' ? { topK: options } : (options || {});
  const defaultTopK = Number(normalizedOptions.topK) || DEFAULT_TOP_K;
  const envMinScore = Number(process.env.RAG_MIN_SCORE);
  const defaultMinScore = Number.isFinite(normalizedOptions.minScore)
    ? normalizedOptions.minScore
    : (Number.isFinite(envMinScore) && process.env.RAG_MIN_SCORE !== '' ? envMinScore : DEFAULT_MIN_SCORE);
  const fetchImpl = normalizedOptions.fetchImpl || globalThis.fetch;

  const docs = (chunks || []).map((chunk) => {
    const tokens = tokenize(chunk.pageContent);
    const termFreq = new Map();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }
    return {
      chunk,
      lowerText: String(chunk.pageContent || '').toLowerCase(),
      tokens,
      length: tokens.length,
      termFreq
    };
  });

  const docCount = docs.length;
  const avgDocLength = docCount > 0
    ? docs.reduce((sum, d) => sum + d.length, 0) / docCount
    : 1;

  // Document frequency across corpus
  const df = new Map();
  for (const doc of docs) {
    for (const term of doc.termFreq.keys()) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  // Smooth IDF and TF-IDF unit vectors per document
  const idf = new Map();
  for (const [term, count] of df.entries()) {
    idf.set(term, Math.log((docCount + 1) / (count + 1)) + 1);
  }

  const docTfidfVectors = docs.map((doc) => {
    const weights = new Map();
    let normSq = 0;
    for (const [term, freq] of doc.termFreq.entries()) {
      const weight = (1 + Math.log(freq)) * (idf.get(term) || 1);
      weights.set(term, weight);
      normSq += weight * weight;
    }
    return { weights, norm: Math.sqrt(normSq) || 1 };
  });

  // Optional remote dense embeddings
  let embeddingConfig = resolveEmbeddingConfig(normalizedOptions);
  let docEmbeddings = null;
  let retrievalMode = 'bm25-tfidf';

  if (embeddingConfig && docs.length > 0) {
    try {
      const batchSize = 32;
      const vectors = [];
      for (let i = 0; i < docs.length; i += batchSize) {
        const batchTexts = docs.slice(i, i + batchSize).map((d) => d.chunk.pageContent);
        const batchVectors = await fetchEmbeddings(batchTexts, embeddingConfig, fetchImpl);
        vectors.push(...batchVectors);
      }
      if (vectors.length === docs.length) {
        docEmbeddings = vectors;
        retrievalMode = 'hybrid-embedding';
      }
    } catch (err) {
      console.warn(`[Retriever] Remote embeddings unavailable (${err.message}); falling back to BM25/TF-IDF scorer.`);
      embeddingConfig = null;
      docEmbeddings = null;
    }
  }

  function scoreLexical(queryText) {
    const queryTokens = tokenize(queryText);
    if (queryTokens.length === 0 || docs.length === 0) {
      return docs.map(() => 0);
    }

    const queryTf = new Map();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) || 0) + 1);
    }

    // Query TF-IDF vector
    const queryWeights = new Map();
    let queryNormSq = 0;
    for (const [term, freq] of queryTf.entries()) {
      const termIdf = idf.get(term) ?? (Math.log((docCount + 1) / 1) + 1);
      const weight = (1 + Math.log(freq)) * termIdf;
      queryWeights.set(term, weight);
      queryNormSq += weight * weight;
    }
    const queryNorm = Math.sqrt(queryNormSq) || 1;

    // Exact phrase / bigram check
    const normalizedQuery = String(queryText || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const uniqueQueryTerms = Array.from(queryTf.keys());
    const k1 = 1.5;
    const b = 0.75;

    return docs.map((doc, idx) => {
      // BM25
      let bm25 = 0;
      let matchedTerms = 0;
      for (const term of uniqueQueryTerms) {
        const freq = doc.termFreq.get(term) || 0;
        if (freq === 0) continue;
        matchedTerms++;
        const docFreq = df.get(term) || 0;
        const bm25Idf = Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));
        const denom = freq + k1 * (1 - b + b * (doc.length / avgDocLength));
        bm25 += bm25Idf * ((freq * (k1 + 1)) / denom);
      }

      if (matchedTerms === 0) return 0;

      // TF-IDF cosine similarity
      const docVec = docTfidfVectors[idx];
      let dot = 0;
      for (const [term, qWeight] of queryWeights.entries()) {
        const dWeight = docVec.weights.get(term);
        if (dWeight) dot += qWeight * dWeight;
      }
      const tfidfCosine = dot / (queryNorm * docVec.norm);

      // Saturating BM25 normalization preserves absolute relevance
      const normBm25 = bm25 / (bm25 + 2.0);
      const coverageBonus = (matchedTerms / uniqueQueryTerms.length) * 0.1;
      const phraseBonus = normalizedQuery.length >= 6 && doc.lowerText.includes(normalizedQuery) ? 0.12 : 0;

      return Math.min(1, 0.5 * normBm25 + 0.4 * tfidfCosine + coverageBonus + phraseBonus);
    });
  }

  return {
    getStats() {
      return {
        chunkCount: docs.length,
        mode: retrievalMode,
        embeddingModel: docEmbeddings ? embeddingConfig.model : null,
        minScore: defaultMinScore
      };
    },

    async getRelevantDocuments(query, queryOptions = {}) {
      const topK = Number(queryOptions.topK) || defaultTopK;
      const minScore = Number.isFinite(queryOptions.minScore) ? queryOptions.minScore : defaultMinScore;
      const trimmedQuery = String(query || '').trim();
      if (!trimmedQuery || docs.length === 0) return [];

      const lexicalScores = scoreLexical(trimmedQuery);
      let denseScores = null;
      let effectiveMode = 'bm25-tfidf';

      if (docEmbeddings && embeddingConfig) {
        try {
          const [queryVector] = await fetchEmbeddings([trimmedQuery], embeddingConfig, fetchImpl);
          if (Array.isArray(queryVector)) {
            denseScores = docEmbeddings.map((vec) => Math.max(0, cosineSimilarity(queryVector, vec)));
            effectiveMode = 'hybrid-embedding';
          }
        } catch (err) {
          console.warn(`[Retriever] Query embedding failed (${err.message}); using BM25/TF-IDF score.`);
        }
      }

      const scored = docs.map((doc, idx) => {
        const lexical = lexicalScores[idx] || 0;
        const dense = denseScores ? denseScores[idx] : null;
        const score = dense != null ? Math.min(1, 0.65 * dense + 0.35 * lexical) : lexical;
        return {
          pageContent: doc.chunk.pageContent,
          metadata: { ...doc.chunk.metadata },
          score: Number(score.toFixed(4)),
          matchMode: effectiveMode
        };
      });

      return scored
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }
  };
}
