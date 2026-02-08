/**
 * Tab Whisperer — Tab Management Tools
 * 
 * Each tool is a plain async function that takes a params object
 * and returns a result object. They are registered in registry.js.
 * 
 * All functions use the browser.* (Firefox promise-based) namespace.
 */

// ─── Helpers ───────────────────────────────────────────────

function summarizeTab(tab) {
  return {
    id: tab.id,
    title: tab.title || "(no title)",
    url: tab.url || "",
    active: tab.active,
    pinned: tab.pinned,
    groupId: tab.groupId ?? -1,
    windowId: tab.windowId,
    index: tab.index,
    audible: tab.audible || false,
    discarded: tab.discarded || false,
  };
}

function summarizeGroup(group) {
  return {
    id: group.id,
    title: group.title || "(untitled)",
    color: group.color,
    collapsed: group.collapsed,
    windowId: group.windowId,
  };
}

// ─── Tools ─────────────────────────────────────────────────

/**
 * List all open tabs (optionally filtered by window).
 */
async function listTabs({ windowId, groupId } = {}) {
  const query = {};
  if (windowId != null) query.windowId = windowId;
  if (groupId != null) query.groupId = groupId;

  const tabs = await browser.tabs.query(query);
  return {
    count: tabs.length,
    tabs: tabs.map(summarizeTab),
  };
}

/**
 * Switch to a specific tab by ID.
 */
async function switchTab({ tabId }) {
  const tab = await browser.tabs.update(tabId, { active: true });
  // Also focus the window containing the tab
  await browser.windows.update(tab.windowId, { focused: true });
  return { success: true, tab: summarizeTab(tab) };
}

/**
 * Close one or more tabs by ID.
 */
async function closeTabs({ tabIds }) {
  if (!Array.isArray(tabIds)) tabIds = [tabIds];

  // Safety: refuse to close all tabs in a window
  const windows = await browser.windows.getAll({ populate: true });
  for (const win of windows) {
    const winTabIds = win.tabs.map(t => t.id);
    const closingAll = winTabIds.every(id => tabIds.includes(id));
    if (closingAll && winTabIds.length > 0) {
      return {
        success: false,
        error: `Refusing to close all ${winTabIds.length} tabs in window ${win.id}. At least one tab must remain.`,
      };
    }
  }

  await browser.tabs.remove(tabIds);
  return { success: true, closedCount: tabIds.length };
}

/**
 * Find and close duplicate tabs (same URL) in the current window.
 * Keeps the first occurrence of each URL.
 */
async function closeDuplicateTabs({ windowId } = {}) {
  const query = windowId != null ? { windowId } : { currentWindow: true };
  const tabs = await browser.tabs.query(query);

  const seen = new Set();
  const dupes = [];
  for (const tab of tabs) {
    if (seen.has(tab.url)) {
      dupes.push(tab.id);
    } else {
      seen.add(tab.url);
    }
  }

  if (dupes.length === 0) {
    return { success: true, closedCount: 0, message: "No duplicate tabs found." };
  }

  await browser.tabs.remove(dupes);
  return { success: true, closedCount: dupes.length };
}

/**
 * Group tabs together and optionally name/color the group.
 * If groupId is provided, adds tabs to an existing group.
 * Otherwise creates a new group.
 */
async function groupTabs({ tabIds, title, color, groupId }) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) {
    return { success: false, error: "tabIds must be a non-empty array." };
  }

  const validColors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

  let gId;
  if (groupId != null) {
    // Add to existing group
    gId = await browser.tabs.group({ tabIds, groupId });
  } else {
    // Create new group
    gId = await browser.tabs.group({ tabIds });
  }

  // Update title and color if provided
  const updateProps = {};
  if (title) updateProps.title = title;
  if (color && validColors.includes(color)) updateProps.color = color;
  if (Object.keys(updateProps).length > 0) {
    await browser.tabGroups.update(gId, updateProps);
  }

  const group = await browser.tabGroups.get(gId);
  return { success: true, group: summarizeGroup(group) };
}

/**
 * Remove tabs from their group(s). If the group becomes empty, it's auto-removed.
 */
async function ungroupTabs({ tabIds }) {
  if (!Array.isArray(tabIds)) tabIds = [tabIds];
  await browser.tabs.ungroup(tabIds);
  return { success: true, ungroupedCount: tabIds.length };
}

/**
 * List all tab groups.
 */
async function listGroups({ windowId } = {}) {
  const query = windowId != null ? { windowId } : {};
  const groups = await browser.tabGroups.query(query);
  
  // For each group, also get the tab count
  const result = [];
  for (const group of groups) {
    const tabs = await browser.tabs.query({ groupId: group.id });
    result.push({
      ...summarizeGroup(group),
      tabCount: tabs.length,
    });
  }

  return { count: result.length, groups: result };
}

/**
 * Move tabs to a specific position or window.
 */
async function moveTabs({ tabIds, index, windowId }) {
  if (!Array.isArray(tabIds)) tabIds = [tabIds];
  const moveProps = { index: index ?? -1 };
  if (windowId != null) moveProps.windowId = windowId;

  const moved = await browser.tabs.move(tabIds, moveProps);
  const movedArr = Array.isArray(moved) ? moved : [moved];
  return { success: true, movedCount: movedArr.length };
}

/**
 * Create a new tab.
 */
async function createTab({ url, active = true, pinned = false }) {
  const props = { active };
  if (url) props.url = url;
  if (pinned) props.pinned = pinned;

  const tab = await browser.tabs.create(props);
  return { success: true, tab: summarizeTab(tab) };
}

/**
 * Reload one or more tabs.
 */
async function reloadTabs({ tabIds, bypassCache = false }) {
  if (!Array.isArray(tabIds)) tabIds = [tabIds];
  for (const id of tabIds) {
    await browser.tabs.reload(id, { bypassCache });
  }
  return { success: true, reloadedCount: tabIds.length };
}

/**
 * Discard (unload) tabs to save memory. Cannot discard active tabs.
 */
async function discardTabs({ tabIds }) {
  if (!Array.isArray(tabIds)) tabIds = [tabIds];
  
  // Filter out active tabs
  const results = [];
  for (const id of tabIds) {
    try {
      await browser.tabs.discard(id);
      results.push({ id, discarded: true });
    } catch (e) {
      results.push({ id, discarded: false, error: e.message });
    }
  }
  
  const discardedCount = results.filter(r => r.discarded).length;
  return { success: true, discardedCount, results };
}

/**
 * Duplicate a tab.
 */
async function duplicateTab({ tabId }) {
  const newTab = await browser.tabs.duplicate(tabId);
  return { success: true, tab: summarizeTab(newTab) };
}

/**
 * Pin or unpin tabs.
 */
async function pinTabs({ tabIds, pinned = true }) {
  if (!Array.isArray(tabIds)) tabIds = [tabIds];
  for (const id of tabIds) {
    await browser.tabs.update(id, { pinned });
  }
  return { success: true, count: tabIds.length, pinned };
}

/**
 * Mute or unmute tabs.
 */
async function muteTabs({ tabIds, muted = true }) {
  if (!Array.isArray(tabIds)) tabIds = [tabIds];
  for (const id of tabIds) {
    await browser.tabs.update(id, { muted });
  }
  return { success: true, count: tabIds.length, muted };
}

/**
 * Collapse or expand a tab group.
 */
async function collapseGroup({ groupId, collapsed = true }) {
  await browser.tabGroups.update(groupId, { collapsed });
  const group = await browser.tabGroups.get(groupId);
  return { success: true, group: summarizeGroup(group) };
}

/**
 * Update a tab group's title and/or color.
 */
async function updateGroup({ groupId, title, color }) {
  const updateProps = {};
  if (title != null) updateProps.title = title;
  if (color != null) updateProps.color = color;
  
  await browser.tabGroups.update(groupId, updateProps);
  const group = await browser.tabGroups.get(groupId);
  return { success: true, group: summarizeGroup(group) };
}

// ─── Exports (attached to global for background script access) ─────

// In MV2 background scripts loaded via manifest, we use a global namespace
var TabTools = {
  listTabs,
  switchTab,
  closeTabs,
  closeDuplicateTabs,
  groupTabs,
  ungroupTabs,
  listGroups,
  moveTabs,
  createTab,
  reloadTabs,
  discardTabs,
  duplicateTab,
  pinTabs,
  muteTabs,
  collapseGroup,
  updateGroup,
};
