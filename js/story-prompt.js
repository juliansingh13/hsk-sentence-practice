export function storyMessages({ words, length, hskLevel, previousStory, grammar, characterMode }) {
  return [
    { role: 'system', content: 'Write a coherent Mandarin story for a learner. Use every supplied Chinese word correctly; repeat words naturally when possible. Follow the requested HSK level and length, while retaining supplied words even if above that level. Include every requested grammar structure naturally and correctly. When character connection mode is on, also use meaningful individual characters from the supplied words alone where valid or in other common compounds; do not split words mechanically or invent unnatural uses. If a previous story is supplied, create a genuinely different plot, setting, and characters. Return only JSON: {"sentences":[{"zh":"Chinese sentence","en":"English translation"}]}. Keep each Chinese sentence and English translation paired.' },
    { role: 'user', content: JSON.stringify({ words, length, hskLevel, previousStory, grammar, characterMode }) },
  ];
}
