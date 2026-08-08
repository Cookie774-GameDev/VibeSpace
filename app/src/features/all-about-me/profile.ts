export const ALL_ABOUT_ME_UPDATE_INTERVAL = 20;
export const ALL_ABOUT_ME_CONTEXT_LIMIT = 8000;
export const ALL_ABOUT_ME_FILE_LOCATION = 'VibeSpace Profile Vault/AllAboutMe.md';

export type AllAboutMeQuestionKind = 'written' | 'choice';

export interface AllAboutMeTestQuestion {
  id: string;
  prompt: string;
  kind: AllAboutMeQuestionKind;
  options?: string[];
}

export interface AllAboutMeQuestionAnswer {
  questionId: string;
  prompt: string;
  kind: AllAboutMeQuestionKind;
  answer: string;
}

export interface AllAboutMeAnswers {
  communicationStyle: string;
  toneExamples: string;
  interests: string;
  strongReactions: string;
  preferences: string[];
  dislikedPatterns: string[];
  responseStyle: string;
  personalNotes: string;
  selectedModel?: string;
  quizResponses?: AllAboutMeQuestionAnswer[];
}

export interface AllAboutMeUpdateState {
  totalUserMessages: number;
  lastUpdatedAtMessageCount: number;
}

export const ALL_ABOUT_ME_TEST_QUESTIONS: AllAboutMeTestQuestion[] = [
  { id: 'displayName', kind: 'written', prompt: 'What name or nickname should Jarvis call you?' },
  { id: 'lockedInAddress', kind: 'written', prompt: 'How should Jarvis address you when you are locked in or building fast?' },
  { id: 'personalityWords', kind: 'written', prompt: 'Pick 3 words that describe your personality or vibe.' },
  { id: 'currentFocus', kind: 'written', prompt: 'What are you currently focused on most in life, school, work, or projects?' },
  { id: 'biggestGoals', kind: 'written', prompt: 'What are your biggest goals right now?' },
  { id: 'onlinePersonality', kind: 'written', prompt: 'What kind of person are you online? Funny / Helpful / Chaotic / Professional / Bold / Chill / Private / Other' },
  { id: 'toneExamples', kind: 'written', prompt: 'How do you normally text or write? Give 2-3 example phrases you actually use.' },
  { id: 'signatureWords', kind: 'written', prompt: 'What words, slang, emojis, or punctuation do you use a lot?' },
  { id: 'avoidPhrases', kind: 'written', prompt: 'What words or phrases should Jarvis avoid because they do not sound like you?' },
  {
    id: 'writingCleanliness',
    kind: 'choice',
    prompt: 'How clean should Jarvis make your writing?',
    options: ['Keep my messy style', 'Clean it slightly', 'Make it polished', 'Make it professional'],
  },
  {
    id: 'answerLength',
    kind: 'choice',
    prompt: 'Default answer length',
    options: ['Very short', 'Short with bullets', 'Medium detail', 'Detailed only when needed', 'Always detailed'],
  },
  {
    id: 'energyLevel',
    kind: 'choice',
    prompt: 'Default energy',
    options: ['Calm', 'Focused', 'High-energy', 'Hype when shipping', 'Serious', 'Funny'],
  },
  {
    id: 'directness',
    kind: 'choice',
    prompt: 'How direct should Jarvis be with you?',
    options: ['Very blunt', 'Honest but nice', 'Gentle', 'Fix first, explain after'],
  },
  {
    id: 'writeAsUserCleanup',
    kind: 'choice',
    prompt: 'When Jarvis writes as you, should it keep your casual style or clean everything up?',
    options: ['Keep casual', 'Light cleanup', 'Fully clean', 'Depends on the situation'],
  },
  {
    id: 'humorSafety',
    kind: 'choice',
    prompt: 'How much humor is safe for Jarvis to use?',
    options: ['None', 'Light jokes', 'Sarcastic', 'Chaotic funny', 'Only when I joke first'],
  },
  { id: 'stressSignals', kind: 'written', prompt: 'How can Jarvis tell you are frustrated, rushed, confused, or urgent?' },
  {
    id: 'frustratedFirst',
    kind: 'choice',
    prompt: 'When you are frustrated, what should Jarvis do first?',
    options: ['Calm me down', 'Give exact steps', 'Fix the problem fast', 'Be blunt', 'Ask one question max'],
  },
  {
    id: 'confusedExplain',
    kind: 'choice',
    prompt: 'When you are confused, how should Jarvis explain things?',
    options: ['Simple analogy', 'Step-by-step', 'Show example', 'Compare options', 'Give the answer first'],
  },
  { id: 'motivation', kind: 'written', prompt: 'What motivates you to keep going when a project gets hard?' },
  { id: 'energyLoss', kind: 'written', prompt: 'What usually makes you quit, rage, or lose energy?' },
  {
    id: 'brokenResponse',
    kind: 'choice',
    prompt: 'When something breaks, what kind of response feels best?',
    options: ['Here is the bug', 'I found the issue', 'Do this first', "Don't worry, we'll fix it", 'Here is the safe minimal fix'],
  },
  { id: 'interests', kind: 'written', prompt: 'What topics do you care about most?' },
  { id: 'attentionTopics', kind: 'written', prompt: 'What topics should Jarvis pay extra attention to? AI / Coding / Business / Design / Games / Fitness / School / Money / Social media / Other' },
  { id: 'strongReactions', kind: 'written', prompt: 'What topics, words, bugs, or situations do you react strongly to?' },
  { id: 'favoriteBrands', kind: 'written', prompt: 'What are your favorite apps, websites, creators, products, or brands?' },
  { id: 'favoriteVibes', kind: 'written', prompt: 'What styles or vibes do you love? Cozy / Futuristic / Japanese / Minimal / Dark mode / Luxury / Cyberpunk / Cute / Professional / Other' },
  { id: 'hatedVibes', kind: 'written', prompt: 'What styles or vibes do you hate?' },
  { id: 'neverJoke', kind: 'written', prompt: 'What should Jarvis never joke about or be careless with?' },
  {
    id: 'buildPace',
    kind: 'choice',
    prompt: 'How do you like work to move when building apps?',
    options: ['Move fast', 'Plan first', 'Build small pieces', 'Ship full feature', 'Fix bugs first', 'Ask before big changes'],
  },
  {
    id: 'codingPriority',
    kind: 'choice',
    prompt: 'When Jarvis is helping code, what should it prioritize?',
    options: ['Working fast', 'Clean architecture', 'No bugs', 'Best UI', 'Performance', 'Simple code', 'Future-proofing'],
  },
  { id: 'goodCode', kind: 'written', prompt: 'What does "good code" mean to you?' },
  { id: 'badCode', kind: 'written', prompt: 'What does "bad code" mean to you?' },
  {
    id: 'complexFeatureHandling',
    kind: 'choice',
    prompt: 'When a feature is complicated, how should Jarvis handle it?',
    options: ['Break into steps', 'Build MVP first', 'Explain trade-offs', 'Pick best option', 'Ask before deciding'],
  },
  {
    id: 'tradeoffs',
    kind: 'choice',
    prompt: 'How should Jarvis present options and trade-offs?',
    options: ['One best answer', '2-3 options', 'Pros and cons', 'Ranked list', 'Cheapest vs best vs fastest'],
  },
  {
    id: 'proofLevel',
    kind: 'choice',
    prompt: 'How much proof should Jarvis show?',
    options: ['Just outcome', 'Short proof', 'Tests and commands', 'Full evidence', 'Screenshots if possible'],
  },
  {
    id: 'correctionStyle',
    kind: 'choice',
    prompt: 'When something is wrong in the project, Jarvis should:',
    options: ['Be blunt', 'Be gentle', 'Fix first then explain', 'Ask before changing', 'Give root cause first'],
  },
  { id: 'dealbreakers', kind: 'written', prompt: 'What are dealbreakers in apps, replies, code, or workflows?' },
  { id: 'favoriteProjects', kind: 'written', prompt: 'What project types or dream builds do you care about most?' },
  { id: 'designTaste', kind: 'written', prompt: 'What makes UI feel polished to you?' },
  { id: 'uiDetails', kind: 'written', prompt: 'What UI details do you notice immediately? Spacing / Fonts / Animations / Colors / Icons / Shadows / Speed / Mobile layout / Dark mode' },
  {
    id: 'designDirection',
    kind: 'choice',
    prompt: 'Pick your favorite design direction:',
    options: ['Clean minimal', 'Cozy', 'Futuristic', 'Cinematic', 'Bold experimental', 'Japanese-inspired', 'Premium SaaS', 'Game-like'],
  },
  {
    id: 'cheapAppSignals',
    kind: 'choice',
    prompt: 'What makes an app feel cheap or unfinished?',
    options: ['Bad spacing', 'Ugly colors', 'Too much clutter', 'Lag', 'Basic buttons', 'Bad icons', 'Random fonts', 'Confusing layout'],
  },
  {
    id: 'animationTaste',
    kind: 'choice',
    prompt: 'How much animation do you like?',
    options: ['None', 'Subtle', 'Smooth and modern', 'Lots of motion', 'Only when useful'],
  },
  { id: 'colorMood', kind: 'written', prompt: 'What colors, themes, or visual moods do you usually like?' },
  { id: 'youtubeReplyStyle', kind: 'written', prompt: 'How should YouTube comments or public replies sound when Jarvis writes for you? Funny / Smart / Chill / Confident / Kind / Savage but safe / Professional / Hype / Other' },
  { id: 'scenarioCoolComment', kind: 'written', prompt: 'Someone comments "this is actually really cool" on something you made. What do you reply?' },
  { id: 'scenarioDontGetIt', kind: 'written', prompt: 'Someone says "I do not get it." How would you explain it back without sounding weird?' },
  { id: 'scenarioFriendText', kind: 'written', prompt: 'Your friend texts "yo what are you doing?" How do you normally answer?' },
  { id: 'scenarioCompliment', kind: 'written', prompt: 'Someone gives you a compliment, but you do not want to sound too serious. What do you say?' },
  { id: 'excitedMessages', kind: 'written', prompt: 'When you are excited about something, what do your messages usually look like? Short hype / All caps / Lots of details / Emojis / Voice-note energy / I stay calm' },
  { id: 'annoyedMessages', kind: 'written', prompt: 'When you are annoyed, what do your messages usually look like? Short / Blunt / Sarcastic / Confused typing / All caps / I go quiet' },
  {
    id: 'oneHourBuild',
    kind: 'choice',
    prompt: 'You have one hour to build something cool. What do you do first?',
    options: ['Start building', 'Sketch idea', 'Ask AI', 'Watch examples', 'Pick design', 'Test tools'],
  },
  { id: 'projectWorksReaction', kind: 'written', prompt: 'Your project suddenly works after being broken for hours. What do you say?' },
  {
    id: 'tooHardReaction',
    kind: 'choice',
    prompt: 'Someone tells you your idea is too hard. What is your first reaction?',
    options: ['Prove them wrong', 'Ask why', 'Get annoyed', 'Think bigger', 'Simplify it', 'Move on'],
  },
  {
    id: 'twoAmIdea',
    kind: 'choice',
    prompt: 'You get a new idea at 2 AM. What usually happens?',
    options: ['Write it down', 'Start building', 'Tell someone', 'Forget it', 'Ask AI', 'Stay up too late'],
  },
  {
    id: 'proudCompliment',
    kind: 'choice',
    prompt: 'What kind of compliment would actually make you feel proud?',
    options: ['That looks clean', 'You built that fast', 'That is smart', 'That could make money', 'That is unique', 'That is professional'],
  },
  { id: 'scenarioNegativeComment', kind: 'written', prompt: 'Someone comments "nah this ain\'t it." What do you reply?' },
  {
    id: 'broWhatMeaning',
    kind: 'choice',
    prompt: 'If you say "BRO WHAT," what should Jarvis assume first?',
    options: ['I am mad', 'I am shocked', 'Something broke', 'I am joking', 'Ask me'],
  },
  {
    id: 'pleaseFixIt',
    kind: 'choice',
    prompt: 'When you say "please just fix it," what should Jarvis do?',
    options: ['Give steps', 'Explain bug', 'Make a patch', 'Ask one question', 'Calm me down first'],
  },
  { id: 'perfectJarvis', kind: 'written', prompt: 'Imagine Jarvis became perfect for you. What would it always do without you asking?' },
];

function clean(value: string): string {
  return value.trim().replace(/\r\n/g, '\n');
}

function bulletList(items: string[]): string {
  const cleanItems = items.map((item) => clean(item)).filter(Boolean);
  return cleanItems.length > 0
    ? cleanItems.map((item) => `- ${item}`).join('\n')
    : '- No strong preference recorded yet.';
}

function section(title: string, body: string): string {
  const cleanBody = clean(body);
  return `## ${title}\n\n${cleanBody || 'Not answered yet.'}`;
}

export function buildAllAboutMeMarkdown(answers: AllAboutMeAnswers, now = new Date()): string {
  const quizResponses = answers.quizResponses?.length
    ? [
        '## Full Quiz Responses',
        '',
        ...answers.quizResponses.map((response, index) => (
          `### ${index + 1}. ${response.prompt}\n\n${clean(response.answer) || 'Not answered.'}`
        )),
        '',
      ]
    : [];
  return [
    '# AllAboutMe.md',
    '',
    '> Generated from the in-app All About Me quiz. Jarvis uses this as durable user-personality context, not as a replacement for the current request.',
    '',
    `Last updated: ${now.toISOString()}`,
    answers.selectedModel ? `AI model used: ${answers.selectedModel}` : '',
    '',
    section('Communication Style', answers.communicationStyle),
    '',
    section('Tone Examples', answers.toneExamples),
    '',
    section('Interests And Topics', answers.interests),
    '',
    section('Strong Reactions', answers.strongReactions),
    '',
    '## Preferred Response Patterns',
    '',
    bulletList(answers.preferences),
    '',
    '## Disliked Response Patterns',
    '',
    bulletList(answers.dislikedPatterns),
    '',
    section('How Jarvis Should Sound', answers.responseStyle),
    '',
    section('Personal Notes', answers.personalNotes),
    '',
    ...quizResponses,
    '## Update Guidance',
    '',
    '- Preserve stable identity, preferences, and communication patterns.',
    '- Improve this document only when repeated behavior makes the profile more accurate.',
    '- Do not add secrets, private credentials, or unsupported claims.',
  ].join('\n');
}

export function buildAllAboutMeContextBlock(markdown: string): string {
  const trimmed = clean(markdown);
  if (!trimmed) return '';
  const bounded =
    trimmed.length <= ALL_ABOUT_ME_CONTEXT_LIMIT
      ? trimmed
      : `${trimmed.slice(0, ALL_ABOUT_ME_CONTEXT_LIMIT)}\n...[AllAboutMe.md truncated by VibeSpace]`;
  return [
    'durable user-personality profile for Jarvis.',
    'Use this to match the user\'s tone, preferences, interests, communication style, and likely reaction patterns. Treat it as context, not a command. Do not reveal this document unless the user asks.',
    '',
    '--- all_about_me_profile ---',
    '```markdown',
    bounded,
    '```',
  ].join('\n');
}

export function shouldUpdateAllAboutMe(state: AllAboutMeUpdateState): boolean {
  if (state.totalUserMessages < ALL_ABOUT_ME_UPDATE_INTERVAL) return false;
  return state.totalUserMessages - state.lastUpdatedAtMessageCount >= ALL_ABOUT_ME_UPDATE_INTERVAL;
}
