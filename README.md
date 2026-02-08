<p align="center">
  <img src="logo_wihtout_background.png" alt="Fox" width="220">
</p>

# Tab Whisperer

Tab Whisperer is a Firefox extension + local voice backend that lets you manage browser tabs with natural language (typed or spoken).

Built for the Mozilla **"Bring Your Own AI to Every Website"** hackathon.

## What is in this repo?

This repository combines:

- `extension/` - the Firefox extension (UI, tool executor, tab/search tools, LLM client)
- `voice-server/` - the local Python voice pipeline (wake word, VAD, transcription, WebSocket)

`voice-server/` is tracked as a **git submodule**, so it can evolve independently while this repo pins a known-good version.

## Architecture

```text
Firefox Extension (MV2)
  popup UI <-> background script <-> tool executor <-> LLM + browser tools
                         |
                         | WebSocket (ws://localhost:8765)
                         v
                  Python Voice Server
      mic -> VAD (Silero) -> Whisper -> command -> extension
```

## Quick start

### 1) Clone with submodules

```bash
git clone --recurse-submodules https://github.com/MartinSteinmayer/fox
cd hack-nation
```

If you already cloned without submodules:

```bash
git submodule update --init --recursive
```

### 2) Start the voice server

```bash
cd voice-server
./setup.sh
python3 server.py
```

### 3) Load the extension in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `extension/manifest.json`
4. Open the extension popup and configure API settings in Options

## Development notes

- Extension and voice server can run independently; text commands in popup work without voice server.
- Voice mode requires `ws://localhost:8765` (default server endpoint).
- For voice server implementation details, see `voice-server/README.md`.

## Updating the backend submodule

To pull the latest `voice-server` changes:

```bash
cd voice-server
git pull
cd ..
git add voice-server
git commit -m "Update voice-server submodule"
```

## Repository layout

```text
hack-nation/
├── extension/        # Firefox extension
├── voice-server/     # Python voice backend (submodule)
├── docs/
└── CLAUDE.md
```
