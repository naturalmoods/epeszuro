// Epeszűrő – kommentenként 6 Jev-kérdés egy hívásban, a döntést (policy) a kód hozza.
// A kérdések szövege angol, mint a Zajszűrőben (a TypeSafe nem ír magyar támogatásról).
// Visszaad: { results: [{ id, threat, dehum, group, vulgar, nick, attack, attackProbs } | { id, error }], tokens }

export const PROMPT_VERSION = "v2";
export const USD_PER_MTOK = 0.042; // docs.typesafe.ai/models, 2026-09

export const ATTACK_LEVELS = [
  "No personal attack. Criticism of someone's actions, statements, honesty or politics, even harsh (e.g. 'he lies', 'disgusting behaviour'), is this level. So is condemning others' insults.",
  "Mockery: a nickname, sarcasm or ridicule aimed at a person (e.g. a mocking name, making fun of how they speak).",
  "Insult: calling a person contemptuous names or demeaning them as a person (e.g. 'insignificant man', 'traitor').",
  "Degrading: vulgar, obscene or dehumanising abuse of a person (e.g. excrement or sexual references, 'vermin').",
];

// A `c` a komment hivatkozása a state-ben, pl. `comments[3]`.
const QUESTIONS = (c) => ({
  t: {
    type: "noul",
    instructions:
      `Does ${c} call for, threaten or approve of physical violence against a person or group (e.g. hanging, lynching, beating, killing; ` +
      "Hungarian: 'fel kell húzni', 'fára vele', 'fel kell akasztani', 'agyon kell verni')? Spelling mistakes and ALL CAPS are common in these comments.",
  },
  // külön kérdés: az erőszakkal összevonva a v1-ben a lincselős komment 0,49-et kapott
  d: {
    type: "noul",
    instructions: `Does ${c} dehumanise a person or group, calling them vermin, parasites, animals or filth (e.g. 'féreg', 'patkány', 'söpredék')?`,
  },
  g: {
    type: "noul",
    instructions:
      `Does ${c} attack a group of people for a protected trait (ethnicity, nationality, religion, sex, sexual orientation, disability)? ` +
      "Attacking a politician or a party's voters for their politics does not count.",
  },
  v: {
    type: "noul",
    instructions:
      `Is ${c} vulgar or obscene, including disguised forms: a person's name twisted into a swear word (e.g. with 'fos', 'szar'), ` +
      "swear words inside compounds, or sexual innuendo without explicit words (e.g. telling someone to put something in their mouth)?",
  },
  n: {
    type: "noul",
    instructions: `Does ${c} refer to a person by a mocking nickname or a contemptuous label instead of their name?`,
  },
  p: {
    type: "score",
    instructions: `How strongly does ${c} personally attack someone? Judge the attack on the person, not the political side.`,
    criteria: ATTACK_LEVELS,
  },
});

// comments: [{ id, text, reply_to?, context? }], video: { title, channel }
export async function judge(comments, video, cfg, signal) {
  const state = {
    video,
    comments: comments.map((c) => ({ text: c.text, ...(c.reply_to ? { reply_to: c.reply_to } : {}), ...(c.context?.length ? { context: c.context.slice(0, 5).map((text) => text.slice(0, 200)) } : {}) })),
  };
  if (state.comments.some((c) => c.context)) state.chat_note = "context holds earlier chat messages, only for interpreting text; judge only text";
  const questions = {};
  comments.forEach((_, i) => {
    for (const [k, q] of Object.entries(QUESTIONS(`\`comments[${i}].text\``))) questions[`${k}${i}`] = q;
  });
  const data = await askJev(state, questions, cfg, signal);
  const a = (data && data.answers) || {};
  const results = comments.map((c, i) => {
    const t = a[`t${i}`], d = a[`d${i}`], g = a[`g${i}`], v = a[`v${i}`], n = a[`n${i}`], p = a[`p${i}`];
    if (![t, d, g, v, n].every((x) => x && typeof x.noul === "number") || !p || typeof p.score !== "number")
      return { id: c.id, error: "hiányzó válasz" };
    return { id: c.id, threat: t.noul, dehum: d.noul, group: g.noul, vulgar: v.noul, nick: n.noul, attack: p.score, attackProbs: p.probabilities || null };
  });
  const tokens = data && data.usage && typeof data.usage.input_tokens === "number" ? data.usage.input_tokens : null;
  return { results, tokens };
}

// Alapbeállítás; a bővítményben csúszkák állítják, újrahívás nélkül.
export const DEFAULTS = { threat: 0.5, dehum: 0.5, group: 0.5, vulgar: 0.5, insult: 1.5, mock: 0.75, nick: 0.6, nickAttack: 0.3 };

// "shred" (iratmegsemmisítő) | "blur" (homályosítás) | "mark" (halvány jelölés) | null
export function action(r, s = DEFAULTS) {
  if (r.error) return null;
  if (r.threat > s.threat || r.dehum > s.dehum || r.group > s.group) return "shred";
  if (r.vulgar > s.vulgar || r.attack > s.insult) return "blur";
  // a gúnynév-kérdés zajos (semleges kommentnél is 0,2–0,5, egy pártnév kisbetűvel akár 0,85), ezért csak enyhe támadással együtt jelöl
  if (r.attack > s.mock || (r.nick > s.nick && r.attack > s.nickAttack)) return "mark";
  return null;
}

// A döntést kiváltó legerősebb jel rövid, megjeleníthető magyar indoka.
export function reason(r, decision) {
  const attack = (from, label) => [
    r.attackProbs && Object.keys(r.attackProbs).length
      ? Object.entries(r.attackProbs).reduce((sum, [level, value]) => sum + (Number(level) >= from ? Number(value) || 0 : 0), 0)
      : r.attack / 3,
    label,
  ];
  const candidates = decision === "shred" ? [
    [r.threat, "Erőszak"], [r.dehum, "Dehumanizálás"], [r.group, "Gyűlöletkeltés"],
  ] : decision === "blur" ? [
    [r.vulgar, "Trágár"], attack(2, "Sértő"),
  ] : [
    attack(1, "Gúny"), [r.nick, "Gúnynév"],
  ];
  const [score, label] = candidates.reduce((best, item) => (Number(item[0]) > Number(best[0]) ? item : best));
  return { label, percent: Math.round(Math.max(0, Math.min(1, Number(score) || 0)) * 100) };
}

export async function askJev(state, questions, cfg, signal) {
  for (let a = 1, delay = 600; ; a++, delay *= 2) {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ state, model: cfg.model || "jev-latest", questions }),
      signal,
    });
    if (res.ok) return res.json();
    if ([429, 500, 502, 503, 529].includes(res.status) && a < 4) {
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : delay));
      continue;
    }
    throw new Error(`HTTP ${res.status}${res.status === 401 ? " – érvénytelen API-kulcs" : ""}: ${(await res.text()).slice(0, 240)}`);
  }
}
