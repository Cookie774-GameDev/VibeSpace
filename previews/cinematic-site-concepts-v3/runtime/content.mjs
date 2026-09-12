const asset = (name) => `./assets/product/${name}.png`;

export const PRICING = Object.freeze({
  access: 20,
  trialDays: 30,
  autoConverts: false,
  note:
    "VibeSpace Access is $20/month after the introductory 30-day access trial. The trial does not auto-convert. Optional AI, voice, and cloud plans are billed separately.",
  plans: Object.freeze([
    { name: "Spark", price: 0, note: "Local + bring your own keys", accent: "#80906f" },
    { name: "Orbit", price: 10, note: "5,500 shared monthly credits", accent: "#d99986" },
    { name: "Nova", price: 50, note: "27,500 shared monthly credits", accent: "#c96f4a", featured: true },
    { name: "Singularity", price: 100, note: "55,000 shared monthly credits", accent: "#aa8da8" },
  ]),
});

export const PRODUCT_BEATS = Object.freeze([
  {
    id: "arrival",
    number: "00",
    eyebrow: "Your work, in one place",
    title: "A workspace that thinks beside you.",
    body:
      "Chat, code, files, schedules, and a crew of focused agents—held together in one calm desktop space.",
    asset: asset("quick-launch"),
    secondary: asset("context-map"),
    detailTitle: "The whole workspace, one shortcut away",
    detailBody:
      "Quick Launch opens tools, projects, schedules, and actions without sending you on a tour of disconnected apps.",
    tags: ["Desktop workspace", "Local-first", "One command surface"],
  },
  {
    id: "jarvis",
    number: "01",
    eyebrow: "Jarvis",
    title: "Begin with a sentence.",
    body:
      "Ask, plan, review, or research in plain language. Jarvis keeps the conversation beside the work it changes.",
    asset: asset("chat"),
    secondary: asset("quick-launch"),
    detailTitle: "Conversation with working context",
    detailBody:
      "A live session keeps edited files, token flow, duration, and agent activity visible instead of hiding the work behind a typing indicator.",
    tags: ["Chat", "Delegation", "Visible activity"],
  },
  {
    id: "agents",
    number: "02",
    eyebrow: "Focused agents",
    title: "One task. The right mind.",
    body:
      "Jarvis coordinates a small team—Coder, Critic, Writer, Researcher, Memory Keeper—each with a legible job.",
    asset: asset("agents"),
    secondary: asset("context-map"),
    detailTitle: "A team you can inspect",
    detailBody:
      "Choose a focused agent, see its instructions and tools, and keep responsibility clear as work moves between specialties.",
    tags: ["Jarvis", "Coder", "Critic", "Researcher"],
  },
  {
    id: "schedule",
    number: "03",
    eyebrow: "Plans that happen",
    title: "Say when. It schedules itself.",
    body:
      "Tell Jarvis what should happen and when. Natural language becomes editable events, reminders, and timed actions.",
    asset: asset("scheduler"),
    secondary: asset("kanban"),
    detailTitle: "A plan you can still edit",
    detailBody:
      "Scheduling stays local, visible, and reversible before save. Kanban keeps the milestones and live work beside it.",
    tags: ["Scheduler", "Timed actions", "Kanban"],
  },
  {
    id: "workspace",
    number: "04",
    eyebrow: "Work without the shuffle",
    title: "Every working surface stays in reach.",
    body:
      "Move from a file to a terminal to a milestone without rebuilding context in another tab or handing your work away.",
    asset: asset("files"),
    secondary: asset("terminal"),
    detailTitle: "Files, terminal, and projects share the room",
    detailBody:
      "The file workspace and multi-pane terminal stay attached to the same project, so an agent can help without erasing where the work lives.",
    tags: ["Files", "Terminal", "Projects"],
  },
  {
    id: "skills",
    number: "05",
    eyebrow: "Skills and tools",
    title: "Teach the workspace your way.",
    body:
      "Save repeatable ways of analyzing, building, creating, and operating. Author actions once; call them from chat when needed.",
    asset: asset("skills"),
    secondary: asset("tools"),
    detailTitle: "Reusable judgment, not another prompt folder",
    detailBody:
      "Skills shape how work is approached. Custom tools bind safe actions into repeatable workflows you can inspect and revise.",
    tags: ["Skills", "Custom tools", "Workflows"],
  },
  {
    id: "trust",
    number: "06",
    eyebrow: "Local-first control",
    title: "Your context stays yours.",
    body:
      "Projects, files, preferences, and personal knowledge form a context map under your control—not a mystery memory somewhere else.",
    asset: asset("context-map"),
    secondary: asset("terminal"),
    detailTitle: "Context with an address",
    detailBody:
      "See the sources connected to a project, choose what enters the map, and keep local tools local until you decide otherwise.",
    tags: ["Context map", "Project scope", "User control"],
  },
  {
    id: "access",
    number: "07",
    eyebrow: "VibeSpace Access",
    title: "Make room for your best work.",
    body:
      "The full desktop workspace begins with a 30-day access trial. Continue only when you deliberately choose to.",
    asset: asset("kanban"),
    secondary: asset("chat"),
    detailTitle: "Simple access, optional cloud",
    detailBody: PRICING.note,
    tags: ["30-day trial", "$20 access", "Optional cloud plans"],
  },
]);

const composeBeats = (overrides) =>
  Object.freeze(
    PRODUCT_BEATS.map((beat, index) =>
      Object.freeze({
        ...beat,
        ...overrides[index],
      }),
    ),
  );

export const CONCEPTS = Object.freeze([
  Object.freeze({
    id: "quiet-ascent",
    number: "01",
    name: "The Quiet Ascent",
    shortName: "Ascent",
    kicker: "A journey from scattered work to a clear view",
    description:
      "Real VibeSpace surfaces become waystations through one continuous watercolor mountain valley.",
    grammar: "forward mountain pilgrimage",
    motion:
      "A continuous forward camera, rising trail, depth-flying product windows, moving sun, and a summit convergence.",
    loaderLabel: "Drawing the path",
    soundLabel: "Valley score",
    arc: ["Stillness", "First step", "Companionship", "Momentum", "Clarity", "Summit"],
    beats: composeBeats([
      { sceneLabel: "Trailhead", align: "center", altitude: 0.08 },
      { sceneLabel: "First light", align: "left", altitude: 0.18 },
      { sceneLabel: "The ridge", align: "right", altitude: 0.31 },
      { sceneLabel: "River crossing", align: "left", altitude: 0.45 },
      { sceneLabel: "The overlook", align: "right", altitude: 0.58 },
      { sceneLabel: "The observatory", align: "left", altitude: 0.7 },
      { sceneLabel: "Above the cloudline", align: "right", altitude: 0.82 },
      { sceneLabel: "The summit", align: "center", altitude: 1 },
    ]),
  }),
  Object.freeze({
    id: "living-desk",
    number: "02",
    name: "The Living Desk",
    shortName: "Desk",
    kicker: "The workspace grows out of the work",
    description:
      "A notebook opens at dawn; real VibeSpace windows unfold as paper, vellum, cards, and one complete folio.",
    grammar: "macro paper theatre",
    motion:
      "Macro-to-overhead camera travel, paper hinges, stacked UI sheets, moving lamp light, and a final folio assembly.",
    loaderLabel: "Opening the folio",
    soundLabel: "Paper score",
    arc: ["Blank page", "First thought", "Structure", "Craft", "Body of work", "Home"],
    beats: composeBeats([
      { sceneLabel: "The blank page", align: "center", paper: "folio" },
      { sceneLabel: "The first line", align: "right", paper: "notebook" },
      { sceneLabel: "The index", align: "left", paper: "cards" },
      { sceneLabel: "The calendar leaf", align: "right", paper: "vellum" },
      { sceneLabel: "The working stack", align: "left", paper: "ledger" },
      { sceneLabel: "The method book", align: "right", paper: "tabs" },
      { sceneLabel: "The archive", align: "left", paper: "map" },
      { sceneLabel: "The finished folio", align: "center", paper: "cover" },
    ]),
  }),
  Object.freeze({
    id: "garden-of-work",
    number: "03",
    name: "The Garden of Work",
    shortName: "Garden",
    kicker: "A living system of intent, rhythm, and focused minds",
    description:
      "One seed of intent becomes a branching ecosystem of agents, plans, skills, tools, and connected work.",
    grammar: "botanical growth system",
    motion:
      "A continuously growing branch, proximity-bending stems, agent buds, a moving sun, and an overhead bloom finale.",
    loaderLabel: "Growing the first root",
    soundLabel: "Garden score",
    arc: ["Seed", "Root", "Growth", "Rhythm", "Bloom", "Belonging"],
    beats: composeBeats([
      { sceneLabel: "Seed of intent", align: "center", growth: 0.06 },
      { sceneLabel: "The first root", align: "left", growth: 0.19 },
      { sceneLabel: "A crown of minds", align: "right", growth: 0.34 },
      { sceneLabel: "The sun keeps time", align: "left", growth: 0.48 },
      { sceneLabel: "Branches meet", align: "right", growth: 0.63 },
      { sceneLabel: "Methods flower", align: "left", growth: 0.76 },
      { sceneLabel: "The garden remembers", align: "right", growth: 0.88 },
      { sceneLabel: "One living workspace", align: "center", growth: 1 },
    ]),
  }),
]);

export function getConcept(id) {
  const concept = CONCEPTS.find((candidate) => candidate.id === id);
  if (!concept) {
    throw new Error(`Unknown VibeSpace cinematic concept: ${id}`);
  }
  return concept;
}
