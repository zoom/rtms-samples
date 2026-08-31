import fs from 'fs/promises';
import path from 'path';
import { recordingDirectory, sanitizeId } from './recordingStore.js';
import { probeMedia } from './mediaProbe.js';
import { generateEditPlan, savePlanArtifacts, validateEditPlan } from './editPlanner.js';
import { renderEdit } from './editRenderer.js';

export function createEditorWorkflow({ recordingsRoot, aiConfig }) {
  return {
    createPlan: (params, brief) => createPlan(recordingsRoot, aiConfig, params, brief),
    renderSavedPlan: (params, plan) => renderSavedPlan(recordingsRoot, aiConfig, params, plan),
    listRecordings: () => listRecordings(recordingsRoot),
  };
}

async function createPlan(recordingsRoot, aiConfig, { meetingId, streamId }, brief) {
  const directory = resolveRecordingDirectory(recordingsRoot, meetingId, streamId);
  const sourcePath = path.join(directory, 'mixed_final.mp4');
  const transcript = await readJson(path.join(directory, 'transcript.json'));
  const media = await probeMedia(sourcePath);
  const usableSegments = transcript.segments.filter(
    (segment) => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs)
  );
  if (!usableSegments.length) {
    throw new Error('Transcript has no source-relative timestamps; verify RTMS transcript start_time/end_time');
  }

  const result = await generateEditPlan({
    transcript: { ...transcript, segments: usableSegments },
    media,
    brief,
    config: aiConfig,
  });
  const editDirectory = await savePlanArtifacts(directory, { ...result, brief });
  return { plan: result.plan, editDirectory };
}

async function renderSavedPlan(recordingsRoot, aiConfig, { meetingId, streamId }, suppliedPlan) {
  const directory = resolveRecordingDirectory(recordingsRoot, meetingId, streamId);
  const sourcePath = path.join(directory, 'mixed_final.mp4');
  const media = await probeMedia(sourcePath);
  const rawPlan = suppliedPlan || await readJson(path.join(directory, 'edits', 'edit-plan.json'));
  const plan = validateEditPlan(rawPlan, media.durationMs, aiConfig);
  return renderEdit({ sourcePath, editDirectory: path.join(directory, 'edits'), plan });
}

async function listRecordings(recordingsRoot) {
  const recordings = [];
  for (const meetingId of await safeReadDirectory(recordingsRoot)) {
    for (const streamId of await safeReadDirectory(path.join(recordingsRoot, meetingId))) {
      const directory = path.join(recordingsRoot, meetingId, streamId);
      recordings.push({
        meetingId,
        streamId,
        sourceReady: await exists(path.join(directory, 'mixed_final.mp4')),
        transcriptReady: await exists(path.join(directory, 'transcript.json')),
        planReady: await exists(path.join(directory, 'edits', 'edit-plan.json')),
        editReady: await exists(path.join(directory, 'edits', 'final-edit.mp4')),
      });
    }
  }
  return recordings;
}

function resolveRecordingDirectory(recordingsRoot, meetingId, streamId) {
  if (meetingId !== sanitizeId(meetingId) || streamId !== sanitizeId(streamId)) {
    throw new Error('Invalid recording identifier');
  }
  return recordingDirectory(recordingsRoot, meetingId, streamId);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function safeReadDirectory(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
