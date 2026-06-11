# VibeSpace - Live To-Do List, Smart Scheduler & Notifications

*The category-defining feature. Specs the live task system that VibeSpace manages, schedules, and reminds on.*

---

## 1. Why this exists

Every AI assistant on the market today has a memory leak: the user asks the assistant to do something later, the assistant says "I'll remind you," and then the assistant forgets the moment the chat closes. Lindy got close on the email/scheduling axis. Granola got close on the meeting axis. No one has built an executive-assistant-grade task layer that lives at the heart of an AI workspace.

That's what this system is. **A live to-do list that VibeSpace owns end-to-end** - it can create, modify, schedule, snooze, prioritize, complete, and notify on tasks via voice, text, or autonomous extraction from any chat or meeting. The user never has to touch a separate task app.

## 2. Goals

1. **Voice-first task creation.** "Hey VibeSpace, add 'review PR #1234' due Friday at 4pm" works in under 2 seconds with verbal confirmation.
2. **Auto-extracted action items.** Every meeting and chat has its action items detected by an extractor agent and surfaced as draft tasks.
3. **Smart scheduling.** Reminder times are picked by VibeSpace based on calendar density, location, quiet hours, deadline pressure, and user habits - not just static "remind at X."
4. **Native, multi-surface notifications.** Desktop banners, mobile push, watch buzz, optional email/SMS digest. Snooze syncs everywhere instantly.
5. **One source of truth.** Tasks live in VibeSpace's database. Optional bidirectional sync to system Reminders, Google Tasks, Todoist, Linear, Notion, etc.
6. **Daily plan briefing.** Morning standup: VibeSpace tells you what's on your list, surfaces conflicts, drafts prep.
7. **Zero-friction completion.** Mark done by saying "done", swiping a notification, or just doing the thing (VibeSpace can detect completion from chat / git / calendar in many cases).

## 3. Data model

### Task

```typescript
type Task = {
  id: string;                         // task_<ulid>
  workspace_id: string;
  project_id?: string;                // optional project scope
  title: string;                      // 1-line, max 200 chars
  notes?: string;                     // markdown body, optional
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'urgent';

  // Time
  due_at?: number;                    // unix ms; hard deadline
  scheduled_for?: number;             // unix ms; intent to do at
  estimated_duration_min?: number;    // for calendar planning

  // Smart scheduling inputs
  effort: 1 | 2 | 3 | 5 | 8 | 13;     // fibonacci pointing
  context_tags: string[];             // ['deep-work', 'errand', 'call', 'review']
  location?: 'home' | 'office' | 'anywhere' | string;
  energy_required: 'low' | 'medium' | 'high';
  blocked_by_task_ids?: string[];

  // Reminders
  reminders: Reminder[];

  // Provenance
  created_by: 'user_voice' | 'user_text' | 'extracted_chat' | 'extracted_meeting' | 'agent';
  source_refs: ContextRef[];          // chat message ID, meeting transcript, file, etc.
  agent_owner?: string;               // optional: which agent owns this

  // External sync
  external_ids: {
    apple_reminders?: string;
    google_tasks?: string;
    todoist?: string;
    linear?: string;
    notion?: string;
    github?: string;                  // issue / PR url
  };

  // Completion
  done_at?: number;
  completion_evidence?: ContextRef;   // what convinced VibeSpace it was done

  created_at: number;
  updated_at: number;
};

type Reminder = {
  id: string;                         // rem_<ulid>
  task_id: string;
  fires_at: number;                   // unix ms
  channels: NotificationChannel[];    // ['banner', 'push', 'watch']
  message_override?: string;          // custom payload
  status: 'scheduled' | 'fired' | 'snoozed' | 'dismissed' | 'completed';
  snooze_history: { snoozed_at: number, until: number, reason?: string }[];
  smart_reason?: string;              // why VibeSpace chose this time
};

type NotificationChannel =
  | 'banner'        // OS desktop banner
  | 'push'          // mobile push
  | 'watch'         // Apple Watch / Wear OS
  | 'email'         // digest or single
  | 'sms'           // Twilio
  | 'voice'         // VibeSpace says it out loud
  | 'imessage'      // iOS only
  | 'in_app';       // shown in to-do panel only

type ContextRef = {
  kind: 'chat_message' | 'meeting' | 'file' | 'email' | 'calendar_event' | 'memory' | 'url';
  id: string;
  excerpt?: string;
};
```

### Why these specific fields

- **`effort` + `context_tags` + `energy_required`** drive smart scheduling. Without them VibeSpace can't pick good reminder times - it'd just nag you at the deadline.
- **`source_refs`** is what makes "Pull up the design doc from yesterday's call" work later. Every task carries the chain back to where it came from.
- **`external_ids`** keeps two-way sync correct without leaking N copies of the task across systems.
- **`completion_evidence`** is the proof VibeSpace used to auto-complete - we need it for "wait, why did you mark this done?" debugging.

## 4. Subsystem architecture

```
+----------------------------------------------------------------+
|                  TASK SERVICE (Node, in-runtime)               |
|                                                                |
|  +-------------+   +----------------+   +-------------------+  |
|  | Task CRUD   |   | Smart Sched.   |   | External Sync     |  |
|  | + Reminder  |   | Engine         |   | (Apple/Google/    |  |
|  | CRUD        |   |                |   |  Todoist/Linear)  |  |
|  +-----+-------+   +-------+--------+   +---------+---------+  |
|        |                   |                      |            |
|        v                   v                      v            |
|  +----------------------------------------------------------+  |
|  |                  SQLite (tasks, reminders)               |  |
|  |  + LanceDB index (semantic search over task corpus)      |  |
|  +----------------------------------------------------------+  |
|        |                   |                      |            |
|        v                   v                      v            |
|  +------------+  +-------------------+   +-------------------+ |
|  | Notification|  | Calendar reader  |   | Action Extractor  | |
|  | engine      |  | (Google + Outlook|   | agent (always-on) | |
|  +-----+-------+  | + Apple)         |   +---------+---------+ |
|        |          +-------------------+              |          |
|        |                                             |          |
+--------+---------------------------------------------+----------+
         |                                             |
         v                                             v
+--------------------+                    +-----------------------+
| Tauri OS bridge    |                    |  Chat / Meeting       |
| - desktop banner   |                    |  pipeline (when       |
| - tray badge       |                    |  conversation ends,   |
| - global hotkey    |                    |  extractor runs)      |
| - sound            |                    +-----------------------+
+----------+---------+
           |
           v
+----------------------+
| APNs / FCM / Web Push|
| (mobile + extension) |
+----------------------+
```

## 5. Smart Scheduling Engine

The hard part. Three rules:

1. **Never fire a reminder at the wrong time.** No 6am buzzes for non-urgent tasks. No interruptions during meetings. No notifications during quiet hours.
2. **Always fire one when it matters.** A high-priority deadline should never slip silently.
3. **Be honest about why.** Every smart-scheduled reminder carries a `smart_reason` string VibeSpace can verbalize ("Setting this for 9am because your morning is light and the deadline is Friday").

### Inputs

The scheduler reads from:
- The task itself (due, priority, effort, context_tags, energy_required, location).
- The user's calendar (today + 7 days).
- The user's quiet hours (default 10pm-8am, configurable).
- Recent task completion history (when does the user actually do tasks?).
- Current location (if mobile, opt-in).
- Other pending reminders (avoid clustering).
- Time zone changes (don't fire at 3am because the user flew across the country).

### Algorithm (high level)

For a new task with a `due_at`:

1. **Compute deadline pressure curve.** Time-to-deadline mapped to urgency score (sigmoid that ramps up sharply in last 25% of available time).
2. **Find candidate slots.** All times between now and `due_at` minus `estimated_duration_min`, filtered by:
   - Outside quiet hours.
   - Outside meetings.
   - Outside other dense reminder clusters.
   - During hours the user historically completes this `context_tag` (e.g., they do "errands" at lunch).
3. **Score each candidate.** Combine deadline pressure, energy alignment (deep-work tasks scored higher when energy historically peaks), location match if applicable, calendar headroom.
4. **Pick top N candidates** for that task: typically 1 main reminder + 1-2 escalations (e.g., 24h before, 1h before).
5. **Generate `smart_reason`** strings via a tiny Haiku-class LLM call that produces natural language ("Reminding you 9am tomorrow - your morning is clear and you usually crank through reviews before lunch").

### Heuristics that matter

- **"Don't surprise me at the deadline."** First reminder should fire at least 1.5x the task's `estimated_duration_min` before `due_at`, so the user has time to actually do it.
- **"Don't nag."** Default to 1 reminder for normal priority, 2 for high, 3 for urgent. Never more without explicit user request.
- **"Respect flow."** If the user has a calendar block tagged "deep work" or "focus", reminders for non-urgent tasks shift outside that block.
- **"Cluster errands."** If three errand-type tasks all have flexible reminder windows, batch them into one notification ("3 errands ready").
- **"Wake up briefing."** Tasks scheduled for "today" without explicit reminder times all flow into the morning briefing instead of buzzing individually.

### What the user can override

Every smart decision shows up with a small "scheduled by VibeSpace" badge. Tap to edit time, channel, or message. Tap "always do this" to teach VibeSpace a preference.

## 6. Action Extractor agent

A standing background agent that runs after every chat turn finishes and after every meeting transcript closes.

### Inputs
- Latest message(s) or transcript.
- Recent task list (to deduplicate and detect updates).
- Speaker identity (for meetings - "this was said by the user vs. someone else").
- User preferences (do they want extracted-from-chat tasks at all? What confidence threshold?).

### Output
A list of **draft tasks** with confidence scores:

```typescript
type DraftTask = {
  task: Partial<Task>;
  confidence: number;             // 0..1
  trigger_phrase: string;         // "...so I'll send Alex the API spec by Friday."
  source_ref: ContextRef;
  diff_against_existing?: string; // task_<ulid> if this looks like an update
};
```

### UX surface

- Drafts appear in a "Suggested" section of the to-do panel with a one-tap accept.
- High confidence drafts (>= 0.85) can be auto-accepted if the user opts in.
- Drafts time-out after 24 hours if not accepted.
- Voice surfacing: at the end of a meeting, VibeSpace says "I caught 3 action items - want to add them?" and reads the titles.

### Extraction prompt (sketch)

```
You are an action item extractor. Given a conversation, identify any concrete commitments
or tasks - things the user (or someone on the user's behalf) is going to do later.

Output JSON list:
[{
  "title": "...",          // imperative, concise
  "owner": "user" | "<other_speaker>",  // skip non-user owners unless flagged
  "due": "<iso8601 or null>",
  "priority": "low|normal|high|urgent",
  "confidence": 0.0-1.0,
  "trigger_phrase": "<exact quote that triggered this>"
}]

Rules:
- Only include items the user clearly committed to.
- "I should think about X" is not a task; "I'll have a draft by Friday" is.
- Skip vague aspirations ("we should improve our docs").
- If the user already has a similar task, mark as 'update' with diff.
```

This runs on a small fast model (Haiku / GPT-mini) for cost.

## 7. Notification engine

The notification engine decides:
- **What** to send (which task, which message).
- **When** to send (informed by smart scheduler, but the engine respects last-minute changes).
- **Where** to send (which channels).
- **How** it should look (rich content, actions, priority).

### Channels

| Channel | Surface | Tech |
|---|---|---|
| **Banner** | Desktop OS banner top-right (Mac) / bottom-right (Win) | Tauri's notification plugin -> `UNUserNotificationCenter` (Mac) / Windows Action Center |
| **Tray badge** | System tray / menu bar icon shows count + dot | Tauri tray APIs |
| **Sound** | Optional chime per priority level | Custom audio assets in `~/.jarvis/sounds/` |
| **Voice** | VibeSpace verbalizes the reminder if user is in voice session | Voice sidecar TTS |
| **Push** | Mobile lock-screen / Notification Center | APNs (iOS), FCM (Android), via VibeSpace Cloud |
| **Watch** | Apple Watch / Wear OS buzz | Companion app or Critical Alert with relay |
| **Web Push** | Browser extension | VAPID Web Push |
| **Email** | Daily digest or single-shot for urgent | Resend |
| **SMS** | Twilio - opt-in only | Twilio API |
| **iMessage** | macOS-only via `osascript -e 'tell application "Messages"...'` to the user's own number | local |
| **In-app** | Shown in the to-do panel only | local |

### Priority -> default channels

| Priority | Default channels (configurable) |
|---|---|
| Low | in_app + tray badge |
| Normal | banner + push |
| High | banner + push + watch |
| Urgent | banner + push + watch + voice (if VibeSpace active) + sound |

### Rich notification content

Banner / push notifications carry actions:
- **Done** - mark complete.
- **Snooze** - opens a quick picker (15m / 1h / tonight / tomorrow / custom / "until I'm done with my next meeting").
- **Open in VibeSpace** - opens app to the task.
- **Edit** - inline reschedule.

Mac actions and Windows toast actions are wired through Tauri; iOS/Android use action categories registered with APNs/FCM.

### Quiet hours

Default quiet hours: 10pm-8am local time, plus all-day Sunday. User-configurable. During quiet hours:
- Low / normal priority -> queued for next non-quiet window.
- High priority -> banner only, no sound, no watch buzz.
- Urgent -> full delivery (the user explicitly marked it urgent for a reason).

### Do Not Disturb integration

Reads system DND state on Mac (Focus modes) and Windows (Focus assist). When the user is in a Focus mode, VibeSpace respects it for non-urgent tasks. Urgent tasks can be allowlisted by adding VibeSpace to the Focus's allowed apps list.

### Smart silencing

If the user has dismissed three notifications in a row in the last hour without acting, VibeSpace silently rate-limits for the next hour and surfaces a "you seem busy - I've held 5 reminders, want them now?" prompt at the end.

## 8. Voice integration

Voice is the primary way the user interacts with the to-do system. VibeSpace recognizes these intents (full list in `04-voice-jarvis-layer.md` section 7):

### Create
- "Add 'review PR 1234' to my list."
- "Remind me to call mom Saturday at 2."
- "Add an urgent task to send the proposal to Acme by EOD."
- "Put 'pick up dry cleaning' on errands for tomorrow."

Confirmation pattern (under 1 second, voice + visual):
> VibeSpace: "Added: review PR 1234, due Friday 4pm. Reminding you Friday at 9am."
> Glow border pulses green briefly. Task panel briefly highlights the new task.

### Modify
- "Move the 4pm reminder to 5."
- "Make the Acme task urgent."
- "Push everything for today to tomorrow."
- "Add a note to the design review that Alex wants the dark theme."

### Complete
- "Done with the API task."
- "Mark everything in errands as done."
- "I just sent the proposal."

### Query
- "What's on my list today?"
- "What's overdue?"
- "What did I commit to in the call with Acme yesterday?"
- "When is the design review due?"

### Snooze
- "Snooze that 'till after lunch."
- "Snooze the standup reminder until Monday."
- "Snooze everything except urgent for an hour."

### Plan
- "Plan my morning."
- "Help me figure out what to do next."
- "What should I pick up first?"

The "plan my morning" flow is interactive: VibeSpace pulls today's tasks, calendar, and energy patterns, proposes an ordering, asks for any swaps, then sets the schedule. Takes about 90 seconds in voice.

## 9. Daily plan briefing

Every morning at the user's chosen time (default: 30 minutes before their first calendar event), VibeSpace runs a briefing:

1. **Pulls** today's tasks (scheduled or due) + calendar + any blockers.
2. **Detects conflicts** (a 2-hour task with no calendar room, two urgent tasks competing for the same morning).
3. **Proposes a schedule** with reasoning.
4. **Drafts prep** for the first 1-2 things on the schedule (links to relevant docs, summarizes prior context, surfaces names of attendees).
5. **Delivers** via:
   - In-app briefing card.
   - Optional voice (VibeSpace reads it aloud while user makes coffee).
   - Optional email digest.
   - Mobile push notification with deep link.

Brief format (voice example):

> "Good morning. You have 4 things on your list and 3 meetings today. The biggest priority is finalizing the Q3 deck before your 2pm with Acme - I've blocked 10:30 to 12 for it. Two errands can fold into your lunch window. I drafted the pre-read for the 9am with Engineering - want me to send it now?"

## 10. External sync

Two-way sync with one external system at a time per task to keep state simple.

### Apple Reminders (Mac)
- Via EventKit (requires user permission).
- New tasks tagged with `apple_reminders=true` (default opt-in if user has Reminders configured) sync.
- Webhook simulation via polling (EventKit doesn't push).

### Google Tasks
- OAuth, polling every 60s for changes; push via Google API for new/edits.

### Todoist
- OAuth + REST API. Has webhooks; we subscribe.

### Linear
- OAuth + GraphQL + webhooks. Tasks tagged with a Linear workspace get bidirectional issue sync.

### Notion
- OAuth + Notion API. User picks a database; tasks become pages.

### GitHub Issues / PRs
- One-way: a PR mentioned in chat creates a draft task linked to the PR. PR closed -> task auto-completes (with completion_evidence pointing to the merge commit).

### Conflict resolution
- Last-writer-wins per field with a human-readable conflict log.
- For deletes, soft-delete with 30-day undo window.

## 11. Auto-complete detection

VibeSpace can detect that a task got done without the user marking it. Sources:

- **Git:** if a task has `source_ref` pointing to a PR and the PR merges, mark done.
- **Calendar:** if a task is "Meeting prep for X" and the meeting passed, mark done.
- **Email:** if a task is "Reply to Alex" and an outgoing email to Alex with relevant subject just sent, propose mark done.
- **Chat with another person:** if the task is "Send the API spec to Bob" and a message containing "API spec" was sent in the user's connected chat, propose mark done.
- **Voice:** "I just sent the proposal" -> mark "send proposal" task done.

Detection always proposes (not auto-marks) unless confidence > 0.95 AND user has opted in. Every auto-complete records `completion_evidence` so the user can verify.

## 12. UI surfaces

### To-do panel (right rail of the main app)
- Pinned to the right pane in chat mode, optional dock in council mode.
- Sections: **Now** (in_progress + urgent due today), **Today**, **This Week**, **Later**, **Suggested** (drafts from extractor).
- Drag to reorder. Click to expand. Right-click for context actions.
- Top bar: search, filter by tag/priority/project, "Plan my day" button.

### Floating to-do drawer (menu-bar / tray)
- Tap the tray icon -> drawer slides down with today's list.
- Voice push-to-talk inline.
- Cmd-Shift-T global shortcut to summon.

### In-chat task chips
- When a task is created from a chat (via voice or extractor), it appears as a chip inline in the chat with status, due date, and a "View" link.
- Real-time status updates if the task changes elsewhere.

### Mobile
- Today list as the home tab.
- Voice button as the primary FAB.
- Swipe right to complete, swipe left for snooze picker.
- Lock-screen widget (iOS / Android) showing next 3 tasks.

### Watch
- Complication on watch face: next task title + countdown.
- Notification with quick complete / snooze actions.

## 13. Privacy posture

- Tasks live local-first by default. No cloud sync without explicit opt-in.
- Voice transcripts of task creation kept only as long as the audit log retention setting (default 30 days, configurable to "never" for paranoid users).
- External sync is per-task explicit; no bulk export by default.
- Extractor agent runs on the user's machine for cascade voice; on the cloud for S2S voice (with the user's consent acknowledged at setup).

## 14. Edge cases & failure modes

- **Time zone changes.** All times stored as UTC with the user's TZ at creation. When the user travels, reminders re-schedule based on current local TZ unless the task has a fixed-tz flag (e.g., "fly to NYC for 9am ET meeting").
- **DST shifts.** Smart scheduler reads IANA TZ rules; we don't hardcode offsets.
- **OS notification permission denied.** App surfaces a one-time banner explaining what notifications enable, with a deep link to system settings.
- **External sync API down.** Tasks remain local; sync queue drains on reconnect.
- **Task created via voice in privacy mode but external sync wants to push.** Block, ask user.
- **Two devices snooze the same reminder offline.** LWW per field with conflict log.
- **User cancels a task that has 3 dependent tasks.** Surface the dependents and ask "cancel them too?" rather than silent orphaning.

## 15. Phase 1 MVP cut

For the first release we ship:

- Task CRUD + Reminder CRUD.
- Local Clock timers/alarms that work without sign-in and fire sound + notification.
- Smart scheduler (deadline pressure + quiet hours + meeting avoidance).
- Voice intents (create, modify, complete, query, snooze).
- OS native banners + tray badge + sound.
- Daily plan briefing in-app (voice version Phase 2).
- Action Extractor agent for chats only (meetings = Phase 2).
- Apple Reminders + Google Tasks two-way sync.
- iOS push (Android Phase 2).

Defer to Phase 2:
- Watch.
- Email/SMS digests.
- Auto-complete detection (manual only at MVP).
- Linear / Notion / Todoist sync.
- Meeting extraction (depends on the meeting capture pipeline).

## 16. Success metrics

Phase 1 (closed beta):
- 70%+ of users create at least one task in the first week.
- 50%+ of users use voice to create at least one task.
- 60%+ of reminders fire and result in task completion within 4 hours.
- < 5% of reminders dismissed as "wrong time" (fed back into smart scheduler).
- 30% of accepted tasks come from the extractor (auto-suggested, not manually typed).

These numbers are how we know the system is actually shifting work into VibeSpace instead of asking users to remember to use it.

---

*See `04-voice-jarvis-layer.md` for voice intent classification details, `03-multi-agent-orchestration.md` for how the Action Extractor fits in the agent topology, and `02-system-architecture.md` for where the Task Service lives in the runtime.*
