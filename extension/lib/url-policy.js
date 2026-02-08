/**
 * fox — URL policy helpers
 *
 * Handles blocked-site pattern parsing and URL matching.
 */

var UrlPolicy = (function () {
  "use strict";

  const DEFAULTS = {
    blockedSites: "",
  };

  function normalizePatternList(rawText) {
    if (typeof rawText !== "string") return [];
    return rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }

  function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function globToRegex(globPattern) {
    const source = "^" + escapeRegex(globPattern).replace(/\\\*/g, ".*") + "$";
    return new RegExp(source, "i");
  }

  function normalizeDomainPattern(pattern) {
    return String(pattern || "")
      .trim()
      .replace(/^\.+/, "")
      .replace(/\.+$/, "")
      .toLowerCase();
  }

  function isDomainPattern(pattern) {
    return !String(pattern || "").includes("://") && !String(pattern || "").includes("/");
  }

  function matchesDomain(hostname, pattern) {
    const host = String(hostname || "").toLowerCase();
    if (!host) return false;

    const normalized = normalizeDomainPattern(pattern);
    if (!normalized) return false;

    if (normalized.includes("*")) {
      return globToRegex(normalized).test(host);
    }

    return host === normalized || host.endsWith("." + normalized);
  }

  function parseAsUrl(url) {
    if (!url || typeof url !== "string") return null;

    const candidate = url.trim();
    if (!candidate) return null;

    try {
      return new URL(candidate);
    } catch (e) {
      // Common user input pattern: "example.com/path"
      try {
        return new URL("https://" + candidate);
      } catch (e2) {
        return null;
      }
    }
  }

  function matchesPattern(url, pattern) {
    const parsed = parseAsUrl(url);
    if (!parsed) {
      // Best effort fallback for malformed URLs
      const raw = String(url || "").trim().toLowerCase();
      if (!raw) return false;
      return globToRegex(String(pattern || "").toLowerCase()).test(raw);
    }

    if (isDomainPattern(pattern)) {
      return matchesDomain(parsed.hostname, pattern);
    }

    const fullUrl = parsed.href.toLowerCase();
    const hostPath = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase();
    const source = String(pattern || "").toLowerCase();
    const regex = globToRegex(source);

    if (regex.test(fullUrl)) return true;

    // Allow host/path patterns without explicit scheme
    if (!source.includes("://") && regex.test(hostPath)) return true;

    return false;
  }

  function isBlockedUrl(url, patterns) {
    if (!url || !Array.isArray(patterns) || patterns.length === 0) {
      return false;
    }

    for (const pattern of patterns) {
      if (matchesPattern(url, pattern)) {
        return true;
      }
    }

    return false;
  }

  async function getBlockedPatterns() {
    const { blockedSites } = await browser.storage.local.get(DEFAULTS);
    return normalizePatternList(blockedSites);
  }

  async function isBlockedBySettings(url) {
    const patterns = await getBlockedPatterns();
    return isBlockedUrl(url, patterns);
  }

  async function isBlockedTab(tabId) {
    if (typeof tabId !== "number") return false;

    try {
      const tab = await browser.tabs.get(tabId);
      return isBlockedBySettings(tab && tab.url);
    } catch (e) {
      return false;
    }
  }

  return {
    normalizePatternList,
    isBlockedUrl,
    getBlockedPatterns,
    isBlockedBySettings,
    isBlockedTab,
  };
})();
