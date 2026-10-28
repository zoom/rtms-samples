import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_QUESTIONS, normalizeComplianceResponse } from '../complianceRiskAnalyzer.js';

test('uses all three Zoom decision primitives', () => {
  const types = new Set(Object.values(COMPLIANCE_QUESTIONS).map((question) => question.type));
  assert.deepEqual(types, new Set(['choice', 'predicate', 'score']));
});

test('normalizes a compliance response', () => {
  const result = normalizeComplianceResponse({
    model: 'zoom-decisions',
    request_id: 'request-1',
    answers: [
      { type: 'choice', name: 'conversation_stage', choice: 'disclosure', probabilities: [] },
      { type: 'choice', name: 'compliance_state', choice: 'material_gap', probabilities: [{ value: 'material_gap', probability: 0.91 }] },
      { type: 'choice', name: 'missing_requirement', choice: 'fees', probabilities: [] },
      {
        type: 'choice',
        name: 'next_action',
        choice: 'state_material_terms',
        probabilities: [
          { value: 'confirm_understanding', probability: 0.07 },
          { value: 'state_material_terms', probability: 0.88 },
          { value: 'offer_alternatives', probability: 0.03 }
        ]
      },
      { type: 'predicate', name: 'consent_recorded', probability: 0.67 },
      { type: 'score', name: 'compliance_risk', score: 2.4, probabilities: [] }
    ],
    usage: { input_units: 120, output_units: 0 }
  });

  assert.equal(result.requestId, 'request-1');
  assert.equal(result.complianceState.value, 'material_gap');
  assert.equal(result.missingRequirement.value, 'fees');
  assert.equal(result.nextAction.value, 'state_material_terms');
  assert.equal(result.nextAction.label, 'State material terms');
  assert.deepEqual(result.actionOptions.map((option) => option.value), [
    'state_material_terms',
    'confirm_understanding',
    'offer_alternatives'
  ]);
  assert.equal(result.actionOptions[0].recommended, true);
  assert.equal(result.consentRecorded, 0.67);
  assert.equal(result.complianceRisk.value, 2.4);
});

test('rejects a response without typed answers', () => {
  assert.throws(() => normalizeComplianceResponse({}), /answers array/);
});
