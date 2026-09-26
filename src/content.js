(async () => {
  const { action, reason, DEFAULTS, USD_PER_MTOK } = await import(chrome.runtime.getURL("src/judge.js"));
  const COMMENT_SELECTOR = "ytd-comment-view-model, ytd-comment-renderer";
  const SETTING_KEYS = [...Object.keys(DEFAULTS), "enabled", "markEnabled", "heatmapEnabled", "usdHuf"];
  let overrides = { enabled: true, markEnabled: true, usdHuf: 320 };
  let rawResults = new WeakMap();
  let observer;
  let finder;
  let timer;
  let run = 0;
  let nextId = 0;
  let judging = 0;
  let pageTokens = 0;
  let heatmapFrame;
  let sectionResize;
  const heatmap = document.createElement("div");
  heatmap.id = "epe-heatmap";
  const viewport = document.createElement("div");
  viewport.className = "epe-heatmap-viewport";
  heatmap.append(viewport);

  const textOf = (element) => (element.querySelector("#content-text")?.innerText || element.querySelector("#content-text")?.textContent || "").replace(/\s+/g, " ").trim();
  const fingerprint = (text) => {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36);
  };

  function videoContext() {
    return {
      title: (document.querySelector("ytd-watch-metadata h1")?.innerText || document.querySelector("ytd-watch-metadata h1")?.textContent || document.title).trim(),
      channel: (document.querySelector("ytd-channel-name a")?.innerText || document.querySelector("ytd-channel-name a")?.textContent || "").trim(),
    };
  }

  function parentText(element) {
    const replies = element.closest("ytd-comment-replies-renderer, #replies");
    if (!replies) return "";
    const thread = replies.closest("ytd-comment-thread-renderer");
    const parent = [...(thread?.querySelectorAll(COMMENT_SELECTOR) || [])].find((comment) => !comment.closest("ytd-comment-replies-renderer, #replies"));
    return parent ? textOf(parent).slice(0, 300) : "";
  }

  function ensureBadge() {
    const section = document.querySelector("ytd-comments#comments, ytd-comments");
    if (!section) return null;
    let badge = document.getElementById("epe-hate-index");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "epe-hate-index";
      const text = document.createElement("span");
      text.className = "epe-badge-text";
      const pill = document.createElement("span");
      pill.className = "epe-toxic-pill";
      const cost = document.createElement("span");
      cost.className = "epe-cost";
      const gauge = document.createElement("span");
      gauge.className = "epe-gauge";
      gauge.append(document.createElement("i"));
      const scanner = document.createElement("span");
      scanner.className = "epe-scanner";
      badge.append(text, pill, cost, gauge, scanner);
      section.prepend(badge);
    }
    return badge;
  }

  function updateBadge() {
    const badge = ensureBadge();
    if (!badge) return;
    const comments = [...document.querySelectorAll(COMMENT_SELECTOR)];
    const hidden = comments.filter((element) => element.dataset.epe === "shred" || element.dataset.epe === "blur").length;
    const percent = comments.length ? Math.round(hidden / comments.length * 100) : 0;
    const text = `Epeszűrő · ${comments.length} hozzászólásból ${hidden} elrejtve · a szál ${percent}%-a mérgező`;
    const label = badge.querySelector(".epe-badge-text");
    if (label.textContent !== text) label.textContent = text;
    const pill = badge.querySelector(".epe-toxic-pill");
    pill.textContent = `${percent}%`;
    pill.className = `epe-toxic-pill epe-toxic-${percent < 10 ? "low" : percent < 30 ? "mid" : "high"}`;
    const usd = pageTokens * USD_PER_MTOK / 1e6;
    badge.querySelector(".epe-cost").textContent = `${usd.toLocaleString("hu-HU", { maximumSignificantDigits: 2 })} $ · ${(usd * (Number(overrides.usdHuf) || 320)).toLocaleString("hu-HU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Ft`;
    const fill = badge.querySelector(".epe-gauge i");
    fill.style.width = `${percent}%`;
    fill.style.backgroundColor = `hsl(${Math.round((100 - percent) * 1.2)} 65% 42%)`;
    badge.classList.toggle("epe-judging", judging > 0);
  }

  function updateHeatmap() {
    heatmapFrame = 0;
    const section = document.querySelector("ytd-comments#comments, ytd-comments");
    const comments = [...(section?.querySelectorAll(COMMENT_SELECTOR) || [])].filter((element) => element.dataset.epe);
    if (!section || location.pathname !== "/watch" || overrides.enabled === false || overrides.heatmapEnabled === false || innerWidth < 900 || !comments.length) {
      heatmap.remove();
      return;
    }
    if (!heatmap.isConnected) document.body.append(heatmap);
    const rect = section.getBoundingClientRect();
    const height = Math.max(rect.height, 1);
    heatmap.style.left = `${Math.min(innerWidth - 8, rect.right + 4)}px`;
    const visible = Math.min(1, innerHeight / height);
    viewport.style.top = `${Math.max(0, Math.min(1 - visible, -rect.top / height)) * 100}%`;
    viewport.style.height = `${visible * 100}%`;
    heatmap.querySelectorAll(".epe-heatmap-tick").forEach((tick) => tick.remove());
    for (const element of comments) {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "epe-heatmap-tick";
      tick.dataset.decision = element.dataset.epe;
      tick.style.top = `${Math.max(0, Math.min(100, (element.getBoundingClientRect().top - rect.top) / height * 100))}%`;
      const why = reason(rawResults.get(element), element.dataset.epe);
      tick.title = `${why.label} · ${why.percent}%`;
      tick.setAttribute("aria-label", tick.title);
      tick.addEventListener("click", () => element.scrollIntoView({ behavior: "smooth", block: "center" }));
      heatmap.append(tick);
    }
  }
  function scheduleHeatmap() {
    if (!heatmapFrame) heatmapFrame = requestAnimationFrame(updateHeatmap);
  }
  window.addEventListener("scroll", scheduleHeatmap, { passive: true });
  window.addEventListener("resize", scheduleHeatmap);

  function clearEffect(element) {
    element.removeAttribute("data-epe");
    element.removeAttribute("data-epe-revealed");
    element.removeAttribute("data-epe-collapsed");
    element.classList.remove("epe-shredding");
    element.querySelector(":scope > .epe-ui")?.remove();
  }

  const decisionFor = (result) => {
    if (overrides.enabled === false) return null;
    const decision = action(result, { ...DEFAULTS, ...overrides });
    return overrides.markEnabled === false && decision === "mark" ? null : decision;
  };

  function applyEffect(element, decision, result, animate = true) {
    clearEffect(element);
    if (!decision) return;
    const why = reason(result, decision);
    const label = `${why.label} · ${why.percent}%`;
    const ui = document.createElement("div");
    ui.className = "epe-ui";
    element.dataset.epe = decision;

    if (decision === "shred") {
      const shreds = document.createElement("div");
      shreds.className = "epe-shreds";
      const source = [...element.children];
      for (let i = 0; i < 10; i++) {
        const strip = document.createElement("span");
        strip.className = "epe-strip";
        strip.style.setProperty("--epe-i", i);
        const copy = document.createElement("span");
        copy.className = "epe-strip-copy";
        source.forEach((child) => copy.append(child.cloneNode(true)));
        strip.append(copy);
        shreds.append(strip);
      }
      ui.append(shreds);
      const bar = document.createElement("div");
      bar.className = "epe-shred-bar";
      const message = document.createElement("span");
      message.textContent = `🔥 Gyűlölködő hozzászólás megsemmisítve · ${label}`;
      const show = document.createElement("button");
      show.className = "epe-show";
      show.type = "button";
      show.textContent = "megnézem";
      bar.append(message, " · ", show);
      ui.append(bar);
      const hide = document.createElement("button");
      hide.className = "epe-hide";
      hide.type = "button";
      hide.textContent = "elrejtés";
      ui.append(hide);
      const collapse = () => {
        if (!ui.isConnected) return;
        element.classList.remove("epe-shredding");
        element.setAttribute("data-epe-collapsed", "");
        shreds.remove();
      };
      if (!animate) {
        element.setAttribute("data-epe-collapsed", "");
        shreds.remove();
      } else if (matchMedia("(prefers-reduced-motion: reduce)").matches) setTimeout(collapse);
      else {
        element.classList.add("epe-shredding");
        setTimeout(collapse, 720);
      }
    } else if (decision === "blur") {
      const stamp = document.createElement("span");
      stamp.className = "epe-stamp";
      stamp.textContent = label.toUpperCase();
      ui.append(stamp);
    } else {
      const tooltip = document.createElement("span");
      tooltip.className = "epe-tooltip";
      tooltip.textContent = label;
      ui.append(tooltip);
    }
    element.append(ui);
  }

  function showError(message) {
    let notice = document.getElementById("epe-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "epe-notice";
      document.documentElement.appendChild(notice);
    }
    notice.textContent = `Epeszűrő: ${message || "a hozzászólások ellenőrzése sikertelen."}`;
  }

  function reapply() {
    document.querySelectorAll(COMMENT_SELECTOR).forEach((element) => {
      const result = rawResults.get(element);
      if (result) applyEffect(element, decisionFor(result), result, false);
      else clearEffect(element);
    });
    updateBadge();
    scheduleHeatmap();
  }

  async function scan() {
    if (location.pathname !== "/watch" || overrides.enabled === false) {
      updateBadge();
      return;
    }
    const currentRun = run;
    const comments = [...document.querySelectorAll(COMMENT_SELECTOR)]
      .map((element) => ({ element, text: textOf(element) }))
      .filter(({ element, text }) => text && element.dataset.epeFingerprint !== fingerprint(text))
      .sort((a, b) => {
        const visible = ({ element }) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom >= 0 && rect.top <= innerHeight;
        };
        return Number(visible(b)) - Number(visible(a));
      })
      .map(({ element, text }) => {
        const hash = fingerprint(text);
        element.dataset.epeFingerprint = hash;
        rawResults.delete(element);
        clearEffect(element);
        const comment = { id: String(++nextId), text };
        const replyTo = parentText(element);
        if (replyTo) comment.reply_to = replyTo;
        return { element, hash, comment };
      });
    updateBadge();
    scheduleHeatmap();

    for (let i = 0; i < comments.length; i += 40) {
      const batch = comments.slice(i, i + 40);
      judging++;
      updateBadge();
      try {
        const response = await chrome.runtime.sendMessage({ type: "judge", comments: batch.map(({ comment }) => comment), video: videoContext() });
        if (currentRun !== run) return;
        if (response?.error) {
          showError(response.error);
          return;
        }
        pageTokens += response?.tokens || 0;
        const byId = new Map((response?.results || []).map((result) => [String(result.id), result]));
        for (const { element, hash, comment } of batch) {
          if (element.dataset.epeFingerprint !== hash) continue;
          const result = byId.get(comment.id);
          if (!result) continue;
          rawResults.set(element, result);
          applyEffect(element, decisionFor(result), result);
        }
        scheduleHeatmap();
      } catch (error) {
        if (currentRun === run) showError(error.message);
        return;
      } finally {
        if (currentRun === run) {
          judging--;
          updateBadge();
        }
      }
    }
  }

  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, 300);
  }

  function watchComments() {
    const section = document.querySelector("ytd-comments#comments, ytd-comments");
    if (!section) {
      if (!finder) {
        finder = new MutationObserver(watchComments);
        finder.observe(document.documentElement, { childList: true, subtree: true });
      }
      return;
    }
    finder?.disconnect();
    finder = undefined;
    observer = new MutationObserver(scheduleScan);
    observer.observe(section, { childList: true, subtree: true, characterData: true });
    sectionResize = new ResizeObserver(scheduleHeatmap);
    sectionResize.observe(section);
    ensureBadge();
    scheduleScan();
  }

  function reset() {
    run++;
    nextId = 0;
    judging = 0;
    pageTokens = 0;
    rawResults = new WeakMap();
    clearTimeout(timer);
    observer?.disconnect();
    sectionResize?.disconnect();
    heatmap.remove();
    finder?.disconnect();
    observer = finder = undefined;
    document.getElementById("epe-notice")?.remove();
    document.getElementById("epe-hate-index")?.remove();
    document.querySelectorAll("[data-epe-fingerprint]").forEach((element) => {
      element.removeAttribute("data-epe-fingerprint");
      clearEffect(element);
    });
    if (location.pathname === "/watch") watchComments();
  }

  document.addEventListener("click", (event) => {
    const show = event.target.closest?.(".epe-show");
    const hide = event.target.closest?.(".epe-hide");
    const comment = event.target.closest?.('[data-epe="shred"], [data-epe="blur"]');
    if (!comment) return;
    if (show) {
      comment.setAttribute("data-epe-revealed", "");
      comment.removeAttribute("data-epe-collapsed");
    } else if (hide) {
      comment.removeAttribute("data-epe-revealed");
      comment.setAttribute("data-epe-collapsed", "");
    } else if (comment.dataset.epe === "blur") {
      event.preventDefault();
      comment.toggleAttribute("data-epe-revealed");
    }
  }, true);
  chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "counts") return;
    const comments = [...document.querySelectorAll(COMMENT_SELECTOR)];
    sendResponse({
      comments: comments.length,
      shred: comments.filter((element) => element.dataset.epe === "shred").length,
      blur: comments.filter((element) => element.dataset.epe === "blur").length,
      mark: comments.filter((element) => element.dataset.epe === "mark").length,
    });
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !SETTING_KEYS.some((key) => key in changes)) return;
    for (const key of SETTING_KEYS) if (key in changes) {
      if (changes[key].newValue === undefined) {
        if (key === "usdHuf") overrides.usdHuf = 320;
        else delete overrides[key];
      } else overrides[key] = changes[key].newValue;
    }
    if (overrides.enabled === false) {
      run++;
      judging = 0;
      document.querySelectorAll(COMMENT_SELECTOR).forEach((element) => {
        if (!rawResults.has(element)) element.removeAttribute("data-epe-fingerprint");
      });
    }
    reapply();
    if (overrides.enabled !== false) scheduleScan();
  });
  document.addEventListener("yt-navigate-finish", reset);
  if (chrome.storage?.local) overrides = { ...overrides, ...(await chrome.storage.local.get(SETTING_KEYS)) };
  reset();
})();
