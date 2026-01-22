const { getConsentState, saveConsentState } = require('../utils/redis');

/**
 * Consent Manager Service
 * Handles consent state management and validation
 */
class ConsentManager {
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
    return participants.some(p => p.consentStatus === 'disagreed');
  }

  /**
   * Add or update participant consent
   */
  static async submitConsent(meetingId, participantData) {
    try {
      const state = await getConsentState(meetingId);

      // Find existing participant or add new one
      const existingIndex = state.participants.findIndex(
        p => p.participantUUID === participantData.participantId
      );

      const participant = {
        participantUUID: participantData.participantId,
        screenName: participantData.participantName || 'Unknown',
        consentStatus: participantData.consentStatus,
        consentedAt: new Date().toISOString()
      };

      if (existingIndex >= 0) {
        state.participants[existingIndex] = participant;
      } else {
        state.participants.push(participant);
      }

      // Check for unanimous consent
      state.unanimousConsent = this.checkUnanimousConsent(state.participants);

      // Update state
      await saveConsentState(meetingId, state);

      return state;
    } catch (error) {
      console.error('Error submitting consent:', error);
      throw error;
    }
  }

  /**
   * Add new participant to consent state
   */
  static async addParticipant(meetingId, participant) {
    try {
      const state = await getConsentState(meetingId);

      // Check if participant already exists
      const exists = state.participants.some(
        p => p.participantUUID === participant.participantUUID
      );

      if (!exists) {
        state.participants.push({
          participantUUID: participant.participantUUID,
          screenName: participant.screenName || participant.participantID,
          consentStatus: 'pending',
          joinedAt: new Date().toISOString()
        });

        // No longer unanimous if new participant joins
        state.unanimousConsent = false;

        await saveConsentState(meetingId, state);
      }

      return state;
    } catch (error) {
      console.error('Error adding participant:', error);
      throw error;
    }
  }

  /**
   * Remove participant from consent state
   */
  static async removeParticipant(meetingId, participantUUID) {
    try {
      const state = await getConsentState(meetingId);

      state.participants = state.participants.filter(
        p => p.participantUUID !== participantUUID
      );

      // Recheck unanimous consent after removal
      state.unanimousConsent = this.checkUnanimousConsent(state.participants);

      await saveConsentState(meetingId, state);

      return state;
    } catch (error) {
      console.error('Error removing participant:', error);
      throw error;
    }
  }

  /**
   * Get list of participants who haven't consented
   */
  static getPendingParticipants(participants) {
    return participants.filter(p => p.consentStatus === 'pending');
  }
}

module.exports = ConsentManager;
