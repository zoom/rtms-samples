// dndGame.js
import { chatWithOpenRouter } from './chatWithOpenrouter.js';

const model = process.env.OPENROUTER_MODEL;
const history = [
  {
    role: 'system',
    content: `You are a Dungeon Master narrating a fantasy roleplaying game. Be descriptive and interactive. Offer clear choices.`,
  },
];

/**
 * Handles a single transcript line and returns DM narration + choices
 * @param {string} speaker
 * @param {string} text
 * @returns {Promise<{ narration: string, choices?: string[] }>}
 */
export async function handleTranscript(speaker, text) {
  if (!text?.trim()) return null;

  const playerLine = `${speaker} says: "${text}"`;
  history.push({ role: 'user', content: playerLine });

  const messages = [...history];

  try {
    const dmResponse = await chatWithOpenRouter(JSON.stringify(messages), model);
    history.push({ role: 'assistant', content: dmResponse });

    return {
      narration: dmResponse,
      speaker,
      playerText: text,
    };
  } catch (err) {
    console.error('❌ D&D LLM Error:', err.message || err);
    return {
      narration: '⚠️ The Dungeon Master hesitated. Something went wrong.',
      speaker,
      playerText: text,
    };
  }
}
