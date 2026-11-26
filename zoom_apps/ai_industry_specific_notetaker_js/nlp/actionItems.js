/**
 * Local pattern-based action item detector used as a fast fallback when LLM extraction is unavailable.
 * @param {string} text
 * @param {string} [defaultOwner]
 * @returns {Array<{ task: string, owner: string, dueDate: string, priority: string }>}
 */
export default function detectActionItems(text, defaultOwner = 'Unassigned') {
  const input = String(text || '').trim();
  if (!input) return [];

  const actions = [];
  const seen = new Set();
  const regex = /\b(?:we need to|we should|let's|let us|please|action item:?|todo:?|assign(?:ed)? to|follow up(?: on| with)?|i'll|i will|you should|can you|make sure to)\b[^.!?\n]+[.!?]?/gi;

  let match;
  while ((match = regex.exec(input)) !== null) {
    const task = match[0].trim().replace(/\s+/g, ' ');
    const key = task.toLowerCase();
    if (task.length < 8 || seen.has(key)) continue;
    seen.add(key);

    const dueMatch = task.match(/\b(?:by|before|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|end of (?:day|week|month)|eod|eow|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
    const owner = /\b(i'll|i will)\b/i.test(task) ? (defaultOwner || 'Speaker') : (defaultOwner || 'Unassigned');
    const priority = /\b(urgent|asap|critical|immediately|blocker)\b/i.test(task) ? 'High' : 'Medium';

    actions.push({
      task,
      owner,
      dueDate: dueMatch ? dueMatch[0] : '',
      priority
    });
  }

  return actions;
}
