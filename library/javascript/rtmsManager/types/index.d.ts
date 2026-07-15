/**
 * TypeScript definitions for RTMSManager
 * @packageDocumentation
 */

import { EventEmitter } from 'events';

// =============================================================================
// Product Types
// =============================================================================

/** Supported Zoom product types */
export type ProductType = 'meeting' | 'videoSdk' | 'webinar' | 'contactCenter' | 'phone';

/** Legacy product type mapping (for backward compatibility) */
export type LegacyProductType = 'session';

// =============================================================================
// Media Types
// =============================================================================

/** Media type flags for subscription */
export interface MediaTypes {
  /** Audio streams (1) */
  AUDIO: 1;
  /** Video streams (2) */
  VIDEO: 2;
  /** Screen share streams (4) */
  SHARESCREEN: 4;
  /** Live transcript (8) */
  TRANSCRIPT: 8;
  /** Chat messages (16) */
  CHAT: 16;
  /** All media types (32) */
  ALL: 32;
}

// =============================================================================
// Credentials
// =============================================================================

/** Credentials for a single product */
export interface ProductCredentials {
  /** OAuth Client ID */
  clientId: string;
  /** OAuth Client Secret */
  clientSecret: string;
  /** Webhook Secret Token for signature verification */
  secretToken: string;
}

/** Server-to-Server OAuth credentials */
export interface S2SCredentials {
  /** S2S OAuth ID */
  clientId: string;
  /** S2S OAuth Client Secret */
  clientSecret: string;
  /** Zoom Account ID */
  accountId: string;
}

/** Product-keyed credentials structure */
export interface CredentialsConfig {
  /** Meeting SDK credentials */
  meeting?: ProductCredentials;
  /** Video SDK credentials */
  videoSdk?: ProductCredentials;
  /** Webinar credentials */
  webinar?: ProductCredentials;
  /** Contact Center credentials */
  contactCenter?: ProductCredentials;
  /** Zoom Phone credentials */
  phone?: ProductCredentials;
  /** S2S OAuth credentials (for API calls) */
  s2s?: S2SCredentials;
}

// =============================================================================
// Configuration
// =============================================================================

/** Audio media parameters */
export interface AudioMediaParams {
  contentType?: number;
  sampleRate?: number;
  channel?: number;
  codec?: number;
  dataOpt?: number;
  sendRate?: number;
}

/** Video media parameters */
export interface VideoMediaParams {
  contentType?: number;
  codec?: number;
  dataOpt?: number;
  resolution?: number;
  fps?: number;
}

/** Deskshare media parameters */
export interface DeskshareMediaParams {
  contentType?: number;
  codec?: number;
  resolution?: number;
  fps?: number;
}

/** Chat media parameters */
export interface ChatMediaParams {
  contentType?: number;
}

/** Transcript media parameters */
export interface TranscriptMediaParams {
  contentType?: number;
  language?: number;
  srcLanguage?: number;
  enableLid?: boolean;
}

/** All media parameters */
export interface MediaParams {
  audio?: AudioMediaParams;
  video?: VideoMediaParams;
  deskshare?: DeskshareMediaParams;
  chat?: ChatMediaParams;
  transcript?: TranscriptMediaParams;
}

export interface ProtocolMessageTypes {
  VIDEO_SUBSCRIPTION_REQ?: number;
  VIDEO_SUBSCRIPTION_RESP?: number;
  STREAM_CLOSE_REQ?: number;
  STREAM_CLOSE_RESP?: number;
}

export interface ProtocolEventTypes {
  PARTICIPANT_VIDEO_ON?: number;
  PARTICIPANT_VIDEO_OFF?: number;
  CHAT_GROUP_CREATE?: number;
  CHAT_GROUP_DELETE?: number;
  CHAT_GROUP_MEMBERS_ADD?: number;
  CHAT_GROUP_MEMBERS_DELETE?: number;
  CHAT_GROUP_MEMBER_STATUS_UPDATE?: number;
}

export interface ProtocolMediaDataOptions {
  VIDEO_SINGLE_INDIVIDUAL_STREAM?: number;
}

export interface ProtocolStatusCodes {
  INVALID_MEDIA_TRANSCRIPT_TARGET_LANGUAGE?: number;
  CHAT_SESSION_KEY_NOT_AVAILABLE?: number;
}

export interface ChatSession {
  type: number;
  id?: string;
}

export interface ChatParticipant {
  user_id: number | string;
  user_name: string;
}

export interface ChatFile {
  file_id: string;
  file_name: string;
  file_size: number;
}

export interface RTMSProtocolDefinitions {
  messageTypes?: ProtocolMessageTypes;
  eventTypes?: ProtocolEventTypes;
  mediaDataOptions?: ProtocolMediaDataOptions;
  statusCodes?: ProtocolStatusCodes;
  chatGroupTypes?: Record<string, number>;
  chatGroupMemberStatuses?: Record<string, number>;
  chatOperationTypes?: Record<string, number>;
  chatSessionTypes?: Record<string, number>;
}

/** Logging levels */
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

/** Custom logger interface */
export interface Logger {
  error(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  log(message: string, ...args: any[]): void;
  debug?(message: string, ...args: any[]): void;
}

/** RTMSManager configuration options */
export interface RTMSConfig {
  // Shorthand credentials (applies to all products)
  /** OAuth Client ID (shorthand) */
  clientId?: string;
  /** OAuth Client Secret (shorthand) */
  clientSecret?: string;
  /** Webhook Secret Token (shorthand) */
  secretToken?: string;
  
  // Product-keyed credentials
  /** Product-specific credentials */
  credentials?: CredentialsConfig;
  
  // Media settings
  /** Media types to subscribe (use RTMSManager.MEDIA.*) */
  mediaTypes?: number;
  /** @deprecated Use mediaTypes instead */
  mediaTypesFlag?: number;
  
  // Gap filler settings
  /** Enable real-time audio/video gap filling */
  enableRealTimeAudioVideoGapFiller?: boolean;
  /** @internal */
  enableGapFilling?: boolean;
  /** @internal */
  useFiller?: boolean;
  
  // History settings
  /** Maximum stream history size */
  maxStreamHistorySize?: number;
  
  // Logging
  /** Logging level (default: 'off') */
  logging?: LogLevel;
  /** Custom logger instance */
  logger?: Logger;
  
  // Media parameters (advanced)
  /** Media encoding/format parameters */
  mediaParams?: MediaParams;

  /** Override numeric values for newer RTMS protocol additions if Zoom changes them */
  protocolDefinitions?: RTMSProtocolDefinitions;
  /** Subscribe to all known signaling events instead of media-specific events only */
  subscribeAllKnownEvents?: boolean;
}

// =============================================================================
// RTMSError
// =============================================================================

/** Error category types */
export type ErrorCategory = 
  | 'success'
  | 'auth'
  | 'meeting'
  | 'stream'
  | 'permission'
  | 'network'
  | 'server'
  | 'limit'
  | 'media'
  | 'protocol'
  | 'security'
  | 'connection'
  | 'request'
  | 'sdk'
  | 'config'
  | 'unknown';

/** RTMSError - Developer-friendly error with causes and fixes */
export class RTMSError extends Error {
  /** Error code */
  code: string;
  /** Error category */
  category: ErrorCategory;
  /** Zoom status code (if applicable) */
  zoomStatus?: number;
  /** Meeting/session UUID */
  meetingId?: string;
  /** RTMS stream ID */
  streamId?: string;
  /** Original error that caused this */
  originalError?: Error;
  /** Possible causes for the error */
  causes: string[];
  /** Suggested fixes */
  fixes: string[];
  /** Link to documentation */
  docsUrl: string;

  constructor(code: string, message?: string, options?: {
    zoomStatus?: number;
    meetingId?: string;
    streamId?: string;
    cause?: Error;
  });

  /** Create RTMSError from Zoom status code */
  static fromZoomStatus(statusCode: number, context?: {
    meetingId?: string;
    streamId?: string;
  }): RTMSError;

  /** Create RTMSError from SDK error code */
  static fromCode(code: string, context?: {
    meetingId?: string;
    streamId?: string;
    cause?: Error;
  }): RTMSError;

  /** Pretty-print the error with causes and fixes */
  toString(): string;

  /** Get a short summary suitable for logging */
  toShortString(): string;

  /** Convert to plain object for JSON serialization */
  toJSON(): object;
}

// =============================================================================
// Events
// =============================================================================

/** Base event fields (common to all media events) */
export interface BaseEvent {
  /** Event type */
  type: 'audio' | 'video' | 'sharescreen' | 'transcript' | 'chat';
  /** User ID (number from Zoom, or string in some contexts) */
  userId: number | string;
  /** User display name */
  userName: string;
  /** Event timestamp */
  timestamp: number;
  /** Product-specific RTMS identifier (meeting/session/engagement/call) */
  rtmsId: string;
  /** Meeting/Session UUID */
  meetingId: string;
  /** RTMS stream ID */
  streamId: string;
  /** Product type */
  productType: ProductType;
}

/** Audio event */
export interface AudioEvent extends BaseEvent {
  type: 'audio';
  /** Audio buffer (PCM/encoded) */
  buffer: Buffer;
}

/** Video event */
export interface VideoEvent extends BaseEvent {
  type: 'video';
  /** Video buffer (H264/JPG frames) */
  buffer: Buffer;
}

/** Screen share event */
export interface SharescreenEvent extends BaseEvent {
  type: 'sharescreen';
  /** Screen share buffer (JPG/PNG frames) */
  buffer: Buffer;
}

/** Transcript event */
export interface TranscriptEvent extends BaseEvent {
  type: 'transcript';
  /** Transcript text */
  text: string;
  /** Start time of speech segment */
  startTime: number;
  /** End time of speech segment */
  endTime: number;
  /** Language code (number from Zoom API) */
  language: number | string;
  /** Raw attribute value */
  attribute: string | number;
}

/** Chat event */
export interface ChatEvent extends BaseEvent {
  type: 'chat';
  /** Chat message text */
  text: string;
  /** Parsed chat payload from the RTMS chat message */
  data?: Record<string, any>;
  /** Original UTF-8 chat payload */
  rawData?: string | Record<string, any>;
  chatSession?: ChatSession | null;
  operationType?: number | null;
  messageId?: string | null;
  parentMessageId?: string | null;
  sender?: ChatParticipant;
  receiver?: ChatParticipant | null;
  files?: ChatFile[];
  deleteFileIdList?: string[];
}

/** Union of all media events */
export type MediaEvent = AudioEvent | VideoEvent | SharescreenEvent | TranscriptEvent | ChatEvent;

/** Raw signaling event data from Zoom */
export interface SignalingEventData {
  event_type: number;
  user_id?: number | string;
  user_name?: string;
  timestamp?: number;
  participants?: Array<{ user_id: number | string; user_name: string }>;
  chat_groups?: Array<Record<string, any>>;
  members_update_list?: Array<Record<string, any>>;
  member_status_update_list?: Array<Record<string, any>>;
}

/** Signaling event (object format) */
export interface SignalingEvent {
  type: 'event';
  /** Event type code */
  eventType: number;
  /** Raw event data */
  data: SignalingEventData;
  /** Product-specific RTMS identifier (meeting/session/engagement/call) */
  rtmsId: string;
  /** Meeting/Session UUID */
  meetingId: string;
  /** RTMS stream ID */
  streamId: string;
  /** Product type */
  productType: ProductType;
  /** Event timestamp */
  timestamp: number;
}

/** Automatic signaling event emitted when Zoom reports media interruption */
export interface MediaConnectionInterruptedEvent {
  type: 'media_connection_interrupted';
  data: SignalingEventData;
  rtmsId: string;
  meetingId: string;
  streamId: string;
  productType: ProductType;
  timestamp: number;
}

export interface VideoParticipant {
  userId: number | string;
  userName?: string | null;
}

export interface VideoParticipantStateEvent {
  type: 'participant_video_on' | 'participant_video_off' | 'video_on_participants_changed';
  participants: VideoParticipant[];
  availableParticipants: VideoParticipant[];
  data: SignalingEventData;
  rtmsId: string;
  meetingId: string;
  streamId: string;
  productType: ProductType;
  timestamp: number;
}

export interface VideoSubscriptionResponseEvent {
  type: 'video_subscription_response';
  userId: number | string | null;
  subscribed: boolean;
  statusCode: number;
  success: boolean;
  reason: string | null;
  currentVideoSubscriptionUserId: number | string | null;
  data: Record<string, any>;
  rtmsId: string;
  meetingId: string;
  streamId: string;
  productType: ProductType;
  timestamp: number;
}

export interface StreamCloseResponseEvent {
  type: 'stream_close_response';
  statusCode: number;
  success: boolean;
  reason: string | null;
  data: Record<string, any>;
  rtmsId: string;
  meetingId: string;
  streamId: string;
  productType: ProductType;
  timestamp: number;
}

/** Raw stream state message from Zoom */
export interface StreamStateData {
  msg_type: number;
  state: number;
  reason?: number;
}

/** Stream state change event (object format) */
export interface StreamStateEvent {
  type: 'stream_state_changed';
  /** Stream state code */
  state: number;
  /** Reason code */
  reason?: number;
  /** Raw message data */
  data: StreamStateData;
  /** Product-specific RTMS identifier (meeting/session/engagement/call) */
  rtmsId: string;
  /** Meeting/Session UUID */
  meetingId: string;
  /** RTMS stream ID */
  streamId: string;
  /** Product type */
  productType: ProductType;
  /** Event timestamp */
  timestamp: number;
}

/** Raw session state message from Zoom */
export interface SessionStateData {
  msg_type: number;
  state: number;
  stop_reason?: number;
}

/** Session state change event (object format) */
export interface SessionStateEvent {
  type: 'session_state_changed';
  /** Session state code */
  state: number;
  /** Stop reason code */
  stopReason?: number;
  /** Raw message data */
  data: SessionStateData;
  /** Product-specific RTMS identifier (meeting/session/engagement/call) */
  rtmsId: string;
  /** Meeting/Session UUID */
  meetingId: string;
  /** RTMS stream ID */
  streamId: string;
  /** Product type */
  productType: ProductType;
  /** Event timestamp */
  timestamp: number;
}

// =============================================================================
// Presets
// =============================================================================

/** Preset configuration for common use cases */
export interface Preset {
  mediaTypes: number;
  mediaParams?: MediaParams;
}

/** Available presets */
export interface Presets {
  /** Audio only - optimized for speech processing */
  AUDIO_ONLY: Preset;
  /** Transcription - audio + transcript */
  TRANSCRIPTION: Preset;
  /** Video recording - audio + video */
  VIDEO_RECORDING: Preset;
  /** Full media - all types (default) */
  FULL_MEDIA: Preset;
}

// =============================================================================
// RTMSManager Class
// =============================================================================

/** Event handler types */
export type AudioEventHandler = (event: AudioEvent) => void;
export type VideoEventHandler = (event: VideoEvent) => void;
export type SharescreenEventHandler = (event: SharescreenEvent) => void;
export type TranscriptEventHandler = (event: TranscriptEvent) => void;
export type ChatEventHandler = (event: ChatEvent) => void;
export type SignalingEventHandler = (event: SignalingEvent) => void;
export type MediaConnectionInterruptedHandler = (event: MediaConnectionInterruptedEvent) => void;
export type VideoParticipantStateHandler = (event: VideoParticipantStateEvent) => void;
export type VideoSubscriptionResponseHandler = (event: VideoSubscriptionResponseEvent) => void;
export type StreamCloseResponseHandler = (event: StreamCloseResponseEvent) => void;
export type StreamStateHandler = (event: StreamStateEvent) => void;
export type SessionStateHandler = (event: SessionStateEvent) => void;
export type ErrorHandler = (error: RTMSError) => void;

/**
 * RTMSManager - Main class for handling Zoom RTMS connections
 * 
 * @example
 * ```typescript
 * import { RTMSManager } from 'rtms-manager-dev';
 * 
 * await RTMSManager.init({
 *   credentials: {
 *     meeting: { clientId: '...', clientSecret: '...', secretToken: '...' }
 *   },
 *   mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT
 * });
 * 
 * RTMSManager.on('audio', ({ buffer, userName }) => {
 *   console.log(`Audio from ${userName}: ${buffer.length} bytes`);
 * });
 * 
 * RTMSManager.on('transcript', ({ text, userName, isFinal }) => {
 *   console.log(`${userName}: ${text} ${isFinal ? '[FINAL]' : ''}`);
 * });
 * 
 * RTMSManager.on('error', (error) => {
 *   console.error(error.toString());
 * });
 * ```
 */
export class RTMSManager extends EventEmitter {
  /** Media type constants */
  static readonly MEDIA: MediaTypes;
  
  /** Preset configurations */
  static readonly PRESETS: Presets;
  
  /** Raw media parameters (advanced usage) */
  static readonly MEDIA_PARAMS: Record<string, number>;

  /** Newer RTMS protocol additions with overrideable defaults */
  static readonly PROTOCOL: RTMSProtocolDefinitions;

  /**
   * Initialize the RTMSManager
   * Auto-starts after initialization - no separate start() needed.
   * 
   * @param config - Configuration options
   * @returns Promise resolving to the RTMSManager instance
   */
  static init(config: RTMSConfig): Promise<RTMSManager>;

  /**
   * Stop the RTMSManager and close all connections
   */
  static stop(): Promise<void>;

  /**
   * Handle an incoming event from webhook/websocket
   * @param event - Event name (e.g., 'meeting.rtms_started')
   * @param payload - Event payload
   */
  static handleEvent(event: string, payload: any): void;

  /**
   * Get all active RTMS connections
   */
  static getActiveConnections(): any[];
  static getVideoOnParticipants(streamId: string): VideoParticipant[];
  static getCurrentVideoSubscription(streamId: string): number | string | null;
  static subscribeToIndividualVideo(streamId: string, userId: number | string, subscribe?: boolean): void;
  static requestStreamClose(streamId: string): void;

  // Event registration overloads
  static on(event: 'audio', handler: AudioEventHandler): void;
  static on(event: 'video', handler: VideoEventHandler): void;
  static on(event: 'sharescreen', handler: SharescreenEventHandler): void;
  static on(event: 'transcript', handler: TranscriptEventHandler): void;
  static on(event: 'chat', handler: ChatEventHandler): void;
  static on(event: 'event', handler: SignalingEventHandler): void;
  static on(event: 'media_connection_interrupted', handler: MediaConnectionInterruptedHandler): void;
  static on(event: 'participant_video_on', handler: VideoParticipantStateHandler): void;
  static on(event: 'participant_video_off', handler: VideoParticipantStateHandler): void;
  static on(event: 'video_on_participants_changed', handler: VideoParticipantStateHandler): void;
  static on(event: 'video_subscription_response', handler: VideoSubscriptionResponseHandler): void;
  static on(event: 'stream_close_response', handler: StreamCloseResponseHandler): void;
  static on(event: 'stream_state_changed', handler: StreamStateHandler): void;
  static on(event: 'session_state_changed', handler: SessionStateHandler): void;
  static on(event: 'error', handler: ErrorHandler): void;

  // Stream metadata accessors
  static getStreamTimestamps(streamId: string): { firstPacketTimestamp: number; lastPacketTimestamp: number } | null;
  static getStreamStartTime(streamId: string): number | null;
  static getStreamMediaConfig(streamId: string): MediaParams | null;
  static getStreamMetadata(streamId: string): any | null;
  static getAudioDetails(streamId: string): AudioMediaParams | null;
  static getVideoDetails(streamId: string): VideoMediaParams | null;
  static getShareScreenDetails(streamId: string): DeskshareMediaParams | null;
  static getTranscriptDetails(streamId: string): TranscriptMediaParams | null;
  static getChatDetails(streamId: string): ChatMediaParams | null;
  static getPingRtt(streamId: string): number;
}

export default RTMSManager;
