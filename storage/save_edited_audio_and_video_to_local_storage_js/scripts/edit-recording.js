import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEditorWorkflow } from '../lib/editorWorkflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

const workflow = createEditorWorkflow({
  recordingsRoot: path.join(projectRoot, 'recordings'),
  aiConfig: {
    apiUrl: process.env.AI_API_URL,
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL,
    minSegmentMs: Number(process.env.AI_MIN_SEGMENT_MS || 800),
    maxOutputMs: Number(process.env.AI_MAX_OUTPUT_SECONDS || 300) * 1000,
  },
});

const [command, meetingId, streamId, ...rest] = process.argv.slice(2);

try {
  if (command === 'list') {
    console.log(JSON.stringify(await workflow.listRecordings(), null, 2));
  } else if (['plan', 'render', 'run'].includes(command) && meetingId && streamId) {
    const params = { meetingId, streamId };
    const brief = option(rest, '--brief') || process.env.AI_DEFAULT_EDITING_BRIEF ||
      'Create a concise meeting highlight video with clear context.';
    let planned;
    if (command === 'plan' || command === 'run') {
      planned = await workflow.createPlan(params, brief);
      console.log(JSON.stringify(planned.plan, null, 2));
    }
    if (command === 'render' || command === 'run') {
      const outputPath = await workflow.renderSavedPlan(params, planned?.plan);
      console.log(`Rendered: ${outputPath}`);
    }
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[Editor] ${error.message}`);
  process.exitCode = 1;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function printUsage() {
  console.error(`Usage:
  npm run edit -- list
  npm run edit -- plan <meetingId> <streamId> [--brief "..."]
  npm run edit -- render <meetingId> <streamId>
  npm run edit -- run <meetingId> <streamId> [--brief "..."]`);
}
