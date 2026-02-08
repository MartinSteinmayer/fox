# Tab Whisperer — Firefox WebExtension API Reference

> Practical, copy-pasteable reference for the APIs we use.
> All examples use the `browser` namespace (Firefox promise-based).

---

## Quick Reference Table

| API | What it does | Permission | Key functions for us |
|-----|-------------|------------|---------------------|
| `tabs` | List, open, close, move, group tabs | `"tabs"` (for url/title) | `query()`, `create()`, `remove()`, `update()`, `move()`, `group()`, `ungroup()`, `get()`, `duplicate()`, `reload()`, `discard()`, `goBack()`, `goForward()` |
| `tabGroups` | Modify/rearrange tab groups | `"tabGroups"` (hidden from users) | `get()`, `query()`, `update()`, `move()` |
| `windows` | Manage browser windows | none | `get()`, `getCurrent()`, `getLastFocused()`, `getAll()`, `create()`, `update()`, `remove()` |
| `bookmarks` | CRUD bookmarks | `"bookmarks"` | `create()`, `get()`, `getTree()`, `search()`, `remove()`, `update()`, `getRecent()` |
| `history` | Browse/modify history | `"history"` | `search()`, `getVisits()`, `addUrl()`, `deleteUrl()`, `deleteRange()`, `deleteAll()` |
| `search` | Web search | `"search"` | `get()` (list engines), `search()` (Firefox-only, any engine) |
| `storage` | Persist extension data | `"storage"` | `local.get/set`, `sync.get/set`, `session` (in-memory) |
| `notifications` | System notifications | `"notifications"` | `create()`, `clear()`, `getAll()` |
| `runtime` | Extension lifecycle & messaging | none | `sendMessage()`, `onMessage`, `onInstalled`, `getURL()`, `connect()` |
| `commands` | Keyboard shortcuts | none (manifest key) | `getAll()`, `update()`, `reset()`, `onCommand` |

---

## 1. tabs API

**Permission**: `"tabs"` required for `Tab.url`, `Tab.title`, `Tab.favIconUrl` access.
Without `"tabs"` permission, these fields are `undefined`.

### Types

**`tabs.Tab`** — Object representing a tab:
```
{
  id: number,              // Unique tab ID (unique per session)
  index: number,           // 0-based position in window
  windowId: number,        // Window this tab belongs to
  active: boolean,         // Is this the active tab in its window?
  pinned: boolean,
  url: string,             // Requires "tabs" permission
  title: string,           // Requires "tabs" permission
  favIconUrl: string,      // Requires "tabs" permission
  status: "loading"|"complete",
  groupId: number,         // -1 if not in a group
  discarded: boolean,      // Tab unloaded from memory?
  mutedInfo: { muted: boolean, reason: string },
  audible: boolean,
  incognito: boolean,
  highlighted: boolean,
  openerTabId: number,     // Tab that opened this one
  successorTabId: number,
  sessionId: string,
  cookieStoreId: string,
  lastAccessed: number,    // Timestamp
}
```

**`tabs.TAB_ID_NONE`** = `-1` — Special ID for non-browser tabs (e.g., devtools).

### Functions

#### `tabs.query(queryInfo)` — Get tabs matching criteria
```js
// Get ALL tabs in current window
const tabs = await browser.tabs.query({ currentWindow: true });

// Get the active tab
const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });

// Get all tabs across all windows
const allTabs = await browser.tabs.query({});

// Find tabs by URL pattern (requires "tabs" permission)
const gmailTabs = await browser.tabs.query({ url: "*://mail.google.com/*" });

// Find tabs by title (requires "tabs" permission)
const matchingTabs = await browser.tabs.query({ title: "*GitHub*" });

// Get pinned tabs
const pinned = await browser.tabs.query({ pinned: true, currentWindow: true });

// Get discarded (unloaded) tabs
const discarded = await browser.tabs.query({ discarded: true });

// Get audible tabs (playing sound)
const audible = await browser.tabs.query({ audible: true });

// Get tabs in a specific group
const grouped = await browser.tabs.query({ groupId: someGroupId });
```

**queryInfo properties**: `active`, `audible`, `currentWindow`, `discarded`, `groupId`, `highlighted`, `index`, `muted`, `pinned`, `status`, `title`, `url` (string or array of match patterns), `windowId`, `windowType`.

#### `tabs.create(createProperties)` — Open a new tab
```js
// Open URL in new tab
const tab = await browser.tabs.create({ url: "https://example.com" });

// Open in background (not active)
await browser.tabs.create({ url: "https://example.com", active: false });

// Open at specific position
await browser.tabs.create({ url: "https://example.com", index: 0 });

// Open in specific window
await browser.tabs.create({ url: "https://example.com", windowId: winId });

// Open pinned
await browser.tabs.create({ url: "https://example.com", pinned: true });
```

#### `tabs.remove(tabIds)` — Close tab(s)
```js
// Close single tab
await browser.tabs.remove(tabId);

// Close multiple tabs
await browser.tabs.remove([tabId1, tabId2, tabId3]);

// Close all tabs except active
const tabs = await browser.tabs.query({ currentWindow: true, active: false });
await browser.tabs.remove(tabs.map(t => t.id));

// Close duplicate tabs (same URL)
const allTabs = await browser.tabs.query({ currentWindow: true });
const seen = new Set();
const dupes = [];
for (const tab of allTabs) {
  if (seen.has(tab.url)) dupes.push(tab.id);
  else seen.add(tab.url);
}
if (dupes.length) await browser.tabs.remove(dupes);
```

#### `tabs.update(tabId, updateProperties)` — Modify a tab
```js
// Navigate tab to new URL
await browser.tabs.update(tabId, { url: "https://example.com" });

// Activate (switch to) a tab
await browser.tabs.update(tabId, { active: true });

// Pin/unpin
await browser.tabs.update(tabId, { pinned: true });

// Mute/unmute
await browser.tabs.update(tabId, { muted: true });
```

#### `tabs.move(tabIds, moveProperties)` — Reposition tab(s)
```js
// Move tab to end of current window
await browser.tabs.move(tabId, { index: -1 });

// Move tab to beginning
await browser.tabs.move(tabId, { index: 0 });

// Move tab to different window
await browser.tabs.move(tabId, { windowId: otherWindowId, index: -1 });

// Move multiple tabs together
await browser.tabs.move([tab1, tab2, tab3], { index: 0 });
```

#### `tabs.group(options)` — Add tabs to a group
```js
// Create a NEW group with specific tabs
const groupId = await browser.tabs.group({ tabIds: [tab1, tab2] });

// Add tabs to an EXISTING group
await browser.tabs.group({ tabIds: [tab3], groupId: existingGroupId });

// Create group in specific window
const groupId = await browser.tabs.group({
  tabIds: [tab1, tab2],
  createProperties: { windowId: winId }
});
```
**Returns**: `groupId` (number) — the ID of the group the tabs were added to.

#### `tabs.ungroup(tabIds)` — Remove tabs from their group
```js
// Remove single tab from its group
await browser.tabs.ungroup(tabId);

// Remove multiple tabs from their groups
await browser.tabs.ungroup([tab1, tab2, tab3]);
```
**Note**: If a group becomes empty after ungrouping, it is automatically removed.

#### `tabs.get(tabId)` — Get single tab by ID
```js
const tab = await browser.tabs.get(tabId);
console.log(tab.url, tab.title);
```

#### `tabs.duplicate(tabId)` — Duplicate a tab
```js
const newTab = await browser.tabs.duplicate(tabId);
```

#### `tabs.reload(tabId, reloadProperties)` — Reload a tab
```js
// Normal reload
await browser.tabs.reload(tabId);

// Bypass cache
await browser.tabs.reload(tabId, { bypassCache: true });

// Reload current tab (omit tabId)
await browser.tabs.reload();
```

#### `tabs.discard(tabIds)` — Unload tab(s) from memory
```js
// Discard a single tab (saves memory, tab stays in tab bar)
await browser.tabs.discard(tabId);

// Discard multiple
await browser.tabs.discard([tab1, tab2]);
```
**Note**: Cannot discard the active tab. Tab is reloaded when user switches to it.

#### `tabs.goBack(tabId)` / `tabs.goForward(tabId)` — Navigation
```js
await browser.tabs.goBack(tabId);
await browser.tabs.goForward(tabId);
```

### Events (useful ones)
```js
// Tab activated (user switched tabs)
browser.tabs.onActivated.addListener(({ tabId, windowId }) => { ... });

// Tab created
browser.tabs.onCreated.addListener((tab) => { ... });

// Tab closed
browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => { ... });

// Tab updated (URL change, loading state, etc.)
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") { /* page finished loading */ }
});

// Tab moved within window
browser.tabs.onMoved.addListener((tabId, { windowId, fromIndex, toIndex }) => { ... });
```

---

## 2. tabGroups API

**Permission**: `"tabGroups"` — not shown to users in permission prompts.

**Important**: `tabGroups` does NOT create/remove groups. Use `tabs.group()` / `tabs.ungroup()` for that.

### Types

**`tabGroups.TabGroup`**:
```
{
  id: number,              // Group ID
  collapsed: boolean,      // Is the group collapsed?
  color: tabGroups.Color,  // Group color
  title: string,           // Group title (can be empty)
  windowId: number,        // Window containing this group
}
```

**`tabGroups.Color`** — one of:
`"grey"`, `"blue"`, `"red"`, `"yellow"`, `"green"`, `"pink"`, `"purple"`, `"cyan"`, `"orange"`

**`tabGroups.TAB_GROUP_ID_NONE`** = `-1` — Value when tab is not in a group.

### Functions

#### `tabGroups.get(groupId)` — Get group details
```js
const group = await browser.tabGroups.get(groupId);
console.log(group.title, group.color, group.collapsed);
```

#### `tabGroups.query(queryInfo)` — Find groups
```js
// Get all groups in current window
const groups = await browser.tabGroups.query({ windowId: browser.windows.WINDOW_ID_CURRENT });

// Get all groups everywhere
const allGroups = await browser.tabGroups.query({});

// Find group by title
const [workGroup] = await browser.tabGroups.query({ title: "Work" });

// Find group by color
const redGroups = await browser.tabGroups.query({ color: "red" });

// Find collapsed groups
const collapsed = await browser.tabGroups.query({ collapsed: true });
```

#### `tabGroups.update(groupId, updateProperties)` — Modify a group
```js
// Set group title and color
await browser.tabGroups.update(groupId, {
  title: "Work",
  color: "blue"
});

// Collapse a group
await browser.tabGroups.update(groupId, { collapsed: true });

// Expand a group
await browser.tabGroups.update(groupId, { collapsed: false });
```

#### `tabGroups.move(groupId, moveProperties)` — Move a group
```js
// Move group to beginning of window
await browser.tabGroups.move(groupId, { index: 0 });

// Move group to different window
await browser.tabGroups.move(groupId, { windowId: otherWindowId, index: -1 });
```

### Tab Whisperer: Full group workflow
```js
// 1. Create a group from tabs
const tabs = await browser.tabs.query({ currentWindow: true, url: "*://*.github.com/*" });
const tabIds = tabs.map(t => t.id);
const groupId = await browser.tabs.group({ tabIds });

// 2. Name and color it
await browser.tabGroups.update(groupId, { title: "GitHub", color: "purple" });

// 3. Later: collapse it to save space
await browser.tabGroups.update(groupId, { collapsed: true });

// 4. Add more tabs to it
const newTab = await browser.tabs.create({ url: "https://github.com/notifications" });
await browser.tabs.group({ tabIds: [newTab.id], groupId });

// 5. Ungroup all tabs (dissolves the group)
const groupedTabs = await browser.tabs.query({ groupId });
await browser.tabs.ungroup(groupedTabs.map(t => t.id));
```

### Events
```js
browser.tabGroups.onCreated.addListener((group) => { ... });
browser.tabGroups.onUpdated.addListener((group) => { ... });
browser.tabGroups.onRemoved.addListener((group) => { ... });
browser.tabGroups.onMoved.addListener((group) => { ... });
```

---

## 3. windows API

**Permission**: none required.

### Types

**`windows.Window`**:
```
{
  id: number,
  focused: boolean,
  top: number, left: number, width: number, height: number,
  tabs: tabs.Tab[],         // Only if populate:true in get/getAll
  incognito: boolean,
  type: "normal"|"popup"|"panel"|"devtools",
  state: "normal"|"minimized"|"maximized"|"fullscreen"|"docked",
  alwaysOnTop: boolean,
  title: string,            // Requires "tabs" permission
  sessionId: string,
}
```

**Constants**:
- `windows.WINDOW_ID_NONE` = `-1` — No window.
- `windows.WINDOW_ID_CURRENT` = `-2` — Use in place of windowId to mean "current window".

### Functions

#### `windows.get(windowId, getInfo)` — Get window by ID
```js
const win = await browser.windows.get(windowId, { populate: true });
// win.tabs contains all tabs in that window
```

#### `windows.getCurrent(getInfo)` — Get the window running this code
```js
const win = await browser.windows.getCurrent({ populate: true });
```

#### `windows.getLastFocused(getInfo)` — Most recently focused window
```js
const win = await browser.windows.getLastFocused({ populate: true });
```

#### `windows.getAll(getInfo)` — Get all windows
```js
// All windows with their tabs
const windows = await browser.windows.getAll({ populate: true });

// Count total tabs across all windows
const totalTabs = windows.reduce((sum, w) => sum + w.tabs.length, 0);
```

#### `windows.create(createData)` — Open a new window
```js
// New empty window
const win = await browser.windows.create();

// New window with URL
const win = await browser.windows.create({ url: "https://example.com" });

// New window with multiple tabs
const win = await browser.windows.create({
  url: ["https://example.com", "https://github.com"]
});

// Move existing tabs to a new window
const win = await browser.windows.create({ tabId: existingTabId });

// Popup window (no tab bar, minimal chrome)
const win = await browser.windows.create({
  url: "popup.html",
  type: "popup",
  width: 400,
  height: 300
});

// Private window
const win = await browser.windows.create({ incognito: true });
```

#### `windows.update(windowId, updateInfo)` — Modify a window
```js
// Focus a window
await browser.windows.update(windowId, { focused: true });

// Minimize/maximize
await browser.windows.update(windowId, { state: "minimized" });
await browser.windows.update(windowId, { state: "maximized" });

// Resize and move
await browser.windows.update(windowId, {
  top: 100, left: 100, width: 800, height: 600
});
```

#### `windows.remove(windowId)` — Close a window (and all its tabs)
```js
await browser.windows.remove(windowId);
```

### Events
```js
browser.windows.onCreated.addListener((window) => { ... });
browser.windows.onRemoved.addListener((windowId) => { ... });
browser.windows.onFocusChanged.addListener((windowId) => {
  // windowId is WINDOW_ID_NONE if all windows lost focus
});
```

---

## 4. bookmarks API

**Permission**: `"bookmarks"` required.

**Note**: Cannot create/modify/delete bookmarks in the root node.

### Types

**`bookmarks.BookmarkTreeNode`**:
```
{
  id: string,               // Unique node ID
  parentId: string,         // Parent folder ID
  index: number,            // 0-based position within parent
  url: string,              // URL (undefined for folders)
  title: string,            // Display title
  dateAdded: number,        // Timestamp (ms since epoch)
  dateGroupModified: number,// Last modified time for folders
  type: "bookmark"|"folder"|"separator",
  children: BookmarkTreeNode[], // Only for folders
  unmodifiable: "managed",  // If set, node can't be changed
}
```

### Functions

#### `bookmarks.create(bookmark)` — Create bookmark or folder
```js
// Bookmark current tab
const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
const bookmark = await browser.bookmarks.create({
  title: activeTab.title,
  url: activeTab.url
});

// Create a folder
const folder = await browser.bookmarks.create({
  title: "Tab Whisperer Saved"
});

// Bookmark into specific folder
await browser.bookmarks.create({
  title: "My Page",
  url: "https://example.com",
  parentId: folder.id
});
```

#### `bookmarks.get(idOrIds)` — Get bookmark(s) by ID
```js
const [node] = await browser.bookmarks.get("bookmark-id");
const nodes = await browser.bookmarks.get(["id1", "id2"]);
```

#### `bookmarks.getTree()` — Get entire bookmark tree
```js
const [root] = await browser.bookmarks.getTree();
// root.children = [Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks, ...]
```

#### `bookmarks.getRecent(count)` — Get recently added bookmarks
```js
const recent = await browser.bookmarks.getRecent(10);
```

#### `bookmarks.search(query)` — Search bookmarks
```js
// Search by string (matches title and URL)
const results = await browser.bookmarks.search("github");

// Search by object for more control
const results = await browser.bookmarks.search({ query: "github" });
const results = await browser.bookmarks.search({ url: "https://github.com/" });
const results = await browser.bookmarks.search({ title: "GitHub" });
```

#### `bookmarks.update(id, changes)` — Update title/URL
```js
await browser.bookmarks.update("bookmark-id", {
  title: "New Title",
  url: "https://new-url.com"
});
```

#### `bookmarks.remove(id)` / `bookmarks.removeTree(id)` — Delete
```js
// Remove single bookmark (or empty folder)
await browser.bookmarks.remove("bookmark-id");

// Remove folder and all its contents
await browser.bookmarks.removeTree("folder-id");
```

#### `bookmarks.move(id, destination)` — Move bookmark
```js
await browser.bookmarks.move("bookmark-id", {
  parentId: "target-folder-id",
  index: 0  // Move to top of folder
});
```

### Tab Whisperer: Bookmark all tabs in a group
```js
async function bookmarkTabGroup(groupId) {
  const tabs = await browser.tabs.query({ groupId });
  const group = await browser.tabGroups.get(groupId);

  // Create a folder named after the group
  const folder = await browser.bookmarks.create({
    title: group.title || "Unnamed Group"
  });

  // Bookmark each tab into the folder
  for (const tab of tabs) {
    await browser.bookmarks.create({
      parentId: folder.id,
      title: tab.title,
      url: tab.url
    });
  }

  return { folderId: folder.id, count: tabs.length };
}
```

---

## 5. history API

**Permission**: `"history"` required.

**Note**: Downloads are treated as `HistoryItem` objects — `onVisited` fires for downloads too.

### Types

**`history.HistoryItem`**:
```
{
  id: string,              // Unique ID
  url: string,             // URL of the page
  title: string,           // Page title
  lastVisitTime: number,   // Timestamp of last visit (ms since epoch)
  visitCount: number,      // Total number of visits
  typedCount: number,      // Times user typed the URL
}
```

**`history.VisitItem`**:
```
{
  id: string,              // HistoryItem ID this visit is part of
  visitId: string,         // Unique visit ID
  visitTime: number,       // Timestamp of this visit
  referringVisitId: string,// Visit ID of the referrer
  transition: TransitionType, // How the user navigated here
}
```

**`history.TransitionType`**: `"link"`, `"typed"`, `"auto_bookmark"`, `"auto_subframe"`, `"manual_subframe"`, `"generated"`, `"auto_toplevel"`, `"form_submit"`, `"reload"`, `"keyword"`, `"keyword_generated"`.

### Functions

#### `history.search(query)` — Search browsing history
```js
// Search by text (matches URL and title)
const items = await browser.history.search({
  text: "github",
  maxResults: 20
});

// Get all history in last 24 hours
const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
const items = await browser.history.search({
  text: "",            // Empty string = match all
  startTime: oneDayAgo,
  maxResults: 100
});

// Get all history in a date range
const items = await browser.history.search({
  text: "",
  startTime: new Date("2026-02-01").getTime(),
  endTime: new Date("2026-02-07").getTime(),
  maxResults: 500
});
```

**search query properties**: `text` (required), `startTime`, `endTime`, `maxResults` (default 100).

#### `history.getVisits(details)` — Get all visits to a URL
```js
const visits = await browser.history.getVisits({ url: "https://github.com" });
// Returns array of VisitItem with timestamps and transition types
```

#### `history.addUrl(details)` — Add a URL to history
```js
await browser.history.addUrl({
  url: "https://example.com",
  title: "Example Page",
  visitTime: Date.now()
});
```

#### `history.deleteUrl(details)` — Remove URL from history
```js
await browser.history.deleteUrl({ url: "https://example.com" });
```

#### `history.deleteRange(range)` — Remove visits in time range
```js
const oneHourAgo = Date.now() - (60 * 60 * 1000);
await browser.history.deleteRange({
  startTime: oneHourAgo,
  endTime: Date.now()
});
```

#### `history.deleteAll()` — Clear all history
```js
await browser.history.deleteAll();
// DANGEROUS — use with confirmation!
```

### Tab Whisperer: Find recently visited sites for context
```js
async function getRecentSites(hours = 1, limit = 20) {
  const startTime = Date.now() - (hours * 60 * 60 * 1000);
  const items = await browser.history.search({
    text: "",
    startTime,
    maxResults: limit
  });
  return items.map(i => ({ url: i.url, title: i.title, visits: i.visitCount }));
}
```

---

## 6. search API

**Permission**: `"search"` required.

### Functions

#### `search.get()` — List installed search engines
```js
const engines = await browser.search.get();
// Returns array of: { name: string, isDefault: boolean, alias: string, favIconUrl: string }

// Find default engine
const defaultEngine = engines.find(e => e.isDefault);

// List all engine names
const names = engines.map(e => e.name);
// e.g. ["Google", "Bing", "DuckDuckGo", "Wikipedia (en)"]
```

#### `search.query(queryInfo)` — Search with default engine (cross-browser)
```js
// Search in current tab
await browser.search.query({
  text: "firefox extensions",
  disposition: "CURRENT_TAB"
});

// Search in new tab
await browser.search.query({
  text: "firefox extensions",
  disposition: "NEW_TAB"
});

// Search in new window
await browser.search.query({
  text: "firefox extensions",
  disposition: "NEW_WINDOW"
});
```

**disposition values**: `"CURRENT_TAB"`, `"NEW_TAB"`, `"NEW_WINDOW"`.

#### `search.search(searchProperties)` — Search with ANY engine (Firefox-only)
```js
// Search with specific engine
await browser.search.search({
  query: "firefox extensions",
  engine: "DuckDuckGo"
});

// Search in specific tab
await browser.search.search({
  query: "firefox extensions",
  engine: "Google",
  tabId: someTabId
});
```

**Key difference**: `search.query()` uses only the default engine, `search.search()` (Firefox-only) lets you target any installed engine.

### Tab Whisperer: Web search tool
```js
async function webSearch(query, engineName = null) {
  if (engineName) {
    // Firefox-specific: search with named engine
    await browser.search.search({ query, engine: engineName });
  } else {
    // Cross-browser: search with default engine
    await browser.search.query({ text: query, disposition: "NEW_TAB" });
  }
}

async function listSearchEngines() {
  const engines = await browser.search.get();
  return engines.map(e => ({
    name: e.name,
    isDefault: e.isDefault,
    alias: e.alias
  }));
}
```

---

## 7. storage API

**Permission**: `"storage"` required.

**Important**: Storage is NOT encrypted — don't store confidential user info (like raw API keys) without warning. Values must be JSON-serializable. Don't use `window.localStorage` in extensions — Firefox clears it when users clear browsing data, but `storage.local` is preserved.

### Storage Areas

| Area | Persists | Syncs | Size limit | Use for |
|------|----------|-------|------------|---------|
| `storage.local` | Yes (on disk) | No | 10MB (default) | Settings, cached data, API keys |
| `storage.sync` | Yes | Yes (across devices) | 100KB total, 8KB/item | User preferences that sync |
| `storage.session` | No (in memory) | No | 10MB | Ephemeral state, session tokens |
| `storage.managed` | Yes | No | Read-only | Enterprise/admin config |

### Common API (same for all areas)

All storage areas share the same `StorageArea` interface:

#### `get(keys)` — Read values
```js
// Get single key (with default)
const { apiKey } = await browser.storage.local.get({ apiKey: "" });

// Get multiple keys
const { model, temperature } = await browser.storage.local.get({
  model: "gpt-4",
  temperature: 0.7
});

// Get everything
const allData = await browser.storage.local.get(null);

// Get by key name (no defaults)
const result = await browser.storage.local.get("apiKey");
// result.apiKey might be undefined if not set
```

#### `set(items)` — Write values
```js
// Set single value
await browser.storage.local.set({ apiKey: "sk-..." });

// Set multiple values
await browser.storage.local.set({
  model: "gpt-4",
  temperature: 0.7,
  voiceServerUrl: "ws://localhost:8765"
});

// Store complex objects (must be JSON-serializable)
await browser.storage.local.set({
  commandHistory: [
    { text: "close duplicate tabs", timestamp: Date.now() },
    { text: "group github tabs", timestamp: Date.now() }
  ]
});
```

#### `remove(keys)` — Delete values
```js
await browser.storage.local.remove("apiKey");
await browser.storage.local.remove(["apiKey", "model"]);
```

#### `clear()` — Delete everything
```js
await browser.storage.local.clear();
```

### Session storage (in-memory, ephemeral)
```js
// Store WebSocket connection state (don't persist across restart)
await browser.storage.session.set({ wsConnected: true, lastPing: Date.now() });

// Read session state
const { wsConnected } = await browser.storage.session.get({ wsConnected: false });
```

### Listen for changes
```js
browser.storage.onChanged.addListener((changes, areaName) => {
  // changes = { key: { oldValue, newValue } }
  // areaName = "local" | "sync" | "session" | "managed"
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    console.log(`${areaName}.${key}: ${oldValue} → ${newValue}`);
  }
});
```

### Tab Whisperer: Settings helper
```js
const DEFAULTS = {
  apiKey: "",
  model: "gpt-4",
  temperature: 0.7,
  voiceServerUrl: "ws://localhost:8765",
  wakeWord: "hey tab",
  maxToolCalls: 10,
};

async function getSettings() {
  return browser.storage.local.get(DEFAULTS);
}

async function updateSettings(partial) {
  await browser.storage.local.set(partial);
}
```

---

## 8. notifications API

**Permission**: `"notifications"` required.

Uses the OS-native notification system. Appearance varies by platform.

### Functions

#### `notifications.create(id, options)` — Show a notification
```js
// Basic notification
await browser.notifications.create("task-done", {
  type: "basic",
  title: "Tab Whisperer",
  message: "Closed 5 duplicate tabs!",
  iconUrl: browser.runtime.getURL("icons/icon-48.png")
});

// With auto-generated ID
const notifId = await browser.notifications.create({
  type: "basic",
  title: "Tab Whisperer",
  message: "Grouped 8 GitHub tabs into 'GitHub' group"
});
```

**`type`**: Only `"basic"` is widely supported in Firefox. Chrome also supports `"image"`, `"list"`, `"progress"`.

**`options`**: `type`, `title`, `message`, `iconUrl` (all required for `"basic"`). Optional: `contextMessage`, `priority` (-2 to 2), `eventTime`.

#### `notifications.clear(id)` — Dismiss a notification
```js
await browser.notifications.clear("task-done");
```

#### `notifications.getAll()` — Get all active notifications
```js
const active = await browser.notifications.getAll();
// Returns { notificationId: NotificationOptions, ... }
```

### Events
```js
// User clicked the notification body
browser.notifications.onClicked.addListener((notificationId) => {
  // e.g., focus the extension popup or open a tab
});

// Notification closed (by user or system)
browser.notifications.onClosed.addListener((notificationId, byUser) => { ... });
```

### Tab Whisperer: Notify helper
```js
async function notify(message, title = "Tab Whisperer") {
  return browser.notifications.create({
    type: "basic",
    title,
    message,
    iconUrl: browser.runtime.getURL("icons/icon-48.png")
  });
}
```

---

## 9. runtime API

**Permission**: none required (it's always available).

### Properties
```js
browser.runtime.id        // Extension's unique ID string
browser.runtime.lastError // Error from last async call (or null)
```

### Functions

#### `runtime.sendMessage(message)` — Send message within extension
```js
// From popup to background
const response = await browser.runtime.sendMessage({
  type: "execute_command",
  text: "close duplicate tabs"
});

// From background — respond to messages
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "execute_command") {
    handleCommand(message.text).then(sendResponse);
    return true; // Keep message channel open for async response
  }
});
```

#### `runtime.connect(connectInfo)` — Long-lived connection
```js
// From popup: open a port to background
const port = browser.runtime.connect({ name: "popup-channel" });

port.onMessage.addListener((msg) => {
  console.log("Received from background:", msg);
});

port.postMessage({ type: "subscribe_status" });

// In background: listen for connections
browser.runtime.onConnect.addListener((port) => {
  if (port.name === "popup-channel") {
    port.onMessage.addListener((msg) => { ... });
    port.postMessage({ status: "connected" });
  }
});
```

#### `runtime.getURL(path)` — Get full URL to extension resource
```js
const iconUrl = browser.runtime.getURL("icons/icon-48.png");
// → "moz-extension://UUID/icons/icon-48.png"
```

#### `runtime.getManifest()` — Get parsed manifest.json
```js
const manifest = browser.runtime.getManifest();
console.log(manifest.version); // "1.0"
```

#### `runtime.getBackgroundPage()` — Get background page Window (MV2 only)
```js
// From popup or options page
const bgPage = await browser.runtime.getBackgroundPage();
bgPage.someBackgroundFunction();
```

#### `runtime.openOptionsPage()` — Open extension options
```js
await browser.runtime.openOptionsPage();
```

### Events

#### `runtime.onInstalled` — Extension installed/updated
```js
browser.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason === "install") {
    // First install — show onboarding, set defaults
    browser.storage.local.set(DEFAULTS);
  } else if (reason === "update") {
    // Extension updated
    console.log(`Updated from ${previousVersion}`);
  }
});
```

**`reason`** values: `"install"`, `"update"`, `"browser_update"`.

#### `runtime.onStartup` — Browser started with extension installed
```js
browser.runtime.onStartup.addListener(() => {
  // Re-initialize state, reconnect WebSocket, etc.
});
```

#### `runtime.onMessage` — Receive messages
```js
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // sender.tab — if sent from a content script, contains the Tab
  // sender.id — extension ID
  // Return true to indicate async response via sendResponse()
  // Or return a Promise that resolves with the response
});
```

---

## 10. commands API

**Permission**: none (defined via `"commands"` key in manifest.json).

### Manifest definition
```json
{
  "commands": {
    "toggle-listening": {
      "suggested_key": {
        "default": "Alt+Shift+L",
        "mac": "Alt+Shift+L"
      },
      "description": "Toggle voice listening"
    },
    "_execute_browser_action": {
      "suggested_key": {
        "default": "Alt+Shift+T",
        "mac": "Alt+Shift+T"
      }
    }
  }
}
```

**Special commands**:
- `"_execute_browser_action"` — Opens the popup (MV2)
- `"_execute_action"` — Opens the popup (MV3)
- `"_execute_sidebar_action"` — Toggles sidebar

### Functions

#### `commands.getAll()` — List all commands
```js
const commands = await browser.commands.getAll();
// Returns [{ name, description, shortcut }, ...]
```

#### `commands.update(detail)` — Change shortcut
```js
await browser.commands.update({
  name: "toggle-listening",
  shortcut: "Alt+Shift+V"
});
```

#### `commands.reset(name)` — Reset to manifest default
```js
await browser.commands.reset("toggle-listening");
```

### Events

#### `commands.onCommand` — Keyboard shortcut pressed
```js
browser.commands.onCommand.addListener((commandName) => {
  if (commandName === "toggle-listening") {
    toggleVoiceListening();
  }
});
```

---

## Permissions Summary for manifest.json

```json
{
  "permissions": [
    "tabs",
    "tabGroups",
    "storage",
    "notifications",
    "search",
    "bookmarks",
    "history"
  ]
}
```

**What users see in install prompt**:
| Permission | Shown to user? | Warning text |
|------------|---------------|--------------|
| `tabs` | Yes | "Access browser tabs" |
| `tabGroups` | **No** | (hidden) |
| `storage` | **No** | (hidden) |
| `notifications` | **No** | (hidden — on macOS, OS may prompt separately) |
| `search` | **No** | (hidden) |
| `bookmarks` | Yes | "Read and modify bookmarks" |
| `history` | Yes | "Access browsing history" |

---

## Gotchas & Firefox-Specific Notes

1. **`browser` vs `chrome` namespace**: Firefox supports both. Use `browser.*` for Promise-based APIs. `chrome.*` uses callbacks. We use `browser.*` exclusively.

2. **Tab IDs are session-scoped**: They reset on browser restart. Don't persist them. Use `sessions.setTabValue()` if you need cross-restart tab identity.

3. **`tabs.group()` / `tabs.ungroup()` are the ONLY way to create/remove groups**. The `tabGroups` namespace only has `get()`, `query()`, `update()`, `move()`.

4. **`tabGroups` permission is invisible to users** — no install prompt. Good for hackathon UX.

5. **`search.search()` is Firefox-only**. It lets you pick any installed engine. `search.query()` is cross-browser but limited to the default engine.

6. **`storage` is NOT encrypted**. Storing API keys there is convenient but not secure. For a hackathon this is fine, but warn in production.

7. **`storage.session`** is in-memory only, never persisted to disk. Perfect for WebSocket state, current-session data.

8. **`history.search({ text: "" })`** with empty string matches ALL history items. Useful with `startTime`/`endTime` for date-range queries.

9. **`notifications`** on Firefox only support `type: "basic"`. No `"list"`, `"image"`, or `"progress"` types.

10. **MV2 background scripts** are persistent (always running). No need to worry about service worker lifecycle issues like in MV3.

11. **`runtime.onMessage` async responses**: Return `true` from the listener to keep the message channel open, then call `sendResponse()` later. Or return a `Promise`.

12. **`windows.create({ tabId })` moves an existing tab** to a new window. It doesn't duplicate it.

13. **`tabs.discard()` cannot discard the active tab**. The tab stays in the tab bar but its content is unloaded from memory.

14. **Match patterns for `tabs.query({ url })`**: Use `"*://*.github.com/*"` format, not raw URLs. Supports `*` wildcards in scheme, host, and path.
