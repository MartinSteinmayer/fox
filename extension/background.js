/**
 * Tab Whisperer — Background Script (Orchestrator)
 *
 * This is the main entry point. It:
 * 1. Handles messages from the popup (text commands)
 * 2. Manages WebSocket connection to the voice server
 * 3. Dispatches commands through the LLM tool-calling loop
 * 4. Manages extension state and badge
 */

(function () {
  "use strict";

  // ─── State ─────────────────────────────────────────────────

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const CONFIRM_TIMEOUT_MS = 30_000;

  const state = {
    wsConnected: false,
    processing: false,
    voiceListening: false,
    ws: null,
    popupPort: null, // Long-lived connection to popup
    actionLog: [], // History of actions for display (persisted)
    currentCommand: null, // In-progress command: { commandId, command, toolCalls[], startedAt }
    commandQueue: [], // FIFO queue for commands arriving while processing
    currentAbortController: null,
  };

  let commandIdCounter = 0;
  let confirmIdCounter = 0;
  const pendingConfirmations = new Map();

  function generateCommandId() {
    return `cmd_${Date.now()}_${commandIdCounter++}`;
  }

  function generateConfirmId() {
    return `confirm_${Date.now()}_${confirmIdCounter++}`;
  }

  // ─── Persistent Action Log ──────────────────────────────

  async function loadActionLog() {
    const { actionLog } = await browser.storage.local.get({ actionLog: [] });
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    state.actionLog = actionLog.filter((e) => e.timestamp > cutoff);
  }

  async function saveActionLog() {
    // Keep max 500 entries and prune >30 days
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    state.actionLog = state.actionLog
      .filter((e) => e.timestamp > cutoff)
      .slice(-500);
    await browser.storage.local.set({ actionLog: state.actionLog });
  }

  // ─── Settings Defaults ───────────────────────────────────

  const SETTINGS_DEFAULTS = {
    apiKey: "",
    provider: "openai",
    model: "gpt-5-nano",
    temperature: 1,
    maxTokens: 10000,
    openaiBaseUrl: "https://api.openai.com/v1",
    ollamaBaseUrl: "http://localhost:11434/v1",
    voiceServerUrl: "ws://localhost:8765",
    wakeWord: "hey fox",
    blockedSites: "",
  };

  // ─── Badge & Status ──────────────────────────────────────

  function setBadge(text, color) {
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setBadgeBackgroundColor({ color });
  }

  function updateStatus(status) {
    // Status: "idle" | "listening" | "processing" | "error"
    switch (status) {
      case "idle":
        setBadge("", "#6366f1");
        break;
      case "listening":
        setBadge("MIC", "#22c55e");
        break;
      case "processing":
        setBadge("...", "#f59e0b");
        break;
      case "error":
        setBadge("ERR", "#ef4444");
        break;
    }

    // Notify popup if connected
    sendToPopup({ type: "status", status, wsConnected: state.wsConnected });
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

  function summarizeToolForNotification(toolCall) {
    if (!toolCall || !toolCall.name) return null;
    const result = toolCall.result;
    if (!result || result.error) return null;

    switch (toolCall.name) {
      case "list_tabs":
        if (typeof result.count === "number") return `${result.count} tabs found`;
        if (Array.isArray(result.tabs)) return `${result.tabs.length} tabs found`;
        return null;

      case "close_tabs":
        if (typeof result.closedCount === "number") return `Closed ${result.closedCount} tabs`;
        return null;

      case "close_duplicate_tabs":
        if (typeof result.closedCount === "number") {
          return result.closedCount > 0
            ? `Removed ${result.closedCount} duplicates`
            : "No duplicates found";
        }
        return null;

      case "group_tabs":
        if (result.group && result.group.title) return `Group "${result.group.title}" ready`;
        return null;

      case "create_tab":
        if (result.deduped) return "Focused existing tab";
        if (result.tab && result.tab.title) {
          return `Opened "${String(result.tab.title).slice(0, 40)}"`;
        }
        return "Opened new tab";

      case "search_bookmarks":
      case "search_history":
        if (typeof result.count === "number") return `${result.count} results`;
        return null;

      default:
        if (result.success) {
          return `${String(toolCall.name).replace(/_/g, " ")} done`;
        }
        return null;
    }
  }

  function buildCompletionSummary(response, error, toolCalls, cancelled = false) {
    if (cancelled) {
      return "Command cancelled.";
    }

    if (error) {
      return truncateText(String(error).replace(/^Error:\s*/i, ""), 180);
    }

    if (typeof response === "string" && response.trim()) {
      return truncateText(firstSentence(response), 180);
    }

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const highlights = [];
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        const line = summarizeToolForNotification(toolCalls[i]);
        if (!line) continue;
        highlights.unshift(line);
        if (highlights.length >= 2) break;
      }

      if (highlights.length > 0) {
        return truncateText(highlights.join(" | "), 180);
      }

      const failed = toolCalls.filter((tc) => tc && tc.result && tc.result.error).length;
      const completed = Math.max(toolCalls.length - failed, 0);
      if (failed > 0) return `${completed} steps done, ${failed} failed.`;
      return `${toolCalls.length} step${toolCalls.length === 1 ? "" : "s"} completed.`;
    }

    return "Command completed.";
  }

  // ─── Popup Communication ─────────────────────────────────

  function sendToPopup(message) {
    if (state.popupPort) {
      try {
        state.popupPort.postMessage(message);
      } catch (e) {
        // Port disconnected
        state.popupPort = null;
      }
    }
  }

  function resolvePendingConfirmation(confirmId, approved) {
    const pending = pendingConfirmations.get(confirmId);
    if (!pending) return false;

    clearTimeout(pending.timeoutId);
    pendingConfirmations.delete(confirmId);
    pending.resolve(!!approved);
    return true;
  }

  function resolveConfirmationsForCommand(commandId, approved) {
    if (!commandId) return;

    for (const [confirmId, pending] of pendingConfirmations.entries()) {
      if (pending.commandId !== commandId) continue;
      clearTimeout(pending.timeoutId);
      pendingConfirmations.delete(confirmId);
      pending.resolve(!!approved);
    }
  }

  async function requestToolConfirmation(commandId, toolName, args, source = "popup") {
    if (!state.popupPort) {
      // Voice commands may run without the popup open; keep them hands-free.
      return source === "voice";
    }

    const confirmId = generateConfirmId();

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        pendingConfirmations.delete(confirmId);
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      pendingConfirmations.set(confirmId, {
        commandId,
        resolve,
        timeoutId,
      });

      sendToPopup({
        type: "confirm_needed",
        commandId,
        confirmId,
        toolName,
        args: args || {},
      });
    });
  }

  // Handle long-lived connections from popup
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === "popup") {
      state.popupPort = port;

      // Send current state immediately
      port.postMessage({
        type: "init",
        status: state.processing
          ? "processing"
          : state.voiceListening
            ? "listening"
            : "idle",
        wsConnected: state.wsConnected,
        actionLog: state.actionLog.slice(-50), // Last 50 entries
        currentCommand: state.currentCommand, // In-progress command (null if idle) — includes commandId
        queueLength: state.commandQueue.length,
      });

      port.onDisconnect.addListener(() => {
        state.popupPort = null;

        // If confirmation UI disappears, deny pending confirmations.
        for (const [confirmId, pending] of pendingConfirmations.entries()) {
          clearTimeout(pending.timeoutId);
          pendingConfirmations.delete(confirmId);
          pending.resolve(false);
        }
      });

      port.onMessage.addListener(handlePopupMessage);
    }
  });

  // Handle one-shot messages (fallback for simple requests)
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "get_status") {
      sendResponse({
        status: state.processing
          ? "processing"
          : state.voiceListening
            ? "listening"
            : "idle",
        wsConnected: state.wsConnected,
      });
      return false;
    }

    if (message.type === "execute_command") {
      handleCommand(message.text, "external").then(sendResponse);
      return true; // Keep channel open for async response
    }

    return false;
  });

  // ─── Command Handling ────────────────────────────────────

  async function handlePopupMessage(message) {
    switch (message.type) {
      case "command":
        await handleCommand(message.text, "popup");
        break;
      case "cancel":
        if (state.currentAbortController) {
          state.currentAbortController.abort();
        }
        if (state.currentCommand && state.currentCommand.commandId) {
          resolveConfirmationsForCommand(state.currentCommand.commandId, false);
        }
        break;
      case "confirm_response":
        if (message.confirmId) {
          resolvePendingConfirmation(message.confirmId, !!message.approved);
        }
        break;
      case "reconnect_ws":
        connectWebSocket();
        break;
      case "get_history":
        sendToPopup({ type: "history", entries: state.actionLog });
        break;
      case "clear_history":
        state.actionLog = [];
        saveActionLog();
        sendToPopup({ type: "history", entries: [] });
        break;
    }
  }

  /**
   * Main command handler. Takes a text command, runs it through the
   * LLM tool-calling loop, and returns the result.
   * 
   * If already processing, queues the command for execution after the current one finishes.
   */
  async function handleCommand(text, source = "popup") {
    const commandId = generateCommandId();

    if (state.processing) {
      // Queue it instead of dropping
      return new Promise((resolve) => {
        state.commandQueue.push({ commandId, text, source, resolve });
        console.log(`[TabWhisperer] Queued command ${commandId}: "${text}" (queue size: ${state.commandQueue.length})`);
        sendToPopup({
          type: "command_queued",
          commandId,
          command: text,
          queuePosition: state.commandQueue.length,
        });
      });
    }

    return executeCommand(commandId, text, source);
  }

  /**
   * Internal: actually execute a command (not queued).
   */
  async function executeCommand(commandId, text, source) {
    state.processing = true;
    updateStatus("processing");

    const abortController = new AbortController();
    state.currentAbortController = abortController;

    // Signal voice server that we're busy
    sendToVoiceServer({ type: "busy", commandId });

    // Track in-progress command in state (survives popup close/reopen)
    state.currentCommand = {
      commandId,
      command: text,
      toolCalls: [],
      startedAt: Date.now(),
    };

    sendToPopup({ type: "command_start", commandId, command: text });

    // Pass last 5 action log entries for conversation context
    const recentHistory = state.actionLog.slice(-5);

    try {
      const result = await ToolExecutor.execute(
        text,
        (type, data) => {
          // Forward progress updates to popup with commandId
          sendToPopup({ type: "progress", commandId, progressType: type, ...data });

          // Track tool calls in currentCommand (with timestamps)
          if (type === "tool_call") {
            state.currentCommand.toolCalls.push({
              callId: data.callId,
              name: data.name,
              args: data.args,
              result: null, // filled in on tool_result
              timestamp: Date.now(),
            });
          }

          // Attach result by callId (exact match, no scanning)
          if (type === "tool_result") {
            const pending = state.currentCommand.toolCalls;
            for (let i = pending.length - 1; i >= 0; i--) {
              if (pending[i].callId === data.callId) {
                pending[i].result = data.result;
                break;
              }
            }
          }
        },
        recentHistory,
        {
          signal: abortController.signal,
          confirm: (toolName, args) =>
            requestToolConfirmation(commandId, toolName, args, source),
        },
      );

      // Build final log entry from currentCommand + result
      const logEntry = {
        id: commandId,
        timestamp: state.currentCommand.startedAt,
        command: text,
        toolCalls: state.currentCommand.toolCalls,
        response: result.response,
        error: result.error || null,
        cancelled: !!result.cancelled,
      };

      const completionSummary = buildCompletionSummary(
        result.response,
        result.error,
        state.currentCommand.toolCalls,
        !!result.cancelled,
      );

      sendToPopup({
        type: "command_complete",
        commandId,
        response: result.response,
        toolCalls: state.currentCommand.toolCalls,
        error: result.error,
        summary: completionSummary,
        cancelled: !!result.cancelled,
      });

      // Show notification if popup is closed
      if (!state.popupPort) {
        browser.notifications.create({
          type: "basic",
          title: result.cancelled
            ? "fox: cancelled"
            : result.error
              ? "fox: issue"
              : "fox: done",
          message: completionSummary,
          iconUrl: browser.runtime.getURL("icons/logo_wihtout_background.png"),
        });
      }

      // Save to action log (persisted)
      state.actionLog.push(logEntry);
      saveActionLog();

      return result;
    } catch (err) {
      const errorMsg = `Error: ${err.message}`;
      const completionSummary = buildCompletionSummary(
        null,
        errorMsg,
        state.currentCommand ? state.currentCommand.toolCalls : [],
      );
      const toolCalls = state.currentCommand ? state.currentCommand.toolCalls : [];

      sendToPopup({
        type: "command_complete",
        commandId,
        response: null,
        toolCalls,
        error: errorMsg,
        summary: completionSummary,
      });

      if (!state.popupPort) {
        browser.notifications.create({
          type: "basic",
          title: "fox: issue",
          message: completionSummary,
          iconUrl: browser.runtime.getURL("icons/logo_wihtout_background.png"),
        });
      }

      // Save error to action log
      state.actionLog.push({
        id: commandId,
        timestamp: state.currentCommand.startedAt,
        command: text,
        toolCalls: state.currentCommand.toolCalls,
        response: null,
        error: errorMsg,
      });
      saveActionLog();

      return { error: errorMsg };
    } finally {
      resolveConfirmationsForCommand(commandId, false);
      state.currentAbortController = null;
      state.processing = false;
      state.currentCommand = null;

      // Drain queue: execute next queued command if any
      if (state.commandQueue.length > 0) {
        const next = state.commandQueue.shift();
        console.log(`[TabWhisperer] Dequeuing command ${next.commandId}: "${next.text}" (remaining: ${state.commandQueue.length})`);
        // Execute asynchronously — don't block the finally block
        executeCommand(next.commandId, next.text, next.source).then(next.resolve);
      } else {
        // No more commands — signal voice server we're ready
        sendToVoiceServer({ type: "ready" });
        updateStatus("idle");
      }
    }
  }

  // ─── WebSocket (Voice Server) ────────────────────────────

  async function connectWebSocket() {
    // Close existing connection
    if (state.ws) {
      try {
        state.ws.close();
      } catch (e) {}
      state.ws = null;
    }

    const settings = await browser.storage.local.get(SETTINGS_DEFAULTS);
    const url = settings.voiceServerUrl;

    console.log(`[WS] Connecting to ${url}...`);

    try {
      const ws = new WebSocket(url);
      state.ws = ws;

      ws.onopen = () => {
        console.log("[WS] Connected to voice server");
        state.wsConnected = true;
        sendToPopup({ type: "ws_status", connected: true });
        updateStatus("idle");
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleVoiceMessage(msg);
        } catch (e) {
          console.warn("[WS] Invalid message:", event.data);
        }
      };

      ws.onclose = () => {
        console.log("[WS] Disconnected from voice server");
        state.wsConnected = false;
        state.voiceListening = false;
        state.ws = null;
        sendToPopup({ type: "ws_status", connected: false });
        updateStatus("idle");

        // Auto-reconnect after 5 seconds
        setTimeout(connectWebSocket, 5000);
      };

      ws.onerror = (err) => {
        console.warn("[WS] Error:", err);
        // onclose will fire after this
      };
    } catch (err) {
      console.warn("[WS] Failed to connect:", err);
      state.wsConnected = false;
      // Retry after 5 seconds
      setTimeout(connectWebSocket, 5000);
    }
  }

  function handleVoiceMessage(msg) {
    console.log("[WS] Voice message:", msg);

    switch (msg.type) {
      case "wake":
        state.voiceListening = true;
        updateStatus("listening");
        sendToPopup({ type: "voice_wake" });
        break;

      case "listening":
        state.voiceListening = true;
        updateStatus("listening");
        sendToPopup({ type: "voice_listening" });
        break;

      case "command":
        state.voiceListening = false;
        if (msg.text) {
          // Show the transcribed text in popup as a user message
          sendToPopup({ type: "voice_command", text: msg.text });

          // Run the command and send ack back to voice server
          handleCommand(msg.text, "voice").then((result) => {
            sendToVoiceServer({
              type: "ack",
              result: result.response || result.error || "done",
            });
          });
        }
        break;

      case "error":
        state.voiceListening = false;
        updateStatus("error");
        sendToPopup({ type: "voice_error", message: msg.message });
        break;

      case "status":
        sendToPopup({ type: "voice_status", ...msg });
        break;
    }
  }

  function sendToVoiceServer(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  // ─── Settings Sync ──────────────────────────────────────

  // Forward wake word changes to voice server when settings are updated
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.wakeWord && changes.wakeWord.newValue) {
      sendToVoiceServer({
        type: "config",
        wake_word: changes.wakeWord.newValue,
      });
      console.log(
        `[TabWhisperer] Wake word updated to: ${changes.wakeWord.newValue}`,
      );
    }
  });

  // ─── Keyboard Shortcuts ──────────────────────────────────

  browser.commands.onCommand.addListener((command) => {
    if (command === "toggle-listening") {
      if (state.voiceListening) {
        sendToVoiceServer({ type: "stop_listening" });
        state.voiceListening = false;
        updateStatus("idle");
      } else {
        sendToVoiceServer({ type: "start_listening" });
        state.voiceListening = true;
        updateStatus("listening");
      }
    }
  });

  // ─── Initialization ──────────────────────────────────────

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === "install") {
      console.log("[TabWhisperer] First install — setting defaults");
      await browser.storage.local.set(SETTINGS_DEFAULTS);
    }
  });

  // Initialize on startup
  async function init() {
    console.log("[TabWhisperer] Background script starting...");
    updateStatus("idle");

    // Load persisted action log
    await loadActionLog();
    console.log(
      `[TabWhisperer] Loaded ${state.actionLog.length} action log entries`,
    );

    // Check if API key is configured
    const settings = await browser.storage.local.get(SETTINGS_DEFAULTS);
    if (!settings.apiKey && settings.provider === "openai") {
      console.warn("[TabWhisperer] No API key configured. Set one in options.");
      setBadge("KEY", "#ef4444");
    }

    // Try to connect to voice server (non-blocking)
    connectWebSocket();
  }

  init();
})();
