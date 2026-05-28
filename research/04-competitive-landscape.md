# Competitive Landscape Report: Multi-AI / Multi-Agent Chat Apps (2026)

*Research compiled by subagent #4 for the Jarvis differentiation initiative.*

---

## Executive Summary

The 2026 multi-AI/multi-agent landscape is fragmented across three distinct tiers, none of which has cracked the unified-experience problem. Tier 1 (multi-model chat aggregators) commoditizes access to GPT-5/Claude/Gemini but treats each conversation as a disposable artifact. Tier 2 (agentic workspaces) is dominated by coding agents that don't generalize to knowledge work. Tier 3 (voice-first assistants) captures speech beautifully but lives in its own silo. The white space is enormous: no competitor convincingly combines parallel multi-model chat, autonomous agents, voice/meeting capture, persistent cross-context memory, and native cross-app integration in one product. Jarvis has the opportunity to be the first true "AI workspace" rather than an aggregator, an IDE, or a notetaker.

---

## TIER 1 - Multi-Model Chat Aggregators

### Poe by Quora (poe.com)

**What it is:** Quora's flagship multi-model chat platform. The original "all the chatbots in one place" product, launched 2023, still the category leader by user count.

**Providers:** GPT-5/5.5, Claude Opus/Sonnet/Haiku 4.x, Gemini 3/3.1 Pro, Llama, Mistral, DeepSeek, xAI Grok, plus thousands of community-built bots and image/video models (Sora 2, Nano Banana, FLUX).

**Key features:** Bot creator with system prompts, server bots via API, points-based usage metering, mobile and web apps, "Channels" for multi-bot conversations, file uploads.

**UI:** Clean, ChatGPT-inspired list-of-bots sidebar. Creator marketplace front-and-center. Mobile app is polished and fast.

**Pricing:** Free tier with limited points; Poe Premium $19.99/mo or $199.99/yr, Premium+ tiers up to ~$249.99/mo for heavy compute users. Points system means costs are unpredictable.

**Platforms:** Web, iOS, Android, macOS, Windows.

**Strengths:** Massive bot marketplace, brand trust (Quora), reliable uptime, points system simplifies billing across providers.

**Weaknesses:** Points pricing is opaque and frustrating. No agentic capabilities - pure chat. No deep web/file integration. Bot creator is shallow (no real tool use). Memory is per-thread only. No MCP support. No team workspace.

**Missing:** True agents, voice, meeting capture, BYOK, cross-thread memory, deep document workflows, local model support.

---

### Msty (msty.app)

**What it is:** A privacy-first desktop AI workspace from CloudStack LLC, repositioned in 2026 into a product family: Msty Studio (chat workspace), Msty Claw (autonomous agent), Msty Stack (private inference), and Msty Law (legal vertical).

**Providers:** Local via Ollama and LM Studio backends, plus cloud (OpenAI, Anthropic, Google, OpenRouter). Heavy emphasis on side-by-side local + cloud.

**Key features:** Knowledge Stacks (RAG), parallel chats with multiple models, prompt workflows, personas, automations, sandboxed agent (Claw) with folder-scoped tool execution, calculators (VRAM, model cost, context).

**UI:** "Studio" metaphor - modular panels, dark-first, slick desktop app. Less polished on mobile (none, really).

**Pricing:** Studio has free tier and paid plans (separate page); Claw is in Beta.

**Platforms:** Windows, macOS, Linux desktop only.

**Strengths:** Privacy-first positioning is genuine. Local + cloud parity. Tooling like the VRAM and cost calculators show technical depth. Vertical strategy (Msty Law) is interesting.

**Weaknesses:** Desktop-only. No mobile/iOS. Steeper learning curve than Poe/ChatHub. No voice. Smaller community than Open WebUI.

**Missing:** Mobile, voice, meeting capture, broad MCP marketplace.

---

### ChatHub (chathub.gg)

**What it is:** "Use GPT-5, Claude 4.5, Gemini 3 side by side." 300K+ users, started as a Chrome extension, expanded into web/desktop/mobile.

**Providers:** GPT-5, Claude 4.5, Gemini 3, Llama 3.3, Grok, DeepSeek, plus 20+ models. Image: Nano Banana, FLUX.2, Stable Diffusion.

**Key features:** Side-by-side response comparison (the original headline use case), one-subscription-all-models, image generation, file upload, web search, code preview, prompt library.

**Pricing:** ChatHub Pro $19/mo, ChatHub Unlimited $39/mo.

**Platforms:** Web, iOS, Android, Windows, macOS, Chrome extension.

**Strengths:** Cleanest side-by-side comparison UX in the category. Cross-platform. One flat subscription. Browser extension reach.

**Weaknesses:** Pure chat - zero agent capability. Shallow file analysis. No memory across chats. No MCP. No voice. Hallucination-resistance pitch is the main story; everything else is table stakes.

**Missing:** Agents, deep automation, persistent memory, voice, meeting capture.

---

### TypingMind (typingmind.com)

**What it is:** "The AI client you actually own." BYOK desktop/web app with lifetime license model. 20,641+ paying customers.

**Providers:** OpenAI, Anthropic, Google Gemini, Mistral, Meta, DeepSeek, Replit, Qwen, Groq, OpenRouter - basically any OpenAI-compatible endpoint.

**Key features:** Multi-model parallel chats, MCP support (notable), Artifacts, Project Folders with knowledge bases, Canvas editor, prompt caching, RAG, plugin system (50+ plugins), AI Agent builder with prompt chaining, Deep Research plugin, voice (TTS/STT including ElevenLabs, OpenAI, Whisper), 50+ pre-built agents.

**Pricing:** One-time lifetime license (50% off promo, 14-day refund). Pay only your own API costs. This is a huge differentiator.

**Platforms:** Web, desktop (Mac/Win), no native mobile.

**Strengths:** No subscription. BYOK only. Local data storage. Encrypted API keys. The most feature-dense product in Tier 1. Real plugin ecosystem. MCP support already shipped. Trusted by Devon Energy, Seattle U, Storytel, etc.

**Weaknesses:** Setup friction (users must wire up API keys for each provider). Not great for non-technical users. No native mobile app. Cloud sync is opt-in/awkward. Plugin quality varies.

**Missing:** True autonomous agents (chains are linear), live voice conversation mode, native mobile, real meeting integration, multi-user/team mode is limited.

---

### Open WebUI (formerly Ollama WebUI)

**What it is:** Open-source self-hosted AI interface. 414K+ community members, 290M+ downloads, 139K GitHub stars. A category in itself.

**Providers:** Ollama (local) plus any OpenAI-compatible endpoint, including Anthropic, OpenAI direct, etc.

**Key features:** Self-hosted, Python function/tool extensions, RBAC and SSO for enterprise, prompts/models/tools/functions community marketplace, voice/vision/RAG/search built in, full enterprise mode with audit logs.

**Pricing:** Free open-source; enterprise tier with SLA.

**Platforms:** Self-hosted via Docker/pip on Linux/Mac/Win servers; users access via browser.

**Strengths:** True self-hosted ownership. Massive open-source community. Enterprise-ready (SOC, RBAC, audit logs). Marketplace of community functions/prompts. Cost only your infrastructure.

**Weaknesses:** Requires technical setup. No polished mobile experience. UI feels engineering-first, not consumer. No native voice mode or meeting integration. No autonomous agent layer beyond function calls.

**Missing:** Polished consumer mobile, voice mode, meeting/calendar integration, autonomous task delegation.

---

### LibreChat (librechat.ai)

**What it is:** Open-source ChatGPT-clone-and-then-some. 37.6K stars, 36M Docker pulls. Used by Shopify, Stripe, Daimler, Boston University.

**Providers:** OpenAI, Anthropic, AWS Bedrock, Azure, Google, plus pre-configured ecosystem.

**Key features:** Agents with file/code-interpreter/API actions, Code Interpreter, Artifacts (React/HTML/Mermaid), Meilisearch-powered search, MCP support, persistent memory across conversations, web search with reranking, enterprise auth (SSO/SAML/LDAP/2FA).

**Pricing:** Free open-source.

**Platforms:** Web (self-hosted) + responsive mobile.

**Strengths:** Strong enterprise auth story. MCP and memory are first-class. Agents are real (file handling, code, APIs). Active OSS community.

**Weaknesses:** Self-hosted only - no managed cloud option. UI is functional but not delightful. No native desktop/mobile apps. Voice is limited.

**Missing:** Managed cloud, polished mobile, voice mode, meeting capture, broader plugin marketplace.

---

### AnythingLLM (Mintplex Labs)

**What it is:** "The all-in-one AI application for everyone." Desktop app + cloud + Docker. MIT licensed.

**Providers:** Built-in local LLM provider, plus OpenAI, Azure, AWS, etc.

**Key features:** Chat with documents (PDF, Word, CSV, codebases), AI Agents, multi-model, Community Hub for Agent Skills/System Prompts/Slash Commands, multi-user with admin controls, white-label, developer API.

**Pricing:** Free desktop; paid cloud and self-hosted enterprise tiers.

**Platforms:** Mac/Win/Linux desktop, Docker, cloud.

**Strengths:** Solid document RAG. White-label/multi-tenant story for resellers. Community hub. Open source.

**Weaknesses:** UI is utilitarian. Agent skills are limited compared to Cline/Devin. No native voice/meeting. Mobile is web-only. Less polished than Msty/TypingMind.

**Missing:** Mobile, voice, meeting integration, native agent orchestration beyond skills.

---

### Jan (jan.ai)

**What it is:** "Personal Intelligence that answers only to you." Open-source ChatGPT replacement, 5.7M downloads, 42.7K GitHub stars.

**Providers:** Local via Llama/Mistral/Qwen/DeepSeek/Gemma/Kimi, plus connectable cloud (ChatGPT, Claude, Gemini).

**Key features:** Local-first, model hub, simple memory ("Coming Soon"), HuggingFace integration with 123 hosted models. Open-source ethos.

**Pricing:** Free.

**Platforms:** Mac/Win/Linux desktop.

**Strengths:** Strong privacy/local-first identity. Clean modern UI. Active dev community. Great for hobbyists running local models.

**Weaknesses:** Memory is "coming soon" in 2026 (laggard). No mobile. No agent layer. No real plugin/tool ecosystem. No voice. Niche audience.

**Missing:** Memory (announced not shipped), mobile, agents, voice, integrations.

---

### LM Studio

**What it is:** Desktop app + SDK for running local LLMs. From Element Labs. New in 2026: LM Link (remote instance connection) and `llmster` (headless GUI-less deployment).

**Providers:** Local only - gpt-oss, Qwen3, Gemma3, DeepSeek R1, MLX models on Apple Silicon, etc.

**Key features:** Native model browser, JS/Python SDKs, MCP client support, OpenAI-compatible API endpoint, CLI (`lms`), headless deploy.

**Pricing:** Free for home and work use; enterprise solutions exist.

**Platforms:** Mac/Win/Linux.

**Strengths:** Best-in-class local model runner UX. Apple Silicon MLX optimization. Developer-friendly SDKs. MCP client. Headless deployment for CI/servers.

**Weaknesses:** Single-user. Single-model focus (no parallel multi-model UI). Not a chat-aggregator product per se. No cloud models, no agents, no voice.

**Missing:** Multi-model parallel chat UX, agents, voice, mobile, cloud-model bridging, meeting integration.

---

### GPT4All (Nomic)

**What it is:** Now mostly a private/local-AI brand under Nomic, which has pivoted heavily into AEC (architecture, engineering, construction) verticals via the Nomic Platform.

**Providers:** Local open-source models on Win/Mac/Linux/WinARM/Ubuntu.

**Key features:** LocalDocs (chat-with-docs), thousands of models, fully offline.

**Pricing:** Free.

**Platforms:** Desktop only.

**Strengths:** Genuine local-first privacy. Wide model support. Brand recognition.

**Weaknesses:** The product itself feels neglected - the parent company is now selling AEC software. No mobile, no voice, no agents, no plugin ecosystem worth mentioning. Lagging the local-first race against LM Studio/Jan/Msty.

**Missing:** Pretty much everything beyond local chat with docs.

---

## TIER 2 - Multi-Agent / Agentic Workspaces

### Cursor (cursor.com)

**What it is:** "The best coding agent." VS Code fork from Anysphere. Used by half of Fortune 500. Multiple Composer model versions (2, 2.5).

**Providers:** GPT-5.5, Claude Opus 4.8, Gemini 3.1 Pro, Grok 4.3, plus their own Composer models. Auto-routing.

**Key features:** Tab autocomplete (specialized model), agent that runs autonomously on its own VM, Cloud Agents (Kanban-style task board), CLI, Slack/GitHub/Jira integration, Mission Control, BugBot for code review, codebase semantic indexing.

**Pricing:** Free tier; Pro $20/mo; Business and Enterprise tiers.

**Platforms:** macOS/Win/Linux desktop, mobile agent app, CLI.

**Strengths:** Best-in-class coding agent UX. The "autonomy slider" (Tab to Cmd+K to Agent) is a genuinely good design. Cloud agents that run in parallel are a step ahead. Half the Fortune 500. Karpathy and Brockman endorse.

**Weaknesses:** Coding-only. Doesn't generalize to research, writing, voice, or general knowledge work. Expensive at scale. Subscription + token overage model. Heavy lock-in to the Cursor IDE.

**Missing:** Anything outside coding. No voice, no meetings, no general chat, no document workflows.

---

### Windsurf (Cognition)

**What it is:** Originally Codeium's IDE; acquired/merged into Cognition (Devin's parent). "First agentic IDE." Cascade is the chat-evolution agent.

**Providers:** Multi-model with custom routing.

**Key features:** Cascade (deep contextual coding agent), Tab autocomplete, Devin-in-Windsurf for cloud agents, Agent Command Center (Kanban for local + cloud agents), Spaces (bundled task contexts), Windsurf Previews (live element editing), Linter integration, MCP support, Tab-to-Jump.

**Pricing:** Free + paid tiers.

**Platforms:** Desktop IDE + JetBrains plugin + Web.

**Strengths:** Tight Devin integration is unique. Previews feature (click element to AI fixes it) is novel. 70M+ lines/day written by AI. 59% of Fortune 500.

**Weaknesses:** Coding-only. Acquisition-related uncertainty. Less mature ecosystem than Cursor.

**Missing:** Same as Cursor - anything beyond code.

---

### Cline (cline.bot)

**What it is:** "The Open Coding Agent." Open-source, 62K GitHub stars, 8M installs. Apache 2.0. Trusted by Samsung, Salesforce, Oracle, Amazon, IBM, Visa, eBay.

**Providers:** Claude, GPT, Gemini, local Ollama/LM Studio, OpenAI-compatible. BYOK or BYOWeights.

**Key features:** Plan-and-Act mode, multi-file edits with checkpoints, terminal execution, .clinerules per repo, MCP marketplace, multi-agent teams with cron schedules, Slack/Linear/Discord/Telegram integration, headless GitHub Actions support, SDK for plugins.

**Pricing:** Free open-source; managed app pricing for hosted use.

**Platforms:** VS Code/Insiders, JetBrains, Cursor, Windsurf (extension model), CLI.

**Strengths:** Open source. No vendor lock-in. The MCP marketplace is real and growing. Multi-agent coordination is more advanced than Cursor's. Runs anywhere - IDE, terminal, CI, Slack.

**Weaknesses:** Lives inside other IDEs (no first-party UI of its own - though arguably this is a strength). Less polished UX than Cursor for non-developers. Coding-focused.

**Missing:** Non-coding workflows, voice, meeting capture, general consumer-facing UI.

---

### Devin (cognition.ai)

**What it is:** "The AI software engineer." Cognition's autonomous cloud agent. New: Auto-Triage. Famous Nubank case study (12x efficiency, 20x cost savings on 6M-LOC migration).

**Providers:** Proprietary stack on top of frontier models.

**Key features:** Devin Review (PR review, visual QA), DeepWiki (auto-docs), code migration at scale, scheduled chores, issue triage, GitHub/Linear/Slack/Teams integration, Devin Enterprise.

**Pricing:** Per-seat-ish, plus Enterprise contracts.

**Platforms:** Cloud + Slack/Linear/GitHub bots.

**Strengths:** True autonomous cloud agent. Spins up its own machine. Massive Enterprise wins (Nubank, etc.). Parallel "fleet of Devins" for migrations.

**Weaknesses:** Coding-only. Expensive. Was historically marketed beyond what it could deliver.

**Missing:** Anything outside engineering.

---

### Lindy (lindy.ai)

**What it is:** "Personal AI work assistant." 400K+ professionals. Inbox/calendar/meetings/scheduling/CRM/follow-ups. Strong text-message delegation pitch.

**Providers:** Multi-model, abstracted away.

**Key features:** Email triage + drafting, meeting prep + attendance + notes + follow-ups, scheduling, CRM updates (HubSpot, Salesforce), iMessage/SMS delegation, Slack/Notion/Google Drive integration, recruiting/customer-success/consultant verticals, SOC 2 + HIPAA + BAA available.

**Pricing:** 7-day free trial. Plus $49.99/mo, Pro $99.99/mo, Max $199.99/mo, Enterprise custom.

**Platforms:** Web app + iMessage/SMS + connected apps.

**Strengths:** The clearest "AI executive assistant" positioning in the market. Text-to-delegate is genuinely novel. Strong compliance story for regulated industries.

**Weaknesses:** Expensive ($50+ entry). Not a chat aggregator. Doesn't do coding or general research. Heavy reliance on integrations being properly authed. Limited customization for power users.

**Missing:** Multi-model side-by-side chat, coding, voice mode (it's text-first), local/private deployment, BYOK.

---

### Relevance AI (relevanceai.com)

**What it is:** "Enterprise platform for agents you can trust at scale." GTM-focused. Customers include Canva, KPMG, Autodesk, Rakuten, Lightspeed, Freshworks.

**Providers:** Vendor-agnostic - Claude, GPT, Gemini routing per agent for cost/eval optimization.

**Key features:** Visual agent builder, "Invent" (build agents from natural language), evals system, monitoring dashboards with real-time activity/cost tracking, RBAC, audit logs, OTEL/Delta Share telemetry, PII masking, SSO/SAML, 1000+ native integrations (HubSpot, Salesforce, Slack, etc.), MCP.

**Pricing:** Try-for-free + Enterprise sales-led.

**Platforms:** Web platform.

**Strengths:** The most credible enterprise multi-agent orchestration platform. L1-L4 autonomy framework is a great pitch. Real customers with real ROI ($7M pipeline at Qualified, 40hrs/week saved at Send Payments). Domain experts (not engineers) own agent quality. Vendor-agnostic LLM routing.

**Weaknesses:** Sales-led, expensive, not for individuals. No consumer chat. Heavy setup. GTM-focused (sales/marketing/ops, not creative/research).

**Missing:** Individual/prosumer pricing, voice, meeting capture, general chat aggregator UX.

---

### Sider (sider.ai)

**What it is:** "All-in-one AI sidekick for your browser." 10M+ users. Browser-extension-first. "Wisebase" is their personal knowledge base play.

### Monica AI (monica.im)

**What it is:** "All-in-one AI assistant. Personalized, fast and free." 10M+ users. 4.9 on Chrome Store. Browser-extension-first like Sider, with broader product surface.

### Merlin AI (getmerlin.in)

**What it is:** "Ideas are a chat away." 20M+ users. Foyer Tech's flagship. Pitched as "$130 worth of value for $19."

---

## TIER 3 - Voice-First AI Assistants

### Pi by Inflection
The product has stagnated since Microsoft acqui-hired most of Inflection's leadership in 2024. Best-in-class warm voice but no agents, no multi-model, no meeting capture.

### Limitless / Rewind
Acquired by Meta in 2025. Pendant continues with unlimited plan free; new sales discontinued. Rewind macOS app sunset Dec 19, 2025. Leaves a vacuum for personal voice/memory capture.

### Friend (friend.com)
Avi Schiffmann's pendant. Marketed as social/emotional. Reviews have been brutal. Cautionary tale.

### Krisp AI Assistant (krisp.ai)
Voice AI for meetings. Best-in-class noise cancellation, AI Note Taker, Accent Conversion, Voice Translation, SDK for developers (VIVA 2.0). Customers include Sony, Cisco, GitHub, VMware, Autodesk.

### Granola (granola.ai)
"AI notepad for back-to-back meetings." Series C raised $125M (March 2026). Used by PostHog, Intercom, Linear, Brex, Replit, Vercel. No bots - transcribes computer audio directly. Templates per meeting type. Endorsed by Nat Friedman, Guillermo Rauch.

---

## Cross-Cutting Patterns Observed

1. **No competitor combines all three tiers.** Multi-model chat aggregators stop at chat. Agentic platforms are coding-only or GTM-only. Voice/meeting apps don't generalize.
2. **Memory is universally weak.** Even leaders like Jan list memory as "coming soon." No one has true unified memory across chat + meetings + voice + browsing.
3. **MCP (Model Context Protocol) is becoming standard.** TypingMind, Open WebUI, LM Studio, Cline, LibreChat, and Relevance AI all support it. Most consumer aggregators (ChatHub, Poe) do not.
4. **BYOK is a massive value prop but executed poorly.** TypingMind's lifetime license is the cleanest example.
5. **Local-first is a niche but powerful identity.** Msty, Jan, LM Studio, Open WebUI, AnythingLLM compete here. Mostly desktop-only.
6. **Mobile is consistently neglected** by serious power-user tools.
7. **Pricing models are fragmented and confusing.** Points, query-limits, per-seat, lifetime, BYOK all coexist. Users hate it.
8. **Real-time collaboration is rare.** Cursor announced Shared Canvases (May 20, 2026). Nobody else does collaborative AI workspaces well.
9. **Voice-first conversation mode is mostly underbuilt.**
10. **Cross-app integration depth varies wildly.** Lindy and Relevance AI are deep. Most chat aggregators are shallow.

---

## Differentiation Strategy: 13 Capabilities Jarvis Should Ship

To be definitively better than every product surveyed, Jarvis should ship the following. Each is a gap that no competitor convincingly fills.

1. **Unified persistent memory across every modality.** One memory layer that captures chat conversations, meeting transcripts, voice notes, browsed pages, uploaded documents, AND tasks/reminders. Memory is queryable, editable, and exportable. Beats Lindy (siloed in inbox), Granola (siloed in notes), and every Tier 1 aggregator (per-thread only).

2. **Parallel multi-model chat with ensemble synthesis.** Don't just show responses side-by-side (ChatHub) - let the user click "synthesize" to have a meta-model produce a single best answer with disagreement-flagging. Optional voting/blind comparison mode.

3. **One subscription, every model, transparent token routing.** Let the user choose: Jarvis-managed (we eat the cost), or BYOK (bring your OpenAI/Anthropic/Google keys, pay only their cost). No points. No daily query limits.

4. **Native MCP marketplace with curation tier.** First-class MCP support with a curated, security-reviewed marketplace plus a "wild west" community section.

5. **No-bot meeting capture (Granola-style) that flows directly into chat memory and creates tasks/reminders automatically.** Listen to system audio, transcribe locally where possible, sync transcripts into the unified memory, AND extract action items into the live to-do list.

6. **Voice-first conversational mode with interrupt and barge-in.** Real-time voice conversation with frontier models that ALSO has access to your unified memory, calendar, and to-do list.

7. **Autonomous agent runtime with human-in-the-loop and L1-L4 autonomy slider.** Borrow Relevance AI's autonomy framework, productize it for individuals and small teams.

8. **Live to-do list managed by Jarvis with smart reminders and notifications.** This is a category-defining feature: a single source of truth for tasks that the assistant can create, modify, schedule, snooze, prioritize, and remind on - via voice, text, or autonomous extraction from meetings/chats. Works as system notifications on desktop and mobile, with quiet hours, location-aware reminders, and deadline-aware nagging. No competitor combines an executive-assistant-grade task layer with the rest of the AI workspace.

9. **iMessage/SMS/WhatsApp delegation interface.** Lindy proved this is sticky. Make it the default for mobile. Text "schedule with Alex, add 'finalize Q3 deck' to my list, recap yesterday's call."

10. **True local-first option with cloud-sync bridge.** Ship a local-first "Privacy Mode" that runs models on-device (MLX/llama.cpp) and a "Hybrid Mode" that keeps memory local but routes specific chats to cloud models. End-to-end encrypted sync.

11. **Built-in evals and quality monitoring.** Per-agent eval suites surfaced to consumers as "trust scores."

12. **Skills/Workflows marketplace with revenue share for creators.**

13. **Real-time multi-user collaboration (Shared Canvases).** Cursor just shipped Shared Canvases for code; nobody has it for chat.

---

## Closing Note

The competitive set is wide but shallow at the unification layer. ChatHub/Poe own breadth-of-models. Cursor/Cline own coding agents. Granola owns meetings. Lindy owns email/scheduling. Krisp owns voice quality. Relevance AI owns enterprise multi-agent.

**No one owns the workspace.** That's the door Jarvis should walk through. Build the layer that makes all of those modalities first-class citizens of a single memory and a single agent runtime, with bring-your-own-key pricing, real local-first options, and an executive-assistant-grade to-do/scheduler/notifications layer woven through every surface. The rest of the field will look like point solutions.
