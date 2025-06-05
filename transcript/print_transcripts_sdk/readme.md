# Transcript Processing Project

This project demonstrates real-time transcript processing using the Zoom RTMS . It focuses on capturing and processing meeting transcripts from Zoom meetings.

## Implementation Details

The application:
1. Listens for `meeting.rtms_started` events
2. Establishes WebSocket connections for signaling and media data
3. Processes incoming transcript data in real-time
4. Converts transcript data to base64 format
5. Outputs transcript data to the terminal

## Prerequisites

- Node.js installed
- A `.env` file with necessary environment variables

## Running the Application

1. Start the server:
   ```bash
   node print_transcripts_sdk.js
   ```

2. Start a Zoom meeting. The application will:
   - Receive the `meeting.rtms_started` event
   - Establish WebSocket connections
   - Begin processing transcript data
   - Convert transcript data to base64
   - Output transcript data to the terminal

