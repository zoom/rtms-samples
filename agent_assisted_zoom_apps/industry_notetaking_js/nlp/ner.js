import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const MODEL = process.env.NER_MODEL;

export default async function detectEntities(text) {
  console.log(`[NER] Using model: ${MODEL}`);
  console.log(`[NER] Input:`, text);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Extract named entities from the following text. Respond with JSON only, no explanation. Format: {"entities": ["Entity1", "Entity2"]}',
          },
          {
            role: 'user',
            content: `Text: ${text}\nOnly return valid JSON.`,
          },
        ],
      }),
    });

    const data = await res.json();
    const raw = data.choices[0].message.content;
    console.log(`[NER] Raw content:`, raw);

    // Try to extract JSON block even if response is chatty
    const match = raw.match(/\{[\s\S]*?\}/);
    if (match) {
      return JSON.parse(match[0]);
    } else {
      console.warn('[NER] No valid JSON found. Returning raw.');
      return { rawEntities: raw };
    }

  } catch (err) {
    console.error('[NER] Error:', err.message);
    return { error: 'NER failed' };
  }
}
