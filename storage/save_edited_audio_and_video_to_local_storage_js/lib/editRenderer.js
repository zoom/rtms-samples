import fs from 'fs/promises';
import path from 'path';
import { run } from './mediaProbe.js';

export async function renderEdit({ sourcePath, editDirectory, plan }) {
  const segmentDirectory = path.join(editDirectory, 'segments');
  await fs.mkdir(segmentDirectory, { recursive: true });
  const videoFilter = aspectFilter(plan.aspectRatio);
  const segmentPaths = [];

  for (let index = 0; index < plan.segments.length; index += 1) {
    const segment = plan.segments[index];
    const output = path.join(segmentDirectory, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
    await run('ffmpeg', [
      '-y',
      '-ss', seconds(segment.startMs),
      '-t', seconds(segment.endMs - segment.startMs),
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-vf', videoFilter,
      '-af', 'aresample=48000,asetpts=PTS-STARTPTS',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '21',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      output,
    ]);
    segmentPaths.push(output);
  }

  const outputPath = path.join(editDirectory, 'final-edit.mp4');
  if (plan.style === 'hard-cut' || segmentPaths.length === 1) {
    await renderHardCut(segmentPaths, editDirectory, outputPath);
  } else {
    await renderTransitions(segmentPaths, plan, editDirectory, outputPath);
  }

  await fs.writeFile(
    path.join(editDirectory, 'render-result.json'),
    `${JSON.stringify({ outputPath, renderedAt: new Date().toISOString(), plan }, null, 2)}\n`
  );
  return outputPath;
}

async function renderHardCut(segmentPaths, editDirectory, outputPath) {
  const concatPath = path.join(editDirectory, 'concat.txt');
  const content = segmentPaths
    .map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`)
    .join('\n');
  await fs.writeFile(concatPath, `${content}\n`);
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-c', 'copy', '-movflags', '+faststart', outputPath,
  ]);
}

async function renderTransitions(segmentPaths, plan, editDirectory, outputPath) {
  const shortestSegmentMs = Math.min(...plan.segments.map((segment) => segment.endMs - segment.startMs));
  const transitionMs = Math.min(plan.transitionMs, Math.floor(shortestSegmentMs / 2));
  const transitionSeconds = transitionMs / 1000;
  const inputs = segmentPaths.flatMap((segmentPath) => ['-i', segmentPath]);
  const lines = [];

  segmentPaths.forEach((_, index) => {
    lines.push(`[${index}:v]settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
    lines.push(`[${index}:a]aresample=48000,asetpts=PTS-STARTPTS[a${index}]`);
  });

  let videoInput = 'v0';
  let audioInput = 'a0';
  let timelineMs = plan.segments[0].endMs - plan.segments[0].startMs;
  for (let index = 1; index < segmentPaths.length; index += 1) {
    const videoOutput = `vx${index}`;
    const audioOutput = `ax${index}`;
    const offsetSeconds = Math.max(0, (timelineMs - transitionMs) / 1000);
    lines.push(
      `[${videoInput}][v${index}]xfade=transition=${plan.style}:duration=${transitionSeconds}:offset=${offsetSeconds}[${videoOutput}]`
    );
    lines.push(
      `[${audioInput}][a${index}]acrossfade=d=${transitionSeconds}:c1=tri:c2=tri[${audioOutput}]`
    );
    timelineMs += plan.segments[index].endMs - plan.segments[index].startMs - transitionMs;
    videoInput = videoOutput;
    audioInput = audioOutput;
  }

  const filterPath = path.join(editDirectory, 'filtergraph.txt');
  await fs.writeFile(filterPath, `${lines.join(';\n')}\n`);
  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex_script', filterPath,
    '-map', `[${videoInput}]`,
    '-map', `[${audioInput}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

function aspectFilter(aspectRatio) {
  const dimensions = {
    '16:9': [1280, 720],
    '9:16': [720, 1280],
    '1:1': [1080, 1080],
  }[aspectRatio];
  if (!dimensions) return 'fps=30,format=yuv420p';
  const [width, height] = dimensions;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30,format=yuv420p`;
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(3);
}

function escapeConcatPath(filePath) {
  return filePath.replaceAll("'", "'\\''");
}
