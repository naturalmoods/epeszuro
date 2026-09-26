(async () => {
  if (!/^\/live_chat(?:_replay)?$/.test(location.pathname)) return;
  const { action, reason, DEFAULTS, USD_PER_MTOK } = await import(chrome.runtime.getURL("src/judge.js"));
  const SELECTOR = "yt-live-chat-text-message-renderer";
  const keys = [...Object.keys(DEFAULTS), "enabled", "markEnabled", "usdHuf"];
  let settings = { enabled: true, markEnabled: true, usdHuf: 320, ...(await chrome.storage.local.get(keys)) };
  const results = new WeakMap();
  const seen = new WeakMap();
  const judged = []; // ponytail: teljes előzmény a csúszkákhoz; többórás chaten összesített küszöbszámokra váltható.
  let total = 0, hidden = 0, tokens = 0, nextId = 0, timer, lastError = "";
  const fingerprint = (text) => {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36);
  };
  const textOf = (element) => {
    const message = element.querySelector("#message");
    if (!message) return "";
    if (!message.textContent.replace(/[0-9#*]\ufe0f?\u20e3/gu, "").replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0f\s]/gu, "").trim()) return "";
    const copy = message.cloneNode(true);
    copy.querySelectorAll("img").forEach((img) => img.replaceWith(img.alt || ""));
    return copy.textContent.replace(/\s+/g, " ").trim();
  };
  const badge = () => {
    const container = document.querySelector("#chat-messages, yt-live-chat-item-list-renderer");
    if (!container) return;
    let counter = document.getElementById("epe-chat-count");
    if (!counter) {
      counter = document.createElement("div");
      counter.id = "epe-chat-count";
      for (const className of ["epe-chat-text", "epe-toxic-pill", "epe-cost"]) counter.append(Object.assign(document.createElement("span"), { className }));
      container.prepend(counter);
    }
    const percent = total ? Math.round(hidden / total * 100) : 0;
    counter.querySelector(".epe-chat-text").textContent = `Epeszűrő · ${total} üzenetből ${hidden} elrejtve${lastError ? ` · HIBA: ${lastError}` : ""}`;
    const pill = counter.querySelector(".epe-toxic-pill");
    pill.textContent = `${percent}%`;
    pill.className = `epe-toxic-pill epe-toxic-${percent < 10 ? "low" : percent < 30 ? "mid" : "high"}`;
    const usd = tokens * USD_PER_MTOK / 1e6;
    counter.querySelector(".epe-cost").textContent = `${usd.toLocaleString("hu-HU", { maximumSignificantDigits: 2 })} $ · ${(usd * (Number(settings.usdHuf) || 320)).toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Ft`;
  };
  function clear(element) {
    element.removeAttribute("data-epe-chat");
    element.removeAttribute("data-epe-revealed");
    element.querySelector(":scope > .epe-chat-ui")?.remove();
  }
  function decisionFor(result) {
    if (!result || settings.enabled === false) return null;
    const decision = action(result, { ...DEFAULTS, ...settings });
    return decision === "mark" && settings.markEnabled === false ? null : decision;
  }
  function apply(element, result) {
    clear(element);
    const decision = decisionFor(result);
    if (!decision) return;
    element.dataset.epeChat = decision;
    const label = reason(result, decision);
    const ui = document.createElement("span");
    ui.className = "epe-chat-ui";
    if (decision === "shred") {
      ui.append(`🔥 elrejtve · ${label.label} · `);
      const show = document.createElement("button");
      show.type = "button";
      show.textContent = "megnézem";
      ui.append(show);
    } else ui.textContent = `${label.label} · ${label.percent}%`;
    element.append(ui);
  }
  function reapply() {
    hidden = judged.filter((result) => ["shred", "blur"].includes(decisionFor(result))).length;
    document.querySelectorAll(SELECTOR).forEach((element) => apply(element, results.get(element)));
    badge();
  }
  async function scan() {
    if (settings.enabled === false) return;
    const messages = [...document.querySelectorAll(SELECTOR)];
    const pending = [];
    for (let i = 0; i < messages.length; i++) {
      const element = messages[i], text = textOf(element);
      if (!text) continue;
      const hash = fingerprint(text);
      if (seen.get(element) === hash) continue;
      if (seen.has(element)) {
        results.delete(element);
        clear(element);
      }
      seen.set(element, hash);
      total++;
      const context = messages.slice(0, i).map(textOf).filter(Boolean).slice(-5).map((t) => t.slice(0, 200));
      pending.push({ element, hash, comment: { id: String(++nextId), text, ...(context.length ? { context } : {}) } });
    }
    badge();
    for (let i = 0; i < pending.length; i += 20) {
      const batch = pending.slice(i, i + 20);
      try {
        const response = await chrome.runtime.sendMessage({ type: "judge", comments: batch.map(({ comment }) => comment), video: { title: document.title, channel: "" } });
        if (response?.error) throw new Error(response.error);
        tokens += response?.tokens || 0;
        const byId = new Map((response?.results || []).map((r) => [String(r.id), r]));
        for (const { element, hash, comment } of batch) {
          if (!element.isConnected || seen.get(element) !== hash) continue;
          const result = byId.get(comment.id);
          if (result) { results.set(element, result); judged.push(result); apply(element, result); }
        }
        lastError = "";
        reapply();
      } catch (error) { console.warn("Epeszűrő chat:", error); lastError = /Extension context invalidated/i.test(error.message) ? "a bővítmény frissült, töltsd újra az oldalt (F5)" : error.message; badge(); }
    }
  }
  function schedule() {
    if (!timer) timer = setTimeout(() => { timer = null; scan(); }, 1000);
  }
  new MutationObserver((mutations) => {
    if (mutations.some((mutation) => !mutation.target.closest?.(".epe-chat-ui, #epe-chat-count"))) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener("click", (event) => {
    const element = event.target.closest?.('[data-epe-chat="shred"], [data-epe-chat="blur"]');
    if (!element) return;
    if (event.target.closest(".epe-chat-ui button")) element.toggleAttribute("data-epe-revealed");
    else if (element.dataset.epeChat === "blur") element.toggleAttribute("data-epe-revealed");
    else return;
    event.preventDefault();
  }, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !keys.some((key) => key in changes)) return;
    for (const key of keys) if (key in changes) settings[key] = changes[key].newValue ?? (key === "usdHuf" ? 320 : undefined);
    reapply();
    if (settings.enabled !== false) schedule();
  });
  schedule();
})();
