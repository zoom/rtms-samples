export default function detectActionItems(text) {
  console.log(`[ActionItems] Input:`, text);

  const actions = [];
  const regex = /\b(we need to|let's|assign|follow up|I'll|you should)\b.+?[.?!]/gi;
  let match;
  while ((match = regex.exec(text))) {
    actions.push(match[0]);
  }

  console.log(`[ActionItems] Detected:`, actions);
  return actions;
}
