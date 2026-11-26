import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthorizeRegistration,
  encryptZoomAppContext,
  mintTokenFromZoomAppHeader
} from '../wsAuth.js';
import { chatWithOpenRouter } from '../chatWithOpenrouter.js';
import {
  DndCampaignManager,
  parseDiceFormula,
  parseDmResponse
} from '../dndGame.js';

test('wsAuth: fail-closed registration supports active RTMS, static token, and Zoom App context token', async () => {
  const clientSecret = 'dnd-client-secret';
  const signingSecret = 'dnd-signing-secret';
  const header = encryptZoomAppContext({ mid: 'dnd-meeting-1', uid: 'player-1' }, clientSecret);
  const token = mintTokenFromZoomAppHeader(header, { clientSecret, signingSecret });

  const authorize = createAuthorizeRegistration({
    getActiveConnections: () => [{ rtmsId: 'live-dnd-meeting' }],
    authToken: 'shared-dnd-token',
    signingSecret,
    allowPreRtms: false
  });

  assert.equal((await authorize({ meetingUUID: 'live-dnd-meeting', userID: 'p1' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'dnd-meeting-1', userID: 'p1', token })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'other', userID: 'p1', token: 'shared-dnd-token' })).authorized, true);
  assert.equal((await authorize({ meetingUUID: 'other', userID: 'p1', token })).authorized, false);
  assert.equal((await authorize({ meetingUUID: 'other', userID: 'p1' })).authorized, false);
});

test('chatWithOpenRouter: passes real messages array (not JSON.stringify) and checks res.ok', async () => {
  let sentPayload = null;
  const result = await chatWithOpenRouter(
    [
      { role: 'system', content: 'You are a DM.' },
      { role: 'user', content: 'I open the door.' }
    ],
    {
      apiKey: 'test-key',
      model: 'openai/gpt-4o-mini',
      fetchImpl: async (_url, init) => {
        sentPayload = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"narration":"The door creaks open."}' } }] })
        };
      }
    }
  );

  assert.equal(result, '{"narration":"The door creaks open."}');
  assert.equal(Array.isArray(sentPayload.messages), true);
  assert.equal(sentPayload.messages.length, 2);
  assert.equal(sentPayload.messages[0].role, 'system');
  assert.equal(sentPayload.messages[1].content, 'I open the door.');

  await assert.rejects(
    () => chatWithOpenRouter([{ role: 'user', content: 'Hi' }], {
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'Rate limited' })
    }),
    /OpenRouter API error \(429\)/
  );
});

test('DndCampaignManager: per-meeting isolation, rewind dedup, party roster, dice roller, OOC pause, and reset', async () => {
  let llmCalls = 0;
  const fakeChat = async (messages) => {
    llmCalls += 1;
    assert.ok(Array.isArray(messages));
    assert.equal(messages[0].role, 'system');
    return JSON.stringify({
      narration: 'A hidden trapdoor clicks open beneath the tavern floorboards.',
      sceneTitle: 'Cellar Entrance',
      location: 'Under the Wyvern Tavern',
      mood: 'Tense',
      suggestedActions: ['Climb down the ladder', 'Drop a torch inside'],
      suggestedRoll: { skill: 'Stealth', formula: '1d20', dc: 14, reason: 'Descend quietly' },
      partyUpdates: [{ playerName: 'Aria', hpDelta: -3, goldDelta: 10, addItem: 'Rusty Key' }]
    });
  };

  const manager = new DndCampaignManager({ batchDelayMs: 0, chatFn: fakeChat });

  // Rewind handling: sentence 1 arrives, then gets revised in place before flush
  manager.ingestTranscript({
    meetingId: 'table-A',
    streamId: 'stream-A',
    userId: 'u1',
    userName: 'Aria',
    sentenceId: 1,
    text: 'I search the floor',
    timestamp: 1000
  });
  manager.ingestTranscript({
    meetingId: 'table-A',
    streamId: 'stream-A',
    userId: 'u1',
    userName: 'Aria',
    sentenceId: 1,
    isUpdate: true,
    attribute: 2,
    text: 'I search the floorboards carefully',
    timestamp: 1100
  });

  // Only 1 pending turn (not duplicated!) and party auto-populated
  const campaignA = manager.getCampaign('table-A');
  assert.equal(campaignA.pendingTurns.length, 1);
  assert.equal(campaignA.pendingTurns[0].text, 'I search the floorboards carefully');
  assert.equal(campaignA.party.size, 1);

  // Flush batched turns to DM
  const dmResult = await manager.flushPendingTurns('table-A');
  assert.equal(llmCalls, 1);
  assert.equal(dmResult.scene.title, 'Cellar Entrance');
  const aria = dmResult.state.party.find((p) => p.name === 'Aria');
  assert.equal(aria.hp, aria.maxHp - 3);
  assert.equal(aria.gold, 35);
  assert.ok(aria.inventory.includes('Rusty Key'));

  // Meeting B is completely isolated from Meeting A
  const stateB = manager.getPublicState('table-B');
  assert.equal(stateB.party.length, 0);
  assert.equal(stateB.scene.title, 'The Lantern & Wyvern Tavern');

  // Dice formula parsing & crit roll
  assert.deepEqual(parseDiceFormula('2d6+3'), { count: 2, sides: 6, formulaModifier: 3, canonical: '2d6+3' });
  assert.throws(() => parseDiceFormula('99d999'), /out of allowed bounds/);

  const rollOut = await manager.rollDice('table-A', {
    playerName: 'Aria',
    userId: 'u1',
    formula: '1d20',
    modifier: 2,
    skill: 'Stealth',
    dc: 14,
    narrate: false,
    rng: () => 19 // produces natural 20
  });
  assert.equal(rollOut.roll.rolls[0], 20);
  assert.equal(rollOut.roll.total, 22);
  assert.equal(rollOut.roll.outcome, 'crit_success');

  // OOC pause prevents transcript turns from queuing for the DM
  manager.setInCharacter('table-A', false);
  const oocIngest = manager.ingestTranscript({
    meetingId: 'table-A',
    streamId: 'stream-A',
    userId: 'u2',
    userName: 'Marcus',
    sentenceId: 2,
    text: 'Wait let me grab coffee',
    timestamp: 2000
  });
  assert.equal(oocIngest.queued, false);
  assert.equal(manager.getCampaign('table-A').pendingTurns.length, 0);

  // Reset campaign restores HP & increments campaign number
  const resetState = manager.resetCampaign('table-A');
  assert.equal(resetState.campaignNumber, 2);
  assert.equal(resetState.party.find((p) => p.name === 'Aria').hp, aria.maxHp);

  // Clear campaign removes meeting A while preserving meeting B
  assert.equal(manager.clearCampaign('table-A'), true);
  assert.equal(manager.getCampaign('table-A'), null);
  assert.ok(manager.getCampaign('table-B'));
});

test('parseDmResponse: handles plain-text fallback gracefully when model ignores JSON schema', () => {
  const res = parseDmResponse('A silver dragon descends from the clouds.');
  assert.equal(res.narration, 'A silver dragon descends from the clouds.');
  assert.ok(Array.isArray(res.suggestedActions));
});
