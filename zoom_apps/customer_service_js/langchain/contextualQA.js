// langchain/contextualQA.js
import { loadDocuments } from '../loaders/index.js';
import { splitDocuments, createRetriever } from './embedUtils.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

function buildPromptWithChunks(question, relevantChunks) {
  const contextText = relevantChunks
    .map((doc, i) => `<doc id="${i + 1}">\n${doc.pageContent}\n</doc>`)
    .join('\n\n');

  return `
You are a support assistant AI. Based only on the context below, answer the user's question in a concise, point-form manner.

<context>
${contextText}
</context>

<question>
${question}
</question>

Only use the information provided. Do not speculate.
  `.trim();
}

export async function askClaudeWithLangchainContext(question, filePaths) {
  const rawDocs = await loadDocuments(filePaths);
  if (rawDocs.length === 0) {
    console.error('❌ No documents loaded.');
    return '⚠️ No documents could be processed.';
  }

  const chunks = await splitDocuments(rawDocs);
  const retriever = await createRetriever(chunks);
  const relevantChunks = await retriever.getRelevantDocuments(question);

  const prompt = buildPromptWithChunks(question, relevantChunks);

  try {
    const response = await openai.chat.completions.create({
      model: 'meta-llama/llama-4-maverick:free',
      messages: [{ role: 'user', content: prompt }],
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error('❌ Claude API error:', err.response?.data || err.message);
    return '⚠️ Claude failed to respond.';
  }
}
