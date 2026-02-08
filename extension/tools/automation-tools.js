/**
 * Tab Whisperer — Automation Tools
 *
 * Playwright-style browser automation via content script injection.
 * Provides inspect_page, interact_with_page, and wait_for_page tools
 * for DOM interaction (fill forms, click buttons, submit searches, etc.).
 */

var AutomationTools = (function () {
  "use strict";

  const BLOCKED_SITE_ERROR = "This site is blocked by your privacy settings.";

  async function getBlockedPatterns() {
    if (typeof UrlPolicy === "undefined" || !UrlPolicy.getBlockedPatterns) {
      return [];
    }
    try {
      return await UrlPolicy.getBlockedPatterns();
    } catch (e) {
      return [];
    }
  }

  async function ensureTabAllowed(tabId, blockedPatterns) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (
        tab &&
        tab.url &&
        typeof UrlPolicy !== "undefined" &&
        UrlPolicy.isBlockedUrl &&
        UrlPolicy.isBlockedUrl(tab.url, blockedPatterns)
      ) {
        return {
          error: BLOCKED_SITE_ERROR,
          blocked: true,
          tabId,
          url: tab.url,
        };
      }

      return { tab };
    } catch (err) {
      return {
        error: `Tab ${tabId} no longer exists: ${err.message}`,
      };
    }
  }

  // ─── inspect_page ──────────────────────────────────────────
  //
  // Inject a content script that extracts interactive elements
  // (inputs, buttons, links, selects, textareas) from the page.
  // Returns a structured array the LLM can reason about.

  async function inspectPage({ tabId }) {
    if (!tabId) {
      return { error: "tabId is required" };
    }

    const blockedPatterns = await getBlockedPatterns();
    const tabCheck = await ensureTabAllowed(tabId, blockedPatterns);
    if (tabCheck.error) return tabCheck;

    try {
      const results = await browser.tabs.executeScript(tabId, {
        code: `(function () {
  "use strict";

  // Build a unique CSS selector for an element
  function buildSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + "[name=" + JSON.stringify(el.name) + "]";
    if (el.type && el.tagName === "INPUT") {
      var inputs = Array.from(document.querySelectorAll("input[type=" + JSON.stringify(el.type) + "]"));
      var idx = inputs.indexOf(el);
      if (inputs.length === 1) return "input[type=" + JSON.stringify(el.type) + "]";
      return "input[type=" + JSON.stringify(el.type) + "]:nth-of-type(" + (idx + 1) + ")";
    }
    if (el.className && typeof el.className === "string") {
      var cls = el.className.trim().split(/\\s+/).slice(0, 2).map(function(c) { return "." + CSS.escape(c); }).join("");
      if (cls && document.querySelectorAll(el.tagName.toLowerCase() + cls).length === 1) {
        return el.tagName.toLowerCase() + cls;
      }
    }
    if (el.getAttribute("role")) {
      var role = el.getAttribute("role");
      var sameRole = document.querySelectorAll("[role=" + JSON.stringify(role) + "]");
      if (sameRole.length === 1) return "[role=" + JSON.stringify(role) + "]";
    }
    if (el.getAttribute("aria-label")) {
      var label = el.getAttribute("aria-label");
      var sameLabel = document.querySelectorAll("[aria-label=" + JSON.stringify(label) + "]");
      if (sameLabel.length === 1) return "[aria-label=" + JSON.stringify(label) + "]";
    }
    // Fallback: tag + nth-of-type
    var parent = el.parentElement;
    if (parent) {
      var siblings = Array.from(parent.querySelectorAll(":scope > " + el.tagName.toLowerCase()));
      var i = siblings.indexOf(el);
      var parentSel = buildSelector(parent);
      return parentSel + " > " + el.tagName.toLowerCase() + ":nth-of-type(" + (i + 1) + ")";
    }
    return el.tagName.toLowerCase();
  }

  function getLabel(el) {
    // <label for="...">
    if (el.id) {
      var lbl = document.querySelector("label[for=" + JSON.stringify(el.id) + "]");
      if (lbl) return lbl.textContent.trim().substring(0, 80);
    }
    // aria-label
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim().substring(0, 80);
    // placeholder
    if (el.placeholder) return el.placeholder.trim().substring(0, 80);
    // title
    if (el.title) return el.title.trim().substring(0, 80);
    // visible text (for buttons/links)
    var text = el.textContent || "";
    text = text.replace(/\\s+/g, " ").trim();
    if (text.length > 0 && text.length <= 80) return text;
    if (text.length > 80) return text.substring(0, 77) + "...";
    // alt text for images inside buttons/links
    var img = el.querySelector("img[alt]");
    if (img) return img.alt.trim().substring(0, 80);
    return "";
  }

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== "BODY" && getComputedStyle(el).position !== "fixed") return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  var elements = [];
  var seen = new Set();

  // Priority 1: Search inputs
  var searchInputs = document.querySelectorAll(
    "input[type=search], input[name*=search], input[name*=query], input[name=q], input[name=s], input[aria-label*=earch], input[placeholder*=earch]"
  );
  searchInputs.forEach(function(el) {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    elements.push({ tag: "input", type: el.type || "text", selector: buildSelector(el), label: getLabel(el), value: el.value || "", role: "search" });
  });

  // Priority 2: Text/email/password/url/tel inputs
  var textInputs = document.querySelectorAll(
    "input[type=text], input[type=email], input[type=password], input[type=url], input[type=tel], input[type=number], input:not([type])"
  );
  textInputs.forEach(function(el) {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    elements.push({ tag: "input", type: el.type || "text", selector: buildSelector(el), label: getLabel(el), value: el.value || "" });
  });

  // Priority 3: Textareas
  document.querySelectorAll("textarea").forEach(function(el) {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    elements.push({ tag: "textarea", selector: buildSelector(el), label: getLabel(el), value: (el.value || "").substring(0, 100) });
  });

  // Priority 4: Select dropdowns
  document.querySelectorAll("select").forEach(function(el) {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    var options = Array.from(el.options).slice(0, 10).map(function(o) { return { value: o.value, text: o.textContent.trim().substring(0, 50) }; });
    elements.push({ tag: "select", selector: buildSelector(el), label: getLabel(el), value: el.value, options: options });
  });

  // Priority 5: Buttons (submit first, then regular)
  document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]").forEach(function(el) {
    if (!isVisible(el) || seen.has(el)) return;
    seen.add(el);
    elements.push({ tag: "button", type: el.type || "", selector: buildSelector(el), label: getLabel(el) });
  });

  // Priority 6: Links (only first 20 visible links to avoid flooding)
  var linkCount = 0;
  document.querySelectorAll("a[href]").forEach(function(el) {
    if (linkCount >= 20 || !isVisible(el) || seen.has(el)) return;
    var text = getLabel(el);
    if (!text) return;
    seen.add(el);
    linkCount++;
    elements.push({ tag: "a", selector: buildSelector(el), label: text, href: (el.href || "").substring(0, 200) });
  });

  // Cap total to 50 elements
  return { elements: elements.slice(0, 50), url: location.href, title: document.title };
})();`,
        runAt: "document_idle",
      });

      if (results && results[0]) {
        return results[0];
      }
      return { error: "No result from page inspection" };
    } catch (err) {
      return { error: `Cannot inspect page: ${err.message}` };
    }
  }

  // ─── interact_with_page ────────────────────────────────────
  //
  // Execute a sequence of DOM actions on a tab.
  // Supported action types: click, type, select, submit, press

  async function interactWithPage({ tabId, actions }) {
    if (!tabId) return { error: "tabId is required" };
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      return { error: "actions array is required and must not be empty" };
    }

    const blockedPatterns = await getBlockedPatterns();
    const tabCheck = await ensureTabAllowed(tabId, blockedPatterns);
    if (tabCheck.error) return tabCheck;

    const results = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const { type, selector } = action;

      if (!type || !selector) {
        results.push({ action: i, error: "type and selector are required" });
        continue;
      }

      // Build the injected code for this action
      let code;

      switch (type) {
        case "click":
          code = `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: "Element not found: ${selector.replace(/"/g, '\\"')}" };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  el.click();
  return { ok: true, clicked: el.tagName + (el.textContent || "").substring(0, 40).trim() };
})();`;
          break;

        case "type":
          code = `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: "Element not found: ${selector.replace(/"/g, '\\"')}" };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  // Clear existing value
  el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  // Type new value character by character (triggers React/Vue/etc. state)
  var text = ${JSON.stringify(action.text || "")};
  // Set value directly + dispatch proper events
  var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  ) || Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  );
  if (nativeInputValueSetter && nativeInputValueSetter.set) {
    nativeInputValueSetter.set.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, typed: text };
})();`;
          break;

        case "select":
          code = `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: "Element not found: ${selector.replace(/"/g, '\\"')}" };
  el.value = ${JSON.stringify(action.value || "")};
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selected: el.value };
})();`;
          break;

        case "submit":
          code = `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: "Element not found: ${selector.replace(/"/g, '\\"')}" };
  // Find the closest form
  var form = el.closest("form") || (el.tagName === "FORM" ? el : null);
  if (form) {
    form.requestSubmit ? form.requestSubmit() : form.submit();
    return { ok: true, submitted: "form" };
  }
  // Fallback: click the element (might be a submit button)
  el.click();
  return { ok: true, submitted: "click" };
})();`;
          break;

        case "press":
          code = `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: "Element not found: ${selector.replace(/"/g, '\\"')}" };
  el.focus();
  var key = ${JSON.stringify(action.key || "Enter")};
  var eventInit = { key: key, code: "Key" + key, bubbles: true, cancelable: true };
  if (key === "Enter") { eventInit.code = "Enter"; eventInit.keyCode = 13; }
  if (key === "Escape") { eventInit.code = "Escape"; eventInit.keyCode = 27; }
  if (key === "Tab") { eventInit.code = "Tab"; eventInit.keyCode = 9; }
  el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  el.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  return { ok: true, pressed: key };
})();`;
          break;

        default:
          results.push({ action: i, error: `Unknown action type: ${type}` });
          continue;
      }

      try {
        const res = await browser.tabs.executeScript(tabId, {
          code,
          runAt: "document_idle",
        });
        results.push({ action: i, type, ...(res && res[0] ? res[0] : { ok: false, error: "No result" }) });
      } catch (err) {
        results.push({ action: i, type, ok: false, error: err.message });
      }

      // Small delay between actions to let the page react
      if (i < actions.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    return { results };
  }

  // ─── wait_for_page ─────────────────────────────────────────
  //
  // Wait for a tab to finish loading (status === "complete").
  // Useful after clicking a link or submitting a form.

  async function waitForPage({ tabId, timeout }) {
    if (!tabId) return { error: "tabId is required" };

    const blockedPatterns = await getBlockedPatterns();
    const tabCheck = await ensureTabAllowed(tabId, blockedPatterns);
    if (tabCheck.error) return tabCheck;

    const maxWait = Math.min(timeout || 5000, 15000); // cap at 15s
    const start = Date.now();
    const pollInterval = 250;

    while (Date.now() - start < maxWait) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (
          tab &&
          tab.url &&
          typeof UrlPolicy !== "undefined" &&
          UrlPolicy.isBlockedUrl &&
          UrlPolicy.isBlockedUrl(tab.url, blockedPatterns)
        ) {
          return {
            error: BLOCKED_SITE_ERROR,
            blocked: true,
            tabId,
            url: tab.url,
          };
        }
        if (tab.status === "complete") {
          return {
            ok: true,
            url: tab.url,
            title: tab.title,
            elapsed: Date.now() - start,
          };
        }
      } catch (err) {
        return { error: `Tab ${tabId} no longer exists: ${err.message}` };
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    // Timeout — return current state anyway
    try {
      const tab = await browser.tabs.get(tabId);
      if (
        tab &&
        tab.url &&
        typeof UrlPolicy !== "undefined" &&
        UrlPolicy.isBlockedUrl &&
        UrlPolicy.isBlockedUrl(tab.url, blockedPatterns)
      ) {
        return {
          error: BLOCKED_SITE_ERROR,
          blocked: true,
          tabId,
          url: tab.url,
        };
      }

      return {
        ok: false,
        timeout: true,
        url: tab.url,
        title: tab.title,
        status: tab.status,
        elapsed: Date.now() - start,
      };
    } catch (err) {
      return { error: `Tab ${tabId} no longer exists after timeout` };
    }
  }

  // ─── Public API ────────────────────────────────────────────

  return {
    inspectPage,
    interactWithPage,
    waitForPage,
  };
})();
