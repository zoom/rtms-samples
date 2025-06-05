import * as tf from '@tensorflow/tfjs-node';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import fs from 'fs';
import path from 'path';
import { createCanvas, loadImage, ImageData } from 'canvas';

let model = null;

async function loadModel() {
  if (!model) {
    console.log('📦 Loading COCO-SSD model...');
    model = await cocoSsd.load();
    console.log('✅ Model loaded.');
  }
}

/**
 * Detect objects in an image buffer using COCO-SSD
 * @param {Buffer} imageBuffer - JPEG or PNG image buffer
 * @param {string} userName - sanitized user name
 * @param {number} timestamp - epoch timestamp in ms
 * @param {string} meetingUuid - sanitized meeting/session ID
 * @param {boolean} shouldSave - whether to save the annotated image
 */
export async function tensorFlowDetectObject(imageBuffer, userName, timestamp, meetingUuid, shouldSave = true) {
  try {
    await loadModel();

    // Prepare output directory
    let outputDir = path.join('recordings', meetingUuid, userName);
    fs.mkdirSync(outputDir, { recursive: true });

    // Save original frame
    let originalPath = path.join(outputDir, `frame-${timestamp}.jpg`);
    fs.writeFileSync(originalPath, imageBuffer);

    // Load image and prepare canvas
    let image = await loadImage(originalPath);
    let canvas = createCanvas(image.width, image.height);
    let ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    // Decode image buffer into Tensor
    let inputTensor = tf.node.decodeImage(imageBuffer, 3); // RGB
    let predictions = await model.detect(inputTensor);
    inputTensor.dispose();

    console.log(`🔍 [${userName}] Detected ${predictions.length} object(s)`);

    // Log timestamp info
    if (predictions.length > 0) {
      let gmtTime = new Date(timestamp).toISOString();
      let now = Date.now();
      let driftMs = now - timestamp;
      console.log(`🕒 Timestamp (GMT): ${gmtTime}`);
      console.log(`⏱️  Time drift: ${driftMs} ms (${(driftMs / 1000).toFixed(2)} seconds)`);
    }

    // Log predictions
    predictions.forEach((pred, i) => {
      console.log(`#${i + 1}: ${pred.class} (${(pred.score * 100).toFixed(2)}%)`);
    });

    // Annotate and save only if shouldSave is true
    if (predictions.length > 0 && shouldSave) {
      for (let pred of predictions) {
        let [x, y, width, height] = pred.bbox;
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, width, height);
        ctx.fillStyle = 'red';
        ctx.font = '14px sans-serif';
        ctx.fillText(`${pred.class} (${(pred.score * 100).toFixed(1)}%)`, x, y - 5);
      }

      let resultPath = path.join(outputDir, `detected-${timestamp}.jpg`);
      let out = fs.createWriteStream(resultPath);
      let stream = canvas.createJPEGStream();
      stream.pipe(out);

      console.log(`📸 Saved detection image: ${resultPath}`);
    }

  } catch (err) {
    console.error(`❌ Detection error for ${userName}:`, err.message);
  }
}
