import sdk from "microsoft-cognitiveservices-speech-sdk";
import dotenv from "dotenv";
dotenv.config();

const speechConfig = sdk.SpeechConfig.fromSubscription(
  process.env.AZURE_SPEECH_KEY,
  process.env.AZURE_REGION
);
speechConfig.speechRecognitionLanguage = "en-US";

const pushStream = sdk.AudioInputStream.createPushStream();
const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

// Start recognizing once
recognizer.recognizing = (_, e) => {
  console.log(`Partial result: ${e.result.text}`);
};

recognizer.recognized = (_, e) => {
  if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
    console.log(`Final result: ${e.result.text}`);
  }
};

recognizer.startContinuousRecognitionAsync();

export function azureSpeechToTextStream(dataChunk) {
  // Push real-time audio data into the Azure SDK
  pushStream.write(dataChunk);
}