import AWS from 'aws-sdk';
import dotenv from 'dotenv';

dotenv.config(); // Load from .env file


// ✅ Validate and apply the region before creating Rekognition instance
if (!process.env.AWS_REGION) {
  throw new Error('Missing AWS_REGION in .env');
}

// Use credentials and region from .env
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const rekognition = new AWS.Rekognition();

/**
 * Detects emotions from faces in the provided image buffer using Amazon Rekognition.
 * @param {Buffer} imageBuffer - The image buffer (e.g., read from file or upload).
 * @returns {Promise<Array>} - A promise that resolves to an array of emotion results per face.
 */

async function detectEmotions(imageBuffer) {
  const params = {
    Image: {
      Bytes: imageBuffer,
    },
    Attributes: ['ALL'], // Needed to get emotions
  };

  try {
    const result = await rekognition.detectFaces(params).promise();

    return result.FaceDetails.map(face => {
      const emotions = face.Emotions.map(e => ({
        Type: e.Type,
        Confidence: e.Confidence,
      }));
      return {
        BoundingBox: face.BoundingBox,
        Emotions: emotions,
      };
    });
  } catch (error) {
    console.error('Error calling Rekognition:', error);
    throw error;
  }
}

export default detectEmotions;