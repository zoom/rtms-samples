const crypto = require('crypto');
const { getConsentState, saveConsentState, deleteConsentState } = require('../utils/redis');

const MAX_AUDIT_EVENTS = 1000;
const VALID_POLICY_MODES = new Set(['unanimous', 'redact']);

function isRunningStatus(status) {
  return status === 'running' || status === 'active';
}

function escapeCsvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Consent Manager Service
 * Handles consent state management, policy evaluation, and audit trail logging.
 */
class ConsentManager {
  /**
   * Fetch current consent state for a meeting.
   */
  static async getConsentState(meetingId) {
    return getConsentState(meetingId);
  }

  /**
   * Delete meeting consent state (e.g. on meeting.ended).
   */
  static async deleteMeetingState(meetingId) {
    return deleteConsentState(meetingId);
  }

  /**
   * Check if all participants have consented
   */
  static checkUnanimousConsent(participants) {
    if (!participants || participants.length === 0) {
      return false;
    }

    return participants.every(p => p.consentStatus === 'agreed');
  }

  /**
   * Check if any participant has disagreed
   */
  static hasDisagreement(participants) {
    if (!participants || participants.length === 0) {
      return false;
    }
    return participants.some(p => p.consentStatus === 'disagreed');
  }

  /**
   * Check if at least one participant has agreed
   */
  static hasAnyAgreement(participants) {
    if (!participants || participants.length === 0) {
      return false;
    }
    return participants.some(p => p.consentStatus === 'agreed');
  }

  /**
   * Determine whether RTMS capture is currently permitted under the active policy mode.
   */
  static canCaptureRTMS(state) {
    if (!state || !Array.isArray(state.participants) || state.participants.length === 0) {
      return false;
    }

    const policyMode = state.policyMode === 'redact' ? 'redact' : 'unanimous';
    if (policyMode === 'redact') {
      return this.hasAnyAgreement(state.participants);
    }

    return this.checkUnanimousConsent(state.participants) && !this.hasDisagreement(state.participants);
  }

  /**
   * Evaluate whether a single transcript utterance should be stored, redacted, or dropped.
   * Returns { action: 'allow' | 'redact' | 'drop', reason: string }.
   */
  static evaluateTranscriptPolicy(state, speaker = {}) {
    if (!state || !isRunningStatus(state.rtmsStatus)) {
      return { action: 'drop', reason: `rtms_status_${state?.rtmsStatus || 'stopped'}` };
    }

    const policyMode = state.policyMode === 'redact' ? 'redact' : 'unanimous';
    if (policyMode === 'unanimous') {
      if (!state.unanimousConsent || !this.checkUnanimousConsent(state.participants)) {
        return { action: 'drop', reason: 'unanimous_consent_not_met' };
      }
      return { action: 'allow', reason: 'unanimous_consent_granted' };
    }

    // Per-participant redaction mode
    const speakerUuid = speaker.participantUUID ? String(speaker.participantUUID) : null;
    const speakerId = speaker.userId !== undefined && speaker.userId !== null ? String(speaker.userId) : null;
    const speakerName = speaker.userName ? String(speaker.userName).trim().toLowerCase() : null;

    const matched = (state.participants || []).find((p) => {
      if (speakerUuid && p.participantUUID && String(p.participantUUID) === speakerUuid) return true;
      if (speakerId && (String(p.participantID || '') === speakerId || String(p.participantUUID || '') === speakerId)) return true;
      if (speakerName && p.screenName && p.screenName.trim().toLowerCase() === speakerName) return true;
      return false;
    });

    if (matched && matched.consentStatus === 'agreed') {
      return { action: 'allow', reason: 'participant_consented' };
    }

    return {
      action: 'redact',
      reason: matched ? `participant_status_${matched.consentStatus}` : 'participant_unmatched'
    };
  }

  /**
   * Append a timestamped entry to the meeting's Consent Audit Trail.
   */
  static recordAuditEvent(state, event = {}) {
    if (!Array.isArray(state.auditTrail)) {
      state.auditTrail = [];
    }

    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      eventType: event.eventType || 'unknown',
      policyMode: state.policyMode || 'unanimous',
      rtmsStatus: state.rtmsStatus || 'stopped',
      unanimousConsent: Boolean(state.unanimousConsent),
      participantUUID: event.participantUUID || null,
      participantName: event.participantName || null,
      consentStatus: event.consentStatus || null,
      source: event.source || 'api',
      details: event.details || null
    };

    state.auditTrail.push(entry);
    if (state.auditTrail.length > MAX_AUDIT_EVENTS) {
      state.auditTrail = state.auditTrail.slice(-MAX_AUDIT_EVENTS);
    }

    return entry;
  }

  /**
   * Format an audit trail array as RFC 4180 CSV.
   */
  static formatAuditTrailCsv(auditTrail = []) {
    const headers = [
      'id',
      'timestamp',
      'eventType',
      'policyMode',
      'rtmsStatus',
      'unanimousConsent',
      'participantUUID',
      'participantName',
      'consentStatus',
      'source',
      'details'
    ];
    const lines = [headers.join(',')];
    for (const entry of auditTrail) {
      lines.push(headers.map((h) => escapeCsvCell(entry?.[h])).join(','));
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Add or update participant consent and apply RTMS gating transitions.
   * Returns { state, statusChanged, previousStatus }.
   */
  static async submitConsent(meetingId, participantData, options = {}) {
    try {
      const state = await getConsentState(meetingId);
      const previousStatus = state.rtmsStatus;

      const participantUUID = participantData.participantId || participantData.participantUUID;
      const participantName = participantData.participantName || participantData.screenName || 'Unknown';
      const consentStatus = participantData.consentStatus;

      const existingIndex = state.participants.findIndex(
        p => p.participantUUID === participantUUID
      );

      const existing = existingIndex >= 0 ? state.participants[existingIndex] : {};
      const participant = {
        ...existing,
        participantUUID,
        screenName: participantName || existing.screenName || 'Unknown',
        consentStatus,
        consentedAt: new Date().toISOString()
      };

      if (existingIndex >= 0) {
        state.participants[existingIndex] = participant;
      } else {
        state.participants.push(participant);
      }

      state.unanimousConsent = this.checkUnanimousConsent(state.participants);

      this.recordAuditEvent(state, {
        eventType: consentStatus === 'agreed' ? 'consent_granted' : 'consent_declined',
        participantUUID,
        participantName: participant.screenName,
        consentStatus,
        source: options.source || 'api',
        details: `Participant ${participant.screenName} ${consentStatus}`
      });

      const policyMode = state.policyMode === 'redact' ? 'redact' : 'unanimous';

      if (consentStatus === 'disagreed' && policyMode === 'unanimous') {
        if (state.rtmsStatus !== 'stopped') {
          state.rtmsStatus = 'stopped';
          state.rtmsPausedReason = `Consent declined by ${participant.screenName}`;
          this.recordAuditEvent(state, {
            eventType: 'rtms_stopped',
            participantUUID,
            participantName: participant.screenName,
            consentStatus,
            source: options.source || 'api',
            details: state.rtmsPausedReason
          });
        } else {
          state.rtmsPausedReason = `Consent declined by ${participant.screenName}`;
        }
      } else if (policyMode === 'redact') {
        const canCapture = this.canCaptureRTMS(state);
        if (canCapture && state.rtmsStatus !== 'running') {
          const eventType = state.rtmsStatus === 'paused' ? 'rtms_resumed' : 'rtms_started';
          state.rtmsStatus = 'running';
          state.rtmsPausedReason = null;
          this.recordAuditEvent(state, {
            eventType,
            participantUUID,
            participantName: participant.screenName,
            source: options.source || 'api',
            details: 'Per-participant redaction mode active with consenting participant(s)'
          });
        } else if (!canCapture && state.rtmsStatus !== 'stopped') {
          state.rtmsStatus = 'stopped';
          state.rtmsPausedReason = 'No consenting participants remaining';
          this.recordAuditEvent(state, {
            eventType: 'rtms_stopped',
            participantUUID,
            participantName: participant.screenName,
            source: options.source || 'api',
            details: state.rtmsPausedReason
          });
        }
      } else if (state.unanimousConsent && (state.rtmsStatus === 'stopped' || state.rtmsStatus === 'paused')) {
        const eventType = state.rtmsStatus === 'paused' ? 'rtms_resumed' : 'rtms_started';
        state.rtmsStatus = 'running';
        state.rtmsPausedReason = null;
        this.recordAuditEvent(state, {
          eventType,
          participantUUID,
          participantName: participant.screenName,
          source: options.source || 'api',
          details: 'Unanimous consent achieved'
        });
      }

      const saved = await saveConsentState(meetingId, state);

      return {
        state: saved,
        statusChanged: saved.rtmsStatus !== previousStatus,
        previousStatus
      };
    } catch (error) {
      console.error('Error submitting consent:', error);
      throw error;
    }
  }

  /**
   * Update the meeting's consent policy mode ('unanimous' | 'redact') and re-evaluate gating.
   */
  static async setPolicyMode(meetingId, policyMode, options = {}) {
    if (!VALID_POLICY_MODES.has(policyMode)) {
      throw new Error(`Invalid policyMode: ${policyMode}`);
    }

    const state = await getConsentState(meetingId);
    const previousStatus = state.rtmsStatus;
    const previousPolicy = state.policyMode;
    state.policyMode = policyMode;
    state.unanimousConsent = this.checkUnanimousConsent(state.participants);

    this.recordAuditEvent(state, {
      eventType: 'policy_mode_changed',
      source: options.source || 'api',
      details: `Policy changed from ${previousPolicy} to ${policyMode}`
    });

    if (policyMode === 'unanimous') {
      if (this.hasDisagreement(state.participants) && state.rtmsStatus !== 'stopped') {
        state.rtmsStatus = 'stopped';
        state.rtmsPausedReason = 'Switched to unanimous consent mode with declined participant(s)';
      } else if (!state.unanimousConsent && isRunningStatus(state.rtmsStatus)) {
        state.rtmsStatus = 'paused';
        state.rtmsPausedReason = 'Switched to unanimous consent mode; waiting for pending consent';
      } else if (state.unanimousConsent && state.rtmsStatus === 'paused') {
        state.rtmsStatus = 'running';
        state.rtmsPausedReason = null;
      }
    } else if (policyMode === 'redact') {
      if (this.canCaptureRTMS(state) && state.rtmsStatus === 'paused') {
        state.rtmsStatus = 'running';
        state.rtmsPausedReason = null;
      }
    }

    if (state.rtmsStatus !== previousStatus) {
      this.recordAuditEvent(state, {
        eventType: `rtms_${state.rtmsStatus}`,
        source: options.source || 'api',
        details: state.rtmsPausedReason || `RTMS transitioned to ${state.rtmsStatus} after policy change`
      });
    }

    const saved = await saveConsentState(meetingId, state);
    return {
      state: saved,
      statusChanged: saved.rtmsStatus !== previousStatus,
      previousStatus
    };
  }

  /**
   * Add new participant to consent state and pause RTMS in unanimous mode if running.
   */
  static async addParticipant(meetingId, participant, options = {}) {
    try {
      const state = await getConsentState(meetingId);
      const previousStatus = state.rtmsStatus;

      const exists = state.participants.some(
        p => p.participantUUID === participant.participantUUID
      );

      if (exists) {
        return {
          state,
          duplicate: true,
          wasRunning: isRunningStatus(previousStatus),
          statusChanged: false,
          previousStatus
        };
      }

      state.participants.push({
        participantUUID: participant.participantUUID,
        participantID: participant.participantID || null,
        screenName: participant.screenName || participant.participantID || 'Unknown',
        role: participant.role || 'attendee',
        isHost: Boolean(participant.isHost),
        isCoHost: Boolean(participant.isCoHost),
        consentStatus: 'pending',
        joinedAt: new Date().toISOString()
      });

      state.unanimousConsent = false;
      this.recordAuditEvent(state, {
        eventType: 'participant_joined',
        participantUUID: participant.participantUUID,
        participantName: participant.screenName || participant.participantID || 'Unknown',
        consentStatus: 'pending',
        source: options.source || 'sdk',
        details: 'New participant joined with pending consent'
      });

      const wasRunning = isRunningStatus(state.rtmsStatus);
      const policyMode = state.policyMode === 'redact' ? 'redact' : 'unanimous';

      if (wasRunning && policyMode === 'unanimous') {
        state.rtmsStatus = 'paused';
        state.rtmsPausedReason = `New participant joined: ${participant.screenName || 'Unknown'}`;
        this.recordAuditEvent(state, {
          eventType: 'rtms_paused',
          participantUUID: participant.participantUUID,
          participantName: participant.screenName || 'Unknown',
          source: options.source || 'sdk',
          details: state.rtmsPausedReason
        });
      }

      const saved = await saveConsentState(meetingId, state);
      return {
        state: saved,
        duplicate: false,
        wasRunning,
        statusChanged: saved.rtmsStatus !== previousStatus,
        previousStatus
      };
    } catch (error) {
      console.error('Error adding participant:', error);
      throw error;
    }
  }

  /**
   * Remove participant from consent state and resume/stop RTMS if appropriate.
   */
  static async removeParticipant(meetingId, participantUUID, options = {}) {
    try {
      const state = await getConsentState(meetingId);
      const previousStatus = state.rtmsStatus;
      const leaving = state.participants.find(p => p.participantUUID === participantUUID);

      state.participants = state.participants.filter(
        p => p.participantUUID !== participantUUID
      );

      state.unanimousConsent = this.checkUnanimousConsent(state.participants);

      this.recordAuditEvent(state, {
        eventType: 'participant_left',
        participantUUID,
        participantName: leaving?.screenName || null,
        consentStatus: leaving?.consentStatus || null,
        source: options.source || 'sdk',
        details: leaving ? `${leaving.screenName} left the meeting` : 'Participant left the meeting'
      });

      if (state.participants.length === 0 && state.rtmsStatus !== 'stopped') {
        state.rtmsStatus = 'stopped';
        state.rtmsPausedReason = 'All participants left the meeting';
        this.recordAuditEvent(state, {
          eventType: 'rtms_stopped',
          source: options.source || 'sdk',
          details: state.rtmsPausedReason
        });
      } else if (state.unanimousConsent && state.rtmsStatus === 'paused') {
        state.rtmsStatus = 'running';
        state.rtmsPausedReason = null;
        this.recordAuditEvent(state, {
          eventType: 'rtms_resumed',
          participantUUID,
          participantName: leaving?.screenName || null,
          source: options.source || 'sdk',
          details: 'Unanimous consent restored after non-consenting participant left'
        });
      } else if (state.policyMode === 'redact' && !this.canCaptureRTMS(state) && state.rtmsStatus !== 'stopped') {
        state.rtmsStatus = 'stopped';
        state.rtmsPausedReason = 'No consenting participants remaining';
        this.recordAuditEvent(state, {
          eventType: 'rtms_stopped',
          source: options.source || 'sdk',
          details: state.rtmsPausedReason
        });
      }

      const saved = await saveConsentState(meetingId, state);
      return {
        state: saved,
        statusChanged: saved.rtmsStatus !== previousStatus,
        previousStatus
      };
    } catch (error) {
      console.error('Error removing participant:', error);
      throw error;
    }
  }

  /**
   * Sync participant list from SDK while preserving consent statuses and enforcing RTMS gating.
   */
  static async syncParticipants(meetingId, incomingParticipants, options = {}) {
    const state = await getConsentState(meetingId);
    const previousStatus = state.rtmsStatus;
    const oldParticipants = state.participants;
    const isLikelyGuestSync = incomingParticipants.length < oldParticipants.length && oldParticipants.length > 0;

    let addedCount = 0;
    let preservedCount = 0;

    if (isLikelyGuestSync) {
      const merged = [...oldParticipants];
      for (const participant of incomingParticipants) {
        const existingIndex = merged.findIndex(p => p.participantUUID === participant.participantUUID);
        if (existingIndex >= 0) {
          preservedCount += 1;
          merged[existingIndex] = {
            ...merged[existingIndex],
            screenName: participant.screenName || merged[existingIndex].screenName,
            role: participant.role || merged[existingIndex].role
          };
        } else {
          addedCount += 1;
          merged.push({
            participantUUID: participant.participantUUID,
            participantID: participant.participantID || null,
            screenName: participant.screenName || 'Unknown',
            role: participant.role || 'attendee',
            isHost: Boolean(participant.isHost),
            isCoHost: Boolean(participant.isCoHost),
            consentStatus: 'pending',
            joinedAt: new Date().toISOString()
          });
        }
      }
      state.participants = merged;
    } else {
      state.participants = incomingParticipants.map((participant) => {
        const existing = oldParticipants.find(p => p.participantUUID === participant.participantUUID);
        if (existing) {
          preservedCount += 1;
          return {
            ...existing,
            screenName: participant.screenName || existing.screenName,
            role: participant.role || existing.role,
            isHost: participant.isHost ?? existing.isHost,
            isCoHost: participant.isCoHost ?? existing.isCoHost
          };
        }
        addedCount += 1;
        return {
          participantUUID: participant.participantUUID,
          participantID: participant.participantID || null,
          screenName: participant.screenName || 'Unknown',
          role: participant.role || 'attendee',
          isHost: Boolean(participant.isHost),
          isCoHost: Boolean(participant.isCoHost),
          consentStatus: 'pending',
          joinedAt: new Date().toISOString()
        };
      });
    }

    state.unanimousConsent = this.checkUnanimousConsent(state.participants);
    const policyMode = state.policyMode === 'redact' ? 'redact' : 'unanimous';

    if (policyMode === 'unanimous') {
      if (isRunningStatus(state.rtmsStatus) && !state.unanimousConsent) {
        state.rtmsStatus = 'paused';
        state.rtmsPausedReason = 'Unconsented participant(s) detected during sync';
        this.recordAuditEvent(state, {
          eventType: 'rtms_paused',
          source: options.source || 'sync',
          details: state.rtmsPausedReason
        });
      } else if (state.rtmsStatus === 'paused' && state.unanimousConsent) {
        state.rtmsStatus = 'running';
        state.rtmsPausedReason = null;
        this.recordAuditEvent(state, {
          eventType: 'rtms_resumed',
          source: options.source || 'sync',
          details: 'Unanimous consent restored during participant sync'
        });
      }
    }

    const saved = await saveConsentState(meetingId, state);
    return {
      state: saved,
      syncedCount: addedCount,
      alreadyTrackedCount: preservedCount,
      statusChanged: saved.rtmsStatus !== previousStatus,
      previousStatus
    };
  }

  /**
   * Get list of participants who haven't consented
   */
  static getPendingParticipants(participants) {
    return (participants || []).filter(p => p.consentStatus === 'pending');
  }
}

module.exports = ConsentManager;
