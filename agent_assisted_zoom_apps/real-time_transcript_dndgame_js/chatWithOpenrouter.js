// openrouterChat.js
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

export async function chatWithOpenRouter(message, model = process.env.OPENROUTER_MODEL) {
  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: message }],
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error('❌ Error with OpenRouter:', err.response?.data || err.message);
    throw err;
  }
}
