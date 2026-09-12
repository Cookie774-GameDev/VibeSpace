# VibeSpace PR #31 — Browser Chat Workspace, Session Mapping, MCP Power Tools, Project Sync, and Native WebView Master Goal

**Goal ID:** `VS-PR31-BROWSER-CHAT-WORKSPACE-MCP-20260810`  
**Repository:** `Cookie774-GameDev/VibeSpace`  
**Target PR:** `#31`  
**Target branch:** `agent/pr30-fixes-and-updates`  
**Observed PR head when this goal was authored:** `cd50c22266a89dcd2898b70e7a6d6713ee06e679`  
**Owner direction date:** `2026-08-10`  
**Priority:** P0/P1 product functionality, native stability, truthful state, maximum practical efficiency and quality  
**Execution model:** one coordinating implementation agent, bounded specialized workers when useful, and one mandatory independent code-review verifier before completion  
**Release rule:** do not merge PR #31 or publish a release merely because this goal passes; follow the broader PR31 release gates

---

## 0. Scope override and relationship to the existing PR31 master goal

This is a later owner-directed **Browser Chat / VibeSpace MCP master goal** for PR31.

It refines the existing implementation instead of replacing the application architecture. For this scope only, this goal supersedes older PR31 instructions where they conflict with the owner’s newer direction, especially older assumptions that:

- Browser Chat must remain permanently read-only;
- the Browser Chat relay can expose only `fs.list` and `fs.read`;
- Browser Chat write, terminal, Git, browser-control, Playwright, or downstream MCP tools must remain unavailable forever;
- no sub-agent may be used under any circumstance.

For this goal, the correct contract is:

1. **The VibeSpace MCP remote endpoint is a real running MCP service.**
2. **The VibeSpace desktop relay automatically runs/reconnects while VibeSpace is open and the VibeSpace account is signed in.**
3. **The user explicitly connects the VibeSpace MCP/app in ChatGPT using the live VibeSpace MCP link and completes the provider’s normal authorization flow.**
4. **No browser injection, DOM scraping, cookie stealing, response scraping, or Playwright automation is used to connect the MCP to ChatGPT.**
5. **MCP capabilities are controlled by a user-selected VibeSpace permission plan/profile.**
6. **Read-only is one selectable permission profile, not the permanent product architecture.**
7. **Write files, edit files, delete within granted scope, terminal commands, Git, VibeSpace browser control, Playwright browser automation, and approved downstream MCP tools are target capabilities when the connected ChatGPT plan/provider surface supports those tool actions.**
8. **The UI must report the real platform/tool limitation when the provider does not support a requested action. Never fake a working write tool.**
9. **A mandatory independent code-review sub-agent must inspect the completed Browser Chat/MCP diff and verification evidence before this goal is called complete.**

Current OpenAI platform behavior must be re-verified immediately before implementation and release. At the time this goal was authored, OpenAI’s official documentation states that full MCP write/modify actions are available on ChatGPT Business and Enterprise/Edu, while Pro custom MCP use is limited to read/fetch. The implementation must adapt to actual provider capability rather than hardcoding a false universal promise.

---

# PART I — MISSION AND PRODUCT CONTRACT

## 1. Mission

Turn the existing PR31 Browser Chat into a first-class VibeSpace workspace system where the real provider browser session remains the provider-owned conversation surface, while VibeSpace owns the organization, session mapping, projects, saved browser chats, pinned chats, history, local context, files, tools, terminals, browser automation, outputs, status, and MCP permission controls around it.

The finished experience must make Browser Chat feel like a native part of VibeSpace:

- one Browser Chat entry in the main VibeSpace navigation;
- a dedicated Browser Chat session rail inside Browser Chat;
- many saved provider conversations without cluttering the main VibeSpace sidebar;
- click any saved Browser Chat and reopen the exact mapped provider conversation;
- create new Browser Chats;
- rename them locally;
- pin/unpin them;
- move them between VibeSpace projects;
- link a VibeSpace project to a provider project such as a ChatGPT Project;
- automatically restore Browser Chat sessions after app restart;
- keep the provider login/session profile alive;
- keep the VibeSpace MCP relay alive and reconnecting while VibeSpace is running;
- show real connection/page/tool/project/output status;
- let the user switch between a minimal provider-browser experience and the richer VibeSpace Browser Chat workspace experience without logging in again or creating a second provider session;
- eliminate the current lag/trailing behavior of the small native provider window by migrating to a true child WebView architecture where supported;
- expand the VibeSpace MCP from the current read-only bridge into a permission-plan-based tool gateway;
- verify every user-visible success state with real runtime evidence.

This is not permission to fabricate synchronization or tool access. If a provider does not expose a supported API or integration surface for a requested capability, the product must show that limitation truthfully and implement the strongest supported fallback.

---

## 2. Core architecture

The target architecture is:

```text
VibeSpace account
    │
    ├── VibeSpace workspace/project database
    │      ├── Projects
    │      ├── Native chats
    │      ├── Browser Chat wrappers/bindings
    │      ├── History/search metadata
    │      ├── Context
    │      ├── Files/outputs
    │      └── Permission profiles
    │
    ├── Browser Chat UI
    │      ├── Provider Sessions rail
    │      ├── Pinned Browser Chats
    │      ├── Saved Browser Chats
    │      ├── Live statuses
    │      └── True child provider WebView
    │
    ├── VibeSpace desktop relay
    │      ├── automatically starts while signed in
    │      ├── reconnects automatically
    │      ├── advertises only user-enabled capabilities
    │      └── executes local capabilities
    │
    └── VibeSpace MCP cloud endpoint
           ├── OAuth/account authority
           ├── ChatGPT custom app/MCP connection
           ├── tool discovery
           ├── capability truth
           └── tool routing to the correct signed-in desktop
```

The ChatGPT/Claude/Gemini provider page remains provider-owned. VibeSpace does not replace the provider’s actual model runtime or copy a consumer subscription into an unofficial API.

---

# PART II — CURRENT PR31 BASELINE TO REFINE

## 3. Existing systems that must be reused

Do not rebuild these systems from scratch. Audit them and extend them.

### Existing Browser Chat

Primary current paths include:

- `app/src/features/browser-chat/BrowserChatHub.tsx`
- `app/src/features/browser-chat/BrowserProviderSurface.tsx`
- `app/src/features/browser-chat/browserChatStore.ts`
- `app/src/features/browser-chat/providerRegistry.ts`
- `app/src/features/browser-chat/providerSurface.ts`
- `app/src/features/browser-chat/mcpConnection.ts`
- `app/src/features/browser-chat/workspaceGrant.ts`
- `app/src-tauri/src/browser_chat_surface.rs`
- `app/src/lib/bridge/useBrowserChatRelay.ts`
- `app/src/lib/bridge/BridgeClient.ts`

The current Browser Chat implementation already has:

- native/browser engine selection per VibeSpace chat;
- provider selection;
- provider page status;
- provider-specific browser profiles;
- a VibeSpace MCP connection flow;
- an authenticated desktop relay;
- a project grant concept;
- a Provider Sessions / saved-browser-chat concept in the Browser Chat hub;
- native provider-window isolation;
- system-browser fallback.

Preserve working behavior.

### Existing VibeSpace projects/chats/history

Reuse:

- `app/src/features/chat/chatLifecycle.ts`
- `app/src/types/chat.ts`
- `app/src/lib/db/schema.ts`
- `app/src/lib/db/repositories.ts`
- `app/src/components/layout/NavPane.tsx`
- `app/src/features/projects/ProjectDetail.tsx`
- `app/src/features/history/HistoryPage.tsx`
- `app/src/features/history/HistoryList.tsx`

The application already has:

- projects;
- project-scoped chats;
- chat titles;
- chat pinning;
- archived state;
- project context/instructions;
- project agent allowlists;
- local-first persistence;
- cloud-sync queue support for projects/chats/messages;
- history;
- title/body search for VibeSpace-owned messages;
- project filtering.

Browser Chat must integrate with these existing records rather than creating an unrelated second chat manager.

### Existing MCP foundations

Reuse and refine:

- `workers/vibespace-mcp/`
- `app/src/lib/mcp/`
- `app/src/lib/bridge/BridgeClient.ts`
- existing native file capability brokers;
- existing terminal capability brokers;
- existing Git brokers;
- existing browser/Playwright workers;
- existing canonical approval infrastructure;
- existing MCP SDK adapter and gateway infrastructure.

The current Browser Chat bridge advertises only safe read tools. This goal expands that architecture through explicit permission profiles and proper capability routing.

---

# PART III — BROWSER CHAT UX

## 4. One main Browser Chat entry

The main VibeSpace sidebar must not contain 50 separate Browser Chat rows.

The main navigation should expose **one Browser Chat entry**.

Clicking Browser Chat opens the Browser Chat workspace. Inside that workspace is its own left rail containing all Browser Chat sessions.

Native VibeSpace chats remain in the normal Chats/Projects navigation unless the existing product design already intentionally mixes them.

The Browser Chat session rail is the authoritative organizer for provider-browser sessions.

---

## 5. Browser Chat session rail

Inside Browser Chat, create/refine a left-hand session rail with sections:

```text
BROWSER CHAT

+ New Browser Chat

PINNED
  ● PR31 MCP debugging            ChatGPT
  ● Marketing research           ChatGPT

PROVIDER SESSIONS
  ◌ New browser chat             ChatGPT
  ● PR31 Browser architecture    ChatGPT
  ● Mobile planning              ChatGPT
  ● Claude research              Claude
```

Each row must support:

- title;
- provider icon/name;
- local VibeSpace project;
- pin/unpin;
- rename;
- remove local binding;
- open externally;
- last opened time;
- page state;
- VibeSpace MCP/tool activity state;
- active/working status when VibeSpace has real evidence;
- error state;
- optional task summary derived from VibeSpace-owned activity;
- context menu;
- keyboard navigation;
- accessible labels.

Do not infer ChatGPT’s internal “thinking” state by scraping the provider DOM. “Working” may be shown when VibeSpace has an active MCP call, terminal run, Playwright run, VibeSpace task/run, known navigation/load operation, or another verified VibeSpace-owned activity. If generic provider generation state is not officially exposed, show no fake activity.

Pinned Browser Chats must use the existing VibeSpace pin semantics where practical.

---

## 6. Browser Chat presentation modes

Add an explicit Browser Chat presentation switch with at least:

### Provider mode

A minimal provider-browser experience close to the current Browser Chat behavior.

- real provider page;
- minimal VibeSpace chrome;
- same provider profile/session;
- same mapped Browser Chat;
- same MCP relay;
- no duplicate login;
- no recreated provider session merely because the view mode changed.

### VibeSpace mode

The full integrated Browser Chat workspace.

Show:

- Browser Chat session rail;
- provider session status;
- page status;
- MCP authorization/connection status;
- desktop relay status;
- enabled tool/permission profile;
- active local project;
- linked provider project if any;
- project grant/root state;
- VibeSpace MCP activity;
- outputs/files generated by VibeSpace tools;
- provider/model/usage data only when truthfully available;
- main provider child WebView.

Switching Provider ↔ VibeSpace mode must reuse the same child WebView/profile and must not sign the user out.

Keep an **Open externally** action.

---

# PART IV — BROWSER CHAT SESSION MAPPING

## 7. Browser Chat binding model

Add a durable Browser Chat binding model. Exact naming may change after code review, but the contract should include:

```ts
type BrowserChatBinding = {
  id: string;
  account_id: string;
  workspace_id: string;
  project_id?: string;
  chat_id: string;
  provider: 'chatgpt' | 'claude' | 'gemini';
  provider_profile_key: string;
  provider_conversation_key?: string;
  resume_url?: string;
  provider_project_key?: string;
  binding_state: 'new' | 'bound' | 'unavailable' | 'stale';
  created_at: number;
  updated_at: number;
  last_opened_at?: number;
};
```

Rules:

- one VibeSpace Browser Chat wrapper maps to at most one active provider conversation for that provider/profile;
- mapping is account-scoped;
- mapping is workspace-scoped;
- never bind a conversation to a different VibeSpace account by accident;
- never store provider passwords;
- never copy provider cookies into the application database;
- never copy ChatGPT response bodies through DOM scraping;
- if storing a resume URL, validate scheme/host/path and keep it provider-allowlisted;
- treat provider URLs/conversation IDs as private metadata;
- support migrations/versioning.

Add proper database schema versioning and repositories instead of loose localStorage-only state.

---

## 8. New Browser Chat creation

When the user clicks **+ New Browser Chat**:

1. create a normal VibeSpace `Chat` row using the existing chat lifecycle;
2. set Browser Chat engine/provider preference for that chat;
3. create a `BrowserChatBinding` in `new` state;
4. open the provider’s supported new-chat surface in the existing provider profile;
5. observe top-level navigation through the native WebView host;
6. when a stable provider conversation location becomes available through a supported top-level navigation signal, bind it;
7. persist the binding;
8. update the local Browser Chat row;
9. do not claim “bound” before it actually is.

If the provider does not expose a stable supported conversation URL/location, keep the session as an unbound provider session and provide a truthful fallback.

Do not use provider DOM scraping to discover the conversation.

---

## 9. Reopen saved Browser Chats

Clicking a saved Browser Chat must:

- activate its VibeSpace chat;
- activate its project if appropriate;
- use the correct provider;
- use the correct provider profile;
- reuse the child WebView;
- navigate to the stored validated provider conversation/resume location;
- restore the Browser Chat toolbar/status context;
- update `last_opened_at`;
- surface a real error if the provider rejects/changes the location.

App restart acceptance:

1. create at least three Browser Chats;
2. pin one;
3. rename one;
4. assign them to projects;
5. quit VibeSpace;
6. reopen VibeSpace;
7. Browser Chat list is restored;
8. selected/pinned metadata is restored;
9. clicking every saved Browser Chat reopens the correct conversation or reports a truthful provider-side limitation.

---

## 10. Provider navigation reconciliation

When the user clicks another conversation inside the provider page:

- listen only to supported top-level WebView navigation events;
- normalize the provider location through a provider adapter;
- if the location matches an existing Browser Chat binding, select that Browser Chat row;
- if it represents a new provider conversation that was entered manually, offer or automatically create a lightweight VibeSpace Browser Chat wrapper according to a user setting;
- never read DOM content merely to obtain a title;
- use a local generated placeholder title until the user renames it or an official supported metadata source/import provides the real title;
- avoid duplicate wrappers for the same provider/profile/conversation key.

Provider URL pattern logic must live behind provider-specific adapters and tests. Do not scatter ChatGPT URL assumptions throughout React code.

---

# PART V — PROJECTS

## 11. VibeSpace project ownership

VibeSpace Projects remain the primary VibeSpace organization model.

A project may contain:

- native VibeSpace chats;
- Browser Chat bindings;
- files;
- context;
- agents;
- terminals;
- tasks/Kanban;
- schedules;
- outputs;
- browser sessions;
- tool permission profile.

Moving a Browser Chat between VibeSpace projects updates the local project relationship without pretending it moved the remote ChatGPT conversation between ChatGPT Projects unless a real supported provider action succeeds.

---

## 12. Link VibeSpace Project ↔ ChatGPT Project

Add a project-provider link model, for example:

```ts
type ProviderProjectLink = {
  id: string;
  account_id: string;
  workspace_id: string;
  project_id: string;
  provider: 'chatgpt' | 'claude' | 'gemini';
  provider_project_key?: string;
  provider_project_url?: string;
  state: 'linked' | 'stale' | 'unsupported';
  created_at: number;
  updated_at: number;
  last_verified_at?: number;
};
```

In Project Detail add a **Browser/Provider Project** section:

- Link current ChatGPT Project;
- Unlink;
- Open linked ChatGPT Project;
- show linked state;
- show last verified state;
- do not show “synced” unless real synchronization is proven.

When a VibeSpace project has a linked ChatGPT Project:

- opening Browser Chat from that VibeSpace project may open the linked provider project landing page;
- new Browser Chats should inherit the local VibeSpace project;
- if the provider offers a supported way to create/move conversations within the linked remote project, use it;
- otherwise let the provider UI own remote project membership and keep VibeSpace membership independent and truthful.

---

## 13. Live provider project/chat synchronization goal

The desired end state is live synchronization of provider chats/projects where the provider officially supports it.

Implementation protocol:

1. research the **current official provider surface** at execution time;
2. prefer a documented provider API, supported account sync interface, compliance API where applicable, official app capability, or another documented supported method;
3. implement a provider-sync adapter only against a supported method;
4. create cursor/checkpoint/deduplication logic;
5. sync titles, IDs, project membership, timestamps, and other metadata only if the provider exposes them;
6. account-scope everything;
7. provide resync, error, stale, disconnected, and conflict states;
8. never call a DOM scraper “live sync.”

If the user’s ChatGPT plan does not expose a supported API for personal chat/project synchronization, do **not** fake this milestone. Mark the true live remote sync portion `BLOCKED — PROVIDER CAPABILITY` while completing:

- Browser Chat navigation/resume mapping;
- VibeSpace project organization;
- official ChatGPT export import;
- provider project link shortcuts;
- deduplication;
- local history/search.

The UI must distinguish **Local VibeSpace organization**, **Imported provider snapshot**, and **Live provider sync**.

---

# PART VI — HISTORY AND IMPORT

## 14. Browser Chats in VibeSpace History

Extend the existing History system so Browser Chats appear alongside native chats with explicit source badges.

Browser Chat History rows must support:

- title;
- provider;
- project;
- pinned state;
- created/last-opened dates;
- mapping state;
- open/reopen;
- rename;
- move project;
- remove local binding;
- search by local metadata.

Do not pretend VibeSpace has full message replay for a live browser conversation unless those messages entered VibeSpace through a supported import/API.

For non-imported Browser Chats, History replay should show a Browser Chat summary card and **Open conversation** action.

---

## 15. Official ChatGPT export import

Add an **Import ChatGPT Export** flow.

Requirements:

- accept an official user-export ZIP chosen by the user;
- inspect the archive defensively;
- detect supported export structures rather than trusting one forever-fixed filename;
- parse conversations as untrusted data;
- never execute HTML/scripts from the export;
- support large archives with progress/cancellation;
- deduplicate imports;
- preserve provider conversation identifiers when present;
- preserve titles/timestamps when present;
- import project metadata when present and supported;
- map imported snapshots to existing Browser Chat bindings where a stable identifier matches;
- keep imported messages as provider-import snapshots, separate from native VibeSpace message authority;
- let imported messages participate in History search/replay;
- expose import date and source;
- support re-import/update without multiplying duplicates;
- support delete imported snapshot without deleting remote ChatGPT data.

Suggested source marker:

```ts
browser_history_source:
  | 'vibespace_binding'
  | 'provider_export_snapshot'
  | 'provider_live_sync';
```

---

# PART VII — MCP: ALWAYS RUNNING, USER-CONNECTED, PERMISSION CONTROLLED

## 16. Always-running VibeSpace MCP contract

The system has two related components:

### Remote VibeSpace MCP endpoint

The deployed VibeSpace MCP endpoint is intended to remain available as the remote MCP service.

### Desktop relay

When:

- VibeSpace is running; and
- the VibeSpace account is signed in;

the Browser Chat desktop relay must automatically:

- start;
- authenticate;
- obtain fresh relay tickets;
- connect;
- register its capability profile;
- heartbeat;
- reconnect with bounded backoff;
- rotate tickets correctly;
- survive temporary network loss;
- refresh after auth changes;
- stop/revoke cleanly on sign-out;
- stop when the app fully exits unless the user explicitly enables a supported VibeSpace background/tray mode.

A local project grant is not required merely for the relay to be online. The relay may connect with zero local capabilities enabled.

The user connects the MCP/app on the ChatGPT side using the canonical live VibeSpace MCP endpoint. VibeSpace may assist by:

- validating the endpoint;
- copying it;
- opening the provider’s supported app/developer settings;

but the provider authorization is user-owned and must remain truthful.

---

## 17. MCP permission plans

Replace the current permanent read-only Browser Chat bridge with explicit user-controlled permission profiles.

Minimum profiles:

### Off

- relay may remain online;
- exposes no local tools.

### Read

- project/context metadata;
- directory listing;
- bounded file reads;
- optional approved external read-only MCPs.

### Project Developer

- read files;
- create/write/edit files inside approved roots;
- create directories;
- rename/move inside scope;
- optional delete/trash according to configured approval behavior;
- Git read/status/diff;
- approved Git write operations;
- terminal execution within configured project roots;
- VibeSpace browser/Playwright tools;
- downstream MCP invocation according to each connection’s capability.

### Full Local Developer

- all Project Developer tools;
- multiple explicitly granted roots;
- wider terminal working-directory choices;
- configured local application/tool actions;
- optional sensitive-file access when the user explicitly enables it;
- optional external side-effect tools.

### Custom

Granular toggles for every capability family.

The permission profile is the VibeSpace-side authority. It must be:

- visible;
- persisted per account/project where chosen;
- changeable;
- revocable immediately;
- reflected in the MCP tool catalog;
- reflected in the desktop registration frame;
- reflected in the Browser Chat status UI.

Do not hardcode `writable: false` and `shell_enabled: false` after the user selected a profile that enables them.

Do not advertise a tool that the desktop cannot actually execute.

---

## 18. Approval behavior is user-configurable

For mutation-capable profiles, provide an approval policy per capability or profile:

- Ask every time;
- Ask once for this session;
- Allow automatically inside approved project/root;
- Always block.

High-impact external or destructive actions may still be constrained by provider/OS/platform safety requirements. Do not bypass ChatGPT’s own required confirmations.

VibeSpace must show exactly which layer denied a tool:

- VibeSpace permission profile;
- missing project/root grant;
- provider plan does not support write/full MCP;
- ChatGPT app action disabled;
- tool unavailable locally;
- approval required;
- OS permission denied;
- timeout/cancelled;
- runtime failure.

---

# PART VIII — MCP TOOL SURFACE

## 19. File tools

Build real MCP tool adapters for the permission profiles.

Target file tools include:

- list directory;
- stat;
- read text/bounded binary metadata;
- create file;
- write file;
- edit/patch file;
- create directory;
- rename/move;
- copy;
- delete or trash according to policy;
- search/find;
- optional file hash;
- optional archive/export.

Requirements:

- operate only inside user-approved roots unless Full Local explicitly grants more;
- canonicalize paths;
- protect against traversal;
- return structured results;
- cancellation/timeouts;
- result size limits;
- no fake success;
- safe atomic writes where practical;
- change preview/diff for edit operations when configured;
- logs/evidence.

Sensitive-file handling must be controlled by user permission settings rather than an invisible permanent ban. Default may be conservative, but the user must have a clear explicit configuration path when technically allowed.

---

## 20. Terminal and Git tools

Target terminal tools:

- run command;
- stream command output;
- cancel;
- working directory;
- environment profile;
- timeout;
- exit code;
- command ID;
- optional background job with visible lifecycle.

Reuse the existing native terminal/command authority rather than inventing a second shell.

Target Git tools:

- status;
- diff;
- log;
- branch info;
- add;
- commit;
- restore/revert only with configured authority;
- push/pull/fetch when the user enabled network Git actions;
- worktree awareness.

Never report command success before the real process exits or a real durable background-job state exists.

---

## 21. Browser control and Playwright MCP tools

The user may enable Browser/Playwright control through the MCP permission profile.

This automation is **not** how ChatGPT connects to the VibeSpace MCP.

Browser automation must operate through VibeSpace-owned browser sessions / the existing Browser Agent / Playwright worker infrastructure.

Target tools:

- create/focus browser session;
- navigate;
- back/forward/reload;
- inspect accessibility/actionable state through the approved browser-control layer;
- click/type/select;
- upload/download through approved flows;
- screenshot;
- wait;
- extract permitted page information;
- close session;
- cancellation;
- browser task progress.

Do not use browser automation to steal provider credentials or secretly scrape the ChatGPT consumer conversation surface as a substitute for a supported API.

It is acceptable for the AI to use Playwright on normal VibeSpace-owned browser tasks when the user enables Browser Control.

---

## 22. Downstream MCP tools

Allow the VibeSpace MCP to route approved connected MCP/plugin tools.

Requirements:

- account-scoped connection;
- explicit tool namespace;
- source connection name;
- capability classification;
- read/write/external-side-effect classification;
- user permission profile;
- provider/tool health;
- cancellation;
- tool result normalization;
- no silent cross-account routing.

A downstream MCP connection may have its own OAuth/credential lifecycle; do not copy secrets into ChatGPT.

---

# PART IX — PROJECT CONTEXT MCP REFINEMENT

## 23. Project/context tools

Refine the existing project read system so ChatGPT can request approved VibeSpace project context through MCP.

Target tools:

- list VibeSpace projects available to this account/profile;
- get active project summary;
- get approved project instructions/context;
- get approved context-map summary;
- search approved context;
- list approved files;
- read approved files;
- list recent VibeSpace outputs/artifacts where enabled.

The response must include provenance/trust metadata where the existing VibeSpace context system supports it.

Do not automatically dump huge project context into every request. Expose retrieval tools so the model can request what it needs.

---

# PART X — LIVE STATUS, CONNECTIONS, USAGE, FILES, OUTPUTS

## 24. Browser Chat status model

The Browser Chat VibeSpace mode must expose independent states.

### Provider page

- opening;
- ready;
- error;
- fallback/external;
- current provider.

### Provider session

- profile loaded;
- provider account state only when actually verifiable;
- otherwise `Provider-managed` / `Unknown`, not fake “signed in.”

### VibeSpace account

- signed in/out;
- account identity label.

### MCP authorization

- setup required;
- waiting for user authorization;
- authorized/last-used only when the gateway has evidence of a valid OAuth client interaction;
- stale/re-auth required;
- unknown.

### Desktop relay

- connecting;
- connected;
- reconnecting;
- error;
- offline.

### Tool bridge

- enabled permission profile;
- advertised tool count;
- available tool count;
- unsupported provider actions;
- current tool call;
- last tool result/error.

### Local project

- current VibeSpace project;
- linked provider project;
- granted roots;
- permission profile;
- context available;
- grant revoked.

### Files/outputs

- current running output;
- recent files modified/created through VibeSpace tools;
- artifact links;
- terminal jobs;
- browser tasks;
- errors.

Each badge/status must come from a real source of truth.

---

## 25. Model and OpenAI usage truth

The owner wants model and OpenAI usage visible.

Implement the strongest official live source available, but never fabricate consumer ChatGPT information.

Rules:

- if ChatGPT exposes the current browser-chat model through a supported interface, show it;
- otherwise show `Model: provider-controlled / not exposed to VibeSpace`;
- do not infer model from page text using DOM scraping;
- if official ChatGPT subscription usage/quota is exposed through a supported source, show it live;
- otherwise show the truthful unavailable state;
- VibeSpace OpenAI API/provider usage may be shown separately when VibeSpace owns that connection;
- never mix VibeSpace API usage with ChatGPT subscription quota;
- timestamp usage snapshots and show freshness.

---

# PART XI — TRUE TAURI CHILD WEBVIEW AND LAG FIX

## 26. Replace the floating/trailing provider window

The current Browser Chat provider surface is implemented as a separate native `WebviewWindow` positioned over the VibeSpace content region. This can visually lag/trail while the main window moves or resizes.

Migrate Browser Chat on supported desktop platforms to a **true child WebView** attached to the VibeSpace native window using the current supported Tauri multi-WebView APIs.

The current Tauri API supports adding a child WebView to a window and supports navigation callbacks. Use the current stable/compatible Tauri APIs for the repository version; re-check upstream docs before implementation.

Target:

```text
Main VibeSpace Window
 ├── VibeSpace React WebView
 └── Child Provider WebView
       └── https://chatgpt.com/
```

The provider child WebView remains isolated from VibeSpace privileged IPC unless a narrowly required host capability exists.

---

## 27. Child WebView lifecycle

Required lifecycle:

- create once per active provider profile where practical;
- reuse instead of constantly destroy/recreate;
- show/hide without losing login;
- position/size from the actual Browser Chat content host;
- react to layout changes;
- no repeated focus stealing;
- no create storms during resize;
- serialize lifecycle changes;
- provider switch hides prior surface and activates correct one;
- Browser Chat route exit hides child;
- Browser Chat route return restores child;
- app minimize/restore works;
- fullscreen works;
- scale-factor/DPI changes work;
- multi-monitor movement works;
- no visible trailing separate window.

Avoid high-frequency requestAnimationFrame geometry thrash when a child WebView can be directly parented.

---

## 28. Native navigation event bridge

Add a narrow native event path for **top-level navigation metadata only**.

Purpose:

- Browser Chat conversation mapping;
- provider project linking;
- browser history binding;
- supported popup/external-link handling.

The event must contain only bounded provider navigation metadata such as:

- provider;
- child WebView/session ID;
- normalized allowlisted top-level URL;
- timestamp;
- navigation type if available.

Do not send DOM content, cookies, page HTML, prompts, or responses.

---

## 29. Anti-lag acceptance

Manual/native acceptance:

- drag the VibeSpace window continuously across the screen;
- resize from every edge/corner;
- maximize/restore;
- move between different-DPI monitors if available;
- toggle sidebar widths;
- toggle Provider/VibeSpace Browser Chat mode;
- switch providers rapidly.

Expected:

- no detached mini-window trail;
- no obvious delayed provider surface;
- no provider surface outside its host bounds;
- no repeated provider login;
- no flickering duplicate windows;
- no input lock;
- no stuck always-on-top surface;
- no focus war between VibeSpace and ChatGPT;
- no unbounded CPU increase.

Capture performance evidence.

---

# PART XII — PERSISTENCE AND ACCOUNT ISOLATION

## 30. Persisted Browser Chat state

Persist:

- bindings;
- pin state;
- local titles;
- provider;
- provider project link;
- VibeSpace project;
- last opened;
- view mode preference;
- permission profile;
- approved roots according to existing security/persistence policy;
- import snapshot metadata.

Do not persist:

- provider passwords;
- raw cookies outside provider-owned browser profile storage;
- hidden secrets in normal app storage.

Cloud-sync only fields that are safe and intended to roam. Provider local profile paths/connection internals should remain local.

---

## 31. Multi-account isolation

Test:

- VibeSpace account A cannot see account B Browser Chat bindings;
- provider profile A does not accidentally open under account B binding;
- desktop relay ticket identity is account-scoped;
- project grants are account/project-scoped;
- imported exports are account-scoped;
- provider project links are account-scoped;
- switching VibeSpace accounts clears/changes active Browser Chat scope immediately;
- no stale tool call from the old account completes into the new account.

---

# PART XIII — IMPLEMENTATION MILESTONES

## 32. Milestone 0 — refresh baseline

Before writes:

- confirm repo/branch/PR;
- fetch newest PR31 head;
- inspect dirty/uncommitted work in the owner’s actual worktree if executing locally;
- do not overwrite unrelated PR31 work;
- run focused Browser Chat/MCP tests;
- record current native behavior;
- record current relay/tool catalog;
- record current Browser Chat UI screenshots/evidence;
- re-verify current official OpenAI MCP plan capabilities;
- re-verify current Tauri child-WebView API.

---

## 33. Milestone 1 — data model and session repository

Implement:

- Browser Chat binding table/repository;
- provider project link table/repository;
- schema migrations;
- account isolation;
- project relationship;
- session list selectors;
- pin/rename/remove/update operations;
- tests.

---

## 34. Milestone 2 — Browser Chat session rail

Implement/refine:

- one main Browser Chat nav entry;
- internal Provider Sessions rail;
- pinned section;
- saved section;
- new Browser Chat;
- rename;
- pin/unpin;
- move project;
- status indicators;
- keyboard/accessibility;
- no fake “working.”

---

## 35. Milestone 3 — conversation mapping and reopen

Implement:

- provider adapter interface;
- top-level navigation metadata;
- new-chat binding;
- existing-binding matching;
- reopen exact mapped conversation;
- restore after restart;
- duplicate prevention;
- stale binding recovery;
- focused tests.

---

## 36. Milestone 4 — true child WebView

Implement:

- child WebView host;
- provider profiles;
- hide/show/reuse;
- native navigation callback;
- geometry lifecycle;
- route lifecycle;
- Provider/VibeSpace mode reuse;
- system-browser fallback;
- Windows native smoke;
- lag/performance evidence.

Do not remove the old WebviewWindow path until the new path proves equivalent/recoverable or until a deliberate fallback is kept for unsupported platforms.

---

## 37. Milestone 5 — project/provider project linking

Implement:

- Provider Project section in Project Detail;
- link current project page;
- unlink;
- open;
- verified/stale status;
- relationship to Browser Chat creation;
- no false remote membership.

---

## 38. Milestone 6 — History and export import

Implement:

- Browser Chat History rows;
- source badges;
- open/reopen;
- imported snapshot support;
- official export ZIP import;
- dedupe;
- search/replay imported content;
- safe parser;
- large import progress/cancel;
- tests.

---

## 39. Milestone 7 — MCP permission-profile framework

Refactor current Browser Chat bridge registration:

- permission profile store;
- tool capability registry;
- dynamic advertised tools;
- dynamic write/shell/browser/MCP states;
- grant model;
- approval policy;
- real tool health;
- capability diff on profile change;
- reconnect/update workflow;
- provider full-MCP capability truth.

Keep existing read tools working through migration.

---

## 40. Milestone 8 — write/file/terminal/Git tools

Wire existing native brokers into Browser Chat MCP:

- write/edit/create;
- safe deletion according to plan;
- terminal command execution;
- cancellation;
- Git;
- structured results;
- activity/status;
- outputs;
- tests;
- real fixture execution.

---

## 41. Milestone 9 — Playwright/browser tools

Wire existing VibeSpace browser/Playwright runtime into MCP:

- browser session lifecycle;
- actions;
- screenshots;
- extraction through approved browser system;
- cancellation;
- status;
- tests;
- no use for ChatGPT MCP connection itself.

---

## 42. Milestone 10 — downstream MCP

Expose approved installed MCP/plugin capabilities through VibeSpace’s account-scoped gateway.

Test at least:

- one read tool;
- one write/external-side-effect fixture tool when provider plan supports it;
- cancellation;
- disconnected tool;
- wrong account;
- permission denied.

---

## 43. Milestone 11 — project context refinement

Implement/refine:

- project summary;
- instructions;
- context search;
- approved context map;
- files;
- outputs;
- bounded result sizes;
- provenance/trust;
- tests.

---

## 44. Milestone 12 — provider sync adapter

Research and implement supported live provider chat/project sync where available.

If unsupported for the owner’s ChatGPT plan/account:

- produce exact evidence;
- mark provider live sync blocked;
- leave all local binding/import/link features working;
- never use DOM scraping to check a box.

---

## 45. Milestone 13 — live status and outputs panel

Make every Browser Chat status live and independent.

Wire:

- provider page;
- relay;
- MCP authorization evidence;
- permission profile;
- tool catalog;
- project;
- provider project link;
- active tool run;
- terminal run;
- browser run;
- file outputs;
- usage freshness;
- errors/recovery.

---

# PART XIV — AUTOMATED TESTING

## 46. Focused unit/integration suites

At minimum cover:

- Browser Chat binding repository;
- duplicate mapping;
- account isolation;
- project moves;
- pin/rename;
- provider URL adapter validation;
- resume navigation;
- stale URL;
- provider switch;
- permission profile serialization;
- capability calculation;
- approval modes;
- tool advertisement;
- write tool success/failure;
- terminal timeout/cancel;
- browser run cancel;
- downstream MCP isolation;
- import dedupe;
- project-link lifecycle;
- status truth;
- sign-out cancellation;
- reconnect fresh tickets.

---

## 47. Rust/native tests

Cover:

- child WebView provider allowlist;
- caller authority;
- child creation;
- show/hide;
- navigation metadata;
- geometry;
- lifecycle serialization;
- scale factor;
- invalid provider;
- invalid URL;
- no privileged provider IPC;
- route exit cleanup;
- crash/error propagation.

---

## 48. MCP worker tests

Update `workers/vibespace-mcp` tests for:

- permission-aware tool catalog;
- account-scoped routing;
- read tools;
- write tools;
- terminal tools;
- browser tools;
- downstream MCP proxy tools;
- unsupported-provider action state;
- OAuth/client identity;
- relay offline;
- project profile changes;
- large result handling;
- cancellations/timeouts;
- stale tool snapshots.

Re-run worker typecheck and deployment dry-run.

---

## 49. Full repository gates

At coherent checkpoints and final:

```text
npm run typecheck
npm --prefix app run test
npm run test:release-manifest
npm run build
cargo check --manifest-path app/src-tauri/Cargo.toml
```

Also run the existing AI-boundary workflow/tests and Browser Chat-specific focused suites.

Do not hide failing tests by deleting or weakening them.

---

# PART XV — HUMAN / NATIVE ACCEPTANCE

## 50. Browser Chat human test script

A human tester must verify the installed Windows/Tauri app.

### Setup

- sign into VibeSpace;
- open Browser Chat;
- ensure ChatGPT provider session can sign in normally;
- connect VibeSpace MCP using the live MCP link through ChatGPT’s supported flow;
- confirm relay state.

### Sessions

- create Browser Chat A;
- create Browser Chat B;
- create Browser Chat C;
- pin B;
- rename C;
- switch among them;
- verify exact mapped conversation reopens;
- close/reopen app;
- repeat.

### Projects

- assign A to Project 1;
- assign B to Project 2;
- link Project 1 to a ChatGPT Project;
- open the linked project;
- unlink/relink;
- verify no false remote move.

### Provider/VibeSpace modes

- switch mode repeatedly;
- same account remains signed in;
- same conversation remains active;
- no WebView recreation loop;
- no lag trail.

### MCP permissions

For each available profile:

- Off;
- Read;
- Project Developer;
- Full Local Developer;
- Custom.

Verify actual advertised tools change.

On a provider plan supporting full MCP actions, verify:

- read file;
- write fixture file;
- edit fixture file;
- run safe terminal fixture command;
- Git status/diff;
- browser/Playwright fixture;
- downstream MCP fixture.

On a provider plan not supporting write actions, verify the UI reports the provider limitation and does not pretend write succeeded.

### Revoke

- revoke project/root;
- attempt tool call;
- confirm denial;
- re-enable;
- confirm restored capability.

### Sign out

- sign out VibeSpace;
- relay stops;
- tool calls no longer reach desktop;
- provider browser account remains provider-owned and is not silently modified.

---

# PART XVI — PERFORMANCE

## 51. Browser Chat performance budgets

Measure:

- Browser Chat route open latency;
- child WebView first creation;
- reused WebView show latency;
- chat switch latency;
- 10 saved Browser Chats;
- 50 saved Browser Chats;
- session rail render;
- moving/resizing main window;
- provider switch;
- relay idle CPU;
- relay reconnect;
- Browser Chat idle RAM;
- import memory;
- large History search.

Targets must be evidence-based, but enforce:

- no unbounded session list rendering;
- no per-frame native geometry RPC loop when unnecessary;
- no hidden provider WebView busy loop;
- no duplicate relay instances;
- no duplicate provider profile for the same intended session;
- no full app rerender on every status tick;
- bounded logs;
- bounded reconnect;
- virtualize/session-window if lists grow large.

---

# PART XVII — INDEPENDENT CODE REVIEW SUB-AGENT

## 52. Mandatory reviewer

Before this goal is marked complete, launch an independent **Browser Chat/MCP Code Review sub-agent**.

The reviewer must not simply read the implementation agent’s summary.

Give the reviewer:

- current PR31 head;
- this master goal;
- Browser Chat changed-file list;
- MCP changed-file list;
- schema migrations;
- tests;
- CI results;
- native evidence.

The reviewer must independently inspect the code and try to disprove completion.

---

## 53. Reviewer checklist

The reviewer must look specifically for:

- fake success states;
- “connected” inferred from page load;
- “authorized” without gateway evidence;
- write tool advertised but not implemented;
- terminal tool returning before real execution;
- browser tool placeholder;
- permission profile not actually enforced;
- stale account/project grant;
- cross-account data leaks;
- provider URL spoofing;
- path traversal;
- shell argument injection;
- replayed relay calls;
- stale relay tickets;
- child WebView privileged IPC exposure;
- provider DOM injection;
- Browser Chat session duplicates;
- restart restore failures;
- WebView recreate loops;
- lag caused by geometry polling;
- provider profile/session loss;
- History pretending to contain messages it does not own;
- “live sync” implemented by unsupported scraping;
- imported export duplication;
- hidden provider-plan limitations;
- model/usage values that are not actually sourced;
- tests that only mock success and never exercise failure;
- error swallowing;
- unbounded retries;
- unbounded output;
- listener/timer leaks.

The reviewer must classify findings P0/P1/P2.

---

## 54. Review closure protocol

1. reviewer produces findings;
2. implementation coordinator fixes all P0/P1 findings or records an evidence-backed blocker;
3. rerun focused tests;
4. rerun repository gates;
5. rerun native smoke for affected areas;
6. reviewer performs a second bounded verification of fixes;
7. only then may the goal report the slice as verified.

A review comment saying “looks good” without evidence is not sufficient.

---

# PART XVIII — EVIDENCE AND NO-FAKE-SUCCESS CONTRACT

## 55. Allowed completion labels

Use:

- `VERIFIED`;
- `IMPLEMENTED — NATIVE VERIFICATION REQUIRED`;
- `IMPLEMENTED — PROVIDER VERIFICATION REQUIRED`;
- `BLOCKED — PROVIDER CAPABILITY`;
- `BLOCKED — OWNER ACTION REQUIRED`;
- `BLOCKED — TECHNICAL`;
- `NOT STARTED`.

Never use “fully working” merely because TypeScript compiles.

---

## 56. Evidence per feature

For each milestone record:

- exact starting head;
- exact ending head;
- files changed;
- root cause;
- implementation summary;
- unit tests;
- integration tests;
- Rust/native tests;
- worker tests;
- manual steps;
- actual outcome;
- screenshot/log where useful;
- blocker;
- rollback;
- reviewer outcome.

---

# PART XIX — DEFINITION OF DONE

## 57. Browser Chat workspace done

This goal is complete only when all applicable items below are proven:

- one Browser Chat main-nav entry exists;
- internal Provider Sessions rail works;
- pinned Browser Chat section works;
- new Browser Chat works;
- Browser Chat rename works;
- Browser Chat project assignment works;
- session mapping works;
- exact saved Browser Chat reopen works;
- restart restore works;
- switching provider works;
- Provider/VibeSpace presentation modes work;
- modes reuse session/profile;
- no floating/trailing mini-window lag on the supported child-WebView path;
- native child WebView is isolated and stable;
- navigation binding uses native top-level metadata, not DOM scraping;
- Browser Chats appear correctly in History;
- official ChatGPT export import works;
- imported snapshots are searchable/replayable;
- provider project linking works;
- live provider sync uses a supported provider surface or is truthfully marked blocked;
- MCP remote endpoint is healthy;
- desktop relay automatically runs/reconnects while VibeSpace is open and signed in;
- user-connected ChatGPT MCP flow remains explicit;
- permission profiles work;
- read profile works;
- write/file tools work where provider capability supports them;
- terminal tools work where provider capability supports them;
- Git tools work where enabled;
- VibeSpace browser/Playwright tools work where enabled;
- downstream MCP routing works where enabled;
- revoked permissions stop access immediately;
- project context tools work;
- status panel shows truthful independent states;
- file/output activity is visible;
- model/usage shows live supported data or truthful unavailable state;
- no fake “working” state;
- no cross-account leak;
- no stale tool execution after sign-out;
- automated suites pass;
- native smoke passes;
- mandatory independent review is completed;
- P0/P1 review findings are fixed or explicitly block completion.

---

# PART XX — IMMEDIATE FIRST ACTIONS FOR THE IMPLEMENTATION AGENT

## 58. Start here

1. Confirm `Cookie774-GameDev/VibeSpace`, PR31, and `agent/pr30-fixes-and-updates`.
2. Refresh from the actual current PR head; do not assume the authored-head SHA is still current.
3. Read this file fully.
4. Read the current `MASTER_GOAL.md`, Browser Chat docs, MCP worker docs, and PR31 evidence.
5. Inventory Browser Chat, project/chat/history, bridge, MCP, terminal, browser/Playwright, and approval code.
6. Create one compact execution ledger.
7. Reproduce the current Browser Chat window lag/trailing behavior.
8. Capture current Browser Chat session/persistence behavior.
9. Capture current MCP tool catalog and relay registration.
10. Re-verify current OpenAI custom MCP/full-MCP plan capabilities from official OpenAI documentation.
11. Re-verify the current Tauri child-WebView API for the repository’s Tauri version.
12. Implement the data/session foundation first.
13. Implement the child-WebView lifecycle before layering more UI onto the lagging floating-window architecture.
14. Keep current read capability working while migrating permission profiles.
15. Expand tools incrementally with focused tests.
16. Test with real fixture files/terminal/browser sessions.
17. Never use ChatGPT DOM scraping to fake chat/project synchronization.
18. Commit coherent verified slices.
19. Run all final gates.
20. Run the independent code-review sub-agent.
21. Fix its P0/P1 findings.
22. Produce the final evidence report and leave PR31 draft unless separately instructed.

---

## 59. Final engineering principle

**Maximum capability, user-controlled permissions, provider-supported integration, and zero fake success.**

VibeSpace should not permanently cripple the MCP to read-only when the user and provider can support more. It also must not pretend a capability exists when the provider/account does not support it.

The final system should feel like one coherent VibeSpace workspace around the real provider browser:

**your projects, your Browser Chats, your pinned sessions, your files, your terminals, your browser tools, your MCPs, your context, your outputs, your permission plan — with the real ChatGPT/Claude/Gemini session running inside a stable native VibeSpace Browser Chat surface.**
