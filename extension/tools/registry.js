/**
 * Tab Whisperer — Tool Registry
 * 
 * Maps tool names to their implementations and defines
 * OpenAI-compatible function calling schemas.
 * 
 * Loaded after tab-tools.js and search-tools.js in the background page.
 */

var ToolRegistry = (function () {

  // ─── Tool Definitions (OpenAI function calling format) ───

  const definitions = [
    {
      type: "function",
      function: {
        name: "list_tabs",
        description: "List all open tabs. Returns tab ID, title, URL, group info, and status for each tab. Use this to understand what tabs the user has open before performing actions.",
        parameters: {
          type: "object",
          properties: {
            windowId: {
              type: "integer",
              description: "Only list tabs in this window. Omit to list tabs across all windows.",
            },
            groupId: {
              type: "integer",
              description: "Only list tabs in this tab group. Omit to list all tabs.",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "switch_tab",
        description: "Switch to (activate) a specific tab and focus its window. Use after finding the desired tab with list_tabs.",
        parameters: {
          type: "object",
          properties: {
            tabId: {
              type: "integer",
              description: "The ID of the tab to switch to.",
            },
          },
          required: ["tabId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "close_tabs",
        description: "Close one or more tabs by their IDs. Will refuse to close ALL tabs in a window (at least one must remain). For closing duplicates, prefer close_duplicate_tabs instead.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to close.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "close_duplicate_tabs",
        description: "Find and close duplicate tabs (same URL) in a window, keeping the first occurrence of each URL.",
        parameters: {
          type: "object",
          properties: {
            windowId: {
              type: "integer",
              description: "Window to check for duplicates. Omit for current window.",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "group_tabs",
        description: "Group tabs together into a named, colored tab group. Creates a new group or adds tabs to an existing group.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to group together.",
            },
            title: {
              type: "string",
              description: "Name for the tab group (e.g. 'Work', 'Research', 'Shopping').",
            },
            color: {
              type: "string",
              enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
              description: "Color for the tab group.",
            },
            groupId: {
              type: "integer",
              description: "Add tabs to this existing group instead of creating a new one.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ungroup_tabs",
        description: "Remove tabs from their tab group(s). If a group becomes empty, it is automatically removed.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to remove from their groups.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_groups",
        description: "List all tab groups with their title, color, and tab count.",
        parameters: {
          type: "object",
          properties: {
            windowId: {
              type: "integer",
              description: "Only list groups in this window. Omit for all windows.",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "move_tabs",
        description: "Move tabs to a specific position or to a different window.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to move.",
            },
            index: {
              type: "integer",
              description: "Position to move tabs to. Use -1 for the end.",
            },
            windowId: {
              type: "integer",
              description: "Move tabs to this window. Omit to keep in current window.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_tab",
        description: "Open a new tab, optionally with a specific URL.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to open. Omit for a new blank tab.",
            },
            active: {
              type: "boolean",
              description: "Whether to make the new tab active (default: true).",
            },
            pinned: {
              type: "boolean",
              description: "Whether to pin the new tab (default: false).",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reload_tabs",
        description: "Reload one or more tabs.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to reload.",
            },
            bypassCache: {
              type: "boolean",
              description: "Bypass the cache (hard reload). Default: false.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "discard_tabs",
        description: "Unload tabs from memory to save resources. Tabs remain visible but will reload when activated. Cannot discard the active tab.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to discard.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "duplicate_tab",
        description: "Duplicate an existing tab.",
        parameters: {
          type: "object",
          properties: {
            tabId: {
              type: "integer",
              description: "The ID of the tab to duplicate.",
            },
          },
          required: ["tabId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "pin_tabs",
        description: "Pin or unpin tabs.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to pin/unpin.",
            },
            pinned: {
              type: "boolean",
              description: "True to pin, false to unpin. Default: true.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mute_tabs",
        description: "Mute or unmute tabs.",
        parameters: {
          type: "object",
          properties: {
            tabIds: {
              type: "array",
              items: { type: "integer" },
              description: "Array of tab IDs to mute/unmute.",
            },
            muted: {
              type: "boolean",
              description: "True to mute, false to unmute. Default: true.",
            },
          },
          required: ["tabIds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "collapse_group",
        description: "Collapse or expand a tab group.",
        parameters: {
          type: "object",
          properties: {
            groupId: {
              type: "integer",
              description: "The ID of the tab group.",
            },
            collapsed: {
              type: "boolean",
              description: "True to collapse, false to expand. Default: true.",
            },
          },
          required: ["groupId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_group",
        description: "Update a tab group's title and/or color.",
        parameters: {
          type: "object",
          properties: {
            groupId: {
              type: "integer",
              description: "The ID of the tab group to update.",
            },
            title: {
              type: "string",
              description: "New title for the group.",
            },
            color: {
              type: "string",
              enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
              description: "New color for the group.",
            },
          },
          required: ["groupId"],
        },
      },
    },
    // ─── Search / Navigation Tools ───
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Perform a web search. Opens results in a new tab using the browser's search engine.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query.",
            },
            engine: {
              type: "string",
              description: "Name of a specific search engine to use (e.g. 'Google', 'DuckDuckGo'). Omit for the default engine.",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_search_engines",
        description: "List all installed search engines in the browser.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_bookmarks",
        description: "Search the user's bookmarks by title or URL.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query to match against bookmark titles and URLs.",
            },
            maxResults: {
              type: "integer",
              description: "Maximum number of results to return. Default: 20.",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_bookmark",
        description: "Create a bookmark. If no URL is provided, bookmarks the currently active tab.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Title for the bookmark.",
            },
            url: {
              type: "string",
              description: "URL to bookmark. Omit to bookmark the active tab.",
            },
            folderId: {
              type: "string",
              description: "ID of the folder to create the bookmark in.",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_history",
        description: "Search the user's browsing history.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query to match against history URLs and titles. Use empty string to match all.",
            },
            maxResults: {
              type: "integer",
              description: "Maximum number of results. Default: 20.",
            },
            hoursBack: {
              type: "number",
              description: "Only search history from the last N hours.",
            },
          },
          required: [],
        },
      },
    },
    // ─── Report Generation Tools ───
    {
      type: "function",
      function: {
        name: "generate_report",
        description: "Generate a research report from all tabs in a tab group. Scrapes every tab's content and uses AI to synthesize a comprehensive markdown report, which opens in a new tab. Great for research, competitive analysis, or summarizing a collection of pages on a topic.",
        parameters: {
          type: "object",
          properties: {
            groupId: {
              type: "integer",
              description: "The ID of the tab group to generate a report from.",
            },
            groupName: {
              type: "string",
              description: "The name of the tab group (fuzzy match). Use this if you don't have the groupId.",
            },
            topic: {
              type: "string",
              description: "Optional focus topic for the report. If provided, the report will emphasize this angle.",
            },
          },
          required: [],
        },
      },
    },
    // ─── Page Automation Tools ───
    {
      type: "function",
      function: {
        name: "inspect_page",
        description: "Extract interactive elements from a tab's page — inputs, buttons, links, selects, textareas. Returns CSS selectors, labels, and current values. Use this to understand what you can interact with on a page before using interact_with_page.",
        parameters: {
          type: "object",
          properties: {
            tabId: {
              type: "integer",
              description: "The ID of the tab to inspect.",
            },
          },
          required: ["tabId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "interact_with_page",
        description: "Execute DOM actions on a page — click buttons, type into inputs, select dropdown values, submit forms, or press keys. Actions run sequentially with small delays between them. Use inspect_page first to find the right selectors.",
        parameters: {
          type: "object",
          properties: {
            tabId: {
              type: "integer",
              description: "The ID of the tab to interact with.",
            },
            actions: {
              type: "array",
              description: "Array of actions to execute in order.",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["click", "type", "select", "submit", "press"],
                    description: "Action type: click (click element), type (fill text input), select (pick dropdown value), submit (submit form), press (key press like Enter).",
                  },
                  selector: {
                    type: "string",
                    description: "CSS selector of the target element (from inspect_page).",
                  },
                  text: {
                    type: "string",
                    description: "Text to type (only for 'type' action).",
                  },
                  value: {
                    type: "string",
                    description: "Value to select (only for 'select' action).",
                  },
                  key: {
                    type: "string",
                    description: "Key to press (only for 'press' action). Default: 'Enter'.",
                  },
                },
                required: ["type", "selector"],
              },
            },
          },
          required: ["tabId", "actions"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wait_for_page",
        description: "Wait for a tab to finish loading after a navigation or form submission. Returns the new URL and title once loaded.",
        parameters: {
          type: "object",
          properties: {
            tabId: {
              type: "integer",
              description: "The ID of the tab to wait on.",
            },
            timeout: {
              type: "integer",
              description: "Max time to wait in milliseconds. Default: 5000, max: 15000.",
            },
          },
          required: ["tabId"],
        },
      },
    },
  ];

  // ─── Function Map (name → implementation) ────────────────

  const implementations = {
    // Tab tools
    list_tabs: TabTools.listTabs,
    switch_tab: TabTools.switchTab,
    close_tabs: TabTools.closeTabs,
    close_duplicate_tabs: TabTools.closeDuplicateTabs,
    group_tabs: TabTools.groupTabs,
    ungroup_tabs: TabTools.ungroupTabs,
    list_groups: TabTools.listGroups,
    move_tabs: TabTools.moveTabs,
    create_tab: TabTools.createTab,
    reload_tabs: TabTools.reloadTabs,
    discard_tabs: TabTools.discardTabs,
    duplicate_tab: TabTools.duplicateTab,
    pin_tabs: TabTools.pinTabs,
    mute_tabs: TabTools.muteTabs,
    collapse_group: TabTools.collapseGroup,
    update_group: TabTools.updateGroup,

    // Search/navigation tools
    web_search: SearchTools.webSearch,
    list_search_engines: SearchTools.listSearchEngines,
    search_bookmarks: SearchTools.searchBookmarks,
    create_bookmark: SearchTools.createBookmark,
    search_history: SearchTools.searchHistory,

    // Report generation
    generate_report: ReportTools.generateReport,

    // Page automation
    inspect_page: AutomationTools.inspectPage,
    interact_with_page: AutomationTools.interactWithPage,
    wait_for_page: AutomationTools.waitForPage,
  };

  // ─── Public API ──────────────────────────────────────────

  return {
    /**
     * Get all tool definitions for the LLM (OpenAI tools array).
     */
    getDefinitions() {
      return definitions;
    },

    /**
     * Execute a tool by name with the given arguments.
     * Returns the result object, or an error object on failure.
     */
    async execute(name, args) {
      const fn = implementations[name];
      if (!fn) {
        return { error: `Unknown tool: ${name}` };
      }
      try {
        return await fn(args || {});
      } catch (err) {
        console.error(`Tool ${name} failed:`, err);
        return { error: err.message };
      }
    },

    /**
     * Check if a tool name exists.
     */
    has(name) {
      return name in implementations;
    },

    /**
     * Get list of all tool names.
     */
    getNames() {
      return Object.keys(implementations);
    },
  };
})();
