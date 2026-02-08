/**
 * Tab Whisperer — Report Generation Tool
 *
 * Scrapes all tabs in a group, sends their content to an LLM,
 * and outputs a synthesized markdown research report in a new tab.
 *
 * Uses LLMClient (from lib/llm-client.js) for the generation call.
 */

var ReportTools = (function () {

  const BODY_BUDGET_PER_TAB = 5000; // chars of body text per tab

  // ─── Content Extraction ──────────────────────────────────

  /**
   * Inject extract.js into a tab and return the full extraction.
   * Returns null for tabs that can't be injected.
   */
  async function scrapeTab(tabId) {
    try {
      const results = await browser.tabs.executeScript(tabId, {
        file: "/content/extract.js",
        runAt: "document_idle",
      });
      return results && results[0] ? results[0] : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Format a tab's extraction into a rich text block for the LLM.
   */
  function formatTabContent(tab, extraction) {
    let content = `### ${tab.title}\n**URL:** ${tab.url}\n`;

    if (!extraction) {
      content += "_Could not extract content from this page._\n";
      return content;
    }

    // Meta description
    const desc = extraction.meta?.description;
    if (desc) content += `**Description:** ${desc}\n`;

    // Author
    const author = extraction.meta?.author;
    if (author) content += `**Author:** ${author}\n`;

    // Breadcrumbs
    if (extraction.breadcrumbs) content += `**Path:** ${extraction.breadcrumbs}\n`;

    // Headings for structure
    if (extraction.headings) {
      const { h1, h2 } = extraction.headings;
      if (h1 && h1.length > 0) content += `**Main headings:** ${h1.join(", ")}\n`;
      if (h2 && h2.length > 0) content += `**Subheadings:** ${h2.join(", ")}\n`;
    }

    // JSON-LD structured data
    if (extraction.jsonLd && extraction.jsonLd.length > 0) {
      const types = extraction.jsonLd
        .map(j => {
          let s = j.type;
          if (j.name) s += `: ${j.name}`;
          if (j.description) s += ` — ${j.description}`;
          return s;
        })
        .join("; ");
      content += `**Structured data:** ${types}\n`;
    }

    // Body text (the main content)
    if (extraction.bodyText) {
      const text = extraction.bodyText.substring(0, BODY_BUDGET_PER_TAB);
      content += `\n**Content:**\n${text}\n`;
    }

    return content;
  }

  // ─── Markdown → HTML Renderer ────────────────────────────

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderReportHtml(markdown, groupTitle) {
    // Escape HTML entities first, then apply markdown rules
    let html = escapeHtml(markdown)
      // Code blocks (fenced)
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
      // Headers (must be at start of line)
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold + italic combos
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Unordered lists
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      // Numbered lists
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      // Horizontal rules
      .replace(/^---$/gm, '<hr>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      // Paragraphs (double newlines)
      .replace(/\n\n/g, '</p><p>')
      // Single newlines
      .replace(/\n/g, '<br>');

    // Wrap consecutive <li> elements in <ul>
    html = html.replace(/((?:<li>.*?<\/li>(?:<br>)?)+)/gs, (match) => {
      const cleaned = match.replace(/<br>/g, '');
      return `<ul>${cleaned}</ul>`;
    });

    const safeTitle = escapeHtml(groupTitle);
    const fileSlug = groupTitle.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Report: ${safeTitle}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      max-width: 840px;
      margin: 0 auto;
      padding: 48px 24px 80px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.7;
      color: #e0e0e0;
      background: #1a1b2e;
    }
    h1 {
      color: #818cf8;
      font-size: 28px;
      border-bottom: 2px solid #2f3150;
      padding-bottom: 12px;
      margin-bottom: 24px;
    }
    h2 {
      color: #6366f1;
      font-size: 22px;
      margin-top: 36px;
      margin-bottom: 12px;
    }
    h3 {
      color: #a5b4fc;
      font-size: 18px;
      margin-top: 28px;
      margin-bottom: 8px;
    }
    h4 {
      color: #c4b5fd;
      font-size: 16px;
      margin-top: 20px;
      margin-bottom: 8px;
    }
    p {
      margin-bottom: 12px;
    }
    a { color: #818cf8; text-decoration: underline; }
    a:hover { color: #a5b4fc; }
    code {
      background: #252740;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: "SF Mono", Monaco, "Cascadia Code", monospace;
    }
    pre {
      background: #252740;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid #2f3150;
    }
    pre code { padding: 0; background: none; }
    hr {
      border: none;
      border-top: 1px solid #2f3150;
      margin: 32px 0;
    }
    ul, ol {
      padding-left: 24px;
      margin: 12px 0;
    }
    li { margin: 6px 0; }
    strong { color: #f0f0f0; }
    em { color: #c0c0d0; }
    blockquote {
      border-left: 3px solid #6366f1;
      padding: 8px 16px;
      margin: 16px 0;
      color: #a0a0b0;
      background: #252740;
      border-radius: 0 4px 4px 0;
    }
    .toolbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 16px;
      background: rgba(26, 27, 46, 0.95);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid #2f3150;
      z-index: 10;
    }
    .toolbar button {
      background: #6366f1;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .toolbar button:hover { background: #818cf8; }
    .toolbar .secondary {
      background: #252740;
      color: #e0e0e0;
      border: 1px solid #2f3150;
    }
    .toolbar .secondary:hover { background: #2f3150; }
    .meta {
      color: #a0a0b0;
      font-size: 13px;
      margin-bottom: 32px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="secondary" onclick="navigator.clipboard.writeText(md).then(()=>this.textContent='Copied!').catch(()=>{})">Copy Markdown</button>
    <button onclick="downloadMd()">Download .md</button>
  </div>
  <p>${html}</p>
  <script>
    const md = ${JSON.stringify(markdown)};
    function downloadMd() {
      const blob = new Blob([md], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'report-${fileSlug}.md';
      a.click();
      URL.revokeObjectURL(a.href);
    }
  </script>
</body>
</html>`;
  }

  // ─── Main Tool ───────────────────────────────────────────

  /**
   * Generate a research report from all tabs in a group.
   *
   * @param {object} params
   * @param {number} [params.groupId] - Tab group ID
   * @param {string} [params.groupName] - Tab group name (fuzzy match)
   * @param {string} [params.topic] - Optional topic/focus for the report
   * @returns {object} { success, tabCount, group, reportLength } or { error }
   */
  async function generateReport({ groupId, groupName, topic } = {}) {
    // 1. Resolve the group
    let targetGroupId = groupId;

    if (targetGroupId == null && groupName) {
      let groups = [];
      try {
        groups = await browser.tabGroups.query({});
      } catch (e) {
        return { error: "tabGroups API not available" };
      }
      const match = groups.find(g =>
        g.title && g.title.toLowerCase().includes(groupName.toLowerCase())
      );
      if (!match) {
        return { error: `No group found matching "${groupName}"` };
      }
      targetGroupId = match.id;
    }

    if (targetGroupId == null) {
      return { error: "Provide either groupId or groupName" };
    }

    // 2. Get group metadata
    let groupInfo;
    try {
      groupInfo = await browser.tabGroups.get(targetGroupId);
    } catch (e) {
      groupInfo = { title: "Research", color: "grey" };
    }

    // 3. Get all tabs in the group
    const tabs = await browser.tabs.query({ groupId: targetGroupId });
    if (tabs.length === 0) {
      return { error: "No tabs found in this group" };
    }

    console.log(`[Report] Scraping ${tabs.length} tabs from group "${groupInfo.title}"`);

    // 4. Scrape all tabs in parallel
    const extractions = await Promise.all(
      tabs.map(t => scrapeTab(t.id))
    );

    // 5. Build content blocks
    const tabContents = tabs
      .map((tab, i) => formatTabContent(tab, extractions[i]))
      .join("\n---\n\n");

    // 6. Build the LLM prompt
    const systemPrompt = `You are a research analyst producing a structured report. Your output is a single markdown document.

INSTRUCTIONS:
- Write a clear title as an H1 heading
- Start with an executive summary (2-3 sentences)
- Organize findings by themes or topics — do NOT just summarize each page separately
- Cross-reference and synthesize information across sources
- Highlight key insights, patterns, agreements, and contradictions
- Use bullet points for lists of findings
- Bold key terms and important conclusions
- End with a "Sources" section listing each URL with its title
- Use proper markdown: # ## ### for hierarchy, **bold**, *italic*, - for lists
- Be thorough and analytical, not just descriptive

OUTPUT: Only the markdown report. No preamble, no meta-commentary.`;

    const userMessage = topic
      ? `Generate a research report focused on "${topic}" based on the following ${tabs.length} web pages from the "${groupInfo.title}" tab group:\n\n${tabContents}`
      : `Generate a comprehensive research report synthesizing the following ${tabs.length} web pages from the "${groupInfo.title}" tab group:\n\n${tabContents}`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    console.log(`[Report] Sending ${userMessage.length} chars to LLM for report generation`);

    // 7. Call the LLM (text generation only, no tool calling)
    let reportMarkdown;
    try {
      const response = await LLMClient.chatCompletion(messages, []);
      reportMarkdown = response.content || "(empty report)";
    } catch (err) {
      return { error: `Report generation failed: ${err.message}` };
    }

    console.log(`[Report] Generated ${reportMarkdown.length} chars of markdown`);

    // 8. Render as HTML and open in a new tab
    const html = renderReportHtml(reportMarkdown, groupInfo.title || "Research");
    const blob = new Blob([html], { type: "text/html" });
    const blobUrl = URL.createObjectURL(blob);
    await browser.tabs.create({ url: blobUrl });

    return {
      success: true,
      tabCount: tabs.length,
      group: groupInfo.title || "(untitled)",
      reportLength: reportMarkdown.length,
    };
  }

  // ─── Public API ──────────────────────────────────────────

  return {
    generateReport,
  };
})();
