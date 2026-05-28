# Changelog

All notable changes to Jarvis are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial planning and research documentation (8 design docs, 5 research reports, 1 implementation plan)
- V1 application scaffold (Vite + React + TypeScript + Tailwind + shadcn-style UI)
- Tauri 2 desktop wrapper configuration (Windows + Mac + Linux capable)
- Voltage design system: OLED-black + cyan-violet accent gradient, Geist typography, Lucide icons
- Three-pane shell layout (collapsible nav, fluid main canvas, slide-over inspector, tray-style to-do drawer)
- Chat thread + composer UI with mention-routing typeahead
- Council mode UI: n-up agent panels, animated beams, synthesize button
- Live to-do system: TaskCard, TodoPanel, smart scheduler, in-app reminder engine, browser notifications
- Voice modal with CSS-only ambient orb + Apple-Intelligence-style glow border + push-to-talk hotkey
- Command palette (cmdk) with global Cmd+K + nested pages + agent switching
- Settings page with BYOK inputs (OpenAI / Anthropic / Google), theme, keyboard alphabet, telemetry toggle
- Onboarding flow (5 steps: welcome -> persona -> providers -> permissions -> demo)
- Local-first persistence via Dexie (IndexedDB) for chats, tasks, agents, settings
- Supabase client wiring (creds plugged in via .env.local) for cloud sync, auth, push relay
- Agent registry: Jarvis (supervisor), Researcher, Coder, Writer, Critic, Memory Keeper, Action Extractor
- Mock LLM provider for offline development without API keys
- Hotkey alphabet: Cmd+K palette, Cmd+B nav, Cmd+\\ inspector, Cmd+Space voice, Cmd+T new chat, Cmd+1..9 tabs
