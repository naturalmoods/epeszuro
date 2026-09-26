import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const url = process.argv[2] || "https://www.youtube.com/live_chat?v=rFZHOHl-L8A";
const content = readFileSync(`${ROOT}src/chat.js`, "utf8").replace(
  'const { action, reason, DEFAULTS, USD_PER_MTOK } = await import(chrome.runtime.getURL("src/judge.js"));',
  "const { action, reason, DEFAULTS, USD_PER_MTOK } = globalThis.__judge;",
);
const css = readFileSync(`${ROOT}src/chat.css`, "utf8");
const judge = readFileSync(`${ROOT}src/judge.js`, "utf8").replaceAll("export ", "") + "\nglobalThis.__judge = { action, reason, DEFAULTS, USD_PER_MTOK };";
const profile = mkdtempSync(join(tmpdir(), "epeszuro-livechat-"));
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const debugPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const browser = spawn("chromium", ["--headless=new", "--no-sandbox", "--disable-blink-features=AutomationControlled", "--window-size=900,950", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
  const pending = new Map(), forbidden = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent" && message.params.request.url.includes("api.typesafe.ai")) forbidden.push(message.params.request.url);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
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
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36" });
  await call("Network.setCookie", { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/", secure: true });
  await call("Page.navigate", { url });
  for (let i = 0; i < 120; i++) {
    if (await evaluate("document.readyState === 'complete'")) break;
    await sleep(500);
  }
  const consentClicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => /reject|accept|elutas|elfogad/i.test(item.innerText));
    if (button) { button.click(); return true; }
    return false;
  })()`);
  if (consentClicked) await sleep(2500);
  if ((await evaluate("location.hostname")) !== "www.youtube.com") throw new Error(`Unexpected page: ${await evaluate("location.href")}`);
  const frameId = (await call("Page.getFrameTree")).result.frameTree.frame.id;
  const contextId = (await call("Page.createIsolatedWorld", { frameId, worldName: "epeszuro-livechat-test" })).result.executionContextId;
  const stub = `globalThis.__sent = [];
    globalThis.chrome = {
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
      runtime: {
        getURL: () => '',
        sendMessage: async (message) => {
          globalThis.__sent.push(JSON.parse(JSON.stringify(message)));
          return { results: message.comments.map((comment, index) => ({ id: comment.id, threat: index % 7 === 0 ? .82 : .08, dehum: .08, group: .08, vulgar: .08, nick: .08, attack: .08, attackProbs: null })) };
        }
      }
    };`;
  await evaluate(`(async () => { document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(css)} })); eval(${JSON.stringify(judge)}); eval(${JSON.stringify(stub)}); await eval(${JSON.stringify(content)}); return true; })()`, contextId);
  await sleep(20000);
  const themes = {};
  mkdirSync(`${ROOT}test/out`, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await evaluate(`document.documentElement.toggleAttribute('dark', ${theme === "dark"}); true`, contextId);
    await sleep(700);
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${ROOT}test/out/livechat-${theme}.png`, Buffer.from(shot.result.data, "base64"));
    if (theme === "light") writeFileSync(`${ROOT}test/out/livechat.png`, Buffer.from(shot.result.data, "base64"));
    themes[theme] = await evaluate(`(() => {
      const sample = (selector) => {
        const element = [...document.querySelectorAll(selector)].find(e => { const r = e.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight; }) || document.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return { color: style.color, background: style.backgroundColor, width: rect.width, height: rect.height, parent: element.parentElement?.tagName, visible: rect.bottom > 0 && rect.top < innerHeight };
      };
      return { dark: document.documentElement.hasAttribute('dark'), message: sample('yt-live-chat-text-message-renderer #message'), bar: sample('.epe-chat-ui'), counter: sample('#epe-chat-count'), header: sample('yt-live-chat-header-renderer'), chatMessages: sample('#chat-messages'), list: sample('yt-live-chat-item-list-renderer'), vars: getComputedStyle(document.documentElement).getPropertyValue('--yt-live-chat-primary-text-color'), bgVar: getComputedStyle(document.documentElement).getPropertyValue('--yt-live-chat-background-color'), body: sample('body'), banner: sample('yt-live-chat-banner-renderer'), bannerMessage: sample('yt-live-chat-banner-renderer #message') };
    })()`, contextId);
  }
  for (const [theme, info] of Object.entries(themes)) {
    if (!info.message?.width || info.message.color === info.header.background ||
        !info.bar?.width || !info.bar.height || info.bar.color === info.bar.background ||
        !info.bar.visible || !info.counter?.width || !info.counter.height || !info.counter.visible || info.counter.color === info.counter.background ||
        (info.bannerMessage && info.bannerMessage.color === info.banner.background))
      throw new Error(`Unreadable ${theme} chat UI: ${JSON.stringify(info)}`);
  }
  const report = await evaluate(`(() => {
    const sent = globalThis.__sent.flatMap(m => m.comments);
    return {
      messagesFound: document.querySelectorAll('yt-live-chat-text-message-renderer').length,
      messagesSent: sent.length,
      withContext: sent.filter(m => m.context?.length).length,
      counterShown: Boolean(document.querySelector('#epe-chat-count')?.getBoundingClientRect().height),
      counter: document.querySelector('#epe-chat-count')?.textContent || '',
      effects: document.querySelectorAll('[data-epe-chat]').length
    };
  })()`, contextId);
  if (forbidden.length) throw new Error(`TypeSafe API was called: ${forbidden[0]}`);
  if (!report.messagesFound || !report.messagesSent || !report.withContext || !report.counterShown || !report.effects) throw new Error(JSON.stringify(report));
  await evaluate("document.querySelector('#epe-chat-count')?.scrollIntoView(); true", contextId);
  await sleep(300);
  console.log(JSON.stringify(report));
  console.log("OK");
} finally {
  ws?.close();
  browser.kill();
  await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), sleep(2000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
