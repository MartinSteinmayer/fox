/**
 * Tab Whisperer — Content Extraction Script
 *
 * Injected on-demand via browser.tabs.executeScript() to extract
 * meaningful signals from a web page for better tab categorization.
 *
 * Returns a structured object with extracted metadata and content.
 * This runs in the content script context (has DOM access).
 */

(function () {
  "use strict";

  // ─── Helpers ──────────────────────────────────────────────

  function getMeta(name) {
    const el =
      document.querySelector(`meta[name="${name}"]`) ||
      document.querySelector(`meta[property="${name}"]`);
    return el ? (el.getAttribute("content") || "").trim() : "";
  }

  /** Collect unique, non-empty strings from an array. */
  function unique(arr) {
    const seen = new Set();
    return arr.filter((s) => {
      const v = s.trim();
      if (!v || seen.has(v.toLowerCase())) return false;
      seen.add(v.toLowerCase());
      return true;
    });
  }

  /** Strip excess whitespace from text. */
  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  // ─── Extraction Layers ────────────────────────────────────

  /**
   * 1. Meta tags — description, keywords, Open Graph, Twitter cards
   */
  function extractMeta() {
    return {
      description:
        getMeta("description") ||
        getMeta("og:description") ||
        getMeta("twitter:description") ||
        "",
      keywords: getMeta("keywords"),
      ogTitle: getMeta("og:title") || getMeta("twitter:title") || "",
      ogType: getMeta("og:type") || "",
      ogSiteName: getMeta("og:site_name") || "",
      author: getMeta("author") || getMeta("article:author") || "",
      section: getMeta("article:section") || getMeta("article:tag") || "",
    };
  }

  /**
   * 2. Headings — h1 and h2 (first few of each)
   */
  function extractHeadings() {
    const h1s = Array.from(document.querySelectorAll("h1"))
      .slice(0, 3)
      .map((el) => clean(el.textContent));
    const h2s = Array.from(document.querySelectorAll("h2"))
      .slice(0, 5)
      .map((el) => clean(el.textContent));
    return { h1: unique(h1s), h2: unique(h2s) };
  }

  /**
   * 3. JSON-LD structured data — extract @type and name/headline/description
   */
  function extractJsonLd() {
    const results = [];
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]',
    );

    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];

        for (const item of items) {
          if (item["@type"]) {
            results.push({
              type: String(item["@type"]),
              name: clean(
                item.name || item.headline || item.title || "",
              ),
              description: clean(
                (item.description || "").substring(0, 200),
              ),
            });
          }
          // Handle @graph
          if (Array.isArray(item["@graph"])) {
            for (const node of item["@graph"]) {
              if (node["@type"]) {
                results.push({
                  type: String(node["@type"]),
                  name: clean(
                    node.name || node.headline || node.title || "",
                  ),
                  description: clean(
                    (node.description || "").substring(0, 200),
                  ),
                });
              }
            }
          }
        }
      } catch (e) {
        // Ignore invalid JSON-LD
      }
    }

    return results.slice(0, 5);
  }

  /**
   * 4. Main content text — tries <article>, <main>, [role="main"],
   *    then falls back to <body>. Strips nav, footer, sidebar, script, style.
   */
  function extractBodyText() {
    // Clone a content-rich container
    const source =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.querySelector("#content") ||
      document.querySelector(".content") ||
      document.body;

    if (!source) return "";

    const clone = source.cloneNode(true);

    // Remove noisy elements
    const noisy = clone.querySelectorAll(
      "script, style, noscript, svg, img, video, audio, iframe, " +
        "nav, footer, aside, header, " +
        '[role="navigation"], [role="banner"], [role="complementary"], ' +
        '[aria-hidden="true"], .sidebar, .nav, .footer, .header, .menu, ' +
        ".ad, .ads, .advertisement, .cookie, .popup, .modal",
    );
    for (const el of noisy) {
      el.remove();
    }

    return clean(clone.textContent);
  }

  /**
   * 5. Navigation / category breadcrumbs
   */
  function extractBreadcrumbs() {
    const nav =
      document.querySelector('[aria-label="breadcrumb"]') ||
      document.querySelector(".breadcrumb") ||
      document.querySelector(".breadcrumbs");

    if (!nav) return "";

    const items = Array.from(nav.querySelectorAll("a, span, li"))
      .map((el) => clean(el.textContent))
      .filter((t) => t.length > 0 && t.length < 60);

    return unique(items).join(" > ");
  }

  // ─── Assemble & Return ─────────────────────────────────────

  const meta = extractMeta();
  const headings = extractHeadings();
  const jsonLd = extractJsonLd();
  const bodyText = extractBodyText();
  const breadcrumbs = extractBreadcrumbs();

  // Return the extraction result.
  // browser.tabs.executeScript resolves with [returnValue].
  return {
    meta,
    headings,
    jsonLd,
    breadcrumbs,
    bodyText,
  };
})();
