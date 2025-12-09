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

function validateConsentSubmission(data) {
  return consentSubmissionSchema.validate(data);
}

function validateMeetingId(data) {
  return meetingIdSchema.validate(data);
}

module.exports = {
  validateConsentSubmission,
  validateMeetingId
};
