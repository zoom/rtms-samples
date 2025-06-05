# Transcript Processing Project

This project demonstrates real-time transcript processing using the Zoom RTMS. It focuses on capturing and processing meeting transcripts from Zoom meetings.

## Implementation Details

The application:
1. Listens for `meeting.rtms_started` events
2. Establishes WebSocket connections for signaling and media data
3. Processes incoming transcript data in real-time
4. Outputs transcript data to the terminal

## Running the Application

1. Start the server:
   ```bash
   node rtms.js
   ```

2. Start a Zoom meeting. The application will:
   - Receive the `meeting.rtms_started` event
   - Establish WebSocket connections
   - Begin processing transcript data
   - Output transcript data to the terminal

