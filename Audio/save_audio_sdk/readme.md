# Zoom RTMS Audio Recording SDK

This SDK provides functionality to record and save audio from Zoom meetings using the Real-Time Media Streaming (RTMS).

## Features

- Captures audio data from Zoom meetings in real-time
- Automatically saves recordings when meetings end
- Converts raw audio data to WAV format
- Handles multiple meeting recordings with unique identifiers

## Prerequisites

- Node.js environment
- FFmpeg installed on your system
- Zoom RTMS access
- `.env` file with necessary configuration

## Installation

1. Install the required dependencies:
```bash
npm install @zoom/rtms dotenv
```

2. Ensure FFmpeg is installed on your system:
- For macOS: `brew install ffmpeg`
- For Ubuntu/Debian: `sudo apt-get install ffmpeg`
- For Windows: Download from [FFmpeg official website](https://ffmpeg.org/download.html)

## Usage

1. Create a `.env` file in your project root with your Zoom RTMS configuration.

2. Import and use the SDK:
```javascript
import rtms from "@zoom/rtms";

// The SDK automatically handles:
// - Starting recording when meeting.rtms_started event is received
// - Stopping and saving when meeting.rtms_stopped event is received
```

## Output

The SDK generates two types of files for each meeting:
- Raw audio file (`recording_[meeting_id].raw`)
- Converted WAV file (`recording_[meeting_id].wav`)

The WAV files are saved with the following specifications:
- Sample rate: 16000 Hz
- Channels: Mono
- Format: 16-bit PCM

## Events Handled

- `meeting.rtms_started`: Initiates audio recording
- `meeting.rtms_stopped`: Stops recording and saves the audio file

## Error Handling

The SDK includes basic error handling for:
- Audio conversion failures
- File system operations
- RTMS connection issues

## Notes

- Raw audio files are automatically deleted after successful conversion to WAV format
- Meeting IDs in filenames are sanitized to remove special characters
- Audio chunks are stored in memory during the meeting and cleared after saving

## Troubleshooting

1. **Connection Issues**:
   - Verify ngrok is running and the tunnel is active
   - Check your Zoom OAuth credentials in the `.env` file
   - Ensure your webhook URL is correctly configured

2. **SDK Installation Issues**:
   - Make sure you have the correct token for fetching prebuilt binaries
   - Check that you've installed the SDK correctly: `npm install github:zoom/rtms`

3. **No Audio Data**:
   - Verify that Auto-Start is enabled for your app in Zoom web settings
   - Check that your app has the correct RTMS scopes
   - Ensure you're properly handling the `meeting.rtms_started` webhook event

4. **WAV Conversion Issues**:
   - Verify FFmpeg is installed and accessible in your PATH
   - RTMS sends uncompressed raw audio data (L16 PCM) at 16kHz sample rate, mono channel
   - Use the correct FFmpeg parameters: `-f s16le -ar 16000 -ac 1`
