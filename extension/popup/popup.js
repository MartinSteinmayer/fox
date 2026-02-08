/**
 * Tab Whisperer — Popup Script (Voice-First + History)
 * 
 * Minimalist voice-driven UI with microphone animations, tool call display, and history panel.
 */

(function () {
  "use strict";

  // ─── DOM Elements ──────────────────────────────────────

  const btnSettings = document.getElementById("btn-settings");
  const micIcon = document.getElementById("mic-icon");
  const quickStart = document.getElementById("quick-start");
  const commandText = document.getElementById("command-text");
  const toolArea = document.getElementById("tool-area");
  const historyPanel = document.getElementById("history-panel");
  const historyList = document.getElementById("history-list");
  const historyCount = document.getElementById("history-count");
  const btnClearHistory = document.getElementById("btn-clear-history");
  const textInput = document.getElementById("text-input");
  const btnSend = document.getElementById("btn-send");
  const DEFAULT_INPUT_PLACEHOLDER = textInput.placeholder || "Type a command...";
  const SEND_ICON_SVG = btnSend.innerHTML;
  const CANCEL_ICON_SVG = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  `;

  // ─── Tool Labels & Summaries ───────────────────────────

  const TOOL_LABELS = {
    list_tabs: "Scanning open tabs",
    switch_tab: "Switching to tab",
    close_tabs: "Closing tabs",
    close_duplicate_tabs: "Removing duplicates",
    group_tabs: "Grouping tabs",
    ungroup_tabs: "Ungrouping tabs",
    list_groups: "Listing groups",
    move_tabs: "Moving tabs",
    create_tab: "Opening new tab",
    reload_tabs: "Reloading tabs",
    discard_tabs: "Unloading tabs",
    duplicate_tab: "Duplicating tab",
    pin_tabs: "Pinning tabs",
    mute_tabs: "Muting tabs",
    collapse_group: "Collapsing group",
    update_group: "Updating group",
    web_search: "Searching the web",
    list_search_engines: "Listing search engines",
    search_bookmarks: "Searching bookmarks",
    create_bookmark: "Creating bookmark",
    search_history: "Searching history",
    generate_report: "Generating report",
    inspect_page: "Inspecting page",
    interact_with_page: "Interacting with page",
    wait_for_page: "Waiting for page load",
  };

  const PERMISSION_TIER_LABELS = {
    read: "Reading",
    organize: "Organizing",
    navigate: "Navigating",
    close: "Closing tabs",
    interact: "Page interaction",
    report: "Reporting",
  };

  function toolLabel(name) {
    if (TOOL_LABELS[name]) return TOOL_LABELS[name];
    return String(name || "unknown_tool")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch (e) {
      return String(url).substring(0, 40);
    }
  }

  function summarizeArgs(name, args) {
    if (!args || typeof args !== "object" || Object.keys(args).length === 0) {
      return null;
    }

    const tabCount = Array.isArray(args.tabIds) ? args.tabIds.length : null;

    switch (name) {
      case "list_tabs":
        if (args.groupId != null) return `Group #${args.groupId}`;
        if (args.windowId != null) return `Window #${args.windowId}`;
        return null;

      case "switch_tab":
      case "duplicate_tab":
      case "inspect_page":
      case "wait_for_page":
        return args.tabId != null ? `Tab #${args.tabId}` : null;

      case "close_tabs":
      case "ungroup_tabs":
      case "move_tabs":
      case "reload_tabs":
      case "discard_tabs":
        return tabCount != null ? `${tabCount} tabs` : null;

      case "create_tab":
        if (args.url) return shortUrl(args.url);
        return "blank tab";

      case "list_groups":
        return args.windowId != null ? `Window #${args.windowId}` : null;

      case "close_duplicate_tabs":
        return args.windowId != null ? `Window #${args.windowId}` : null;

      case "group_tabs": {
        const parts = [];
        if (tabCount != null) parts.push(`${tabCount} tabs`);
        if (args.title) parts.push(`-> "${args.title}"`);
        if (args.color) parts.push(`(${args.color})`);
        if (args.groupId != null) parts.push(`group #${args.groupId}`);
        return parts.length > 0 ? parts.join(" ") : null;
      }

      case "pin_tabs":
        return tabCount != null
          ? `${tabCount} tabs${args.pinned === false ? ", unpin" : ""}`
          : null;

      case "mute_tabs":
        return tabCount != null
          ? `${tabCount} tabs${args.muted === false ? ", unmute" : ""}`
          : null;

      case "collapse_group":
        if (args.groupId == null) return null;
        return `Group #${args.groupId}${args.collapsed === false ? ", expand" : ""}`;

      case "update_group": {
        if (args.groupId == null) return null;
        const parts = [`Group #${args.groupId}`];
        if (args.title) parts.push(`-> "${args.title}"`);
        if (args.color) parts.push(`(${args.color})`);
        return parts.join(" ");
      }

      case "web_search":
        return args.query ? `"${args.query}"${args.engine ? ` on ${args.engine}` : ""}` : null;

      case "search_bookmarks":
        return args.query ? `"${args.query}"` : null;

      case "create_bookmark":
        if (args.title) return args.title;
        if (args.url) return shortUrl(args.url);
        return "active tab";

      case "search_history":
        if (args.query) return `"${args.query}"`;
        if (args.hoursBack != null) return `last ${args.hoursBack}h`;
        return "recent";

      case "generate_report":
        if (args.topic) return `Topic: ${args.topic}`;
        if (args.groupName) return `Group: ${args.groupName}`;
        if (args.groupId != null) return `Group #${args.groupId}`;
        return null;

      case "interact_with_page": {
        const actionCount = Array.isArray(args.actions) ? args.actions.length : 0;
        return `${actionCount} actions`;
      }

      default: {
        const compact = Object.entries(args)
          .map(([k, v]) => {
            const val = Array.isArray(v) ? `[${v.length}]` : JSON.stringify(v);
            return `${k}: ${val}`;
          })
          .join(", ");
        return compact.length > 80 ? compact.substring(0, 77) + "..." : compact;
      }
    }
  }

  function summarizeResult(name, result) {
    if (!result) return null;
    if (result.error) return `Error: ${result.error}`;

    switch (name) {
      case "list_tabs":
        if (typeof result.count === "number") return `${result.count} tabs found`;
        if (Array.isArray(result.tabs)) return `${result.tabs.length} tabs found`;
        return null;

      case "close_tabs":
        if (typeof result.closedCount === "number") return `Closed ${result.closedCount} tabs`;
        return null;

      case "switch_tab":
        if (result.alreadyFocused) return "Already focused";
        if (result.deduped) return "Reused switch";
        if (result.success) return "Focused tab";
        return null;

      case "close_duplicate_tabs":
        if (typeof result.closedCount === "number") {
          return result.closedCount > 0
            ? `Removed ${result.closedCount} duplicates`
            : "No duplicates found";
        }
        return null;

      case "search_bookmarks":
      case "search_history":
        if (typeof result.count === "number") return `${result.count} results`;
        return null;

      case "group_tabs":
        if (result.group && result.group.title) return `Group "${result.group.title}" ready`;
        return null;

      case "create_tab":
        if (result.deduped) return "Reused existing tab";
        if (result.tab && result.tab.title) return `Opened "${result.tab.title.substring(0, 40)}"`;
        return null;

      case "wait_for_page":
        if (result.ok && typeof result.elapsed === "number") return `Loaded in ${result.elapsed}ms`;
        if (result.timeout && typeof result.elapsed === "number") return `Timed out at ${result.elapsed}ms`;
        return null;

      case "interact_with_page":
        if (Array.isArray(result.results)) {
          const successCount = result.results.filter((r) => r && r.ok).length;
          return `${successCount}/${result.results.length} actions succeeded`;
        }
        return null;

      default:
        return null;
    }
  }

  function truncateText(text, maxLength) {
    const str = String(text || "").trim();
    if (!str) return "";
    if (str.length <= maxLength) return str;
    return str.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
  }

  function firstSentence(text) {
    const str = String(text || "").trim();
    if (!str) return "";
    const match = str.match(/.+?[.!?](?:\s|$)/);
    return match ? match[0].trim() : str;
  }

  function buildCompletionSummary(response, toolCalls, error) {
    if (error) {
      return truncateText(String(error).replace(/^Error:\s*/i, ""), 160);
    }

    if (typeof response === "string" && response.trim()) {
      return truncateText(firstSentence(response), 160);
    }

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const highlights = [];

      for (let i = toolCalls.length - 1; i >= 0; i--) {
        const tc = toolCalls[i];
        if (!tc || !tc.name) continue;
        const line = summarizeResult(tc.name, tc.result);
        if (!line || /^Error:/i.test(line)) continue;
        highlights.unshift(line);
        if (highlights.length >= 2) break;
      }

      if (highlights.length > 0) {
        return truncateText(highlights.join(" | "), 160);
      }

      const failed = toolCalls.filter((tc) => tc && tc.result && tc.result.error).length;
      const completed = Math.max(toolCalls.length - failed, 0);
      if (failed > 0) return `${completed} steps done, ${failed} failed.`;
      return `${toolCalls.length} step${toolCalls.length === 1 ? "" : "s"} completed.`;
    }

    return "Command completed.";
  }

  // ─── State ─────────────────────────────────────────────

  let port = null;
  let currentState = "idle"; // idle | wake | listening | processing | error
  let currentCommandId = null; // Track which command we're displaying
  let toolCallIndex = 0; // Counter for tagging timeline step divs
  let currentIteration = -1; // Counter for thinking cycles

  // ─── Connect to Background ────────────────────────────

  function connect() {
    port = browser.runtime.connect({ name: "popup" });

    port.onMessage.addListener(handleBackgroundMessage);

    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
  }

  function handleBackgroundMessage(msg) {
    switch (msg.type) {
      case "init":
        // Restore state from background — force update (bypass same-state check)
        currentState = "__init__";
        if (msg.currentCommand) {
          // Mid-processing: replay in-progress tool calls immediately
          currentCommandId = msg.currentCommand.commandId;
          clearToolArea();
          showCommand(msg.currentCommand.command);
          for (const tc of msg.currentCommand.toolCalls) {
            addTimelineStep(tc.callId, tc.name, tc.args, tc.result);
          }
          // Show tools immediately (no transition delay on restore)
          micIcon.style.display = "none";
          micIcon.className = "mic-icon";
          setQuickStartVisible(false);
          toolArea.classList.add("active");
          setSendButtonMode("cancel");
          textInput.disabled = true;
          textInput.placeholder = "Processing command...";
          currentState = "processing";
        } else {
          // Idle or listening — fresh mic state, no stale tools
          currentCommandId = null;
          clearToolArea();
          setState(msg.status === "listening" ? "listening" : "idle");
        }
        // Render history
        if (msg.actionLog) {
          renderHistory(msg.actionLog);
        }
        break;

      case "history":
        renderHistory(msg.entries || []);
        break;

      case "status":
        if (msg.status === "idle") setState("idle");
        else if (msg.status === "processing") setState("processing");
        else if (msg.status === "error") setState("error");
        break;

      case "command_start":
        // New command starting — show command text, clear old tools, enter processing
        currentCommandId = msg.commandId;
        clearToolArea();
        removeConfirmationCards();
        showCommand(msg.command);
        setState("processing");
        break;

      case "progress":
        // Only process progress for the current command
        if (msg.commandId && msg.commandId !== currentCommandId) break;
        handleProgress(msg);
        break;

      case "command_complete":
        // Only process completion for the current command
        if (msg.commandId && msg.commandId !== currentCommandId) break;
        removeThinkingIndicator();
        removeConfirmationCards();
        addCompletionCard(
          msg.summary,
          msg.response,
          msg.toolCalls || [],
          msg.error,
          !!msg.cancelled,
        );
        // Transition to idle but KEEP tool area visible until next command
        setState("idle");

        // Refresh history to include the new entry
        if (port) {
          port.postMessage({ type: "get_history" });
        }
        break;

      case "confirm_needed":
        if (msg.commandId && msg.commandId !== currentCommandId) break;
        addConfirmationCard(msg.confirmId, msg.toolName, msg.args || {});
        break;

      case "command_queued":
        // A command was queued while another is processing — show brief feedback
        // (could show a queue indicator in the future)
        console.log(`[Popup] Command queued: "${msg.command}" (position ${msg.queuePosition})`);
        break;

      case "voice_wake":
        setState("wake");
        // Clear tool area — new voice session starting
        clearToolArea();
        break;

      case "voice_listening":
        setState("listening");
        break;

      case "voice_command":
        // Transcription received — command_start will handle the transition
        break;

      case "voice_error":
        setState("error");
        setTimeout(() => setState("idle"), 2000);
        break;

      case "error":
        setState("error");
        setTimeout(() => setState("idle"), 2000);
        break;
    }
  }

  function handleProgress(msg) {
    switch (msg.progressType) {
      case "reasoning":
        currentIteration += 1;
        removeThinkingIndicator();
        addReasoningStep(msg.message, currentIteration);
        break;

      case "permissions":
        addPermissionBadges(msg.tiers || [], currentIteration);
        break;

      case "thinking":
        // Reserved for low-level executor state updates.
        // We show explicit "reasoning" updates as pass headers instead.
        break;

      case "tool_call":
        removeThinkingIndicator();
        addTimelineStep(msg.callId, msg.name, msg.args, null);
        break;

      case "tool_result":
        updateTimelineStep(msg.callId, msg.name, msg.result);
        break;

      case "response":
        removeThinkingIndicator();
        break;

      case "error":
        removeThinkingIndicator();
        addTimelineError(msg.message || "Unknown error");
        break;

      default:
        break;
    }
  }

  // ─── State Management ──────────────────────────────────

  function setSendButtonMode(mode) {
    const cancelMode = mode === "cancel";
    btnSend.classList.toggle("cancel", cancelMode);
    btnSend.title = cancelMode ? "Cancel" : "Send";
    btnSend.innerHTML = cancelMode ? CANCEL_ICON_SVG : SEND_ICON_SVG;
  }

  function sendCancelRequest() {
    if (!port) return;
    port.postMessage({ type: "cancel" });
  }

  function setQuickStartVisible(visible) {
    if (!quickStart) return;
    const shouldShow = !!visible && !(historyPanel && historyPanel.open);
    quickStart.classList.toggle("active", shouldShow);
  }

  function setState(newState) {
    if (currentState === newState) return;
    currentState = newState;

    if (newState === "processing") {
      setSendButtonMode("cancel");
      textInput.disabled = true;
      textInput.placeholder = "Processing command...";

      // Hide mic immediately, show tool area after brief delay
      micIcon.style.display = "none";
      micIcon.className = "mic-icon";
      setQuickStartVisible(false);
      setTimeout(() => {
        toolArea.classList.add("active");
      }, 100);
    } else if (newState === "idle") {
      setSendButtonMode("send");
      textInput.disabled = false;
      textInput.placeholder = DEFAULT_INPUT_PLACEHOLDER;

      if (toolArea.children.length > 0) {
        // Tool results visible — keep them + command text, mic stays hidden
        micIcon.style.display = "none";
        micIcon.className = "mic-icon";
        setQuickStartVisible(false);
        toolArea.classList.add("active");
      } else {
        // No tools — show mic, hide tool area + command text
        toolArea.classList.remove("active");
        commandText.classList.remove("active");
        micIcon.style.display = "";
        micIcon.className = "mic-icon idle";
        setQuickStartVisible(true);
      }
    } else if (newState === "wake" || newState === "listening") {
      setSendButtonMode("send");
      textInput.disabled = false;
      textInput.placeholder = DEFAULT_INPUT_PLACEHOLDER;

      // Voice session — show mic animation, hide tool area + command text
      toolArea.classList.remove("active");
      commandText.classList.remove("active");
      micIcon.style.display = "";
      micIcon.className = `mic-icon ${newState}`;
      setQuickStartVisible(false);
    } else if (newState === "error") {
      setSendButtonMode("send");
      textInput.disabled = false;
      textInput.placeholder = DEFAULT_INPUT_PLACEHOLDER;

      micIcon.style.display = "";
      micIcon.className = "mic-icon error";
      setQuickStartVisible(false);
    }
  }

  // ─── Tool Area Management ──────────────────────────────

  function clearToolArea() {
    toolArea.innerHTML = "";
    toolCallIndex = 0;
    currentIteration = -1;
    commandText.textContent = "";
    commandText.classList.remove("active");
  }

  /**
   * Show the command text in the green box above the timeline.
   */
  function showCommand(text) {
    if (!text) return;
    commandText.textContent = `"${text}"`;
    commandText.classList.add("active");
  }

  function getIterationBody(iteration) {
    const key = String(iteration);
    let iterationBlock = toolArea.querySelector(`.timeline-iteration[data-iteration="${key}"]`);
    if (!iterationBlock) {
      iterationBlock = document.createElement("div");
      iterationBlock.className = "timeline-iteration";
      iterationBlock.dataset.iteration = key;
      iterationBlock.dataset.status = "idle";

      const header = document.createElement("div");
      header.className = "iteration-header";
      header.textContent = iteration < 0 ? "Setup" : `Pass ${iteration + 1}`;

      const body = document.createElement("div");
      body.className = "iteration-body";

      iterationBlock.appendChild(header);
      iterationBlock.appendChild(body);
      toolArea.appendChild(iterationBlock);
    }
    return iterationBlock.querySelector(".iteration-body");
  }

  function refreshIterationStatus(iterationBlock) {
    if (!iterationBlock) return;
    const hasPendingStep = !!iterationBlock.querySelector('.timeline-step[data-status="pending"]');
    const hasThinking = !!iterationBlock.querySelector(".timeline-thinking");
    iterationBlock.dataset.status = hasPendingStep || hasThinking ? "pending" : "idle";
  }

  function refreshAllIterationStatus() {
    const iterations = toolArea.querySelectorAll(".timeline-iteration");
    iterations.forEach((iteration) => refreshIterationStatus(iteration));
  }

  function scrollTimelineToBottom() {
    toolArea.scrollTop = toolArea.scrollHeight;
  }

  function addReasoningStep(message, iteration) {
    const targetIteration = typeof iteration === "number" ? iteration : currentIteration;
    const body = getIterationBody(targetIteration);

    const wrapper = document.createElement("div");
    wrapper.className = "timeline-reasoning";

    const connector = document.createElement("div");
    connector.className = "step-connector";

    const dot = document.createElement("div");
    dot.className = "reasoning-dot";

    const line = document.createElement("div");
    line.className = "step-line";

    connector.appendChild(dot);
    connector.appendChild(line);

    const content = document.createElement("div");
    content.className = "reasoning-content";
    content.textContent = message || "Plan: decide the next actions.";

    wrapper.appendChild(connector);
    wrapper.appendChild(content);
    body.appendChild(wrapper);
    refreshIterationStatus(body.closest(".timeline-iteration"));
    scrollTimelineToBottom();
  }

  function addPermissionBadges(tiers, iteration) {
    if (!Array.isArray(tiers) || tiers.length === 0) return;

    const targetIteration = typeof iteration === "number" ? iteration : currentIteration;
    const body = getIterationBody(targetIteration);

    const existing = body.querySelector(".permission-row");
    if (existing) existing.remove();

    const row = document.createElement("div");
    row.className = "permission-row";

    const seen = new Set();
    for (const tier of tiers) {
      if (!tier || seen.has(tier)) continue;
      seen.add(tier);

      const badge = document.createElement("span");
      badge.className = "permission-badge";
      badge.dataset.tier = tier;
      badge.textContent = PERMISSION_TIER_LABELS[tier] || tier;
      row.appendChild(badge);
    }

    if (!row.children.length) return;

    body.insertBefore(row, body.firstChild);
    scrollTimelineToBottom();
  }

  function removeConfirmationCards() {
    const cards = toolArea.querySelectorAll(".confirm-card");
    cards.forEach((card) => card.remove());
    refreshAllIterationStatus();
  }

  function buildConfirmationMessage(toolName, args) {
    if (toolName === "close_tabs") {
      const count = Array.isArray(args && args.tabIds) ? args.tabIds.length : null;
      if (count != null) {
        return `Close ${count} tab${count === 1 ? "" : "s"}?`;
      }
      return "Close the selected tabs?";
    }

    if (toolName === "close_duplicate_tabs") {
      return "Remove duplicate tabs in this window?";
    }

    return "Approve this action?";
  }

  function addConfirmationCard(confirmId, toolName, args) {
    if (!confirmId) return;

    const existing = toolArea.querySelector(`.confirm-card[data-confirm-id="${confirmId}"]`);
    if (existing) return;

    const targetIteration = currentIteration >= 0 ? currentIteration : -1;
    const body = getIterationBody(targetIteration);

    const card = document.createElement("div");
    card.className = "confirm-card";
    card.dataset.confirmId = confirmId;

    const title = document.createElement("div");
    title.className = "confirm-title";
    title.textContent = "Confirmation required";
    card.appendChild(title);

    const message = document.createElement("div");
    message.className = "confirm-message";
    message.textContent = buildConfirmationMessage(toolName, args || {});
    card.appendChild(message);

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const btnAllow = document.createElement("button");
    btnAllow.type = "button";
    btnAllow.className = "confirm-btn allow";
    btnAllow.textContent = "Allow";

    const btnDeny = document.createElement("button");
    btnDeny.type = "button";
    btnDeny.className = "confirm-btn deny";
    btnDeny.textContent = "Deny";

    let answered = false;
    function reply(approved) {
      if (answered) return;
      answered = true;

      if (port) {
        port.postMessage({
          type: "confirm_response",
          confirmId,
          approved: !!approved,
        });
      }

      card.remove();
      refreshIterationStatus(body.closest(".timeline-iteration"));
      scrollTimelineToBottom();
    }

    btnAllow.addEventListener("click", () => reply(true));
    btnDeny.addEventListener("click", () => reply(false));

    actions.appendChild(btnAllow);
    actions.appendChild(btnDeny);
    card.appendChild(actions);

    body.appendChild(card);
    refreshIterationStatus(body.closest(".timeline-iteration"));
    scrollTimelineToBottom();
  }

  function addThinkingIndicator(message, iteration) {
    removeThinkingIndicator();

    const targetIteration = typeof iteration === "number" ? iteration : currentIteration;
    const body = getIterationBody(targetIteration);

    const wrapper = document.createElement("div");
    wrapper.className = "timeline-thinking";

    const connector = document.createElement("div");
    connector.className = "step-connector";

    const dot = document.createElement("div");
    dot.className = "thinking-dot";

    const line = document.createElement("div");
    line.className = "step-line";

    connector.appendChild(dot);
    connector.appendChild(line);

    const text = document.createElement("div");
    text.className = "thinking-text";
    text.textContent = message || "Thinking...";

    wrapper.appendChild(connector);
    wrapper.appendChild(text);
    body.appendChild(wrapper);
    refreshIterationStatus(body.closest(".timeline-iteration"));
    scrollTimelineToBottom();
  }

  function pruneEmptyIterations() {
    const iterations = toolArea.querySelectorAll(".timeline-iteration");
    iterations.forEach((iteration) => {
      const body = iteration.querySelector(".iteration-body");
      if (body && body.children.length === 0) {
        iteration.remove();
      }
    });
  }

  function removeThinkingIndicator() {
    const allIndicators = toolArea.querySelectorAll(".timeline-thinking");
    allIndicators.forEach((el) => el.remove());
    refreshAllIterationStatus();
    pruneEmptyIterations();
  }

  function addTimelineError(message) {
    const targetIteration = currentIteration >= 0 ? currentIteration : -1;
    const body = getIterationBody(targetIteration);
    const error = document.createElement("div");
    error.className = "timeline-error";
    error.textContent = message;
    body.appendChild(error);
    refreshIterationStatus(body.closest(".timeline-iteration"));
    scrollTimelineToBottom();
  }

  function addCompletionCard(summary, response, toolCalls, error, cancelled) {
    const existing = toolArea.querySelector(".completion-card");
    if (existing) existing.remove();

    const card = document.createElement("div");
    card.className = "completion-card";
    card.dataset.status = cancelled ? "cancelled" : error ? "error" : "done";

    const title = document.createElement("div");
    title.className = "completion-title";
    title.textContent = cancelled ? "Cancelled" : error ? "Needs attention" : "Done";
    card.appendChild(title);

    const summaryLine = document.createElement("div");
    summaryLine.className = "completion-summary";
    summaryLine.textContent = summary || buildCompletionSummary(response, toolCalls, error);
    card.appendChild(summaryLine);

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const failed = toolCalls.filter((tc) => tc && tc.result && tc.result.error).length;
      const completed = Math.max(toolCalls.length - failed, 0);
      const meta = document.createElement("div");
      meta.className = "completion-meta";

      if (cancelled) {
        meta.textContent = `${completed} completed before cancel`;
      } else if (failed > 0) {
        meta.textContent = `${completed} done, ${failed} failed`;
      } else {
        meta.textContent = `${toolCalls.length} step${toolCalls.length === 1 ? "" : "s"} completed`;
      }

      card.appendChild(meta);
    }

    toolArea.appendChild(card);
    scrollTimelineToBottom();
  }

  function addTimelineStep(callId, name, args, result) {
    const targetIteration = currentIteration >= 0 ? currentIteration : -1;
    const body = getIterationBody(targetIteration);

    const step = document.createElement("div");
    step.className = "timeline-step";
    step.dataset.toolIndex = toolCallIndex++;
    step.dataset.toolName = name;
    step.dataset.callId = callId || `fallback_${toolCallIndex}`;

    const hasResult = result !== null && result !== undefined;
    const isError = hasResult && result && result.error;
    step.dataset.status = hasResult ? (isError ? "fail" : "done") : "pending";

    const connector = document.createElement("div");
    connector.className = "step-connector";

    const dot = document.createElement("div");
    dot.className = "step-dot";

    const line = document.createElement("div");
    line.className = "step-line";

    connector.appendChild(dot);
    connector.appendChild(line);

    const content = document.createElement("div");
    content.className = "step-content";

    const label = document.createElement("div");
    label.className = "step-label";
    label.textContent = toolLabel(name);
    content.appendChild(label);

    const detailText = summarizeArgs(name, args);
    if (detailText) {
      const detail = document.createElement("div");
      detail.className = "step-detail";
      detail.textContent = detailText;
      content.appendChild(detail);
    }

    const resultText = summarizeResult(name, result);
    if (resultText) {
      const resultLine = document.createElement("div");
      resultLine.className = "step-result";
      resultLine.textContent = resultText;
      content.appendChild(resultLine);
    }

    step.appendChild(connector);
    step.appendChild(content);
    body.appendChild(step);
    refreshIterationStatus(body.closest(".timeline-iteration"));
    scrollTimelineToBottom();
  }

  function updateTimelineStep(callId, name, result) {
    let targetStep = null;

    if (callId) {
      targetStep = toolArea.querySelector(`.timeline-step[data-call-id="${callId}"]`);
    }

    if (!targetStep) {
      const allSteps = toolArea.querySelectorAll(".timeline-step");
      for (let i = allSteps.length - 1; i >= 0; i--) {
        const step = allSteps[i];
        if (step.dataset.toolName === name && step.dataset.status === "pending") {
          targetStep = step;
          break;
        }
      }
    }

    if (!targetStep) return;

    const isError = !!(result && result.error);
    targetStep.dataset.status = isError ? "fail" : "done";

    const content = targetStep.querySelector(".step-content");
    if (!content) return;

    const resultText = summarizeResult(name, result);
    let resultLine = targetStep.querySelector(".step-result");
    if (resultText) {
      if (!resultLine) {
        resultLine = document.createElement("div");
        resultLine.className = "step-result";
        content.appendChild(resultLine);
      }
      resultLine.textContent = resultText;
    }

    refreshIterationStatus(targetStep.closest(".timeline-iteration"));

    scrollTimelineToBottom();
  }

  // ─── History Rendering ─────────────────────────────────

  function renderHistory(entries) {
    historyList.innerHTML = "";
    historyCount.textContent = entries.length;

    // Show most recent first
    const sorted = [...entries].reverse();

    for (const entry of sorted) {
      historyList.appendChild(renderHistoryEntry(entry));
    }
  }

  function renderHistoryEntry(entry) {
    const details = document.createElement("details");
    details.className = "history-entry";

    const time = new Date(entry.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const commandText = entry.command || "(voice command)";
    const hasError = !!entry.error;

    // Summary line
    const summary = document.createElement("summary");
    const timeSpan = document.createElement("span");
    timeSpan.className = "entry-time";
    timeSpan.textContent = time;
    summary.appendChild(timeSpan);
    const cmdSpan = document.createElement("span");
    cmdSpan.className = "entry-command";
    cmdSpan.textContent = commandText;
    summary.appendChild(cmdSpan);
    if (hasError) {
      const errSpan = document.createElement("span");
      errSpan.className = "entry-error-badge";
      errSpan.textContent = "ERR";
      summary.appendChild(errSpan);
    }
    details.appendChild(summary);

    // Expanded body
    const body = document.createElement("div");
    body.className = "entry-body";

    // Tool calls section
    if (entry.toolCalls && entry.toolCalls.length > 0) {
      const label = document.createElement("div");
      label.className = "entry-section-label";
      label.textContent = `Tools (${entry.toolCalls.length})`;
      body.appendChild(label);

      for (const tc of entry.toolCalls) {
        const toolDiv = document.createElement("div");
        toolDiv.className = "entry-tool";

        const nameSpan = document.createElement("span");
        nameSpan.className = "entry-tool-name";
        nameSpan.textContent = tc.name;
        toolDiv.appendChild(nameSpan);

        if (tc.args && Object.keys(tc.args).length > 0) {
          const argsDiv = document.createElement("div");
          argsDiv.className = "entry-tool-args";
          argsDiv.textContent = JSON.stringify(tc.args, null, 2);
          toolDiv.appendChild(argsDiv);
        }

        if (tc.result !== undefined && tc.result !== null) {
          const resultStr = typeof tc.result === "string"
            ? tc.result
            : JSON.stringify(tc.result, null, 2);
          const truncated = resultStr.length > 300
            ? resultStr.substring(0, 300) + "..."
            : resultStr;
          const resultDiv = document.createElement("div");
          resultDiv.className = "entry-tool-result";
          resultDiv.textContent = truncated;
          toolDiv.appendChild(resultDiv);
        }

        body.appendChild(toolDiv);
      }
    }

    // Response section
    if (entry.response) {
      const label = document.createElement("div");
      label.className = "entry-section-label";
      label.textContent = "Response";
      body.appendChild(label);

      const resp = document.createElement("div");
      resp.className = "entry-response";
      resp.textContent = entry.response;
      body.appendChild(resp);
    }

    // Error section
    if (entry.error) {
      const errDiv = document.createElement("div");
      errDiv.className = "entry-error";
      errDiv.textContent = entry.error;
      body.appendChild(errDiv);
    }

    details.appendChild(body);
    return details;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Text Input ────────────────────────────────────────

  function sendTextCommand() {
    if (currentState === "processing") {
      sendCancelRequest();
      return;
    }

    const text = textInput.value.trim();
    if (!text || !port) return;
    textInput.value = "";
    port.postMessage({ type: "command", text });
  }

  // ─── Event Listeners ──────────────────────────────────

  btnSettings.addEventListener("click", () => {
    browser.runtime.openOptionsPage();
  });

  btnClearHistory.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation(); // Don't toggle the <details> panel
    if (port) {
      port.postMessage({ type: "clear_history" });
    }
  });

  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (currentState === "processing") {
        sendCancelRequest();
        return;
      }
      sendTextCommand();
    }
  });

  btnSend.addEventListener("click", () => {
    sendTextCommand();
  });

  if (historyPanel) {
    historyPanel.addEventListener("toggle", () => {
      const canShowQuickStart = currentState === "idle" && toolArea.children.length === 0;
      setQuickStartVisible(canShowQuickStart);
    });
  }

  // ─── Init ─────────────────────────────────────────────

  connect();
  // Set initial visual state (mic visible, tool area hidden)
  // The actual state will be set by the 'init' message from background
  micIcon.style.display = "";
  micIcon.className = "mic-icon idle";
  setSendButtonMode("send");
  textInput.disabled = false;
  textInput.placeholder = DEFAULT_INPUT_PLACEHOLDER;

})();
