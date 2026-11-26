import { randomInt, randomUUID } from 'crypto';
import { TranscriptRevisionStore } from '../../library/javascript/rtmsManager/utils/TranscriptRevisionStore.js';
import { chatWithOpenRouter } from './chatWithOpenrouter.js';

const DEFAULT_CLASSES = [
  { className: 'Ranger', maxHp: 24, ac: 14, inventory: ['Longbow', 'Torch', 'Healing Potion'] },
  { className: 'Wizard', maxHp: 18, ac: 12, inventory: ['Spellbook', 'Quarterstaff', 'Mana Vial'] },
  { className: 'Fighter', maxHp: 30, ac: 16, inventory: ['Longsword', 'Shield', 'Rations'] },
  { className: 'Rogue', maxHp: 22, ac: 15, inventory: ['Twin Daggers', 'Thieves Tools', 'Smoke Bomb'] },
  { className: 'Cleric', maxHp: 26, ac: 15, inventory: ['Mace', 'Holy Symbol', 'Healing Potion'] },
  { className: 'Bard', maxHp: 22, ac: 13, inventory: ['Lute', 'Rapier', 'Lantern'] }
];

const INITIAL_SCENE = Object.freeze({
  title: 'The Lantern & Wyvern Tavern',
  location: 'Crossroads of Briarwood',
  mood: 'Mysterious',
  description: 'Rain taps against leaded glass as a hooded courier slides a wax-sealed map across your table.',
  suggestedActions: [
    'Inspect the wax seal on the map',
    'Ask the courier who sent them',
    'Scan the tavern for eavesdroppers'
  ],
  suggestedRoll: {
    skill: 'Perception',
    formula: '1d20',
    dc: 12,
    reason: 'Check if anyone in the tavern is watching your table'
  }
});

const DM_SYSTEM_PROMPT = `You are an engaging tabletop Dungeons & Dragons Dungeon Master running a live voice campaign inside a Zoom meeting.
Keep narration vivid, interactive, and concise (2-4 sentences).
ALWAYS respond with valid JSON matching this exact shape (no markdown fences):
{
  "narration": "Vivid 2-4 sentence DM narration responding to the party.",
  "sceneTitle": "Short scene title",
  "location": "Current location name",
  "mood": "One-word atmosphere (e.g. Tense, Mysterious, Heroic, Calm)",
  "suggestedActions": ["Action 1", "Action 2", "Action 3"],
  "suggestedRoll": null | { "skill": "Perception", "formula": "1d20", "dc": 13, "reason": "Why to roll" },
  "partyUpdates": [
    { "playerName": "Exact Name", "hpDelta": 0, "goldDelta": 0, "addItem": "", "removeItem": "" }
  ]
}`;

/**
 * Parses a standard tabletop dice expression such as "1d20", "d20+3", "2d6-1".
 */
export function parseDiceFormula(rawFormula = '1d20') {
  const normalized = String(rawFormula || '1d20').replace(/\s+/g, '').toLowerCase();
  const match = /^(\d*)d(\d+)([+-]\d+)?$/.exec(normalized);
  if (!match) {
    throw new Error(`Invalid dice formula: ${rawFormula}`);
  }
  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const formulaModifier = match[3] ? Number(match[3]) : 0;

  if (count < 1 || count > 20 || sides < 2 || sides > 100) {
    throw new Error(`Dice formula out of allowed bounds: ${rawFormula}`);
  }

  return {
    count,
    sides,
    formulaModifier,
    canonical: `${count}d${sides}${formulaModifier ? (formulaModifier > 0 ? `+${formulaModifier}` : `${formulaModifier}`) : ''}`
  };
}

/**
 * Extracts structured JSON from a DM model reply, with graceful fallback to plain text.
 */
export function parseDmResponse(rawText, fallbackScene = INITIAL_SCENE) {
  const text = String(rawText || '').trim();
  if (!text) {
    return {
      narration: 'The Dungeon Master pauses, studying the ancient map before speaking.',
      sceneTitle: fallbackScene.title,
      location: fallbackScene.location,
      mood: fallbackScene.mood,
      suggestedActions: [...(fallbackScene.suggestedActions || [])],
      suggestedRoll: fallbackScene.suggestedRoll || null,
      partyUpdates: []
    };
  }

  let parsed = null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed && typeof parsed === 'object' && typeof parsed.narration === 'string' && parsed.narration.trim()) {
    const suggestedActions = Array.isArray(parsed.suggestedActions)
      ? parsed.suggestedActions.map((a) => String(a || '').trim()).filter(Boolean).slice(0, 4)
      : [...(fallbackScene.suggestedActions || [])];

    let suggestedRoll = null;
    if (parsed.suggestedRoll && typeof parsed.suggestedRoll === 'object' && parsed.suggestedRoll.skill) {
      suggestedRoll = {
        skill: String(parsed.suggestedRoll.skill).slice(0, 40),
        formula: String(parsed.suggestedRoll.formula || '1d20').slice(0, 20),
        dc: Number.isFinite(Number(parsed.suggestedRoll.dc)) ? Number(parsed.suggestedRoll.dc) : null,
        reason: String(parsed.suggestedRoll.reason || '').slice(0, 140)
      };
    }

    const partyUpdates = Array.isArray(parsed.partyUpdates) ? parsed.partyUpdates : [];

    return {
      narration: parsed.narration.trim(),
      sceneTitle: String(parsed.sceneTitle || fallbackScene.title).slice(0, 80),
      location: String(parsed.location || fallbackScene.location).slice(0, 80),
      mood: String(parsed.mood || fallbackScene.mood).slice(0, 30),
      suggestedActions,
      suggestedRoll,
      partyUpdates
    };
  }

  return {
    narration: text,
    sceneTitle: fallbackScene.title,
    location: fallbackScene.location,
    mood: fallbackScene.mood,
    suggestedActions: [...(fallbackScene.suggestedActions || [])],
    suggestedRoll: fallbackScene.suggestedRoll || null,
    partyUpdates: []
  };
}

export class DndCampaignManager {
  constructor(options = {}) {
    this.batchDelayMs = options.batchDelayMs ?? 1500;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 24;
    this.maxLogEntries = options.maxLogEntries ?? 50;
    this.chatFn = options.chatFn || chatWithOpenRouter;
    this.campaigns = new Map();
  }

  getOrCreateCampaign(meetingId) {
    const key = String(meetingId || 'default');
    let campaign = this.campaigns.get(key);
    if (!campaign) {
      campaign = {
        meetingId: key,
        campaignNumber: 1,
        history: [{ role: 'system', content: DM_SYSTEM_PROMPT }],
        summary: '',
        party: new Map(),
        scene: {
          ...INITIAL_SCENE,
          suggestedActions: [...INITIAL_SCENE.suggestedActions],
          suggestedRoll: { ...INITIAL_SCENE.suggestedRoll }
        },
        inCharacter: true,
        pendingTurns: [],
        timer: null,
        transcriptStore: new TranscriptRevisionStore(),
        answeredSentenceKeys: new Set(),
        diceLog: [],
        log: [
          {
            id: randomUUID(),
            type: 'dm',
            speaker: 'Dungeon Master',
            narration: INITIAL_SCENE.description,
            timestamp: Date.now()
          }
        ],
        flushing: false
      };
      this.campaigns.set(key, campaign);
    }
    return campaign;
  }

  getCampaign(meetingId) {
    return this.campaigns.get(String(meetingId || 'default')) || null;
  }

  ensurePartyMember(meetingId, { userId, userName }) {
    const campaign = this.getOrCreateCampaign(meetingId);
    const displayName = String(userName || '').trim() || `Adventurer ${userId || campaign.party.size + 1}`;
    const memberKey = String(userId || displayName.toLowerCase());

    let member = campaign.party.get(memberKey);
    if (!member) {
      // Also check by case-insensitive displayName to avoid duplicate roster cards
      for (const existing of campaign.party.values()) {
        if (existing.name.toLowerCase() === displayName.toLowerCase()) {
          return existing;
        }
      }
      const preset = DEFAULT_CLASSES[campaign.party.size % DEFAULT_CLASSES.length];
      member = {
        id: memberKey,
        name: displayName,
        className: preset.className,
        level: 1,
        hp: preset.maxHp,
        maxHp: preset.maxHp,
        ac: preset.ac,
        gold: 25,
        inventory: [...preset.inventory]
      };
      campaign.party.set(memberKey, member);
    } else if (userName && member.name !== displayName) {
      member.name = displayName;
    }

    return member;
  }

  getPublicState(meetingId) {
    const campaign = this.getOrCreateCampaign(meetingId);
    return {
      meetingId: campaign.meetingId,
      campaignNumber: campaign.campaignNumber,
      inCharacter: campaign.inCharacter,
      summary: campaign.summary,
      scene: campaign.scene,
      party: Array.from(campaign.party.values()),
      diceLog: campaign.diceLog.slice(-15),
      log: campaign.log.slice(-this.maxLogEntries),
      pendingCount: campaign.pendingTurns.length
    };
  }

  setInCharacter(meetingId, inCharacter) {
    const campaign = this.getOrCreateCampaign(meetingId);
    campaign.inCharacter = Boolean(inCharacter);
    if (!campaign.inCharacter && campaign.timer) {
      clearTimeout(campaign.timer);
      campaign.timer = null;
      campaign.pendingTurns = [];
    }
    return this.getPublicState(meetingId);
  }

  resetCampaign(meetingId) {
    const campaign = this.getOrCreateCampaign(meetingId);
    if (campaign.timer) {
      clearTimeout(campaign.timer);
      campaign.timer = null;
    }
    campaign.campaignNumber += 1;
    campaign.history = [{ role: 'system', content: DM_SYSTEM_PROMPT }];
    campaign.summary = '';
    campaign.pendingTurns = [];
    campaign.answeredSentenceKeys.clear();
    campaign.diceLog = [];
    campaign.inCharacter = true;
    campaign.scene = {
      ...INITIAL_SCENE,
      suggestedActions: [...INITIAL_SCENE.suggestedActions],
      suggestedRoll: { ...INITIAL_SCENE.suggestedRoll }
    };
    for (const member of campaign.party.values()) {
      member.hp = member.maxHp;
      member.gold = 25;
    }
    campaign.log = [
      {
        id: randomUUID(),
        type: 'dm',
        speaker: 'Dungeon Master',
        narration: `Campaign #${campaign.campaignNumber} begins! ${INITIAL_SCENE.description}`,
        timestamp: Date.now()
      }
    ];
    return this.getPublicState(meetingId);
  }

  clearCampaign(meetingId) {
    const key = String(meetingId || 'default');
    const campaign = this.campaigns.get(key);
    if (!campaign) return false;
    if (campaign.timer) {
      clearTimeout(campaign.timer);
      campaign.timer = null;
    }
    campaign.transcriptStore.clear();
    this.campaigns.delete(key);
    return true;
  }

  /**
   * Records a transcript event with rewind handling and schedules batched DM narration when in-character.
   */
  ingestTranscript(event, { onDmResponse, now = Date.now() } = {}) {
    const meetingId = String(event.meetingId || event.rtmsId || 'default');
    const campaign = this.getOrCreateCampaign(meetingId);
    const revision = campaign.transcriptStore.apply(event);
    const text = String(revision.sentence.text || '').trim();
    const userName = revision.sentence.userName || `User ${revision.sentence.userId ?? 'unknown'}`;
    const member = this.ensurePartyMember(meetingId, {
      userId: revision.sentence.userId,
      userName
    });

    const transcriptTurn = {
      sentenceKey: revision.key,
      action: revision.action,
      userId: revision.sentence.userId,
      userName: member.name,
      text,
      timestamp: Number(revision.sentence.timestamp) || now,
      inCharacter: campaign.inCharacter
    };

    if (!text || !campaign.inCharacter) {
      return { transcriptTurn, queued: false, state: this.getPublicState(meetingId) };
    }

    if (revision.action === 'updated' && campaign.answeredSentenceKeys.has(revision.key)) {
      return { transcriptTurn, queued: false, state: this.getPublicState(meetingId) };
    }

    const existingPending = campaign.pendingTurns.find((t) => t.sentenceKey === revision.key);
    if (existingPending) {
      existingPending.text = text;
      existingPending.speaker = member.name;
      existingPending.timestamp = transcriptTurn.timestamp;
    } else {
      campaign.pendingTurns.push({
        sentenceKey: revision.key,
        speaker: member.name,
        text,
        timestamp: transcriptTurn.timestamp
      });
    }

    if (this.batchDelayMs > 0 && typeof onDmResponse === 'function') {
      if (campaign.timer) clearTimeout(campaign.timer);
      campaign.timer = setTimeout(async () => {
        campaign.timer = null;
        try {
          const result = await this.flushPendingTurns(meetingId);
          if (result) {
            onDmResponse(result);
          }
        } catch (err) {
          console.error('[D&D] Batched DM flush failed:', err.message || err);
        }
      }, this.batchDelayMs);
    }

    return { transcriptTurn, queued: true, state: this.getPublicState(meetingId) };
  }

  /**
   * Immediately processes a direct player action (e.g., clicked suggested action or typed input).
   */
  async submitPlayerAction(meetingId, { playerName, userId, text }) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;

    const member = this.ensurePartyMember(meetingId, { userId, userName: playerName });
    const campaign = this.getOrCreateCampaign(meetingId);
    if (campaign.timer) {
      clearTimeout(campaign.timer);
      campaign.timer = null;
    }

    campaign.pendingTurns.push({
      sentenceKey: `action:${randomUUID()}`,
      speaker: member.name,
      text: cleanText,
      timestamp: Date.now()
    });

    return await this.flushPendingTurns(meetingId);
  }

  /**
   * Rolls dice for a player, updates the dice log, and optionally sends the roll outcome to the DM.
   */
  async rollDice(meetingId, {
    playerName,
    userId,
    formula = '1d20',
    modifier = 0,
    skill = '',
    dc = null,
    narrate = true,
    rng
  } = {}) {
    const member = this.ensurePartyMember(meetingId, { userId, userName: playerName });
    const campaign = this.getOrCreateCampaign(meetingId);
    const parsed = parseDiceFormula(formula);
    const extraMod = Number.isFinite(Number(modifier)) ? Number(modifier) : 0;
    const totalMod = parsed.formulaModifier + extraMod;

    const rolls = [];
    for (let i = 0; i < parsed.count; i += 1) {
      const value = typeof rng === 'function'
        ? Math.max(1, Math.min(parsed.sides, Math.floor(rng(parsed.sides)) + 1))
        : randomInt(1, parsed.sides + 1);
      rolls.push(value);
    }

    const sum = rolls.reduce((acc, v) => acc + v, 0);
    const total = sum + totalMod;
    const numericDc = dc != null && dc !== '' && Number.isFinite(Number(dc)) ? Number(dc) : null;

    let outcome = null;
    if (parsed.count === 1 && parsed.sides === 20 && rolls[0] === 20) {
      outcome = 'crit_success';
    } else if (parsed.count === 1 && parsed.sides === 20 && rolls[0] === 1) {
      outcome = 'crit_fail';
    } else if (numericDc != null) {
      outcome = total >= numericDc ? 'success' : 'fail';
    }

    const rollRecord = {
      id: randomUUID(),
      playerName: member.name,
      formula: parsed.canonical,
      rolls,
      modifier: totalMod,
      total,
      skill: String(skill || '').trim().slice(0, 40),
      dc: numericDc,
      outcome,
      timestamp: Date.now()
    };

    campaign.diceLog.push(rollRecord);
    if (campaign.diceLog.length > 30) {
      campaign.diceLog.splice(0, campaign.diceLog.length - 30);
    }

    let dmResult = null;
    if (narrate && campaign.inCharacter) {
      const skillPart = rollRecord.skill ? ` for ${rollRecord.skill}` : '';
      const dcPart = rollRecord.dc != null ? ` against DC ${rollRecord.dc}` : '';
      const outcomePart = rollRecord.outcome ? ` (${rollRecord.outcome.replace('_', ' ')})` : '';
      const rollAction = `[Dice Roll] ${member.name} rolled ${rollRecord.formula}${extraMod ? ` (${extraMod >= 0 ? '+' : ''}${extraMod})` : ''}${skillPart}${dcPart} -> ${rollRecord.total}${outcomePart}.`;

      if (campaign.timer) {
        clearTimeout(campaign.timer);
        campaign.timer = null;
      }
      campaign.pendingTurns.push({
        sentenceKey: `dice:${rollRecord.id}`,
        speaker: member.name,
        text: rollAction,
        timestamp: rollRecord.timestamp
      });
      dmResult = await this.flushPendingTurns(meetingId);
    }

    return {
      roll: rollRecord,
      dmResult,
      state: this.getPublicState(meetingId)
    };
  }

  /**
   * Flushes buffered turns into a single OpenRouter DM completion call.
   */
  async flushPendingTurns(meetingId) {
    const campaign = this.getOrCreateCampaign(meetingId);
    if (campaign.flushing || campaign.pendingTurns.length === 0) {
      return null;
    }

    campaign.flushing = true;
    const batch = campaign.pendingTurns.splice(0, campaign.pendingTurns.length);
    for (const item of batch) {
      campaign.answeredSentenceKeys.add(item.sentenceKey);
    }

    const combinedText = batch.map((t) => `${t.speaker}: "${t.text}"`).join('\n');
    const primarySpeaker = batch[batch.length - 1].speaker;
    const latestPlayerText = batch[batch.length - 1].text;

    const partySnapshot = Array.from(campaign.party.values())
      .map((p) => `${p.name} (${p.className}, HP ${p.hp}/${p.maxHp}, Gold ${p.gold}, Items: ${p.inventory.join(', ')})`)
      .join('; ');

    const contextHeader = [
      `Current Scene: ${campaign.scene.title} (${campaign.scene.location}) — Mood: ${campaign.scene.mood}`,
      partySnapshot ? `Party: ${partySnapshot}` : '',
      campaign.summary ? `Earlier Story Summary: ${campaign.summary}` : ''
    ].filter(Boolean).join('\n');

    campaign.history.push({
      role: 'user',
      content: `${contextHeader}\n\nParty actions:\n${combinedText}`
    });

    this.#trimHistory(campaign);

    try {
      const rawReply = await this.chatFn(campaign.history);
      const parsed = parseDmResponse(rawReply, campaign.scene);

      campaign.history.push({
        role: 'assistant',
        content: parsed.narration
      });
      this.#trimHistory(campaign);

      campaign.scene = {
        title: parsed.sceneTitle,
        location: parsed.location,
        mood: parsed.mood,
        description: parsed.narration,
        suggestedActions: parsed.suggestedActions,
        suggestedRoll: parsed.suggestedRoll
      };

      this.#applyPartyUpdates(campaign, parsed.partyUpdates);

      const entry = {
        id: randomUUID(),
        type: 'dm',
        speaker: primarySpeaker,
        playerText: combinedText,
        narration: parsed.narration,
        suggestedActions: parsed.suggestedActions,
        suggestedRoll: parsed.suggestedRoll,
        timestamp: Date.now()
      };
      campaign.log.push(entry);
      if (campaign.log.length > this.maxLogEntries) {
        campaign.log.splice(0, campaign.log.length - this.maxLogEntries);
      }

      return {
        meetingId: campaign.meetingId,
        speaker: primarySpeaker,
        playerText: latestPlayerText,
        combinedTurns: batch,
        narration: parsed.narration,
        scene: campaign.scene,
        suggestedActions: parsed.suggestedActions,
        suggestedRoll: parsed.suggestedRoll,
        state: this.getPublicState(meetingId),
        entry
      };
    } catch (err) {
      console.error('[D&D] LLM error:', err.message || err);
      const fallbackNarration = 'The Dungeon Master pauses as arcane static crackles across the realm. Try your action again.';
      const entry = {
        id: randomUUID(),
        type: 'dm',
        speaker: primarySpeaker,
        playerText: combinedText,
        narration: fallbackNarration,
        error: true,
        timestamp: Date.now()
      };
      campaign.log.push(entry);
      return {
        meetingId: campaign.meetingId,
        speaker: primarySpeaker,
        playerText: latestPlayerText,
        combinedTurns: batch,
        narration: fallbackNarration,
        scene: campaign.scene,
        suggestedActions: campaign.scene.suggestedActions,
        suggestedRoll: campaign.scene.suggestedRoll,
        state: this.getPublicState(meetingId),
        entry
      };
    } finally {
      campaign.flushing = false;
    }
  }

  #applyPartyUpdates(campaign, updates) {
    if (!Array.isArray(updates) || updates.length === 0) return;
    for (const upd of updates) {
      if (!upd || !upd.playerName) continue;
      const targetName = String(upd.playerName).trim().toLowerCase();
      let target = null;
      for (const member of campaign.party.values()) {
        if (member.name.toLowerCase() === targetName) {
          target = member;
          break;
        }
      }
      if (!target) continue;

      if (Number.isFinite(Number(upd.hpDelta))) {
        target.hp = Math.max(0, Math.min(target.maxHp, target.hp + Number(upd.hpDelta)));
      }
      if (Number.isFinite(Number(upd.goldDelta))) {
        target.gold = Math.max(0, target.gold + Number(upd.goldDelta));
      }
      if (upd.addItem && typeof upd.addItem === 'string' && upd.addItem.trim()) {
        const item = upd.addItem.trim().slice(0, 50);
        if (!target.inventory.includes(item)) {
          target.inventory.push(item);
        }
      }
      if (upd.removeItem && typeof upd.removeItem === 'string' && upd.removeItem.trim()) {
        const itemLower = upd.removeItem.trim().toLowerCase();
        target.inventory = target.inventory.filter((i) => i.toLowerCase() !== itemLower);
      }
    }
  }

  #trimHistory(campaign) {
    // Keep index 0 (system prompt) + last maxHistoryMessages entries
    const limit = this.maxHistoryMessages + 1;
    if (campaign.history.length <= limit) return;
    const evicted = campaign.history.splice(1, campaign.history.length - limit);
    const snippet = evicted
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content.slice(0, 120))
      .join(' ');
    if (snippet) {
      campaign.summary = `${campaign.summary ? `${campaign.summary} ` : ''}${snippet}`.slice(-800);
    }
  }
}

const defaultManager = new DndCampaignManager();

export function handleTranscript(meetingId, speaker, text, options = {}) {
  return defaultManager.submitPlayerAction(meetingId, { playerName: speaker, text, ...options });
}
