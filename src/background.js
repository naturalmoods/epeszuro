import { judge, PROMPT_VERSION } from "./judge.js";
import { DEFAULTS } from "./settings.js";

const CACHE_TTL_MS = 48 * 60 * 60 * 1000;
const BATCH_SIZE = 10;
const CONCURRENCY = 4;

chrome.storage.local.get(null).then((stored) => {
  const expired = Object.entries(stored).filter(([key, value]) => key.startsWith("c:") && Date.now() - value?.t >= CACHE_TTL_MS).map(([key]) => key);
  if (expired.length) chrome.storage.local.remove(expired);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "judge") return;
  handleJudge(message).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});

async function cacheKey(comment, model) {
  const bytes = new TextEncoder().encode(JSON.stringify([comment.text, PROMPT_VERSION, model, comment.reply_to || "", comment.context || []]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `c:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function handleJudge({ comments, video }) {
  if (!Array.isArray(comments) || !video || typeof video.title !== "string" || typeof video.channel !== "string")
    throw new Error("Érvénytelen pontozási kérés.");
  if (comments.some((comment) => !comment || typeof comment.text !== "string" ||
    (comment.context !== undefined && (!Array.isArray(comment.context) || comment.context.length > 5 || comment.context.some((text) => typeof text !== "string")))))
    throw new Error("Érvénytelen hozzászólás vagy kontextus.");

  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (!cfg.apiKey) throw new Error("Nincs megadva TypeSafe API-kulcs. Nyisd meg az Epeszűrő beállításait.");

  const items = await Promise.all(comments.map(async (comment, index) => ({
    comment,
    index,
    key: await cacheKey(comment, cfg.model),
  })));
  const unique = [...new Map(items.map((item) => [item.key, item])).values()];
  const stored = await chrome.storage.local.get(unique.map((item) => item.key));
  const now = Date.now();
  const records = new Map();
  const stale = [];
  const todo = [];

  for (const item of unique) {
    const hit = stored[item.key];
    if (hit && now - hit.t < CACHE_TTL_MS) records.set(item.key, hit.r);
    else {
      if (hit) stale.push(item.key);
      todo.push(item);
    }
  }

  const chunks = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) chunks.push(todo.slice(i, i + BATCH_SIZE));
  let next = 0;
  let tokens = 0;
  const writes = {};

  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const request = chunk.map((item) => ({
        id: String(item.index),
        text: item.comment.text,
        ...(item.comment.reply_to ? { reply_to: item.comment.reply_to } : {}),
        ...(item.comment.context?.length ? { context: item.comment.context } : {}),
      }));
      const response = await judge(request, video, cfg);
      tokens += response.tokens || 0;
      for (const result of response.results) {
        const item = chunk.find((candidate) => String(candidate.index) === String(result.id));
        if (!item) continue;
        const { id: _id, ...record } = result;
        records.set(item.key, record);
        if (!record.error) writes[item.key] = { t: Date.now(), r: record };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  if (stale.length) await chrome.storage.local.remove(stale);
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);

  return {
    results: items.map(({ comment, key }) => ({ id: comment.id, ...(records.get(key) || { error: "hiányzó válasz" }) })),
    tokens,
  };
}
