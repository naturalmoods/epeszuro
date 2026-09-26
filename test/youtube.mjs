import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const url = process.argv[2] || "https://www.youtube.com/watch?v=UylZ_e2mAFk";
const content = readFileSync(`${ROOT}src/content.js`, "utf8").replace(
  'const { action, reason, DEFAULTS, USD_PER_MTOK } = await import(chrome.runtime.getURL("src/judge.js"));',
  "const { action, reason, DEFAULTS, USD_PER_MTOK } = globalThis.__judge;",
);
const css = readFileSync(`${ROOT}src/content.css`, "utf8");
const judge = readFileSync(`${ROOT}src/judge.js`, "utf8").replaceAll("export ", "") + "\nglobalThis.__judge = { action, reason, DEFAULTS, USD_PER_MTOK };";
const profile = mkdtempSync(join(tmpdir(), "epeszuro-youtube-"));
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const debugPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const browser = spawn("chromium", [
  "--headless=new", "--no-sandbox", "--disable-blink-features=AutomationControlled", "--window-size=1280,1000",
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ws;
try {
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(100); }
  }
  if (!version) throw new Error("Chromium did not start.");
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  const forbidden = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent" && message.params.request.url.includes("api.typesafe.ai")) forbidden.push(message.params.request.url);
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
    const reply = await call("Runtime.evaluate", { expression, ...(contextId ? { contextId } : {}), awaitPromise: true, returnByValue: true });
    if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text);
    return reply.result.result.value;
  };
  const waitFor = async (expression, contextId, attempts = 60) => {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression, contextId)) return;
      await sleep(500);
    }
    throw new Error(`Timed out: ${expression}`);
  };

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Network.setCookie", { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/", secure: true });
  await call("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'", undefined, 120);
  const consentClicked = await evaluate(`(() => {
    const words = /reject|accept|elutas|elfogad/i;
    const button = [...document.querySelectorAll('button')].find((item) => words.test(item.innerText));
    if (button) { button.click(); return true; }
    return false;
  })()`);
  if (consentClicked) await sleep(2500);
  if ((await evaluate("location.hostname")) !== "www.youtube.com") throw new Error(`Unexpected page: ${await evaluate("location.href")}`);

  for (let i = 0; i < 20; i++) {
    await evaluate("window.scrollTo(0, document.documentElement.scrollHeight); true");
    await sleep(800);
    if (await evaluate("[...document.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer')].filter((element) => (element.querySelector('#content-text')?.textContent || '').trim()).length >= 10")) break;
  }
  await waitFor("[...document.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer')].some((element) => (element.querySelector('#content-text')?.textContent || '').trim())", undefined, 120);
  let replyClicked = false;
  for (let i = 0, attempts = 0; i < 60 && attempts < 90 && !replyClicked; attempts++) {
    const hasThread = await evaluate(`Boolean([...document.querySelectorAll('ytd-comment-thread-renderer')][${i}])`);
    await evaluate(hasThread
      ? `[...document.querySelectorAll('ytd-comment-thread-renderer')][${i}].scrollIntoView({ block: 'center' }); true`
      : "window.scrollTo(0, document.documentElement.scrollHeight); true");
    await sleep(1000);
    if (!hasThread) continue;
    i++;
    replyClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => /\\d.*(repl|válasz)/i.test(item.innerText || item.getAttribute('aria-label') || '')) || document.querySelector('ytd-comment-replies-renderer #more-replies');
      button?.click();
      return Boolean(button);
    })()`);
  }
  if (!replyClicked) throw new Error("No reply button found.");
  await waitFor("document.querySelectorAll('ytd-comment-replies-renderer ytd-comment-view-model, ytd-comment-replies-renderer ytd-comment-renderer').length > 0", undefined, 80);
  await waitFor("document.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer').length > 0", undefined, 120);

  const frameId = (await call("Page.getFrameTree")).result.frameTree.frame.id;
  const contextId = (await call("Page.createIsolatedWorld", { frameId, worldName: "epeszuro-youtube-test" })).result.executionContextId;
  const stub = `globalThis.__sent = [];
    globalThis.chrome = {
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
      runtime: {
        getURL: () => '',
        onMessage: { addListener: () => {} },
        sendMessage: async (message) => {
          globalThis.__sent.push(JSON.parse(JSON.stringify(message)));
          return { results: message.comments.map((comment, index) => {
            const result = { id: comment.id, threat: .08, dehum: .08, group: .08, vulgar: .08, nick: .08, attack: .08, attackProbs: null };
            const n = globalThis.__sent.length * 41 + index;
            if (n % 7 === 0) result.threat = .82;
            else if (n % 5 === 0) result.vulgar = .82;
            else if (n % 3 === 0) result.attack = 1;
            return result;
          }) };
        }
      }
    };`;
  await evaluate(`(async () => { document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(css)} })); eval(${JSON.stringify(judge)}); eval(${JSON.stringify(stub)}); await eval(${JSON.stringify(content)}); return true; })()`, contextId);
  await waitFor("globalThis.__sent?.flatMap((message) => message.comments).length > 0", contextId, 60);
  await waitFor("document.getElementById('epe-hate-index')", contextId, 30);
  await sleep(5000);

  const report = await evaluate(`(() => {
    const comments = [...document.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer')];
    const sent = globalThis.__sent.flatMap((message) => message.comments);
    const video = globalThis.__sent[0]?.video || {};
    return {
      commentsFound: comments.length,
      commentsWithText: comments.filter((element) => (element.querySelector('#content-text')?.textContent || '').trim()).length,
      expandedReplies: document.querySelectorAll('ytd-comment-replies-renderer ytd-comment-view-model, ytd-comment-replies-renderer ytd-comment-renderer').length,
      repliesWithReplyTo: sent.filter((comment) => comment.reply_to).length,
      titleRead: Boolean(video.title),
      channelRead: Boolean(video.channel),
      badgeAppeared: document.getElementById('epe-hate-index')?.getBoundingClientRect().height > 0,
      dataEpeSet: comments.filter((element) => element.hasAttribute('data-epe')).length,
      heatmapTicks: document.querySelectorAll('#epe-heatmap .epe-heatmap-tick').length,
      heatmapDecisions: Object.fromEntries(['shred', 'blur', 'mark'].map(kind => [kind, document.querySelectorAll('#epe-heatmap .epe-heatmap-tick[data-decision="' + kind + '"]').length]))
    };
  })()`, contextId);
  if (forbidden.length) throw new Error(`TypeSafe API was called: ${forbidden[0]}`);
  if (!report.commentsFound || !report.commentsWithText || !report.expandedReplies || !report.repliesWithReplyTo || !report.titleRead || !report.channelRead || !report.badgeAppeared || !report.dataEpeSet || !report.heatmapTicks)
    throw new Error(JSON.stringify(report));

  await evaluate("document.getElementById('epe-hate-index').scrollIntoView({ block: 'start' }); scrollBy(0, -100); true", contextId);
  await sleep(300);
  mkdirSync(`${ROOT}test/out`, { recursive: true });
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${ROOT}test/out/youtube.png`, Buffer.from(shot.result.data, "base64"));
  await evaluate("document.querySelector('#epe-heatmap .epe-heatmap-tick')?.click(); true", contextId);
  await sleep(900);
  const mapShot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${ROOT}test/out/youtube-heatmap.png`, Buffer.from(mapShot.result.data, "base64"));
  console.log(JSON.stringify(report));
  console.log("OK");
} finally {
  ws?.close();
  browser.kill();
  await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), sleep(2000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
