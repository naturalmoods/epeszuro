import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reason } from "../src/judge.js";

const ROOT = new URL("..", import.meta.url).pathname;
const fixture = readFileSync(`${ROOT}test/fixtures/yt-page.html`);
const chatFixture = readFileSync(`${ROOT}test/fixtures/yt-chat.html`);
const chat = readFileSync(`${ROOT}src/chat.js`, "utf8");
const judge = readFileSync(`${ROOT}src/judge.js`);
const content = readFileSync(`${ROOT}src/content.js`, "utf8");
const css = readFileSync(`${ROOT}src/content.css`);
const server = createServer((request, response) => {
  if (request.url === "/src/judge.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(judge);
  } else if (request.url === "/src/content.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(request.url.startsWith("/live_chat") ? chatFixture : fixture);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/watch?v=test`;
const debugPort = 9336;
const profile = mkdtempSync(join(tmpdir(), "epeszuro-"));
const browser = spawn("chromium", ["--headless=new", "--no-sandbox", "--window-size=1200,900", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ws;
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      ready = true;
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!ready) throw new Error("A Chromium nem indult el.");

  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(pageUrl)}`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params = {}) => new Promise((resolve) => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  const evaluate = async (expression, contextId) => {
    const reply = await call("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true });
    if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text);
    return reply.result.result.value;
  };
  const waitFor = async (expression, contextId) => {
    for (let i = 0; i < 50; i++) {
      if (await evaluate(expression, contextId)) return;
      await sleep(100);
    }
    throw new Error(`Időtúllépés: ${expression}`);
  };

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.navigate", { url: pageUrl });
  await waitFor("document.readyState === 'complete'");
  const frameId = (await call("Page.getFrameTree")).result.frameTree.frame.id;
  const contextId = (await call("Page.createIsolatedWorld", { frameId, worldName: "epeszuro-test" })).result.executionContextId;
  const origin = new URL(pageUrl).origin;
  const stub = `globalThis.__sent = [];
    globalThis.__storageListeners = [];
    globalThis.chrome = {
      storage: {
        local: { get: async () => ({ usdHuf: 400 }) },
        onChanged: { addListener: (listener) => globalThis.__storageListeners.push(listener) }
      },
      runtime: {
      getURL: (path) => ${JSON.stringify(origin)} + "/" + path,
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => {
        globalThis.__sent.push(JSON.parse(JSON.stringify(message)));
        const base = { threat: .1, dehum: .1, group: .1, vulgar: .1, nick: .1, attack: .1, attackProbs: null };
        return { tokens: 10000, results: message.comments.map((comment) => {
          const result = { id: comment.id, ...base };
          if (comment.text.includes("Erőszak")) result.threat = .9;
          if (comment.text.includes("Trágár")) result.vulgar = .9;
          if (comment.text.includes("Nyugodt")) result.vulgar = .35;
          if (comment.text.includes("Gúny")) result.attack = 1;
          if (comment.text.includes("Késői")) result.dehum = .9;
          return result;
        }) };
      }
    } };`;
  await evaluate(`document.head.insertAdjacentHTML("beforeend", '<link rel="stylesheet" href="/src/content.css">'); eval(${JSON.stringify(stub)}); eval(${JSON.stringify(content)}); true`, contextId);
  await waitFor("globalThis.__sent?.flatMap((message) => message.comments).length === 4", contextId);

  await evaluate("document.querySelector('ytd-comments').append(document.getElementById('late-comment').content.cloneNode(true)); true");
  await waitFor("globalThis.__sent?.flatMap((message) => message.comments).length === 5", contextId);

  await waitFor(`document.querySelector('[data-case="shred"]')?.hasAttribute('data-epe-collapsed')`, contextId);
  await waitFor(`document.querySelectorAll('.epe-heatmap-tick').length === 4`, contextId);
  const heatmap = await evaluate(`(() => {
    const ticks = [...document.querySelectorAll('.epe-heatmap-tick')];
    const colors = Object.fromEntries(ticks.map(t => [t.dataset.decision, getComputedStyle(t).backgroundColor]));
    const reasons = ticks.map(t => t.title);
    const target = document.querySelector('[data-case="late"]');
    ticks.at(-1).click();
    return { count: ticks.length, colors, reasons, targetTop: target.getBoundingClientRect().top };
  })()`, contextId);
  await sleep(900);
  heatmap.scrolled = await evaluate(`(() => { const r = document.querySelector('[data-case="late"]').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight && scrollY > 0; })()`, contextId);
  const heatmapReapply = await evaluate(`(() => {
    globalThis.__storageListeners[0]({ vulgar: { newValue: .2 } }, 'local');
    const stricter = document.querySelector('[data-case="safe"]').dataset.epe === 'blur';
    return { stricter };
  })()`, contextId);
  await waitFor(`document.querySelectorAll('.epe-heatmap-tick').length === 5`, contextId);
  heatmapReapply.added = true;
  await evaluate("globalThis.__storageListeners[0]({ vulgar: { newValue: .5 }, heatmapEnabled: { newValue: false } }, 'local'); true", contextId);
  await sleep(100);
  heatmapReapply.disabled = await evaluate("!document.getElementById('epe-heatmap')", contextId);
  await evaluate("globalThis.__storageListeners[0]({ heatmapEnabled: { newValue: true } }, 'local'); true", contextId);
  await waitFor(`document.querySelectorAll('.epe-heatmap-tick').length === 4`, contextId);
  const off = await evaluate(`(() => {
    const before = globalThis.__sent.length;
    globalThis.__storageListeners[0]({ enabled: { oldValue: true, newValue: false } }, 'local');
    return { before, cleared: !document.querySelector('[data-epe]') };
  })()`, contextId);
  await sleep(100);
  off.hidden = await evaluate("!document.getElementById('epe-heatmap')", contextId);
  const reapply = await evaluate(`(() => {
    globalThis.__storageListeners[0]({ enabled: { oldValue: false, newValue: true } }, 'local');
    const shred = document.querySelector('[data-case="shred"]');
    return { noCalls: globalThis.__sent.length === ${off.before}, restored: shred.dataset.epe === 'shred', noAnimation: !shred.classList.contains('epe-shredding') };
  })()`, contextId);
  await waitFor(`document.querySelectorAll('.epe-heatmap-tick').length === 4`, contextId);
  const shred = await evaluate(`(() => {
    const element = document.querySelector('[data-case="shred"]');
    const bar = element.querySelector('.epe-shred-bar')?.innerText;
    element.querySelector('.epe-show').click();
    const restored = element.hasAttribute('data-epe-revealed') && !!element.querySelector('.epe-hide');
    element.querySelector('.epe-hide').click();
    return { bar, restored, hiddenAgain: element.hasAttribute('data-epe-collapsed') };
  })()`, contextId);
  const blur = await evaluate(`(() => {
    const element = document.querySelector('[data-case="blur"]');
    const stamp = element.querySelector('.epe-stamp')?.textContent;
    element.click();
    const revealed = element.hasAttribute('data-epe-revealed');
    element.click();
    return { stamp, revealed, hiddenAgain: !element.hasAttribute('data-epe-revealed') };
  })()`, contextId);

  await evaluate(`document.querySelector('[data-case="safe"] #content-text').textContent = 'Trágár újrahasznosított hozzászólás'; true`, contextId);
  await waitFor("globalThis.__sent?.flatMap((message) => message.comments).length === 6", contextId);
  await waitFor(`document.querySelector('[data-case="safe"]')?.dataset.epe === 'blur'`, contextId);
  await waitFor(`document.querySelector('#epe-hate-index .epe-badge-text')?.textContent.includes('5 hozzászólásból 4 elrejtve')`, contextId);

  await waitFor(`document.querySelectorAll('.epe-heatmap-tick').length === 5`, contextId);
  const sent = await evaluate("globalThis.__sent", contextId);
  const state = await evaluate(`Object.fromEntries([...document.querySelectorAll('[data-case]')].map((element) => [element.dataset.case, element.dataset.epe || null]))`);
  const badge = await evaluate(`({
    text: document.querySelector('#epe-hate-index .epe-badge-text')?.textContent,
    pill: document.querySelector('#epe-hate-index .epe-toxic-pill')?.textContent,
    cost: document.querySelector('#epe-hate-index .epe-cost')?.textContent
  })`, contextId);
  const comments = sent.flatMap((message) => message.comments);
  const originalComments = comments.filter((comment) => comment.text !== "Trágár újrahasznosított hozzászólás");
  const counts = Object.fromEntries(originalComments.map((comment) => [comment.text, originalComments.filter((other) => other.text === comment.text).length]));
  const reply = comments.find((comment) => comment.text === "Gúnyos válasz");
  const leaked = ["Titkos Szerző Egy", "Titkos Szerző Kettő", "Titkos Szülő", "Titkos Válaszoló", "Titkos Késői Szerző"].some((name) => JSON.stringify(sent).includes(name));
  const attackReason = reason({ threat: .1, dehum: .1, group: .1, vulgar: .1, nick: .2, attack: 1.8, attackProbs: { 0: .1, 1: .1, 2: .64, 3: .16 } }, "blur");
  const scopedReasons = [
    reason({ threat: .6, dehum: .4, group: .3, vulgar: .99, nick: .99, attack: 2.9 }, "shred").label,
    reason({ threat: .99, dehum: .1, group: .1, vulgar: .6, nick: .99, attack: .1 }, "blur").label,
    reason({ threat: .99, dehum: .1, group: .1, vulgar: .99, nick: .7, attack: .8 }, "mark").label,
  ];
  const ok = comments.length === 6 && Object.values(counts).every((count) => count === 1) &&
    reply?.reply_to === "Nyugodt szülő hozzászólás" && !leaked && sent.every((message) => message.comments.length <= 40) &&
    sent.every((message) => message.video.title === "Próba videó" && message.video.channel === "Próba csatorna") &&
    state.shred === "shred" && state.blur === "blur" && state.mark === "mark" && state.safe === "blur" && state.late === "shred" &&
    shred.bar?.includes("Gyűlölködő hozzászólás megsemmisítve · Erőszak") && shred.restored && shred.hiddenAgain &&
    blur.stamp === "TRÁGÁR · 90%" && blur.revealed && blur.hiddenAgain && badge.text.includes("a szál 80%-a mérgező") &&
    badge.pill === "80%" && badge.cost === "0,0013 $ · 0,50 Ft" &&
    attackReason.label === "Sértő" && attackReason.percent === 80 && scopedReasons.join() === "Erőszak,Trágár,Gúnynév" &&
    off.cleared && off.hidden && reapply.noCalls && reapply.restored && reapply.noAnimation &&
    heatmap.count === 4 && heatmap.scrolled && heatmap.colors.shred === 'rgb(217, 48, 37)' && heatmap.colors.blur === 'rgb(232, 88, 49)' && heatmap.colors.mark === 'rgb(239, 140, 0)' && heatmap.reasons.every(Boolean) &&
    heatmapReapply.stricter && heatmapReapply.added && heatmapReapply.disabled;
  if (!ok) throw new Error(JSON.stringify({ comments, state, shred, blur, badge, attackReason, scopedReasons, reapply, heatmap, heatmapReapply, leaked }, null, 2));

  mkdirSync(`${ROOT}test/out`, { recursive: true });
  const light = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${ROOT}test/out/page.png`, Buffer.from(light.result.data, "base64"));
  await evaluate("document.documentElement.setAttribute('dark', ''); document.body.style.background = '#0f0f0f'; true", contextId);
  const dark = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${ROOT}test/out/page-dark.png`, Buffer.from(dark.result.data, "base64"));
  const chatTarget = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(new URL('/live_chat?v=test', origin))}`, { method: 'PUT' })).json();
  const chatWs = new WebSocket(chatTarget.webSocketDebuggerUrl);
  await new Promise((resolve) => chatWs.addEventListener('open', resolve, { once: true }));
  let chatId = 0;
  const chatPending = new Map();
  chatWs.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && chatPending.has(message.id)) { chatPending.get(message.id)(message); chatPending.delete(message.id); }
  });
  const chatCall = (method, params = {}) => new Promise((resolve) => {
    const callId = ++chatId;
    chatPending.set(callId, resolve);
    chatWs.send(JSON.stringify({ id: callId, method, params }));
  });
  const chatEval = async (expression, world) => {
    const reply = await chatCall('Runtime.evaluate', { expression, ...(world ? { contextId: world } : {}), awaitPromise: true, returnByValue: true });
    if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text);
    return reply.result.result.value;
  };
  try {
    await chatCall('Page.enable');
    await chatCall('Runtime.enable');
    await chatEval("document.readyState === 'complete'");
    const chatFrame = (await chatCall('Page.getFrameTree')).result.frameTree.frame.id;
    const chatWorld = (await chatCall('Page.createIsolatedWorld', { frameId: chatFrame, worldName: 'epeszuro-chat-test' })).result.executionContextId;
    await chatEval(`eval(${JSON.stringify(stub)}); eval(${JSON.stringify(chat)}); true`, chatWorld);
    for (let i = 0; i < 40; i++) {
      if (await chatEval('globalThis.__sent?.flatMap(m => m.comments).length === 4', chatWorld)) break;
      await sleep(100);
    }
    const first = await chatEval(`({ sent: globalThis.__sent, effects: [...document.querySelectorAll('yt-live-chat-text-message-renderer')].map(e => e.dataset.epeChat || null), counter: document.querySelector('#epe-chat-count')?.textContent, pill: document.querySelector('#epe-chat-count .epe-toxic-pill')?.textContent, cost: document.querySelector('#epe-chat-count .epe-cost')?.textContent })`, chatWorld);
    await chatEval(`document.querySelector('#items').firstElementChild.querySelector('#message').textContent = 'Trágár újrahasznosított'; true`, chatWorld);
    for (let i = 0; i < 40; i++) {
      if (await chatEval('globalThis.__sent?.flatMap(m => m.comments).length === 5', chatWorld)) break;
      await sleep(100);
    }
    const second = await chatEval(`({ sent: globalThis.__sent, effects: [...document.querySelectorAll('yt-live-chat-text-message-renderer')].map(e => e.dataset.epeChat || null), counter: document.querySelector('#epe-chat-count')?.textContent, pill: document.querySelector('#epe-chat-count .epe-toxic-pill')?.textContent, cost: document.querySelector('#epe-chat-count .epe-cost')?.textContent })`, chatWorld);
    const toggled = await chatEval(`(() => {
      const before = globalThis.__sent.length;
      globalThis.__storageListeners[0]({ enabled: { newValue: false } }, 'local');
      const off = !document.querySelector('[data-epe-chat]') && document.querySelector('#epe-chat-count').textContent.includes('0 elrejtve');
      globalThis.__storageListeners[0]({ enabled: { newValue: true }, threat: { newValue: .99 }, vulgar: { newValue: .99 } }, 'local');
      const sliders = !document.querySelector('[data-epe-chat="shred"], [data-epe-chat="blur"]');
      globalThis.__storageListeners[0]({ threat: { newValue: .5 }, vulgar: { newValue: .5 } }, 'local');
      return { off, sliders, restored: !!document.querySelector('[data-epe-chat="shred"]'), noCalls: globalThis.__sent.length === before };
    })()`, chatWorld);
    const sentChat = first.sent.flatMap(m => m.comments);
    if (sentChat.length !== 4 || JSON.stringify(first.sent).includes('Titkos Szerző') ||
      sentChat.some(c => c.text.includes('😂😂')) || sentChat[1].context?.join('|') !== 'Nyugodt üzenet' ||
      sentChat[2].context?.join('|') !== 'Nyugodt üzenet|Erőszak üzenet' ||
      first.effects.join() !== ',shred,,blur,mark' || !first.counter.includes('4 üzenetből 2 elrejtve') || first.pill !== '50%' || first.cost !== '0,00042 $ · 0,17 Ft' ||
      second.sent.flatMap(m => m.comments).length !== 5 || second.effects[0] !== 'blur' || !second.counter.includes('5 üzenetből 3 elrejtve') || second.pill !== '60%' || second.cost !== '0,00084 $ · 0,34 Ft' ||
      !Object.values(toggled).every(Boolean))
      throw new Error(JSON.stringify({ first, second, toggled }, null, 2));
  } finally { chatWs.close(); }
  console.log('OK');
} finally {
  ws?.close();
  browser.kill();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
