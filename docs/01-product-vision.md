# Jarvis - Product Vision & Executive Overview

*Project: Jarvis (working title)*
*Date: May 28, 2026*
*Status: Pre-development - planning phase*

---

## 1. The thesis

Today's AI workspace is a junk drawer. Power users juggle ChatGPT, Claude, Gemini, Cursor, Granola, Lindy, Notion AI, Raycast AI, plus a handful of MCP servers and browser extensions. Each tool owns a slice of the workflow, none of them talk to each other, and the user becomes the integration layer.

**Jarvis is the unification.** One desktop-and-web app where every model, every agent, every voice, and every task lives under one persistent memory and one always-available assistant.

We are building what BridgeMind hinted at and what no shipping product has actually delivered: a **multi-agent operating layer** for everyday work, with a voice-first overarching assistant ("Jarvis") that ties all the agents, tools, conversations, schedules, and reminders together.

## 2. North-star user story

> Sarah, a product manager, says "Hey Jarvis" while making coffee.
>
> "Pull up yesterday's roadmap call, give me the three biggest open questions, and put a reminder on my list to follow up with Alex about the API timeline before standup tomorrow."
>
> Jarvis pulls the meeting transcript from her unified memory, fans out to a research agent for context, summarizes the three questions on her glass-edge HUD, drops a task into her live to-do list with a 9:45 AM reminder, and gently notifies her at exactly 9:43 AM with the prepped context already loaded.
>
> She never opened the app. She never clicked anything. She never had to remember.

That is the product.

## 3. Core pillars

Jarvis is built on five pillars. Every feature must reinforce at least two of them.

1. **Council of agents.** Multiple AI agents (Claude, GPT, Gemini, local Llama/Qwen, plus user-defined personas) running in parallel, visible in one canvas, mention-routable, and synthesizable into a single answer.
2. **Persistent unified memory.** One memory layer indexed across chats, voice, meetings, browsing, files, and tasks. Local-first by default, encrypted-sync optional, fully exportable.
3. **Jarvis voice layer.** Always-available voice assistant with wake word, push-to-talk, low-latency S2S option, and natural-language access to every other surface in the app.
4. **Live to-do list + smart scheduler.** A first-class task system where Jarvis creates, modifies, schedules, snoozes, and reminds via OS notifications. The to-do list is a native peer to chat, not a plug-in.
5. **MCP-native tool ecosystem.** Every tool is an MCP server. Curated marketplace, one-click install, sandboxed by default. Skills/workflows can be authored and shared.

## 4. Who it's for

Primary audiences, in priority order:

1. **Power users / "vibe coders" and PMs** (the BridgeMind/Cursor demographic): people who already pay for 3+ AI subscriptions and would consolidate.
2. **Indie hackers and solo founders**: needs a Lindy-grade assistant + a Cursor-grade builder + a Granola-grade meeting tool, can't afford all three.
3. **Knowledge workers (consultants, analysts, designers)**: drowning in meetings and want one tool that listens, remembers, and acts.

Explicitly **not** for: enterprise compliance buyers (SOC 2 Type II is post-launch), or non-technical mass-market users (we'd dilute the keyboard-first design).

## 5. Key differentiators vs BridgeMind & every competitor

| | BridgeMind | Cursor | Lindy | Granola | ChatHub | **Jarvis** |
|---|---|---|---|---|---|---|
| Multi-model parallel chat | partial | no | no | no | yes | **yes + ensemble synthesis** |
| Multi-agent council mode | partial | no | no | no | no | **yes** |
| Voice-first overarching assistant | dictation only | no | no | no | no | **yes (full S2S)** |
| Persistent memory across modalities | code only | code only | inbox only | meetings only | no | **yes (everything)** |
| Live to-do + smart reminders | no | no | partial (via integrations) | no | no | **yes (native)** |
| MCP marketplace | yes | partial | no | no | no | **yes (curated + community)** |
| Local-first option | partial | no | no | no | no | **yes** |
| BYOK | no | no | no | no | no | **yes (optional)** |
| Mobile companion | no | partial | yes (SMS) | yes (iOS) | yes | **yes (read + voice + remind)** |
| Open-source core | no | no | no | no | no | **yes (apprentice)** |

The BridgeMind comparison specifically: we match BridgeMind's multi-agent panel grid and their Bridge Assistant concept, then go beyond by adding parallel-non-coding-agents, ensemble synthesis, the live to-do/scheduler layer, true cross-modality memory, and a real voice S2S path. We're targeting the workspace, not just the IDE.

## 6. Product surfaces (what ships)

1. **Desktop app (Tauri-based, Win/Mac/Linux):** The main workspace. Three-pane shell, council mode, voice modal, to-do panel, settings.
2. **Mobile companion (iOS + Android, React Native + Expo):** Read tasks, dictate to Jarvis, receive reminders, approve agent actions. Not a full chat client.
3. **Browser extension (Chrome + Firefox + Safari):** Capture pages into memory, summon Jarvis, sidebar chat.
4. **Menu-bar/system-tray micro-app (Mac + Win):** Always-on Jarvis presence, push-to-talk hotkey, floating to-do drawer, notification center.
5. **Web app (jarvis.app):** Cloud sync surface, shareable chats, account settings. Not the primary surface - desktop is.

## 7. Live to-do list & smart scheduler (added scope)

This is a category-defining feature. Specs in detail in `docs/06-todo-scheduler-notifications.md`. Headline:

- **Single source of truth** for tasks. Native data model in the app database with bidirectional sync to system Reminders / Google Tasks / Todoist (optional).
- **Voice-driven create/modify.** "Hey Jarvis, add 'review PR #1234' due Friday at 4pm, high priority, link to the Cursor thread."
- **Auto-extract from chats and meetings.** Action items detected by an extractor agent and surfaced as draft tasks for one-tap accept.
- **Smart scheduling.** Jarvis picks optimal reminder times using calendar density, location, quiet hours, and deadline pressure - not just static "remind at X."
- **Native OS notifications.** Desktop banners, Mac/Windows action center, iOS/Android push, Apple Watch / Wear OS support, optional email + SMS digest.
- **Snooze with intelligence.** "Snooze until I'm done with my next meeting" - Jarvis figures out when that is.
- **Daily plan briefing.** Morning standup with Jarvis: today's tasks, conflicts, suggestions, drafted prep.

## 8. Open positioning questions (decisions needed)

1. **Pricing model.** Free + BYOK + Pro ($20/mo) + Pro+ ($50/mo) is the working assumption. Lifetime license like TypingMind? Credits like BridgeMind? Decide before public launch.
2. **Open-source posture.** Open the core ADE (MIT) and monetize hosted sync, voice infra, marketplace? Or closed-source with generous free tier? Working assumption: open-source the core.
3. **Mobile launch order.** Ship desktop first, mobile follows in Phase 2. iOS before Android.
4. **Branding.** "Jarvis" is unprotectable trademark territory. Working title only - real name needed before public launch.

## 9. Non-goals

To stay focused, Jarvis explicitly **does not** try to be:

- A code editor. We integrate with VS Code, Cursor, and the user's existing IDE via MCP. We are not building a Monaco-based editor surface.
- A meeting recorder for Zoom/Teams as bots. We capture system audio Granola-style. No bots in calls.
- A CRM. We integrate with HubSpot/Salesforce as MCP servers.
- A team chat product (no Slack/Discord competitor). Multi-user shared canvases yes, full team chat no.
- An enterprise compliance product (Phase 1). SOC 2 lives in Phase 4+.

## 10. Success metrics

Phase 1 (closed beta, 90 days post-MVP):

- 500 weekly active users.
- 4+ chat threads per user per week.
- 50%+ of users using voice at least 1x/week.
- 70%+ of users with at least one active task in the to-do list.
- D30 retention >= 35%.
- NPS >= 40.

Phase 2 (public launch, 6 months later):

- 25,000 monthly active users.
- 5,000 paying subscribers.
- $1M ARR run-rate.
- D30 retention >= 45%.

---

*See companion docs in `docs/` for system architecture, orchestration, voice layer, to-do/scheduler/notifications, UI/UX, and the phased implementation plan.*
