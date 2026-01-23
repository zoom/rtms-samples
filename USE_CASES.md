# Featured Use Cases

## Real-time Note-Taking with NLP

[`zoom_apps/ai_industry_specific_notetaker_js/`](./zoom_apps/ai_industry_specific_notetaker_js/)

Build a meeting assistant that extracts entities, detects action items, classifies topics, and generates summaries in real-time.

```
Zoom Meeting → RTMS Webhook → WebSocket → Transcript → NLP Pipeline → Frontend
```

```javascript
RTMSManager.on('transcript', async ({ text, userName }) => {
  // Named Entity Recognition
  const entities = await detectEntities(text);
  
  // Action item detection (regex-based)
  const actions = detectActionItems(text);
  
  // Topic classification via LLM
  const topic = await classifyTopic(text);
  
  // Periodic summarization
  if (transcriptHistory.length % 5 === 0) {
    summary = await summarize(transcriptHistory.join(' '));
  }
  
  // Broadcast to connected frontends
  frontendWss.broadcast({ text, entities, actions, topic, summary, user: userName });
});
```

**Features:**
- Real-time entity extraction (people, organizations, dates)
- Action item detection ("we need to", "let's", "follow up")
- Topic classification (Finance, Legal, Tech, HR)
- Rolling meeting summaries
- WebSocket broadcast to frontend dashboard

## AI-Powered Applications

| Sample | Description |
|--------|-------------|
| [`ai_industry_specific_notetaker_js`](./zoom_apps/ai_industry_specific_notetaker_js/) | NLP pipeline: NER, action items, topics, summaries |
| [`ai_transcript_analysis_js`](./zoom_apps/ai_transcript_analysis_js/) | Real-time transcript analysis |
| [`ai_rag_customer_support_js`](./zoom_apps/ai_rag_customer_support_js/) | Customer service AI with RAG |
| [`ai_chat_with_audio_playback_js`](./zoom_apps/ai_chat_with_audio_playback_js/) | LLM chatbot with neural audio playback |
| [`ai_dnd_game_js`](./zoom_apps/ai_dnd_game_js/) | D&D game powered by transcripts |

## Multi-Provider Transcription

| Sample | Description |
|--------|-------------|
| [`send_audio_to_deepgram_transcribe_service_js`](./audio/send_audio_to_deepgram_transcribe_service_js/) | Deepgram real-time transcription |
| [`send_audio_to_assemblyai_transcribe_service_js`](./audio/send_audio_to_assemblyai_transcribe_service_js/) | AssemblyAI transcription |
| [`send_audio_to_aws_transcribe_service_js`](./audio/send_audio_to_aws_transcribe_service_js/) | AWS Transcribe integration |
| [`send_audio_to_azure_speech_to_text_service_js`](./audio/send_audio_to_azure_speech_to_text_service_js/) | Azure Speech-to-Text |

## Cloud Storage

| Sample | Description |
|--------|-------------|
| [`save_audio_and_video_to_aws_s3_storage_js`](./storage/save_audio_and_video_to_aws_s3_storage_js/) | Save recordings to AWS S3 |
| [`save_audio_and_video_to_azure_blob_storage_js`](./storage/save_audio_and_video_to_azure_blob_storage_js/) | Save recordings to Azure Blob |
| [`save_audio_and_video_to_local_storage_js`](./storage/save_audio_and_video_to_local_storage_js/) | Save recordings locally |

## Live Streaming

| Sample | Strategy | Description |
|--------|----------|-------------|
| [`stream_to_aws_ivs_gap_filler_js`](./streaming/stream_to_aws_ivs_gap_filler_js/) | Gap Filler | Stream to AWS IVS with mute detection |
| [`stream_to_aws_ivs_jitter_buffer_js`](./streaming/stream_to_aws_ivs_jitter_buffer_js/) | Jitter Buffer | Stream to AWS IVS with packet reordering |
| [`stream_audio_and_video_to_youtube_greedy_gap_filler_js`](./streaming/stream_audio_and_video_to_youtube_greedy_gap_filler_js/) | Greedy Gap Filler | Stream to YouTube Live |
| [`stream_audio_and_video_to_custom_frontend_passthru_js`](./streaming/stream_audio_and_video_to_custom_frontend_passthru_js/) | Passthru | Stream to custom HLS frontend |
