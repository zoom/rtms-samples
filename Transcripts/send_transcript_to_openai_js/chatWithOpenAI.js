// chatWithOpenAI.js

import dotenv from 'dotenv';
dotenv.config();

import OpenAI from "openai";


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Store your key in an environment variable
});

/**
 * Sends a transcript to the OpenAI Chat API and returns the assistant's response.
 * @param {string} transcriptText - The full transcript to send to the chatbot.
 * @returns {Promise<string>} - The assistant's response.
 */
export async function chatWithTranscript(transcriptText) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o', // or 'gpt-4'
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. Analyze or respond based on the provided transcript.',
        },
        {
          role: 'user',
          content: `Transcript:\n\n${transcriptText}`,
        },
      ],
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error('Error calling OpenAI:', err);
    throw err;
  }
}

