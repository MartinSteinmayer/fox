/**
 * Tab Whisperer — LLM Client
 *
 * Supports OpenAI API and Ollama (OpenAI-compatible endpoint).
 * Handles chat completions with function/tool calling.
 */

var LLMClient = (function () {
  // ─── Settings ────────────────────────────────────────────

  const DEFAULTS = {
    provider: "openai", // "openai" or "ollama"
    apiKey: "",
    model: "gpt-5-nano",
    temperature: 1,
    maxTokens: 10000,
    openaiBaseUrl: "https://api.openai.com/v1",
    ollamaBaseUrl: "http://localhost:11434/v1",
  };

  async function getConfig() {
    return browser.storage.local.get(DEFAULTS);
  }

  // ─── System Prompt ───────────────────────────────────────

  const SYSTEM_PROMPT = `You are fox, a voice-controlled browser assistant. You act immediately and silently.

BEHAVIOR:
- Execute actions, don't talk
- Call tools to do the work
- No explanations, no status messages, no pleasantries
- Just execute and be done
- Exception: when returning tool_calls, include ONE concise planning sentence in content for the mission timeline
- Planning sentence format: "Plan: ..." (max ~12 words, action-focused)

TOOLS:
- List, switch, close, group, ungroup, move, pin, mute, reload, discard tabs
- Create tab groups (names: 1-2 words max, colors: blue/green/red/yellow/purple/cyan/orange/pink/grey)
- Web search, bookmarks, history
- Generate research reports from tab groups (scrapes all tabs, synthesizes with AI, opens as styled page)
- Page automation: inspect_page (discover interactive elements), interact_with_page (click/type/submit/press), wait_for_page (wait for load)

RULES:
1. Tab state is already provided — do NOT call list_tabs, it has already been run for you
2. Never close all tabs in a window
3. Group names: SHORT (e.g. "Dev", "Docs", "Shopping")
4. If ambiguous, make your best guess and execute
5. For report generation: use generate_report with the group name or ID. Add a topic param to focus the report.
6. For "search X on [site]" — prefer create_tab with the site's search URL (fastest, one step):
   YouTube: https://www.youtube.com/results?search_query=QUERY
   Google: https://www.google.com/search?q=QUERY
   Amazon: https://www.amazon.com/s?k=QUERY
   Reddit: https://www.reddit.com/search/?q=QUERY
   Wikipedia: https://en.wikipedia.org/w/index.php?search=QUERY
   GitHub: https://github.com/search?q=QUERY
   Twitter/X: https://x.com/search?q=QUERY
   Stack Overflow: https://stackoverflow.com/search?q=QUERY
7. For search/navigation intents ("find", "search for", "open", "click", "go to"), finish the job end-to-end. If user wants a specific page, do not stop at search results.
8. After EVERY create_tab call, immediately call wait_for_page on that tab, then inspect_page, then decide next action.
9. For complex page interactions (fill forms, click specific buttons, navigate menus): use inspect_page to find elements, then interact_with_page to act on them. Always call wait_for_page after actions that cause navigation.
10. For result selection: use inspect_page output, click the best matching link with interact_with_page, call wait_for_page, and inspect again if still on a results page.
11. For references like "this guy", "this site", "that company", infer query from ACTIVE tab title/URL/content context.
12. Never call create_tab twice for the same URL in one command unless the user explicitly asks for multiple tabs.
13. If the target URL is already open, prefer switch_tab to that existing tab instead of create_tab.
14. Avoid redundant switch_tab calls. If a tab was just created (active by default), do not immediately switch to it again.
15. For each tool-calling pass, always include a brief "Plan: ..." line in assistant content.

COLOR GUIDE:
blue=work, green=dev, red=urgent, yellow=learning, purple=social, cyan=email, orange=shopping, pink=personal, grey=archive`;



  // ─── Model Ring Buffer (rate limit avoidance) ─────────────

  const MODEL_RING = [
    "gpt-5-nano",
    "gpt-4.1-mini",
    "gpt-4o-mini",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4o",
    "gpt-5",
    "gpt-5.1",
    "gpt-5.1-chat-latest",
  ];

  const RPM_LIMIT = 3;
  const RPM_WINDOW_MS = 60_000; // 1 minute
  // Per-model timestamps of recent calls: model -> [timestamp, ...]
  const modelCallLog = {};

  /**
   * Pick the highest-priority model (lowest index) that still has RPM budget.
   * Falls back to the model whose oldest call will expire soonest.
   */
  function nextModel() {
    const now = Date.now();

    // Clean up old entries & find first available model
    for (let i = 0; i < MODEL_RING.length; i++) {
      const model = MODEL_RING[i];
      const log = modelCallLog[model] || [];
      // Keep only calls within the window
      const recent = log.filter((t) => now - t < RPM_WINDOW_MS);
      modelCallLog[model] = recent;

      if (recent.length < RPM_LIMIT) {
        recent.push(now);
        console.log(
          `[LLM] Picked model ${model} (priority #${i}, ${recent.length}/${RPM_LIMIT} RPM used)`,
        );
        return model;
      }
    }

    // All models at limit — pick the one whose oldest call expires soonest
    let bestModel = MODEL_RING[0];
    let bestWait = Infinity;
    for (const model of MODEL_RING) {
      const oldest = modelCallLog[model][0];
      const wait = RPM_WINDOW_MS - (now - oldest);
      if (wait < bestWait) {
        bestWait = wait;
        bestModel = model;
      }
    }
    console.warn(
      `[LLM] All models at RPM limit, using ${bestModel} (cooldown ~${Math.ceil(bestWait / 1000)}s)`,
    );
    modelCallLog[bestModel].push(now);
    return bestModel;
  }

  // ─── API Call ─────────────────────────────────────────────

  // Track which token parameter works per model.
  // Models that reject max_tokens get remembered here.
  const tokenParamCache = {}; // model -> "new" | "old"
  const REQUEST_TIMEOUT_MS = 45_000;

  async function fetchWithTimeout(url, options, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;

    const onExternalAbort = () => {
      controller.abort();
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut && err && err.name === "AbortError") {
        throw new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * Build the request body with the appropriate token limit parameter.
   * Newer OpenAI models (gpt-5, o-series) require max_completion_tokens;
   * older models and Ollama use max_tokens.
   */
  function buildBody(model, config, messages, tools, useNewTokenParam) {
    const body = {
      model,
      messages,
      temperature: config.temperature,
    };

    // Token parameter (max_tokens vs max_completion_tokens)
    if (useNewTokenParam) {
      body.max_completion_tokens = config.maxTokens;
    } else {
      body.max_tokens = config.maxTokens;
    }

    // Add tools if provided
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    return body;
  }

  /**
   * Make a single API call for a specific model. Handles max_tokens vs
   * max_completion_tokens detection with one retry.
   */
  async function tryModel(model, config, url, headers, messages, tools, signal) {
    const cached = tokenParamCache[model];
    const tryNew = cached === "new" || cached == null; // default to max_completion_tokens

    let response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(model, config, messages, tools, tryNew)),
    }, signal);

    // Token param mismatch — retry with the other one (only if we haven't cached yet)
    if (!response.ok && response.status === 400 && !cached) {
      const errorText = await response.text();
      if (errorText.includes("unsupported_parameter")) {
        const retryNew = !tryNew;
        console.log(
          `[LLM] ${model}: retrying with ${retryNew ? "max_completion_tokens" : "max_tokens"}`,
        );
        response = await fetchWithTimeout(url, {
          method: "POST",
          headers,
          body: JSON.stringify(
            buildBody(model, config, messages, tools, retryNew),
          ),
        }, signal);
        if (response.ok) {
          tokenParamCache[model] = retryNew ? "new" : "old";
        }
        return response;
      }
      // Re-create a fake response with the error text we already consumed
      return {
        ok: false,
        status: response.status,
        text: async () => errorText,
        json: async () => JSON.parse(errorText),
      };
    }

    if (response.ok && !cached) {
      tokenParamCache[model] = tryNew ? "new" : "old";
    }

    return response;
  }

  const MAX_429_RETRIES = 3;

  /**
   * Parse the retry delay from a 429 error message.
   * Looks for "try again in X.XXXs" or "Please retry after Xms".
   * Returns delay in milliseconds, or a default of 3000ms.
   */
  function parse429Delay(errorText) {
    // "Please try again in 2.388s"
    const secMatch = errorText.match(/try again in ([\d.]+)s/i);
    if (secMatch) return Math.ceil(parseFloat(secMatch[1]) * 1000) + 200; // +200ms margin

    // "Please retry after Xms"
    const msMatch = errorText.match(/retry after ([\d]+)ms/i);
    if (msMatch) return parseInt(msMatch[1]) + 200;

    return 3000; // default 3s
  }

  /**
   * Send a chat completion request.
   * For OpenAI: cycles through MODEL_RING to avoid per-model RPM limits.
   * Retries on 429 (rate limit) errors with parsed delay.
   * For Ollama: uses the configured model directly.
   */
  async function chatCompletion(messages, tools, signal) {
    const config = await getConfig();

    const isOllama = config.provider === "ollama";
    const baseUrl = isOllama ? config.ollamaBaseUrl : config.openaiBaseUrl;
    const url = `${baseUrl}/chat/completions`;

    const headers = { "Content-Type": "application/json" };
    if (!isOllama && config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    // For Ollama, just use the configured model directly
    if (isOllama) {
      const model = config.model;
      console.log(`[LLM] Request to ${url} with model ${model}`);
      tokenParamCache[model] = "old"; // Ollama always uses max_tokens
      const response = await tryModel(
        model,
        config,
        url,
        headers,
        messages,
        tools,
        signal,
      );
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API error ${response.status}: ${errorText}`);
      }
      return parseResponse(await response.json());
    }

    // OpenAI: retry loop for 429 rate limits
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      const model = nextModel();

      const response = await tryModel(
        model,
        config,
        url,
        headers,
        messages,
        tools,
        signal,
      );

      if (response.ok) {
        return parseResponse(await response.json());
      }

      const errorText = await response.text();

      // On 429, parse delay and retry
      if (response.status === 429 && attempt < MAX_429_RETRIES) {
        const delay = parse429Delay(errorText);
        console.warn(
          `[LLM] 429 rate limit on ${model} (attempt ${attempt + 1}/${MAX_429_RETRIES}), retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw new Error(
        `LLM API error ${response.status} (${model}): ${errorText}`,
      );
    }
  }

  function parseResponse(data) {
    if (!data.choices || data.choices.length === 0) {
      throw new Error("LLM returned no choices");
    }

    const message = data.choices[0].message;

    console.log("[LLM] Response:", {
      model: data.model,
      hasContent: !!message.content,
      toolCalls: message.tool_calls?.length || 0,
      finishReason: data.choices[0].finish_reason,
      usage: data.usage,
    });

    return message;
  }

  // ─── Public API ──────────────────────────────────────────

  return {
    SYSTEM_PROMPT,
    chatCompletion,
    getConfig,
  };
})();
