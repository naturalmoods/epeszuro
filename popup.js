import { DEFAULTS } from "./src/judge.js";

const labels = ["enyhe", "közepes", "szigorú"];
const presets = {
  shred: [
    { threat: .9, dehum: .9, group: .9 },
    { threat: .5, dehum: .5, group: .5 },
    { threat: .2, dehum: .2, group: .2 },
  ],
  blur: [
    { vulgar: .9, insult: 2.5 },
    { vulgar: .5, insult: 1.5 },
    { vulgar: .2, insult: 1 },
  ],
  mock: [{ mock: 1.5 }, { mock: .75 }, { mock: .5 }],
};
const keys = [...Object.keys(DEFAULTS), "enabled", "markEnabled", "heatmapEnabled"];
const elements = Object.fromEntries(["enabled", "enabledText", "shred", "blur", "mock", "markEnabled", "heatmapEnabled", "counts"].map((id) => [id, document.getElementById(id)]));
let settings = { ...DEFAULTS, enabled: true, markEnabled: true, heatmapEnabled: true, ...(await chrome.storage.local.get(keys)) };

const nearest = (values, current) => values.reduce((best, value, index) =>
  Math.abs(Object.values(value)[0] - current) < Math.abs(Object.values(values[best])[0] - current) ? index : best, 0);

function render() {
  elements.enabled.checked = settings.enabled !== false;
  elements.enabledText.textContent = elements.enabled.checked ? "Bekapcsolva" : "Kikapcsolva";
  elements.markEnabled.checked = settings.markEnabled !== false;
  elements.heatmapEnabled.checked = settings.heatmapEnabled !== false;
  for (const id of ["shred", "blur", "mock"]) {
    elements[id].value = nearest(presets[id], settings[Object.keys(presets[id][0])[0]]);
    document.querySelector(`output[for="${id}"]`).textContent = labels[elements[id].value];
    elements[id].disabled = id === "mock" && !elements.markEnabled.checked;
  }
}

async function save(values) {
  Object.assign(settings, values);
  await chrome.storage.local.set(values);
  render();
}

elements.enabled.addEventListener("change", () => save({ enabled: elements.enabled.checked }));
elements.markEnabled.addEventListener("change", () => save({ markEnabled: elements.markEnabled.checked }));
elements.heatmapEnabled.addEventListener("change", () => save({ heatmapEnabled: elements.heatmapEnabled.checked }));
for (const id of ["shred", "blur", "mock"]) elements[id].addEventListener("input", () => save(presets[id][Number(elements[id].value)]));
document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(keys);
  settings = { ...DEFAULTS, enabled: true, markEnabled: true, heatmapEnabled: true };
  render();
});
render();

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const counts = await chrome.tabs.sendMessage(tab.id, { type: "counts" });
  elements.counts.textContent = `${counts.comments} hozzászólás · ${counts.shred + counts.blur} elrejtve · ${counts.mark} jelölve`;
} catch {
  elements.counts.remove();
}
