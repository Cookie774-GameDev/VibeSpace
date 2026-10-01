export const CONCEPT_ORDER = ['aperture', 'desk', 'cosmos', 'foundry', 'archive'];

export const CONCEPTS = Object.freeze({
  aperture: Object.freeze({
    id: 'aperture',
    number: '01',
    name: 'Aperture OS',
    file: 'aperture.html',
    thesis: 'The workspace is not another window. It is the architecture around every window.',
    signature: 'A copper aperture that turns flat product windows into inhabitable rooms.',
    type: 'Monumental grotesk / surgical mono',
    materials: 'Obsidian glass, smoked titanium, warm emissive copper',
    palette: ['#050505', '#17130f', '#f0e7d8', '#e57a42', '#7fd8d0'],
    scenes: Object.freeze([
      Object.freeze({
        phase: 'Awakening',
        kicker: 'A workspace wakes up',
        title: 'Stop working between worlds.',
        body: 'VibeSpace opens one living layer across chats, files, models, terminals, and the next thing you need.',
      }),
      Object.freeze({
        phase: 'Orchestration',
        kicker: 'Everything has a place',
        title: 'Your tools become one room.',
        body: 'Speak to Jarvis. Bring in agents. Open ten terminals. The context stays in the architecture.',
      }),
      Object.freeze({
        phase: 'Release',
        kicker: 'The way forward',
        title: 'Think. Build. Keep moving.',
        body: 'A local-first workspace for the messy middle between the idea and the shipped thing.',
      }),
    ]),
  }),
  desk: Object.freeze({
    id: 'desk',
    number: '02',
    name: 'Infinite Desk',
    file: 'infinite-desk.html',
    thesis: 'Every part of the build lives on one impossible, tactile workstation.',
    signature: 'A continuous camera glide across a desk whose instruments unfold into VibeSpace features.',
    type: 'Condensed editorial sans / instrument mono',
    materials: 'Anodized metal, smoked acrylic, paper, amber task lights',
    palette: ['#0a0b0b', '#25211c', '#f3ead9', '#ffb45e', '#9db6ff'],
    scenes: Object.freeze([
      Object.freeze({
        phase: 'Awakening',
        kicker: 'Clear the surface',
        title: 'One desk. Every mode of thought.',
        body: 'The scattered tabs disappear. Your active project settles into one physical, understandable place.',
      }),
      Object.freeze({
        phase: 'Orchestration',
        kicker: 'Reach, do not switch',
        title: 'Voice, agents, terminals—within arm’s reach.',
        body: 'Tools arrive as instruments around the work instead of pulling you into another application.',
      }),
      Object.freeze({
        phase: 'Release',
        kicker: 'Leave with the work',
        title: 'The desk ends where shipping begins.',
        body: 'Context, decisions, and artifacts stay together when the build leaves the workspace.',
      }),
    ]),
  }),
  cosmos: Object.freeze({
    id: 'cosmos',
    number: '03',
    name: 'Context Cosmos',
    file: 'context-cosmos.html',
    thesis: 'Work becomes a navigable universe instead of a pile of disconnected history.',
    signature: 'Constellations resolve into crisp VibeSpace interfaces when the camera crosses their orbit.',
    type: 'Wide humanist display / coordinate mono',
    materials: 'Deep-space ink, spectral dust, luminous data glass',
    palette: ['#02040a', '#10162b', '#f1f5ff', '#7c91ff', '#ff8b68'],
    scenes: Object.freeze([
      Object.freeze({
        phase: 'Awakening',
        kicker: 'Your work has gravity',
        title: 'Nothing important should disappear.',
        body: 'Chats, files, calls, tasks, and decisions find each other in one project-aware universe.',
      }),
      Object.freeze({
        phase: 'Orchestration',
        kicker: 'Dive into the signal',
        title: 'Context becomes somewhere you can go.',
        body: 'Move from the whole project to the exact message, terminal, agent, or source that matters now.',
      }),
      Object.freeze({
        phase: 'Release',
        kicker: 'Carry the constellation',
        title: 'Every next move remembers the last.',
        body: 'Jarvis and your agents act with the history you approved, without losing the shape of the work.',
      }),
    ]),
  }),
  foundry: Object.freeze({
    id: 'foundry',
    number: '04',
    name: 'Agent Foundry',
    file: 'agent-foundry.html',
    thesis: 'Intent enters once; coordinated intelligence turns it into visible, reviewable work.',
    signature: 'A cinematic production line where agent cores transform an idea into a finished artifact.',
    type: 'Industrial neo-grotesk / stamped utility mono',
    materials: 'Black steel, furnace glass, ceramic white, safety orange',
    palette: ['#090806', '#241d17', '#f5eee3', '#ff5d2e', '#f4c96b'],
    scenes: Object.freeze([
      Object.freeze({
        phase: 'Awakening',
        kicker: 'Feed the intention',
        title: 'Say what should exist.',
        body: 'Start with a voice note, a prompt, a file, or a rough plan. VibeSpace keeps the source attached.',
      }),
      Object.freeze({
        phase: 'Orchestration',
        kicker: 'Watch the line',
        title: 'Agents build. Terminals prove. You approve.',
        body: 'Every handoff, command, context source, and result remains visible while the system works.',
      }),
      Object.freeze({
        phase: 'Release',
        kicker: 'Inspect the artifact',
        title: 'No black box at the end.',
        body: 'Review what changed, keep the evidence, and release the exact work you trust.',
      }),
    ]),
  }),
  archive: Object.freeze({
    id: 'archive',
    number: '05',
    name: 'Living Archive',
    file: 'living-archive.html',
    thesis: 'Context should grow around the work, quietly, until the exact memory is needed.',
    signature: 'Bioluminescent memory fibers bloom into tools and curl back into a living project archive.',
    type: 'Organic display serif / quiet technical sans',
    materials: 'Carbon soil, translucent fibers, mineral light, vellum',
    palette: ['#030706', '#102019', '#e9f1e6', '#81d7a2', '#df9b68'],
    scenes: Object.freeze([
      Object.freeze({
        phase: 'Awakening',
        kicker: 'A memory takes root',
        title: 'Your work is already connected.',
        body: 'VibeSpace notices the relationships between conversations, files, tasks, models, and moments.',
      }),
      Object.freeze({
        phase: 'Orchestration',
        kicker: 'Recall becomes action',
        title: 'The right context blooms on demand.',
        body: 'Jarvis, agents, and tools receive only the project knowledge and permissions you choose.',
      }),
      Object.freeze({
        phase: 'Release',
        kicker: 'Growth without clutter',
        title: 'Keep the memory. Lose the mess.',
        body: 'The archive becomes calmer as the project grows—ready for the next build, not buried by the last.',
      }),
    ]),
  }),
});

export function getConcept(id) {
  return CONCEPTS[id] || CONCEPTS.aperture;
}
