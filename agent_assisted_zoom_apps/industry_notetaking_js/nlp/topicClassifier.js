import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const MODEL = process.env.TOPIC_MODEL;

export default async function classifyTopic(text) {
  console.log(`[TopicClassifier] Using model: ${MODEL}`);
  console.log(`[TopicClassifier] Input:`, text);

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
          { role: 'system', content: 'Classify the topic of this text in one word (e.g., Finance, Legal, Tech, HR).' },
          { role: 'user', content: text }
        ]
      })
    });

    const data = await res.json();
    console.log(`[TopicClassifier] Response:`, data);
    return data.choices[0].message.content.trim();
  } catch (err) {
    console.error('[TopicClassifier] Error:', err.message);
    return '';
  }
}
