import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const MODEL = process.env.SUMMARY_MODEL;

export default async function summarize(text) {
  console.log(`[Summarizer] Using model: ${MODEL}`);
  console.log(`[Summarizer] Input:`, text.slice(0, 200), '...'); // trim for readability

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
          { role: 'system', content: 'Summarize this transcript in bullet points.' },
          { role: 'user', content: text }
        ]
      })
    });

    const data = await res.json();
    console.log(`[Summarizer] Response:`, data);
    return data.choices[0].message.content.trim();
  } catch (err) {
    console.error('[Summarizer] Error:', err.message);
    return '';
  }
}
