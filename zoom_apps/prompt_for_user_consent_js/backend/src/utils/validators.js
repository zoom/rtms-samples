const Joi = require('joi');

const consentSubmissionSchema = Joi.object({
  meetingId: Joi.string().required(),
  participantId: Joi.string().required(),
  participantName: Joi.string().allow('').optional(),
  consentStatus: Joi.string().valid('agreed', 'disagreed').required()
});

const meetingIdSchema = Joi.object({
  meetingId: Joi.string().required()
});

const policyUpdateSchema = Joi.object({
  meetingId: Joi.string().required(),
  policyMode: Joi.string().valid('unanimous', 'redact').required()
});

function validateConsentSubmission(data) {
  return consentSubmissionSchema.validate(data);
}

function validateMeetingId(data) {
  return meetingIdSchema.validate(data);
}

function validatePolicyUpdate(data) {
  return policyUpdateSchema.validate(data);
}

module.exports = {
  validateConsentSubmission,
  validateMeetingId,
  validatePolicyUpdate
};
