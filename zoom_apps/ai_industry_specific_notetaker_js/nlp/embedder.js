import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const MODEL = process.env.EMBEDDING_MODEL;

export default async function generateEmbedding(text) {
  console.log(`[Embedder] Using model: ${MODEL}`);
  console.log(`[Embedder] Input:`, text);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: text
      })
    });

    const data = await res.json();
    console.log(`[Embedder] Response:`, data);
    return data.data[0].embedding;
  } catch (err) {
    console.error('[Embedder] Error:', err.message);
    return [];
  }
}
