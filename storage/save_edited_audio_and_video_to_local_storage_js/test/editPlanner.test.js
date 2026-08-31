import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEditPlan } from '../lib/editPlanner.js';

test('validates and normalizes an edit plan', () => {
  const plan = validateEditPlan({
    title: 'Highlights',
    style: 'dissolve',
    transitionMs: 400,
    aspectRatio: '16:9',
    segments: [
      { startMs: 5000, endMs: 9000, label: 'Second' },
      { startMs: 0, endMs: 3000, label: 'First' },
    ],
  }, 10000, { minSegmentMs: 800, maxOutputMs: 10000 });

  assert.equal(plan.style, 'dissolve');
  assert.equal(plan.selectedDurationMs, 7000);
  assert.deepEqual(plan.segments.map((segment) => segment.label), ['First', 'Second']);
});

test('rejects overlapping edit segments', () => {
  assert.throws(() => validateEditPlan({
    segments: [
      { startMs: 0, endMs: 3000 },
      { startMs: 2500, endMs: 5000 },
    ],
  }, 6000), /overlap/);
});
