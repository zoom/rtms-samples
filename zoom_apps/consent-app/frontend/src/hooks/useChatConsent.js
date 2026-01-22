/**
 * useChatConsent Hook
 * Listens for chat messages and detects consent keywords
 * Provides fallback consent mechanism for external participants who cannot open the app
 */

import { useEffect, useState } from 'react';
import { useZoomSDK } from '../contexts/ZoomSDKContext';

// Consent keywords (case-insensitive)
const CONSENT_KEYWORDS = [
  'i consent',
  'i agree',
  '/consent',
  '/agree',
  'consent granted',
  'yes to consent'
];

const DECLINE_KEYWORDS = [
  'i decline',
  'i disagree',
  '/decline',
  'no consent',
  'consent declined'
];

/**
 * Parse a chat message to detect consent intent
 * @param {string} message - The chat message text
 * @returns {'agreed' | 'disagreed' | null} - Consent status or null if not a consent message
 */
export function parseConsentFromChat(message) {
  if (!message || typeof message !== 'string') return null;

  const text = message.toLowerCase().trim();

  // Check for agreement keywords
  if (CONSENT_KEYWORDS.some(keyword => text.includes(keyword))) {
    return 'agreed';
  }

  // Check for decline keywords
  if (DECLINE_KEYWORDS.some(keyword => text.includes(keyword))) {
    return 'disagreed';
  }

  return null; // Not a consent message
}

/**
 * Hook to listen for chat-based consent
 * @param {function} onConsentDetected - Callback when consent is detected (participantId, consentStatus)
 */
export function useChatConsent(onConsentDetected) {
  const { zoomSdk, meetingContext } = useZoomSDK();
  const [chatConsentEnabled, setChatConsentEnabled] = useState(false);

  useEffect(() => {
    if (!zoomSdk || !meetingContext) return;

    console.log('📨 Setting up chat consent listener...');

    // Listen for chat messages
    const handleMessage = async (data) => {
      try {
        console.log('💬 Chat message received:', data);

        // Extract message details
        const message = data.message || '';
        const senderId = data.senderId || data.sender?.userId;
        const senderName = data.senderName || data.sender?.screenName || 'Unknown';

        if (!message || !senderId) {
          console.log('⚠️  Invalid message data, skipping');
          return;
        }

        // Parse consent from message
        const consentStatus = parseConsentFromChat(message);

        if (consentStatus) {
          console.log(`✅ Chat consent detected: ${senderName} → ${consentStatus}`);
          console.log(`   Message: "${message}"`);
          console.log(`   Sender ID: ${senderId}`);

          // Notify parent component
          if (onConsentDetected) {
            onConsentDetected({
              participantId: senderId,
              participantName: senderName,
              consentStatus,
              via: 'chat',
              message
            });
          }
        }
      } catch (error) {
        console.error('❌ Error processing chat message:', error);
      }
    };

    // Set up chat message listener
    try {
      zoomSdk.onMessage(handleMessage);
      setChatConsentEnabled(true);
      console.log('✅ Chat consent listener active');
      console.log(`   Listening for: ${CONSENT_KEYWORDS.join(', ')}`);
    } catch (error) {
      console.error('❌ Failed to set up chat listener:', error);
      console.error('   Make sure "onMessage" API is enabled in Zoom Marketplace');
    }

    // Cleanup function
    return () => {
      console.log('🔌 Removing chat consent listener');
      // Note: Zoom SDK doesn't have an off() method for onMessage
      // The listener will be removed when the component unmounts
    };
  }, [zoomSdk, meetingContext, onConsentDetected]);

  return { chatConsentEnabled };
}
