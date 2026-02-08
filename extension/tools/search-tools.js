/**
 * Tab Whisperer — Search & Navigation Tools
 * 
 * Web search, bookmark, and history tools.
 */

// ─── Search Tools ──────────────────────────────────────────

/**
 * Perform a web search. Opens results in a new tab.
 * Can optionally target a specific search engine (Firefox-only).
 */
async function webSearch({ query, engine }) {
  if (engine) {
    // Firefox-specific: use named engine
    await browser.search.search({ query, engine });
  } else {
    // Cross-browser: default engine, new tab
    await browser.search.query({ text: query, disposition: "NEW_TAB" });
  }
  return { success: true, query, engine: engine || "(default)" };
}

/**
 * List all installed search engines.
 */
async function listSearchEngines() {
  const engines = await browser.search.get();
  return {
    engines: engines.map(e => ({
      name: e.name,
      isDefault: e.isDefault,
      alias: e.alias || null,
    })),
  };
}

// ─── Bookmark Tools ────────────────────────────────────────

/**
 * Search bookmarks by query string.
 */
async function searchBookmarks({ query, maxResults = 20 }) {
  const results = await browser.bookmarks.search(query);
  return {
    count: Math.min(results.length, maxResults),
    bookmarks: results.slice(0, maxResults).map(b => ({
      id: b.id,
      title: b.title,
      url: b.url,
      type: b.type || (b.url ? "bookmark" : "folder"),
    })),
  };
}

/**
 * Create a bookmark for a URL (or bookmark the current active tab).
 */
async function createBookmark({ title, url, folderId }) {
  const props = {};
  if (title) props.title = title;
  if (url) props.url = url;
  if (folderId) props.parentId = folderId;

  // If no URL provided, bookmark the active tab
  if (!url) {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    props.url = activeTab.url;
    if (!title) props.title = activeTab.title;
  }

  const bookmark = await browser.bookmarks.create(props);
  return { success: true, bookmark: { id: bookmark.id, title: bookmark.title, url: bookmark.url } };
}

// ─── History Tools ─────────────────────────────────────────

/**
 * Search browsing history.
 */
async function searchHistory({ query, maxResults = 20, hoursBack }) {
  const searchParams = {
    text: query || "",
    maxResults,
  };

  if (hoursBack) {
    searchParams.startTime = Date.now() - (hoursBack * 60 * 60 * 1000);
  }

  const items = await browser.history.search(searchParams);
  return {
    count: items.length,
    items: items.map(i => ({
      url: i.url,
      title: i.title,
      lastVisit: i.lastVisitTime,
      visitCount: i.visitCount,
    })),
  };
}

// ─── Exports ───────────────────────────────────────────────

var SearchTools = {
  webSearch,
  listSearchEngines,
  searchBookmarks,
  createBookmark,
  searchHistory,
};
