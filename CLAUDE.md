# CLAUDE.md — Tab Whisperer

## What is this?

**Tab Whisperer** is a Firefox extension that lets you manage your browser tabs using natural language — typed or spoken. You say or type things like "group my tabs by topic" or "close all the YouTube tabs" and an AI figures out which browser APIs to call.

Built for the **Mozilla "Bring Your Own AI to Every Website" hackathon**.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Firefox Browser                       │
│                                                         │
│  ┌──────────────┐    port     ┌──────────────────────┐  │
│  │  Popup UI    │◄──────────►│  Background Script    │  │
│  │  (popup/)    │            │  (background.js)      │  │
│  └──────────────┘            │                       │  │
│                              │  ┌─────────────────┐  │  │
│                              │  │  Tool Executor   │  │  │
│                              │  │  (agentic loop)  │  │  │
│                              │  └────────┬────────┘  │  │
│                              │           │           │  │
│                              │  ┌────────▼────────┐  │  │
│                              │  │  LLM Client     │  │  │
│                              │  │  (OpenAI/Ollama) │  │  │
│                              │  └────────┬────────┘  │  │
│                              │           │           │  │
│                              │  ┌────────▼────────┐  │  │
│                              │  │  Tool Registry   │  │  │
│                              │  │  (21 tools)      │  │  │
│                              │  └────────┬────────┘  │  │
│                              │           │           │  │
│                              │  ┌────────▼────────┐  │  │
│                              │  │  Tab Tools (16)  │  │  │
│                              │  │  Search Tools(5) │  │  │
│                              │  └─────────────────┘  │  │
│                              └──────────┬────────────┘  │
│                                    WebSocket            │
└────────────────────────────────┬────────────────────────┘
                                 │ ws://localhost:8765
                    ┌────────────▼────────────┐
                    │   Voice Server (Python)  │
                    │                          │
                    │  Mic → VAD (Silero)       │
                    │      → Whisper (cpp)      │
                    │      → State Machine      │
                    │      → WebSocket          │
                    └──────────────────────────┘
```

## Two Components

### 1. Firefox Extension (`extension/`)

A Manifest V2 extension that runs entirely in the browser. It works standalone via text input even without the voice server.

### 2. Voice Server (`voice-server/`)

A local Python process that captures microphone audio, detects speech, transcribes it with Whisper, and sends commands to the extension over WebSocket. Fully offline after initial setup.

---

## Extension — Detailed Breakdown

### Manifest & Permissions (`manifest.json`)

- **Manifest V2** (Firefox-specific, uses `browser.*` promise-based namespace)
- Permissions: `tabs`, `tabGroups`, `storage`, `notifications`, `search`, `bookmarks`, `history`, `<all_urls>`
- `<all_urls>` is needed for `browser.tabs.executeScript()` to inject the content extraction script into any page
- Background scripts loaded in dependency order (no ES modules in MV2 background pages)
- Keyboard shortcuts: `Alt+Shift+T` (open popup), `Alt+Shift+L` (toggle voice listening)

### Background Script (`background.js`)

The orchestrator. Responsibilities:

- **Popup communication**: Long-lived `runtime.onConnect` port. Sends init state, progress updates, command results.
- **WebSocket client**: Connects to voice server at `ws://localhost:8765`, auto-reconnects every 5s on disconnect.
- **Command handling**: Receives text from popup or voice server, runs it through the tool executor, stores results in persistent action log.
- **Badge status**: Visual indicator on the toolbar icon — idle (clear), listening (green "MIC"), processing (yellow "..."), error (red "ERR"), missing API key (red "KEY").
- **Persistent action log**: Entries saved to `storage.local`, pruned to 500 entries / 30 days. Each entry stores: `id`, `timestamp`, `command`, `toolCalls[]` (name, args, result), `response`, `error`.
- **Notifications**: If the popup is closed when a command completes, shows a browser notification with the result.

### Tool Executor (`lib/tool-executor.js`)

Implements the **agentic tool-calling loop**:

1. Builds context (current tab state + extracted page content)
2. Sends user message + context + system prompt to LLM
3. If LLM returns `tool_calls`, executes them via the registry
4. Feeds tool results back to LLM
5. Repeats until LLM returns a text response (max 10 iterations)

Fires `onUpdate` callbacks throughout for real-time progress display in the popup.

#### Content Extraction & Character Budget

When building context, the executor injects `content/extract.js` into every open tab via `browser.tabs.executeScript()` to extract page signals beyond just title + URL. This runs in parallel across all tabs.

**Extraction layers** (in priority order for budget allocation):

1. **Meta tags**: `description`, `og:description`, `twitter:description`, `keywords`, `og:type`, `og:site_name`, `author`, `article:section`
2. **Breadcrumbs**: `[aria-label="breadcrumb"]`, `.breadcrumb`, `.breadcrumbs`
3. **JSON-LD**: `@type`, `name`/`headline`, `description` from `<script type="application/ld+json">` (handles `@graph`)
4. **Headings**: First 3 `<h1>`s + first 5 `<h2>`s (deduplicated)
5. **Body text**: Text from `<article>`, `<main>`, `[role="main"]`, `#content`, or `<body>` — with nav/footer/sidebar/scripts/ads stripped via clone + removal

**Budget system**:

- Global budget: **30,000 characters** across all tabs
- Per-tab budget: `min(30000 / numTabs, 2000)`
- High-signal metadata (description, keywords, headings) is included first; body text fills whatever budget remains
- Tabs that can't be injected (`about:*`, `moz-extension:*`, etc.) silently get title + URL only

### LLM Client (`lib/llm-client.js`)

Handles communication with OpenAI or Ollama APIs.

**Model ring buffer** (rate limit avoidance): The user has a 3 RPM per-model rate limit. Instead of using one model and waiting, the client maintains a priority-ordered list of models:

```
gpt-5-mini > gpt-4o > gpt-4o-mini > gpt-5 > gpt-4.1 > gpt-4.1-mini > gpt-5-nano > gpt-5.1 > gpt-5.1-chat-latest
```

For each request, it picks the highest-priority model with < 3 calls in the last 60 seconds. If all models are saturated, it picks the one whose cooldown expires soonest. Per-model call timestamps are tracked in `modelCallLog`. This is only used for OpenAI; Ollama uses the configured model directly.

**Token parameter auto-detection**: Newer OpenAI models require `max_completion_tokens` instead of `max_tokens`. The client tries `max_completion_tokens` first; on a 400 `unsupported_parameter` error, retries with `max_tokens`. The result is cached per model in `tokenParamCache`.

**System prompt** instructs the AI to:
- Always call `list_tabs` first before taking action
- Never close all tabs in a window
- Keep tab group names to 1-2 words (Firefox truncates long labels)
- Use a specific color guide for group categories
- Be concise in responses

### Tool Registry (`tools/registry.js`)

Maps 21 tool names to their implementations and provides OpenAI function-calling JSON schemas via `getDefinitions()`. All schemas follow the OpenAI `tools` format with `type: "function"` wrappers.

### Tab Tools (`tools/tab-tools.js`) — 16 tools

| Tool | What it does |
|------|-------------|
| `list_tabs` | List all open tabs (with filter by window) |
| `switch_tab` | Activate a tab by ID |
| `close_tabs` | Close tabs by ID list (safety: refuses to close all in a window) |
| `close_duplicate_tabs` | Find and close tabs with duplicate URLs |
| `group_tabs` | Create/add to a tab group with title and color |
| `ungroup_tabs` | Remove tabs from their groups |
| `list_groups` | List all tab groups |
| `move_tabs` | Move tabs to a specific index/window |
| `create_tab` | Open a new tab with a URL |
| `reload_tabs` | Reload tabs by ID |
| `discard_tabs` | Unload tabs from memory (save RAM) |
| `duplicate_tab` | Duplicate a tab |
| `pin_tabs` | Pin or unpin tabs |
| `mute_tabs` | Mute or unmute tabs |
| `collapse_group` | Collapse or expand a tab group |
| `update_group` | Change a group's title or color |

### Search Tools (`tools/search-tools.js`) — 5 tools

| Tool | What it does |
|------|-------------|
| `web_search` | Search using Firefox's search engines (can target a specific engine) |
| `list_search_engines` | List available search engines |
| `search_bookmarks` | Search bookmarks by query |
| `create_bookmark` | Bookmark a URL with title and folder |
| `search_history` | Search browsing history with time range |

### Content Extraction Script (`content/extract.js`)

An IIFE injected on-demand into tabs. Extracts structured data from the page DOM and returns it to the background script. Not a persistent content script — only runs when `buildContext()` is called. See the "Content Extraction & Character Budget" section above.

### Popup UI (`popup/`)

- **popup.html**: Dark themed layout — header (logo, WS indicator, settings gear), status bar, chat messages area, collapsible history panel, text input + send button
- **popup.css**: Dark theme (`--bg: #1a1b2e` palette), message types with distinct styling (user/assistant/error/tool-call/thinking/system), animated status bar, expandable history entries
- **popup.js**: IIFE that manages popup lifecycle:
  - Port-based connection to background script
  - Requests full history on connect, renders entries newest-first
  - Each history entry is an expandable `<details>` showing: timestamp, command text, tool calls (name + args as JSON + truncated result), AI response, errors
  - Real-time progress display during command execution (thinking, tool calls, responses)
  - Command history navigation with arrow keys
  - Clear history button

### Options Page (`options/`)

Settings page for: provider (OpenAI/Ollama), API key (toggle visibility), model, temperature, max tokens, base URL, voice server URL, wake word. Provider-aware UI disables irrelevant fields.

---

## Voice Server — Detailed Breakdown

Located in `voice-server/`. A standalone Python process.

### Pipeline

```
PASSIVE mode (wake word):
  Mic → VAD (Silero, 300ms silence) → whisper.cpp (base.en + prompt conditioning) → regex match → ACTIVE

ACTIVE mode (command):
  Mic → VAD (Silero, 700ms silence) → whisper.cpp (large-v3-turbo) → command → PASSIVE
```

### Components

#### `server.py` — Main orchestrator

- Opens a `sounddevice.InputStream` with a callback that feeds audio chunks to the async processing pipeline
- Audio callback runs in a separate thread; uses `asyncio.run_coroutine_threadsafe` to bridge into the event loop
- Hosts a WebSocket server on `ws://localhost:8765`
- Single-client mode: new connections replace old ones (clean disconnect)
- Handles incoming messages from extension: `start_listening`, `stop_listening`, `config` (wake word update), `ack`
- **Dual-mode pipeline**: switches VAD silence timeout and Whisper model when state transitions between PASSIVE and ACTIVE
- Graceful shutdown on SIGINT/SIGTERM

#### `vad_detector.py` — Voice Activity Detection

Uses **Silero VAD** (PyTorch, CPU-only, ~0.1ms per chunk):

- Processes audio in chunks of exactly 512 samples (32ms at 16kHz) — required by Silero's streaming API
- Tracks speech onset (minimum 100ms of speech before considering it real)
- **Dynamic silence timeout**: 300ms in PASSIVE mode (wake word is short), 700ms in ACTIVE mode (commands have natural pauses)
- `set_mode("passive"|"active")` switches the silence threshold at runtime
- Includes trailing silence in the utterance for natural boundaries
- Safety: forces utterance end at 30s to prevent unbounded buffer growth
- Resets Silero's internal LSTM hidden states between utterances

#### `transcriber.py` — Whisper Transcription

Uses **whisper.cpp** via subprocess for transcription:

- **Dual-model setup**: selects model based on mode
  - `base.en` for PASSIVE mode (wake word detection — with `--prompt` conditioning for "hey fox")
  - `large-v3-turbo` for ACTIVE mode (high-accuracy command transcription)
- Runs whisper-cli as subprocess, writes temp WAV file, reads output from `-otxt --output-file`
- **Prompt conditioning**: In passive mode, passes `--prompt "hey fox"` to bias Whisper's decoder token probabilities toward the wake word, dramatically improving recognition accuracy
- Rejects audio < 0.3s (noise clicks), truncates audio > 30s
- Models are GGML format, downloaded via whisper.cpp's download script

#### `state_machine.py` — Wake Word Detection

Two states: **PASSIVE** (listening for wake word) and **ACTIVE** (recording command).

- Wake word is "hey fox" by default (configurable at runtime from extension)
- Pre-compiles regex patterns that tolerate punctuation/whitespace: "hey fox" matches "hey, fox", "hey. fox", etc.
- **Key feature**: If the wake word and command appear in the same utterance ("Hey fox, group my tabs"), extracts the command portion and processes it immediately — no second utterance needed
- 20-second timeout in ACTIVE state; returns to PASSIVE if no command arrives
- Supports manual trigger from extension (skip wake word)

#### `config.py` — Centralized Configuration

All tunable parameters: sample rate, VAD thresholds (passive/active), chunk sizes, Whisper models (passive/active), whisper.cpp binary path, wake words, WebSocket host/port, safety limits.

#### `ws_monitor.py` — Debugging Tool

Standalone WebSocket client that connects to the voice server and displays every message with color-coded output and timestamps. Supports interactive mode for sending test messages and JSONL logging for session replay.

### WebSocket Protocol

Messages are JSON objects with a `type` field.

**Server → Extension:**

| Type | Fields | When |
|------|--------|------|
| `status` | `vad`, `passive_model`, `active_model`, `wake_word` | On client connect |
| `wake` | — | Wake word detected |
| `listening` | — | Actively listening for command |
| `command` | `text` | Transcribed command ready |
| `error` | `message` | Something went wrong |

**Extension → Server:**

| Type | Fields | When |
|------|--------|------|
| `start_listening` | — | Manual trigger (skip wake word) |
| `stop_listening` | — | Cancel current session |
| `config` | `wake_word` | Update wake word at runtime |
| `ack` | `result` | Acknowledge command processed |

### Setup

```bash
cd voice-server
./setup.sh      # Builds whisper.cpp, downloads GGML models, installs Python deps
python3 server.py
```

Dependencies: Python 3.8+, CMake (to build whisper.cpp), working microphone. After initial setup, runs fully offline.

---

## File Structure

```
hack-nation/
├── CLAUDE.md                           # This file
├── docs/
│   └── firefox-api-reference.md        # Complete Firefox API reference (1200 lines)
├── extension/
│   ├── manifest.json                   # MV2 manifest
│   ├── background.js                   # Orchestrator (popup comms, WS client, command handling)
│   ├── content/
│   │   └── extract.js                  # Page content extraction (injected on demand)
│   ├── tools/
│   │   ├── tab-tools.js                # 16 tab management functions
│   │   ├── search-tools.js             # 5 search/bookmark/history functions
│   │   └── registry.js                 # Tool name → function map + JSON schemas
│   ├── lib/
│   │   ├── llm-client.js               # OpenAI/Ollama client with model ring buffer
│   │   └── tool-executor.js            # Agentic loop with content extraction + budget
│   ├── popup/
│   │   ├── popup.html                  # Popup layout
│   │   ├── popup.css                   # Dark theme styles
│   │   └── popup.js                    # Popup logic (messages, history, progress)
│   ├── options/
│   │   ├── options.html                # Settings page
│   │   └── options.js                  # Settings load/save
│   └── icons/
│       ├── icon.svg                    # Source icon
│       ├── icon-48.png                 # Toolbar icon
│       └── icon-96.png                 # High-DPI icon
└── voice-server/
    ├── README.md                       # Voice server docs
    ├── server.py                       # Main server (audio capture + WS)
    ├── config.py                       # All configuration constants
    ├── state_machine.py                # PASSIVE/ACTIVE wake word state machine
    ├── transcriber.py                  # whisper.cpp dual-model transcriber
    ├── vad_detector.py                 # Silero VAD wrapper (dynamic silence timeout)
    ├── ws_monitor.py                   # WebSocket debugging tool
    ├── requirements.txt                # Python dependencies
    ├── setup.sh                        # One-command setup script
    └── .gitignore
```

## Key Design Decisions

1. **MV2 over MV3**: Firefox's MV3 support is less mature. MV2 gives us persistent background pages (no service worker lifecycle issues) and `browser.*` promise-based APIs.

2. **Background script load order**: All tool/lib files use global `var` with IIFE pattern since they share the MV2 background page scope. Loaded in manifest order: `tab-tools → search-tools → registry → llm-client → tool-executor → background`.

3. **Model ring buffer over single model**: With 3 RPM per model, a single model would block after 3 commands/minute. Rotating across 9 models gives effective 27 RPM throughput.

4. **On-demand content extraction over persistent content scripts**: We only need page content when building context for a command, not continuously. `executeScript()` avoids running code on every page load.

5. **whisper.cpp with prompt conditioning**: Uses whisper.cpp via subprocess with dual GGML models (base.en for wake word, large-v3-turbo for commands). In passive mode, `--prompt "hey fox"` biases Whisper's decoder toward the wake word, significantly improving detection accuracy even with smaller models.

6. **Silero VAD over WebRTC VAD**: Silero is significantly more accurate for speech detection, and the PyTorch overhead is negligible (~0.1ms per 32ms chunk).

7. **Character budget system**: With many tabs open, sending full page content for every tab would blow past context limits. The budget system degrades gracefully — with few tabs you get rich content, with many tabs you get concise metadata.
