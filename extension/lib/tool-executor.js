/**
 * Tab Whisperer — Tool Executor
 * 
 * Implements the agentic tool-calling loop:
 * 1. Send user message + context to LLM
 * 2. If LLM returns tool_calls, execute them
 * 3. Feed results back to LLM
 * 4. Repeat until LLM returns a text response (or max iterations)
 */

var ToolExecutor = (function () {

  const MAX_ITERATIONS = 10;
  const AUTO_WAIT_TIMEOUT_MS = 7000;
  let callIdCounter = 0;
  function nextCallId() {
    return `tc_${Date.now()}_${callIdCounter++}`;
  }

  // ─── Character Budget ────────────────────────────────────
  //
  // Total characters we'll spend on tab context in the prompt.
  // Divided evenly across tabs, with a per-tab cap so that one
  // very content-rich tab doesn't eat moderate budgets when there
  // are few tabs open.

  const GLOBAL_CONTEXT_BUDGET = 10000;  // chars total for all tabs (keeps TPM usage low)
  const MAX_CHARS_PER_TAB = 800;        // hard cap per tab
  const CONTENT_EXTRACTION_TIMEOUT_MS = 1500;
  const CONTEXT_BUILD_TIMEOUT_MS = 5000;

  // ─── Content Extraction ──────────────────────────────────

  /**
   * Inject the extraction content script into a tab and return
   * the structured result.  Silently returns null for tabs we
   * can't inject into (about:*, moz-extension:*, etc.).
   */
  async function extractTabContent(tabId, tabUrl, blockedPatterns) {
    if (isUrlBlocked(tabUrl, blockedPatterns)) {
      return { blocked: true };
    }

    try {
      const extractionPromise = browser.tabs.executeScript(tabId, {
        file: "/content/extract.js",
        runAt: "document_idle",
      }).then((results) => (results && results[0] ? results[0] : null))
        .catch(() => null);

      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(null), CONTENT_EXTRACTION_TIMEOUT_MS);
      });

      return await Promise.race([extractionPromise, timeoutPromise]);
    } catch (e) {
      // Privileged / restricted pages — expected
      return null;
    }
  }

  /**
   * Format the extracted content for a single tab into a compact
   * text block, trimmed to fit within `budget` characters.
   */
  function formatExtraction(extraction, budget) {
    if (!extraction) return "";

    const parts = [];

    // Meta description (highest signal density)
    const desc = extraction.meta?.description;
    if (desc) parts.push(`desc: ${desc}`);

    // OG / site metadata
    const ogSite = extraction.meta?.ogSiteName;
    if (ogSite) parts.push(`site: ${ogSite}`);
    const ogType = extraction.meta?.ogType;
    if (ogType) parts.push(`type: ${ogType}`);
    const section = extraction.meta?.section;
    if (section) parts.push(`section: ${section}`);
    const author = extraction.meta?.author;
    if (author) parts.push(`author: ${author}`);

    // Keywords
    const keywords = extraction.meta?.keywords;
    if (keywords) parts.push(`keywords: ${keywords}`);

    // Breadcrumbs
    if (extraction.breadcrumbs) parts.push(`path: ${extraction.breadcrumbs}`);

    // JSON-LD types
    if (extraction.jsonLd && extraction.jsonLd.length > 0) {
      const types = extraction.jsonLd
        .map(j => {
          let s = j.type;
          if (j.name) s += `: ${j.name}`;
          return s;
        })
        .join("; ");
      parts.push(`structured: ${types}`);
    }

    // Headings
    if (extraction.headings) {
      const { h1, h2 } = extraction.headings;
      if (h1 && h1.length > 0) parts.push(`h1: ${h1.join(" | ")}`);
      if (h2 && h2.length > 0) parts.push(`h2: ${h2.join(" | ")}`);
    }

    let text = parts.join("\n    ");

    // If we still have budget remaining, append body text excerpt
    if (extraction.bodyText && text.length < budget - 40) {
      const remaining = budget - text.length - 20; // leave some margin
      if (remaining > 50) {
        const excerpt = extraction.bodyText.substring(0, remaining);
        text += `\n    content: ${excerpt}`;
      }
    }

    // Final trim to budget
    if (text.length > budget) {
      text = text.substring(0, budget - 3) + "...";
    }

    return text;
  }

  // ─── Context Building ────────────────────────────────────

  /**
   * Build the context message with current tab state.
   * Injects the extraction script into each tab in parallel,
   * then formats everything within the character budget.
   */
  async function buildContext() {
    try {
      const tabs = await browser.tabs.query({});
      const blockedPatterns = await getBlockedPatternsSafe();
      let groups = [];
      try {
        groups = await browser.tabGroups.query({});
      } catch (e) {
        // tabGroups may not be available
      }

      // Calculate per-tab budget
      const numTabs = tabs.length || 1;
      const perTabBudget = Math.min(
        Math.floor(GLOBAL_CONTEXT_BUDGET / numTabs),
        MAX_CHARS_PER_TAB,
      );

      // Extract content from all tabs in parallel
      const blockedByPolicy = tabs.map((t) => isUrlBlocked(t.url, blockedPatterns));

      const extractions = await Promise.all(
        tabs.map((t, i) => {
          if (blockedByPolicy[i]) return Promise.resolve({ blocked: true });
          return extractTabContent(t.id, t.url, blockedPatterns);
        }),
      );

      // Build tab summaries with enriched content
      const tabSummary = tabs.map((t, i) => {
        // Basic line (always present)
        let entry = `  [${t.id}] "${t.title}" - ${t.url}`;
        const flags = [];
        if (t.active) flags.push("ACTIVE");
        if (t.pinned) flags.push("pinned");
        if (t.groupId && t.groupId !== -1) flags.push(`group:${t.groupId}`);
        if (t.audible) flags.push("playing audio");
        if (t.discarded) flags.push("discarded");
        if (blockedByPolicy[i]) flags.push("blocked");
        if (flags.length > 0) entry += ` (${flags.join(", ")})`;

        // Enriched content (budget-limited)
        if (blockedByPolicy[i]) {
          entry += "\n    content access blocked by user policy";
        } else {
          const basicLen = entry.length;
          const contentBudget = Math.max(perTabBudget - basicLen - 10, 0);
          const enriched = formatExtraction(extractions[i], contentBudget);

          if (enriched) {
            entry += `\n    ${enriched}`;
          }
        }

        return entry;
      }).join("\n");

      const groupSummary = groups.length > 0
        ? groups.map(g =>
            `  [${g.id}] "${g.title || "(untitled)"}" (${g.color}, ${g.collapsed ? "collapsed" : "expanded"})`,
          ).join("\n")
        : "  (no groups)";

      return `Current browser state:
TABS (${tabs.length} total, budget: ${perTabBudget} chars/tab):
${tabSummary}

TAB GROUPS (${groups.length}):
${groupSummary}`;
    } catch (err) {
      console.warn("[ToolExecutor] Failed to build context:", err);
      return "Could not retrieve current browser state.";
    }
  }

  // ─── Pass Reasoning ───────────────────────────────────────

  const TOOL_REASONING_PHRASES = {
    switch_tab: "focus the target tab",
    close_tabs: "close selected tabs",
    close_duplicate_tabs: "remove duplicate tabs",
    group_tabs: "group related tabs",
    ungroup_tabs: "ungroup selected tabs",
    list_groups: "check existing tab groups",
    move_tabs: "reorder tabs",
    create_tab: "open the requested page",
    reload_tabs: "reload selected tabs",
    discard_tabs: "unload tabs from memory",
    duplicate_tab: "duplicate a tab",
    pin_tabs: "pin or unpin tabs",
    mute_tabs: "mute or unmute tabs",
    collapse_group: "collapse or expand a group",
    update_group: "update a tab group",
    web_search: "run a web search",
    list_search_engines: "check available search engines",
    search_bookmarks: "search bookmarks",
    create_bookmark: "save a bookmark",
    search_history: "search browsing history",
    generate_report: "generate the report",
    inspect_page: "inspect page controls",
    interact_with_page: "interact with page elements",
    wait_for_page: "wait for page load",
  };

  const TOOL_PERMISSION_TIERS = {
    list_tabs: "read",
    list_groups: "read",
    list_search_engines: "read",
    search_bookmarks: "read",
    search_history: "read",

    group_tabs: "organize",
    ungroup_tabs: "organize",
    move_tabs: "organize",
    pin_tabs: "organize",
    mute_tabs: "organize",
    collapse_group: "organize",
    update_group: "organize",
    reload_tabs: "organize",
    discard_tabs: "organize",
    duplicate_tab: "organize",
    switch_tab: "organize",

    create_tab: "navigate",
    web_search: "navigate",
    create_bookmark: "navigate",

    close_tabs: "close",
    close_duplicate_tabs: "close",

    inspect_page: "interact",
    interact_with_page: "interact",
    wait_for_page: "interact",

    generate_report: "report",
  };

  const DESTRUCTIVE_TOOLS = new Set(["close_tabs", "close_duplicate_tabs"]);
  const BLOCKED_SITE_ERROR = "Blocked by privacy settings for this site.";

  function getPermissionTiers(parsedCalls) {
    const tiers = [];
    const seen = new Set();

    for (const call of parsedCalls) {
      const tier = TOOL_PERMISSION_TIERS[call.funcName];
      if (!tier || seen.has(tier)) continue;
      seen.add(tier);
      tiers.push(tier);
    }

    return tiers;
  }

  function createAbortError() {
    return new DOMException("Aborted", "AbortError");
  }

  function isAbortError(err) {
    return !!(err && (err.name === "AbortError" || err.code === 20));
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      throw createAbortError();
    }
  }

  async function getBlockedPatternsSafe() {
    if (typeof UrlPolicy === "undefined" || !UrlPolicy.getBlockedPatterns) {
      return [];
    }
    try {
      return await UrlPolicy.getBlockedPatterns();
    } catch (e) {
      return [];
    }
  }

  function isUrlBlocked(url, blockedPatterns) {
    if (!url || !Array.isArray(blockedPatterns) || blockedPatterns.length === 0) {
      return false;
    }
    if (typeof UrlPolicy === "undefined" || !UrlPolicy.isBlockedUrl) {
      return false;
    }
    return UrlPolicy.isBlockedUrl(url, blockedPatterns);
  }

  function awaitWithSignal(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(createAbortError());
      };

      signal.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(promise).then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  function cleanReasoningText(text) {
    if (!text || typeof text !== "string") return null;
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return null;

    let concise = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
    concise = concise.trim();
    if (!concise) return null;

    // Filter out non-reasoning placeholders
    if (/^\(?no response\)?$/i.test(concise)) return null;

    // Keep a consistent timeline tone
    if (!/^plan\s*:/i.test(concise)) {
      concise = `Plan: ${concise}`;
    }

    // Strip markdown bullets/prefixes if model adds them
    concise = concise.replace(/^plan\s*:\s*[-*]\s*/i, "Plan: ");

    if (concise.length > 110) {
      concise = concise.substring(0, 107).trimEnd() + "...";
    }

    if (!/[.!?]$/.test(concise)) {
      concise += ".";
    }

    return concise;
  }

  function buildPassReasoning(parsedCalls, assistantContent) {
    const explicit = cleanReasoningText(assistantContent);
    if (explicit) return explicit;

    const uniqueNames = [];
    for (const call of parsedCalls) {
      const name = call.funcName;
      if (name === "list_tabs") continue;
      if (!uniqueNames.includes(name)) uniqueNames.push(name);
    }

    if (uniqueNames.length === 0) return null;

    const phrases = uniqueNames.map((name) => {
      if (TOOL_REASONING_PHRASES[name]) return TOOL_REASONING_PHRASES[name];
      return `run ${String(name).replace(/_/g, " ")}`;
    });

    if (phrases.length === 1) {
      return `Plan: ${phrases[0]}.`;
    }
    if (phrases.length === 2) {
      return `Plan: ${phrases[0]}, then ${phrases[1]}.`;
    }
    return `Plan: ${phrases[0]}, ${phrases[1]}, and ${phrases.length - 2} more.`;
  }

  // ─── Auto Browser Follow-Up ──────────────────────────────

  /**
   * After any create_tab call, automatically wait for load and inspect the
   * page so the next LLM turn can immediately click/type/select elements.
   */
  async function autoInspectCreatedTabs(
    toolResults,
    iteration,
    onUpdate,
    allToolCalls,
    messages,
    signal,
  ) {
    throwIfAborted(signal);

    const createdTabs = toolResults
      .filter((t) => t.funcName === "create_tab" && !(t.result && t.result.deduped))
      .map((t) => t.result && t.result.tab && t.result.tab.id)
      .filter((id) => typeof id === "number");

    if (createdTabs.length === 0) return;

    const reasoning = createdTabs.length === 1
      ? "Plan: verify the new page load and inspect available controls."
      : `Plan: verify ${createdTabs.length} new pages and inspect their controls.`;
    onUpdate("reasoning", { message: reasoning });

    const autoRuns = await Promise.all(
      createdTabs.map(async (tabId, index) => {
        throwIfAborted(signal);

        const waitArgs = { tabId, timeout: AUTO_WAIT_TIMEOUT_MS };
        const waitCallId = nextCallId();
        onUpdate("tool_call", {
          callId: waitCallId,
          name: "wait_for_page",
          args: waitArgs,
        });

        const waitResult = await ToolRegistry.execute("wait_for_page", waitArgs);
        onUpdate("tool_result", {
          callId: waitCallId,
          name: "wait_for_page",
          result: waitResult,
        });

        throwIfAborted(signal);

        const inspectArgs = { tabId };
        const inspectCallId = nextCallId();
        onUpdate("tool_call", {
          callId: inspectCallId,
          name: "inspect_page",
          args: inspectArgs,
        });

        const inspectResult = await ToolRegistry.execute("inspect_page", inspectArgs);
        onUpdate("tool_result", {
          callId: inspectCallId,
          name: "inspect_page",
          result: inspectResult,
        });

        return {
          index,
          wait: {
            toolCallId: `auto_wait_${iteration}_${tabId}_${index}`,
            callId: waitCallId,
            name: "wait_for_page",
            args: waitArgs,
            result: waitResult,
          },
          inspect: {
            toolCallId: `auto_inspect_${iteration}_${tabId}_${index}`,
            callId: inspectCallId,
            name: "inspect_page",
            args: inspectArgs,
            result: inspectResult,
          },
        };
      }),
    );

    // Keep deterministic order in conversation/history
    autoRuns.sort((a, b) => a.index - b.index);

    const syntheticToolCalls = [];

    for (const run of autoRuns) {
      for (const autoCall of [run.wait, run.inspect]) {
        allToolCalls.push({
          callId: autoCall.callId,
          name: autoCall.name,
          args: autoCall.args,
          result: autoCall.result,
        });

        syntheticToolCalls.push({
          id: autoCall.toolCallId,
          type: "function",
          function: {
            name: autoCall.name,
            arguments: JSON.stringify(autoCall.args),
          },
        });
      }
    }

    if (syntheticToolCalls.length === 0) return;

    // Inject synthetic tool calls + results so the LLM sees page element context
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: syntheticToolCalls,
    });

    for (const run of autoRuns) {
      for (const autoCall of [run.wait, run.inspect]) {
        messages.push({
          role: "tool",
          tool_call_id: autoCall.toolCallId,
          content: JSON.stringify(autoCall.result),
        });
      }
    }
  }

  /**
   * Normalize URLs so duplicate create_tab calls can be suppressed.
   */
  function normalizeUrlForDedup(url) {
    if (!url || typeof url !== "string") return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

    const stripWww = (host) => String(host || "").replace(/^www\./i, "");

    function normalizeParsed(parsed) {
      const protocol = parsed.protocol || "https:";
      const host = stripWww(parsed.host || parsed.hostname).toLowerCase();
      const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
      return `${protocol}//${host}${path}${parsed.search || ""}`;
    }

    try {
      const parsed = new URL(trimmed);
      return normalizeParsed(parsed);
    } catch (e) {
      // Common command format from LLM/user: "youtube.com" or "www.youtube.com"
      try {
        const parsed = new URL(`https://${trimmed}`);
        return normalizeParsed(parsed);
      } catch (e2) {
        return trimmed.toLowerCase().replace(/\/+$/, "");
      }
    }
  }

  /**
   * True if target tab is already active and its window is focused.
   */
  async function isTabAlreadyFocused(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (!tab || !tab.active) return false;
      const win = await browser.windows.get(tab.windowId);
      return !!(win && win.focused);
    } catch (e) {
      return false;
    }
  }

  /**
   * Execute a single command through the LLM tool-calling loop.
   *
   * @param {string} userText - The user's command text
   * @param {function} onUpdate - Callback for progress updates: (type, data) => void
   *   type: "thinking" | "reasoning" | "permissions" | "tool_call" | "tool_result" | "response" | "error"
   * @param {Array} recentHistory - Last N action log entries for conversation context
   * @param {Object} options - { signal?: AbortSignal, confirm?: (name, args) => Promise<boolean> }
   * @returns {Object} { response: string, toolCalls: Array, error?: string, cancelled?: boolean }
   */
  async function execute(userText, onUpdate = () => {}, recentHistory = [], options = {}) {
    const signal = options && options.signal ? options.signal : null;
    const confirmFn = options && typeof options.confirm === "function" ? options.confirm : null;

    const tools = ToolRegistry.getDefinitions();
    const allToolCalls = [];
    const createdTabsByUrl = new Map();
    const inFlightCreateByUrl = new Map();
    const inFlightSwitchByTab = new Map();
    const blockedPatterns = await getBlockedPatternsSafe();

    const cancelledResult = () => {
      const message = "Command cancelled.";
      onUpdate("error", { message });
      return {
        response: null,
        toolCalls: allToolCalls,
        error: message,
        cancelled: true,
      };
    };

    // ─── Pre-run list_tabs instantly ────────────────────────
    // Fires UI updates immediately so it looks fast & responsive,
    // then injects the result into the conversation so the LLM
    // already has tab state and won't call list_tabs again.

    let listTabsResult;
    try {
      throwIfAborted(signal);
      const prerunCallId = nextCallId();
      onUpdate("tool_call", { callId: prerunCallId, name: "list_tabs", args: {} });
      listTabsResult = await ToolRegistry.execute("list_tabs", {});
      onUpdate("tool_result", {
        callId: prerunCallId,
        name: "list_tabs",
        result: listTabsResult,
      });
      allToolCalls.push({
        callId: prerunCallId,
        name: "list_tabs",
        args: {},
        result: listTabsResult,
      });

      // Seed dedup map with already-open tabs so create_tab reuses them.
      if (listTabsResult && Array.isArray(listTabsResult.tabs)) {
        for (const tab of listTabsResult.tabs) {
          const key = normalizeUrlForDedup(tab && tab.url);
          if (!key || createdTabsByUrl.has(key)) continue;
          createdTabsByUrl.set(key, tab);
        }
      }
    } catch (e) {
      if (isAbortError(e) || (signal && signal.aborted)) {
        return cancelledResult();
      }
      console.warn("[ToolExecutor] Pre-run list_tabs failed:", e);
    }

    let context = "Could not retrieve current browser state.";
    try {
      throwIfAborted(signal);

      const contextTimeout = new Promise((resolve) => {
        setTimeout(() => resolve("Could not retrieve current browser state."), CONTEXT_BUILD_TIMEOUT_MS);
      });

      context = await awaitWithSignal(
        Promise.race([buildContext(), contextTimeout]),
        signal,
      );

      throwIfAborted(signal);
    } catch (e) {
      if (isAbortError(e) || (signal && signal.aborted)) {
        return cancelledResult();
      }
      console.warn("[ToolExecutor] Context build failed:", e);
      context = "Could not retrieve current browser state.";
    }

    // Build initial messages
    const messages = [{ role: "system", content: LLMClient.SYSTEM_PROMPT }];

    // ─── Inject recent conversation history ──────────────────
    // Last 5 action log entries give the LLM context for follow-up
    // commands like "do that again", "close those tabs", etc.
    if (recentHistory && recentHistory.length > 0) {
      for (const entry of recentHistory) {
        messages.push({ role: "user", content: `User command: ${entry.command}` });

        if (entry.toolCalls && entry.toolCalls.length > 0) {
          const toolCalls = entry.toolCalls.map((tc, i) => ({
            id: `hist_${entry.id}_${i}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args || {}),
            },
          }));

          messages.push({
            role: "assistant",
            content: null,
            tool_calls: toolCalls,
          });

          for (let i = 0; i < entry.toolCalls.length; i++) {
            const tc = entry.toolCalls[i];
            let resultStr = JSON.stringify(tc.result || {});
            if (resultStr.length > 500) {
              resultStr = resultStr.substring(0, 497) + "...";
            }
            messages.push({
              role: "tool",
              tool_call_id: `hist_${entry.id}_${i}`,
              content: resultStr,
            });
          }
        }

        if (entry.response) {
          messages.push({ role: "assistant", content: entry.response });
        }
      }
    }

    messages.push({ role: "user", content: `${context}\n\nUser command: ${userText}` });

    if (listTabsResult) {
      const fakeCallId = "prerun_list_tabs";
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: fakeCallId,
            type: "function",
            function: { name: "list_tabs", arguments: "{}" },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: fakeCallId,
        content: JSON.stringify(listTabsResult),
      });
    }

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      throwIfAborted(signal);

      let assistantMessage;
      try {
        assistantMessage = await LLMClient.chatCompletion(messages, tools, signal);
      } catch (err) {
        if (isAbortError(err) || (signal && signal.aborted)) {
          return cancelledResult();
        }
        const errorMsg = `LLM error: ${err.message}`;
        onUpdate("error", { message: errorMsg });
        return { response: null, toolCalls: allToolCalls, error: errorMsg };
      }

      messages.push(assistantMessage);

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const parsed = assistantMessage.tool_calls.map((toolCall) => {
          let funcArgs;
          try {
            funcArgs = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            funcArgs = {};
          }
          const callId = nextCallId();
          return { toolCall, funcName: toolCall.function.name, funcArgs, callId };
        });

        const reasoning = buildPassReasoning(parsed, assistantMessage.content);
        if (reasoning) {
          onUpdate("reasoning", { message: reasoning });
        }

        const permissionTiers = getPermissionTiers(parsed);
        if (permissionTiers.length > 0) {
          onUpdate("permissions", { tiers: permissionTiers });
        }

        for (const { funcName, funcArgs, callId } of parsed) {
          onUpdate("tool_call", { callId, name: funcName, args: funcArgs });
          console.log(`[ToolExecutor] Calling ${funcName}(${JSON.stringify(funcArgs)})`);
        }

        const approvalsByCallId = new Map();
        for (const { funcName, funcArgs, callId } of parsed) {
          if (!DESTRUCTIVE_TOOLS.has(funcName)) continue;

          try {
            throwIfAborted(signal);
            const approved = confirmFn
              ? await awaitWithSignal(confirmFn(funcName, funcArgs), signal)
              : true;
            approvalsByCallId.set(callId, !!approved);
          } catch (err) {
            if (isAbortError(err) || (signal && signal.aborted)) {
              return cancelledResult();
            }
            const errorMsg = `Confirmation error: ${err.message}`;
            onUpdate("error", { message: errorMsg });
            return { response: null, toolCalls: allToolCalls, error: errorMsg };
          }
        }

        let toolResults;
        try {
          toolResults = await Promise.all(
            parsed.map(async ({ toolCall, funcName, funcArgs, callId }) => {
              throwIfAborted(signal);

              if (DESTRUCTIVE_TOOLS.has(funcName) && approvalsByCallId.get(callId) === false) {
                const deniedResult = {
                  error: "User denied this action.",
                  denied: true,
                };
                onUpdate("tool_result", { callId, name: funcName, result: deniedResult });
                return { toolCall, funcName, funcArgs, callId, result: deniedResult };
              }

              if (
                funcName === "create_tab" &&
                funcArgs &&
                funcArgs.url &&
                isUrlBlocked(funcArgs.url, blockedPatterns)
              ) {
                const blockedResult = {
                  error: BLOCKED_SITE_ERROR,
                  blocked: true,
                  url: funcArgs.url,
                };
                onUpdate("tool_result", { callId, name: funcName, result: blockedResult });
                return { toolCall, funcName, funcArgs, callId, result: blockedResult };
              }

              // Guardrail: suppress redundant switch_tab calls when the tab
              // is already active/focused or an identical switch is in-flight.
              if (funcName === "switch_tab") {
                const tabId = funcArgs && funcArgs.tabId;
                if (typeof tabId === "number") {
                  const alreadyFocused = await isTabAlreadyFocused(tabId);
                  if (alreadyFocused) {
                    const noopResult = {
                      success: true,
                      skipped: true,
                      alreadyFocused: true,
                      tabId,
                      message: "switch_tab skipped: tab already active and focused.",
                    };
                    onUpdate("tool_result", { callId, name: funcName, result: noopResult });
                    console.log(`[ToolExecutor] ${funcName} noop (already focused):`, noopResult);
                    return { toolCall, funcName, funcArgs, callId, result: noopResult };
                  }

                  const inFlightSwitch = inFlightSwitchByTab.get(tabId);
                  if (inFlightSwitch) {
                    const firstSwitchResult = await inFlightSwitch;
                    throwIfAborted(signal);
                    const dedupedSwitch = {
                      success: true,
                      deduped: true,
                      tabId,
                      switch: firstSwitchResult,
                      message: "Duplicate switch_tab suppressed; reused in-flight switch.",
                    };
                    onUpdate("tool_result", { callId, name: funcName, result: dedupedSwitch });
                    console.log(`[ToolExecutor] ${funcName} deduped (in-flight):`, dedupedSwitch);
                    return { toolCall, funcName, funcArgs, callId, result: dedupedSwitch };
                  }

                  throwIfAborted(signal);
                  const switchPromise = ToolRegistry.execute(funcName, funcArgs);
                  inFlightSwitchByTab.set(tabId, switchPromise);

                  let switchResult;
                  try {
                    switchResult = await switchPromise;
                  } finally {
                    inFlightSwitchByTab.delete(tabId);
                  }

                  throwIfAborted(signal);

                  onUpdate("tool_result", { callId, name: funcName, result: switchResult });
                  console.log(`[ToolExecutor] ${funcName} result:`, switchResult);
                  return { toolCall, funcName, funcArgs, callId, result: switchResult };
                }
              }

              // Guardrail: suppress duplicate create_tab calls for the same URL
              // within a single command run. Re-focus existing tab instead.
              if (funcName === "create_tab") {
                const dedupKey = normalizeUrlForDedup(funcArgs && funcArgs.url);
                if (dedupKey) {
                  const existingTab = createdTabsByUrl.get(dedupKey);
                  if (existingTab && typeof existingTab.id === "number") {
                    const switchResult = await isTabAlreadyFocused(existingTab.id)
                      ? {
                          success: true,
                          skipped: true,
                          alreadyFocused: true,
                          tabId: existingTab.id,
                          message: "switch_tab skipped: tab already active and focused.",
                        }
                      : await ToolRegistry.execute("switch_tab", {
                          tabId: existingTab.id,
                        });
                    throwIfAborted(signal);
                    const dedupedResult = {
                      success: true,
                      deduped: true,
                      tab: existingTab,
                      switch: switchResult,
                      message: "Duplicate create_tab suppressed; switched to existing tab.",
                    };
                    onUpdate("tool_result", { callId, name: funcName, result: dedupedResult });
                    console.log(`[ToolExecutor] ${funcName} deduped (existing):`, dedupedResult);
                    return { toolCall, funcName, funcArgs, callId, result: dedupedResult };
                  }

                  const inFlight = inFlightCreateByUrl.get(dedupKey);
                  if (inFlight) {
                    const firstCreateResult = await inFlight;
                    throwIfAborted(signal);
                    const firstTab = firstCreateResult && firstCreateResult.tab;
                    if (firstTab && typeof firstTab.id === "number") {
                      const switchResult = await isTabAlreadyFocused(firstTab.id)
                        ? {
                            success: true,
                            skipped: true,
                            alreadyFocused: true,
                            tabId: firstTab.id,
                            message: "switch_tab skipped: tab already active and focused.",
                          }
                        : await ToolRegistry.execute("switch_tab", {
                            tabId: firstTab.id,
                          });
                      throwIfAborted(signal);
                      const dedupedResult = {
                        success: true,
                        deduped: true,
                        tab: firstTab,
                        switch: switchResult,
                        message: "Duplicate create_tab suppressed; reused in-flight tab.",
                      };
                      onUpdate("tool_result", { callId, name: funcName, result: dedupedResult });
                      console.log(`[ToolExecutor] ${funcName} deduped (in-flight):`, dedupedResult);
                      return { toolCall, funcName, funcArgs, callId, result: dedupedResult };
                    }
                  }

                  throwIfAborted(signal);
                  const createPromise = ToolRegistry.execute(funcName, funcArgs);
                  inFlightCreateByUrl.set(dedupKey, createPromise);

                  let result;
                  try {
                    result = await createPromise;
                  } finally {
                    inFlightCreateByUrl.delete(dedupKey);
                  }

                  throwIfAborted(signal);

                  const resultKey = normalizeUrlForDedup(
                    (result && result.tab && result.tab.url) || (funcArgs && funcArgs.url),
                  );
                  if (resultKey && result && !result.error && result.tab) {
                    createdTabsByUrl.set(resultKey, result.tab);
                  }

                  onUpdate("tool_result", { callId, name: funcName, result });
                  console.log(`[ToolExecutor] ${funcName} result:`, result);
                  return { toolCall, funcName, funcArgs, callId, result };
                }
              }

              throwIfAborted(signal);
              const result = await ToolRegistry.execute(funcName, funcArgs);
              throwIfAborted(signal);

              if (funcName === "create_tab") {
                const resultKey = normalizeUrlForDedup(
                  (result && result.tab && result.tab.url) || (funcArgs && funcArgs.url),
                );
                if (resultKey && result && !result.error && result.tab) {
                  createdTabsByUrl.set(resultKey, result.tab);
                }
              }

              onUpdate("tool_result", { callId, name: funcName, result });
              console.log(`[ToolExecutor] ${funcName} result:`, result);
              return { toolCall, funcName, funcArgs, callId, result };
            }),
          );
        } catch (err) {
          if (isAbortError(err) || (signal && signal.aborted)) {
            return cancelledResult();
          }
          const errorMsg = `Tool execution error: ${err.message}`;
          onUpdate("error", { message: errorMsg });
          return { response: null, toolCalls: allToolCalls, error: errorMsg };
        }

        for (const { toolCall, funcName, funcArgs, callId, result } of toolResults) {
          allToolCalls.push({
            callId,
            name: funcName,
            args: funcArgs,
            result,
          });

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }

        try {
          await autoInspectCreatedTabs(
            toolResults,
            iteration,
            onUpdate,
            allToolCalls,
            messages,
            signal,
          );
        } catch (err) {
          if (isAbortError(err) || (signal && signal.aborted)) {
            return cancelledResult();
          }
          const errorMsg = `Auto-follow-up error: ${err.message}`;
          onUpdate("error", { message: errorMsg });
          return { response: null, toolCalls: allToolCalls, error: errorMsg };
        }
      } else {
        const responseText = assistantMessage.content || "(no response)";
        onUpdate("response", { message: responseText });
        return {
          response: responseText,
          toolCalls: allToolCalls,
        };
      }
    }

    const msg = "Reached maximum tool call iterations. Here's what was done so far.";
    onUpdate("error", { message: msg });
    return {
      response: msg,
      toolCalls: allToolCalls,
      error: "Max iterations reached",
    };
  }

  // ─── Public API ──────────────────────────────────────────

  return {
    execute,
    buildContext,
    MAX_ITERATIONS,
  };
})();
