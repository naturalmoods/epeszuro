import { DEFAULTS } from "./src/settings.js";

const apiKey = document.getElementById("apiKey");
const model = document.getElementById("model");
const usdHuf = document.getElementById("usdHuf");
const msg = document.getElementById("msg");

const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
apiKey.value = settings.apiKey;
model.value = settings.model;
usdHuf.value = settings.usdHuf;

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: apiKey.value.trim(),
    model: model.value.trim() || DEFAULTS.model,
    usdHuf: Number(usdHuf.value) > 0 ? Number(usdHuf.value) : DEFAULTS.usdHuf,
  });
  const missing = !apiKey.value.trim();
  msg.textContent = missing ? "Mentve, de API-kulcs nélkül a szűrés nem működik." : "Mentve.";
  msg.className = missing ? "err" : "ok";
});
