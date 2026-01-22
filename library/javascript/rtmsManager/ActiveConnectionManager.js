import { FileLogger } from './utils/FileLogger.js';

export class ActiveConnectionManager {
  constructor() {
    this.connections = new Map(); // key: streamId, value: RTMSMessageHandler instance
  }

  /**
   * Add a connection
   * @param {string} streamId 
   * @param {Object} handler 
   */
  add(streamId, handler) {
    this.connections.set(streamId, handler);
    FileLogger.log(`[ActiveConnectionManager] Added handler for ${handler.rtmsType} ${handler.rtmsId} stream ${streamId}`);
  }

  /**
   * Remove a connection
   * @param {string} streamId 
   */
  remove(streamId) {
    const handler = this.connections.get(streamId);
    if (handler) {
      this.connections.delete(streamId);
      FileLogger.log(`[ActiveConnectionManager] Removed handler for ${handler.rtmsType} ${handler.rtmsId} stream ${streamId}`);
    }
  }

  /**
   * Check if a streamId exists
   * @param {string} streamId 
   * @returns {boolean}
   */
  has(streamId) {
    return this.connections.has(streamId);
  }

  /**
   * Get a handler by streamId
   * @param {string} streamId 
   * @returns {Object|null}
   */
  get(streamId) {
    return this.connections.get(streamId) || null;
  }

  /**
   * Find a handler by RTMS ID (meeting_uuid or session_id)
   * @param {string} rtmsId 
   * @returns {Object|null}
   */
  findByRtmsId(rtmsId) {
    for (const conn of this.connections.values()) {
      if (conn.rtmsId === rtmsId) {
        return conn;
      }
    }
    return null;
  }

  /**
   * Get all active connections
   * @returns {Array}
   */
  getAll() {
    return Array.from(this.connections.values());
  }

  /**
   * Clear all connections
   */
  clear() {
    this.connections.clear();
  }

  /**
   * Get total number of active connections
   * @returns {number}
   */
  get size() {
    return this.connections.size;
  }
}

export default ActiveConnectionManager;
