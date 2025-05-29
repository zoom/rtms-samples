// openrouterChat.js
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

// Set up OpenAI client with OpenRouter endpoint
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

/**
 * Sends a message to a model via OpenRouter
 * @param {string} message - The user message
 * @param {string} model - The model to use (e.g., 'anthropic/claude-3-haiku')
 * @returns {Promise<string>}
 */
export async function chatWithOpenRouter(message, model = 'anthropic/claude-3-haiku') {
  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [{ role: 'user', content: message }],
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error('❌ Error with OpenRouter:', err.response?.data || err.message);
    throw err;
  }
}
