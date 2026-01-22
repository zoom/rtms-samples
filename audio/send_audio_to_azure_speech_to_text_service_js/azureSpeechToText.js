import sdk from "microsoft-cognitiveservices-speech-sdk";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_REGION) {
  console.error('❌ AZURE_SPEECH_KEY and AZURE_REGION are required');
  process.exit(1);
}

const speechConfig = sdk.SpeechConfig.fromSubscription(
  process.env.AZURE_SPEECH_KEY,
  process.env.AZURE_REGION
);
speechConfig.speechRecognitionLanguage = "en-US";

const pushStream = sdk.AudioInputStream.createPushStream();
const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

let isRecognizing = false;
let recognizerFailed = false;

recognizer.recognizing = (_, e) => {
  console.log(`Partial result: ${e.result.text}`);
};

recognizer.recognized = (_, e) => {
  if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
    console.log(`Final result: ${e.result.text}`);
  } else if (e.result.reason === sdk.ResultReason.NoMatch) {
    console.log(`No speech recognized`);
  }
};

recognizer.canceled = (_, e) => {
  if (e.reason === sdk.CancellationReason.Error) {
    console.error(`❌ Azure Speech error: ${e.errorDetails}`);
    console.error(`❌ Please check your AZURE_SPEECH_KEY and AZURE_REGION`);
    recognizerFailed = true;
    isRecognizing = false;
  } else {
    console.log(`🔌 Azure Speech recognition canceled: ${e.reason}`);
  }
};

recognizer.sessionStarted = (_, e) => {
  if (!recognizerFailed) {
    console.log(`✅ Azure Speech session started`);
    isRecognizing = true;
  }
};

recognizer.sessionStopped = (_, e) => {
  console.log(`🔌 Azure Speech session stopped`);
  isRecognizing = false;
};

console.log(`🔗 Connecting to Azure Speech service...`);
recognizer.startContinuousRecognitionAsync(
  () => {
    if (!recognizerFailed) {
      console.log(`✅ Azure Speech continuous recognition started`);
    }
  },
  (err) => {
    console.error(`❌ Azure Speech failed to start: ${err}`);
    recognizerFailed = true;
  }
);

export function azureSpeechToTextStream(dataChunk) {
  if (recognizerFailed) {
    return;
  }
  pushStream.write(dataChunk);
}