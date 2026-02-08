/**
 * Tab Whisperer — Options Page Script
 */

(function () {
  "use strict";

  const DEFAULTS = {
    provider: "openai",
    apiKey: "",
    model: "gpt-5-nano",
    temperature: 1,
    maxTokens: 10000,
    openaiBaseUrl: "https://api.openai.com/v1",
    ollamaBaseUrl: "http://localhost:11434/v1",
    voiceServerUrl: "ws://localhost:8765",
    wakeWord: "hey fox",
    blockedSites: "",
  };

  // ─── DOM Elements ──────────────────────────────────────

  const els = {
    provider: document.getElementById("provider"),
    apiKey: document.getElementById("apiKey"),
    model: document.getElementById("model"),
    temperature: document.getElementById("temperature"),
    maxTokens: document.getElementById("maxTokens"),
    baseUrl: document.getElementById("baseUrl"),
    voiceServerUrl: document.getElementById("voiceServerUrl"),
    wakeWord: document.getElementById("wakeWord"),
    blockedSites: document.getElementById("blockedSites"),
    btnSave: document.getElementById("btn-save"),
    btnReset: document.getElementById("btn-reset"),
    toggleKey: document.getElementById("toggle-key"),
    statusMessage: document.getElementById("status-message"),
  };

  // ─── Load Settings ────────────────────────────────────

  async function loadSettings() {
    const settings = await browser.storage.local.get(DEFAULTS);

    els.provider.value = settings.provider;
    els.apiKey.value = settings.apiKey;
    els.model.value = settings.model;
    els.temperature.value = settings.temperature;
    els.maxTokens.value = settings.maxTokens;
    els.voiceServerUrl.value = settings.voiceServerUrl;
    els.wakeWord.value = settings.wakeWord;
    els.blockedSites.value = settings.blockedSites;

    // Set base URL based on provider
    if (settings.provider === "ollama") {
      els.baseUrl.value = settings.ollamaBaseUrl;
    } else {
      els.baseUrl.value = settings.openaiBaseUrl;
    }

    updateProviderUI(settings.provider);
  }

  // ─── Save Settings ────────────────────────────────────

  async function saveSettings() {
    const provider = els.provider.value;

    const settings = {
      provider,
      apiKey: els.apiKey.value.trim(),
      model: els.model.value.trim() || DEFAULTS.model,
      temperature: parseFloat(els.temperature.value) || DEFAULTS.temperature,
      maxTokens: parseInt(els.maxTokens.value) || DEFAULTS.maxTokens,
      voiceServerUrl:
        els.voiceServerUrl.value.trim() || DEFAULTS.voiceServerUrl,
      wakeWord: els.wakeWord.value.trim() || DEFAULTS.wakeWord,
      blockedSites: els.blockedSites.value,
    };

    // Save base URL to the right key
    const baseUrl = els.baseUrl.value.trim();
    if (provider === "ollama") {
      settings.ollamaBaseUrl = baseUrl || DEFAULTS.ollamaBaseUrl;
    } else {
      settings.openaiBaseUrl = baseUrl || DEFAULTS.openaiBaseUrl;
    }

    await browser.storage.local.set(settings);
    showStatus("Settings saved!", "success");
  }

  // ─── Reset ────────────────────────────────────────────

  async function resetSettings() {
    await browser.storage.local.set(DEFAULTS);
    await loadSettings();
    showStatus("Settings reset to defaults.", "success");
  }

  // ─── UI Helpers ────────────────────────────────────────

  function updateProviderUI(provider) {
    if (provider === "ollama") {
      els.apiKey.disabled = true;
      els.apiKey.placeholder = "(not needed for Ollama)";
      els.baseUrl.value = els.baseUrl.value || DEFAULTS.ollamaBaseUrl;
      els.model.placeholder = "llama3.1";
    } else {
      els.apiKey.disabled = false;
      els.apiKey.placeholder = "sk-...";
      els.baseUrl.value = els.baseUrl.value || DEFAULTS.openaiBaseUrl;
      els.model.placeholder = "gpt-4o-mini";
    }
  }

  function showStatus(message, type) {
    els.statusMessage.textContent = message;
    els.statusMessage.className = type;

    setTimeout(() => {
      els.statusMessage.className = "";
      els.statusMessage.style.display = "none";
    }, 3000);
  }

  // ─── Event Listeners ──────────────────────────────────

  els.btnSave.addEventListener("click", saveSettings);
  els.btnReset.addEventListener("click", resetSettings);

  els.provider.addEventListener("change", () => {
    updateProviderUI(els.provider.value);
  });

  els.toggleKey.addEventListener("click", () => {
    if (els.apiKey.type === "password") {
      els.apiKey.type = "text";
      els.toggleKey.textContent = "hide";
    } else {
      els.apiKey.type = "password";
      els.toggleKey.textContent = "show";
    }
  });

  // ─── Init ─────────────────────────────────────────────

  loadSettings();
})();
