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

  // ─── Content Extraction ──────────────────────────────────

  /**
   * Inject the extraction content script into a tab and return
   * the structured result.  Silently returns null for tabs we
   * can't inject into (about:*, moz-extension:*, etc.).
   */
  async function extractTabContent(tabId) {
    try {
      const results = await browser.tabs.executeScript(tabId, {
        file: "/content/extract.js",
        runAt: "document_idle",
      });
      return results && results[0] ? results[0] : null;
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
      const extractions = await Promise.all(
        tabs.map(t => extractTabContent(t.id)),
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
        if (flags.length > 0) entry += ` (${flags.join(", ")})`;

        // Enriched content (budget-limited)
        const basicLen = entry.length;
        const contentBudget = Math.max(perTabBudget - basicLen - 10, 0);
        const enriched = formatExtraction(extractions[i], contentBudget);

        if (enriched) {
          entry += `\n    ${enriched}`;
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
  ) {
    const createdTabs = toolResults
      .filter((t) => t.funcName === "create_tab")
      .map((t) => t.result && t.result.tab && t.result.tab.id)
      .filter((id) => typeof id === "number");

    if (createdTabs.length === 0) return;

    onUpdate("thinking", { message: "Inspecting new tabs..." });

    const autoRuns = await Promise.all(
      createdTabs.map(async (tabId, index) => {
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
   * Execute a single command through the LLM tool-calling loop.
   * 
   * @param {string} userText - The user's command text
   * @param {function} onUpdate - Callback for progress updates: (type, data) => void
   *   type: "thinking" | "tool_call" | "tool_result" | "response" | "error"
   * @param {Array} recentHistory - Last N action log entries for conversation context
   * @returns {Object} { response: string, toolCalls: Array, error?: string }
   */
  async function execute(userText, onUpdate = () => {}, recentHistory = []) {
    const tools = ToolRegistry.getDefinitions();
    const context = await buildContext();
    const allToolCalls = [];

    // ─── Pre-run list_tabs instantly ────────────────────────
    // Fires UI updates immediately so it looks fast & responsive,
    // then injects the result into the conversation so the LLM
    // already has tab state and won't call list_tabs again.

    let listTabsResult;
    try {
      const prerunCallId = nextCallId();
      onUpdate("tool_call", { callId: prerunCallId, name: "list_tabs", args: {} });
      listTabsResult = await ToolRegistry.execute("list_tabs", {});
      onUpdate("tool_result", { callId: prerunCallId, name: "list_tabs", result: listTabsResult });
      allToolCalls.push({ callId: prerunCallId, name: "list_tabs", args: {}, result: listTabsResult });
    } catch (e) {
      console.warn("[ToolExecutor] Pre-run list_tabs failed:", e);
    }

    // Build initial messages
    const messages = [
      { role: "system", content: LLMClient.SYSTEM_PROMPT },
    ];

    // ─── Inject recent conversation history ──────────────────
    // Last 5 action log entries give the LLM context for follow-up
    // commands like "do that again", "close those tabs", etc.
    if (recentHistory && recentHistory.length > 0) {
      for (const entry of recentHistory) {
        // User's command
        messages.push({ role: "user", content: `User command: ${entry.command}` });

        // Reconstruct tool calls + results
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
            // Truncate large results to save tokens
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

        // Final assistant response
        if (entry.response) {
          messages.push({ role: "assistant", content: entry.response });
        }
      }
    }

    // Current command with full context
    messages.push(
      { role: "user", content: `${context}\n\nUser command: ${userText}` },
    );

    // Inject pre-run list_tabs as if the assistant already called it
    if (listTabsResult) {
      const fakeCallId = "prerun_list_tabs";
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: fakeCallId,
          type: "function",
          function: { name: "list_tabs", arguments: "{}" },
        }],
      });
      messages.push({
        role: "tool",
        tool_call_id: fakeCallId,
        content: JSON.stringify(listTabsResult),
      });
    }

    onUpdate("thinking", { message: "Sending to AI..." });

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let assistantMessage;

      try {
        assistantMessage = await LLMClient.chatCompletion(messages, tools);
      } catch (err) {
        const errorMsg = `LLM error: ${err.message}`;
        onUpdate("error", { message: errorMsg });
        return { response: null, toolCalls: allToolCalls, error: errorMsg };
      }

      // Add assistant message to conversation
      messages.push(assistantMessage);

      // Check if LLM wants to call tools
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        // Fire all tool_call UI updates immediately so the popup shows them all at once
        const parsed = assistantMessage.tool_calls.map((toolCall) => {
          let funcArgs;
          try {
            funcArgs = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            funcArgs = {};
          }
          const callId = nextCallId();
          onUpdate("tool_call", { callId, name: toolCall.function.name, args: funcArgs });
          console.log(`[ToolExecutor] Calling ${toolCall.function.name}(${JSON.stringify(funcArgs)})`);
          return { toolCall, funcName: toolCall.function.name, funcArgs, callId };
        });

        // Execute all tools in parallel
        const toolResults = await Promise.all(
          parsed.map(async ({ toolCall, funcName, funcArgs, callId }) => {
            const result = await ToolRegistry.execute(funcName, funcArgs);
            onUpdate("tool_result", { callId, name: funcName, result });
            console.log(`[ToolExecutor] ${funcName} result:`, result);
            return { toolCall, funcName, funcArgs, callId, result };
          }),
        );

        // Record results and add tool messages to conversation
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

        // Auto-follow-up for browser automation: when a tab is created,
        // immediately wait for load + inspect page to expose clickable targets.
        await autoInspectCreatedTabs(
          toolResults,
          iteration,
          onUpdate,
          allToolCalls,
          messages,
        );

        onUpdate("thinking", { message: "Processing results..." });
        // Continue loop — LLM will process tool results
      } else {
        // LLM returned a text response — we're done
        const responseText = assistantMessage.content || "(no response)";
        
        onUpdate("response", { message: responseText });
        return { 
          response: responseText, 
          toolCalls: allToolCalls 
        };
      }
    }

    // Hit max iterations
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
