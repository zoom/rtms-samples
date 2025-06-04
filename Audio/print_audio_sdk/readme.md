# Zoom RTMS Audio SDK Sample

This project demonstrates how to use Zoom's Real-Time Media SDK (RTMS) to capture and process audio data from Zoom meetings.

## Prerequisites

- Node.js (v14 or higher)
- A Zoom account with RTMS access
- Environment variables configured

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with your Zoom credentials:
```env
ZOOM_API_KEY=your_api_key
ZOOM_API_SECRET=your_api_secret
```

## Project Structure

- `print_audio_sdk.js`: Main implementation file that handles RTMS audio data

## Features

- Connects to Zoom meetings using RTMS
- Captures real-time audio data
- Converts audio data to base64 format
- Logs audio data to console

## Usage

1. Start the application:
```bash
node print_audio_sdk.js
```

2. The application will:
   - Listen for RTMS webhook events
   - Connect to the meeting when `meeting.rtms_started` event is received
   - Capture and convert audio data to base64 format
   - Log the audio data to the console

## Dependencies

- `@zoom/rtms`: Zoom's Real-Time Media SDK
- `dotenv`: Environment variable management

## Notes

- The application currently logs audio data in base64 format
- Make sure your Zoom account has the necessary permissions to use RTMS
- Keep your API credentials secure and never commit them to version control

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