// chatWithClaude.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Internal chat history store
const chatHistory = [
  { role: 'user', content: 'You are a helpful assistant.' }, // Optional primer
];

/**
 * Sends a user message to Claude and returns the assistant's reply.
 * Keeps track of conversation history internally.
 * @param {string} userMessage - The user's latest message.
 * @returns {Promise<string>} - The assistant's response.
 */
export async function chatWithClaude(userMessage) {
  try {
    // Add the user message to the conversation history
    chatHistory.push({ role: 'user', content: userMessage });

    // Call Claude API with full history
    const response = await axios.post(
      API_URL,
      {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: chatHistory,
      },
      {
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    // Get assistant response
    const assistantMessage = response.data.content?.[0]?.text ?? '(no response)';

    // Add assistant reply to the history
    chatHistory.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
  } catch (error) {
    console.error('❌ Claude API error:', error.response?.data || error.message);
    throw error;
  }
}
