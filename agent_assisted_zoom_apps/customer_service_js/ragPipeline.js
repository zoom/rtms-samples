
// ragPipeline.js

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

import { loadDocuments } from './loaders/index.js';
import { splitDocuments, createRetriever } from './langchain/embedUtils.js';
import { chatWithOpenRouter } from './chatWithOpenrouter.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let retriever = null;

/**
 * Loads document files, chunks them, and builds a retriever.
 */
export async function preloadRetrieverOnce() {
  if (retriever) return;

  const docsDir = path.resolve(__dirname, './docs');
  const filePaths = fs.readdirSync(docsDir).map(file => path.join(docsDir, file));

  console.log('📥 Loading supported documents...');
  const rawDocs = await loadDocuments(filePaths);

  console.log(`🔪 Splitting ${rawDocs.length} loaded documents...`);
  const chunks = await splitDocuments(rawDocs);

  console.log(`🧠 Building retriever from ${chunks.length} chunks...`);
  retriever = await createRetriever(chunks);

  console.log('✅ Retriever initialized.');
}

/**
 * Uses OpenRouter LLM to generate a response from transcript and retrieved context.
 * @param {string} transcript - Input transcript
 * @returns {Promise<string>} AI-generated response
 */
export async function askLLMWithTranscript(transcript) {
  if (!retriever) {
    throw new Error('❌ Retriever is not initialized. Call preloadRetrieverOnce() first.');
  }

  console.log('📝 Received transcript:');
  console.log(transcript);

  console.log('🔍 Retrieving relevant context from documents...');
  const contextDocs = await retriever.getRelevantDocuments(transcript);

  console.log(`📄 Retrieved ${contextDocs.length} relevant documents.`);

  if (contextDocs.length === 0) {
    console.warn('⚠️ No context documents found for this transcript.');
  } else {
    console.log('🧩 Sample context snippet:');
    console.log(contextDocs[0].pageContent.slice(0, 300) + '...');
  }

  const context = contextDocs.map(doc => doc.pageContent).join("\n\n");

  const prompt = `
<scenario>
  <role>customer_support</role>
  <input>
    <transcript>${transcript}</transcript>
    <context>${context}</context>
  </input>
  <instruction>
    Use the context to answer the customer's question from the transcript.
    Your answer should be helpful, concise, and formatted in bullet points.
    Do not hallucinate. Only respond using information from the transcript or context.
  </instruction>
</scenario>
`.trim();

  console.log('🧠 Final prompt being sent to OpenRouter:');
  console.log(prompt.slice(0, 1000) + '...');  // Truncate to avoid overload

  try {
    const response = await chatWithOpenRouter(prompt);
    console.log('✅ Received response from OpenRouter:');
    console.log(response);
    return response;
  } catch (err) {
    console.error('❌ Failed to get response from OpenRouter:', err.message || err);
    throw err;
  }
}
