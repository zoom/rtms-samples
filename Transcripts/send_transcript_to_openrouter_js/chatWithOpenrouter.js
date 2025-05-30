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

export async function chatWithMultipleModels(message) {
  const models = [
    'meta-llama/llama-4-maverick:free',
    'meta-llama/llama-4-scout:free',
  ];

  await Promise.all(models.map(async (model) => {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: message }],
      });

      const reply = response.choices[0].message.content;

      console.log('='.repeat(60));
      console.log(`🧠 MODEL: ${model}`);
      console.log('-'.repeat(60));
      console.log(`💬 RESPONSE:\n${reply}`);
      console.log('='.repeat(60));
    } catch (err) {
      console.error(`❌ Error with model ${model}:`, err.response?.data || err.message);
      console.log('='.repeat(60));
    }
  }));
}

export async function contextualSynthesisFromMultipleModels(message) {
  const models = [
    'meta-llama/llama-4-maverick:free',
    'meta-llama/llama-4-scout:free',
  ];

  console.log(`📨 Received prompt: "${message}"\n`);
  console.log(`🤖 Sending prompt to ${models.length} models in parallel...\n`);

  const modelTasks = models.map(async (model) => {
    try {
      console.log(`⏳ Querying model: ${model}`);
      const response = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: message }],
      });

      console.log(`✅ Received response from ${model}`);
      return { model, reply: response.choices[0].message.content };
    } catch (err) {
      console.error(`❌ Error with model ${model}:`, err.response?.data || err.message);
      return null;
    }
  });

  const modelResponses = (await Promise.all(modelTasks)).filter(Boolean);

  if (modelResponses.length === 0) {
    console.error('❌ No successful responses to synthesize from.');
    return;
  }

  console.log('\n🧠 All model responses received. Preparing for synthesis...\n');

  const combinedContext = modelResponses.map(({ model, reply }) =>
    `Response from ${model}:\n${reply}`
  ).join('\n\n');

  const synthesisPrompt = `
You are an expert assistant. The user asked:

"${message}"

Here are responses from multiple AI models. Cross-check the answers, validate facts, and generate a final answer that is accurate, clear, and well-supported. Do not summarize — synthesize the best answer possible using their content.

${combinedContext}
  `.trim();

  const synthesisModel = 'anthropic/claude-3-haiku';

  try {
    console.log(`🧪 Synthesizing final answer using ${synthesisModel}...\n`);

    // Spinner: show elapsed seconds while waiting
    let seconds = 0;
    const spinner = setInterval(() => {
      seconds++;
      process.stdout.write(`⏳ Thinking... ${seconds}s\r`);
    }, 1000);

    const finalResponse = await openai.chat.completions.create({
      model: synthesisModel,
      messages: [{ role: 'user', content: synthesisPrompt }],
    });

    clearInterval(spinner);
    process.stdout.write('\n'); // move to clean line

    const finalAnswer = finalResponse.choices[0].message.content;

    console.log('\n✅ FINAL SYNTHESIZED ANSWER');
    console.log('='.repeat(60));
    console.log(finalAnswer);
    console.log('='.repeat(60));
  } catch (err) {
    console.error(`❌ Error during synthesis:`, err.response?.data || err.message);
  }
}
