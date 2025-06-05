// openrouterChat.js
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const DEFAULT_MODEL = process.env.DEFAULT_OPENROUTER_MODEL || 'meta-llama/llama-4-scout:free';

// Accumulated state
let totalTraits = {
  Curiosity: 0,
  Empathy: 0,
  Assertiveness: 0,
  Creativity: 0,
  Analytical: 0
};

/**
 * Extracts traits from a single line and updates internal accumulator.
 * Returns cumulative traits.
 */
export async function extractAndAccumulateTraits(line, model = DEFAULT_MODEL) {
  const prompt = `
Analyze the following conversation text and return a JSON object categorizing phrases that match these traits:

Traits:
- Curiosity
- Empathy
- Assertiveness
- Creativity
- Analytical

For each trait, list matching phrases found in the text. Use this format:

{
  "Curiosity": [...],
  "Empathy": [...],
  "Assertiveness": [...],
  "Creativity": [...],
  "Analytical": [...]
}

Text:
"${line}"

Only return the JSON. Do not include explanations or comments.
`;

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0].message.content;
    const match = content.match(/{[\s\S]*}/);
    const parsed = match ? JSON.parse(match[0]) : {};

    const traitsCount = {
      Curiosity: (parsed.Curiosity || []).length,
      Empathy: (parsed.Empathy || []).length,
      Assertiveness: (parsed.Assertiveness || []).length,
      Creativity: (parsed.Creativity || []).length,
      Analytical: (parsed.Analytical || []).length,
    };

    // Accumulate
    for (const trait in traitsCount) {
      totalTraits[trait] += traitsCount[trait];
    }

    return { current: traitsCount, total: { ...totalTraits } };
  } catch (err) {
    console.error('❌ Error extracting traits:', err.response?.data || err.message);
    return {
      current: {
        Curiosity: 0,
        Empathy: 0,
        Assertiveness: 0,
        Creativity: 0,
        Analytical: 0
      },
      total: { ...totalTraits }
    };
  }
}

/**
 * Optional: reset accumulation externally
 */
export function resetTraits() {
  totalTraits = {
    Curiosity: 0,
    Empathy: 0,
    Assertiveness: 0,
    Creativity: 0,
    Analytical: 0
  };
}
