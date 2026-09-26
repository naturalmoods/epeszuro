# Epeszűrő

[Magyar](README.md) · **English**

*Epeszűrő* is Hungarian for "bile filter". It is a Chrome extension that reads YouTube comments and live chat messages with TypeSafe's **Jev** model. Severe hate is removed with a paper-shredder animation, vulgar or insulting text is blurred, and mockery gets a small mark. Any hidden comment can be revealed with a click.

A hate index above the comments shows how many comments were checked and hidden, the toxic share as a green, orange or red percentage pill, and what the filtering on the page has cost so far, in US dollars and Hungarian forints. Everything runs in the browser: Jev calls go straight to the TypeSafe API with your own key, and there is no server in between.

**Note:** the user interface is in Hungarian, and accuracy has only been measured on Hungarian text (see [Measured accuracy](#measured-accuracy)). The Jev questions themselves are in English and nothing restricts the language, so it works on comments in other languages too, but that is unmeasured.

![Epeszűrő at work on a YouTube comment thread: hate index, shredded and blurred comments, heatmap](docs/demo.webp)

*Usernames and avatars are masked in the recording.*

## Installation

1. Download the latest release from the [Releases](https://github.com/naturalmoods/epeszuro/releases/latest) page (`epeszuro-<version>.zip`) and unzip it. Or: `git clone https://github.com/naturalmoods/epeszuro.git`.
2. In Chrome open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the Epeszűrő folder.
4. Open the extension's options (**Details → Extension options**, or the **API-kulcs beállítása** link in the popup).
5. Enter your TypeSafe API key from https://typesafe.ai and click **Mentés** (Save).
6. Open or reload a YouTube video.

The API key is kept in the browser's `chrome.storage.local`. Don't put it in source files, tests or version control.

## What it does on the page

- **Shred:** a comment that calls for violence, dehumanises someone or attacks a protected group falls apart in strips, and a slim bar remains in its place.
- **Blur:** a vulgar, obscene or strongly insulting comment is blurred, with a rubber-stamp label such as "TRÁGÁR · 87%" (vulgar).
- **Mark:** a mocking comment gets an orange left border and a short reason on hover.
- **Reveal:** "megnézem" (show me) on a shredded comment, or a click on a blurred one, shows the original text.
- **Hate index:** at the top of the thread, live counts of checked and hidden comments, the toxic-share pill, and the cost for the current video. The cost resets when you switch videos.
- **Heatmap:** a thin strip on the right edge of the comments shows where the shredded (red), blurred (orange-red) and marked (orange) comments are. Hover shows the reason, a click scrolls there, and a translucent box shows the visible part. Hidden in narrow windows.
- **Live chat:** severe messages collapse into one line without animation. A counter above the chat shows checked and hidden messages, the toxic-share pill and the cost for that chat frame. Readable in light and dark themes, and works in the embedded chat and the pop-out.

The options page has a **USD/HUF** rate (default 320); open pages update the cost display immediately. Clicking the toolbar icon turns filtering on or off. Three sliders set the sensitivity of shredding, blurring and marking; marking and the **Hőtérkép** (heatmap, on by default) can each be turned off. The sliders only move decision thresholds in code, so no comment is sent again.

## How it works

For every comment the extension asks Jev six narrow questions in a single request:

1. Does it call for, threaten or approve of physical violence?
2. Does it dehumanise someone as vermin, an animal, a parasite or filth?
3. Does it attack a group of people for a protected trait?
4. Is it vulgar or obscene, including disguised swearing and sexual innuendo?
5. Does it refer to someone by a mocking nickname or a contemptuous label?
6. How strong is the personal attack: none, mockery, insult or degrading abuse?

Jev returns probabilities and a personal-attack score. The model does not pick the display mode: code in `src/judge.js` decides between shred, blur and mark from those values and the thresholds. For replies, up to 300 characters of the parent comment are sent as context. In live chat, up to five earlier messages (200 characters each) go along as context; only the current message is judged.

Only the video title, channel name, comment or chat message text, the parent text for replies, and earlier message texts in chat are sent to the API. No author names are sent. Results are cached for 48 hours by text, context, model and question version, so the same text in the same context isn't scored twice in that time. Expired entries are pruned when the service worker starts.

## Measured cost and speed

Measurements use two hand-labelled test sets (`test/fixtures/yt-1.json`, `test/fixtures/yt-2.json`). Both are **invented Hungarian text** modelled on real YouTube threads: the same categories, traps and labels, but every name, party and nickname is made up. The first is a political comment thread, the second a friendly, mostly food-related live chat. Saved answers are in `test/out/`. Price: 0.042 USD per million input tokens, 320 HUF/USD.

| Set | Comments processed | Time | Input tokens | Cost |
| --- | ---: | ---: | ---: | ---: |
| `yt-1` | 33 | 604 ms | 19,201 | 0.000806 USD ≈ 0.26 HUF |
| `yt-2` | 70 | 1328 ms | 39,812 | 0.00167 USD ≈ 0.54 HUF |

Four of the 29 comments in the first set also have a party-swapped variant, hence 33. Time depends on the network and service load.

## Measured accuracy

With the current thresholds, on the saved answers of one live run, against the hand labels:

| Set | Exact match | Unjustified hides | Missed severe |
| --- | ---: | ---: | ---: |
| `yt-1` | 26/29 | 0 | 1 |
| `yt-2` | 67/70 | 0 | 0 |

- `yt-1`: the comment calling for a lynching was shredded (violence 0.96). The missed severe one is a sexual innuendo without any swear word; two milder mockeries went unmarked. For one vulgar insult ("szarkeverő", roughly "shit-stirrer") shredding is also accepted, because calling someone filth is dehumanisation by the question's own definition; that second label was added after the measurement.
- `yt-2`: harmless messages containing the word "threat", a band saw and kickboxing all stayed clean. A friendly "why are you bald?" question and "Kopasz" (Baldy) used as a nickname were wrongly marked, and one mocking "ringmaster… his sect" went unmarked.

A separate run on `yt-2` that adds the previous five messages as context (`test/out/yt-2.v2.ctx.json`):

| Context | Exact match | Unjustified hides | Missed severe | Input tokens | Time |
| --- | ---: | ---: | ---: | ---: | ---: |
| None | 67/70 | 0 | 0 | 39,812 | 1328 ms |
| Five earlier messages | 67/70 | 0 | 0 | 49,331 | 702 ms |

Context didn't help on this set and costs 24% more tokens. The extension still sends it in live chat because it may help with short messages that are ambiguous on their own; this is worth re-measuring on a larger set.

In the `yt-1` party-neutrality check, none of the four name swaps changed a decision; the largest raw difference was 0.24.

## Tests

Remove the real key from the environment for every Node command, so tests run on the saved answers:

```bash
env -u TYPESAFE_API_KEY node test/jev.mjs
env -u TYPESAFE_API_KEY node test/jev.mjs test/fixtures/yt-2.json
env -u TYPESAFE_API_KEY node test/page.mjs
env -u TYPESAFE_API_KEY node test/youtube.mjs
env -u TYPESAFE_API_KEY node test/livechat.mjs
```

- `test/jev.mjs`: evaluates the hand-labelled `yt-1` set and prints accuracy, the party-neutrality check, time, tokens and cost.
- `test/jev.mjs test/fixtures/yt-2.json`: the same on the live chat set. With `--context` (and a key) it runs the context measurement and writes the separate `.ctx.json` file.
- `test/page.mjs`: local HTML fixtures for comments and live chat: context order, no author names, emoji-only messages, recycled elements, effects, counter and heatmap.
- `test/youtube.mjs`: on a real YouTube page, expands at least one reply thread, checks today's DOM and parent-text passing, reports heatmap ticks and saves `test/out/youtube-heatmap.png`. Uses simulated scores and never calls the TypeSafe API.
- `test/livechat.mjs`: on a real live chat, checks messages, context, the counter and readability in light and dark themes, with simulated scores; saves `test/out/livechat-light.png` and `test/out/livechat-dark.png`.

If `TYPESAFE_API_KEY` is set, `test/jev.mjs` makes live TypeSafe API calls and overwrites the saved answers. Without it, it re-evaluates the existing answers in `test/out/`. The browser tests need `chromium` installed.

## Files

- `src/content.js`, `src/content.css` – comment detection, reply links, effects, hate index and heatmap
- `src/chat.js`, `src/chat.css` – live chat in the iframe and the pop-out
- `src/background.js` – batching, parallel Jev calls and the 48-hour cache
- `src/judge.js` – the six Jev questions and the decision rules
- `popup.html`, `popup.js` – switches, sensitivity sliders and counters
- `options.html`, `options.js` – API key, model and USD/HUF rate

## Limitations

- Jev often misses vulgarity hidden in wordplay, such as a name twisted into a swear word.
- Mocking nicknames often need more conversation context than a comment and its parent provide.
- Live chat replaces messages quickly: the counter covers messages seen since the extension started, and messages that disappear very fast can be missed. Emoji-only messages are skipped.
- It depends on YouTube's DOM. If the page structure changes, the comment or reply selectors need updating.
- Jev is a probabilistic model, so two live runs on the same set won't necessarily give identical values or decisions.
- TypeSafe doesn't claim Hungarian support (hence the English questions); accuracy on Hungarian, or any other language, needs checking on your own samples. The numbers above come from two threads, 99 comments.

## Privacy

The extension sends the text of YouTube comments and live chat messages written by third parties to TypeSafe for processing, together with the video title, channel name, part of the parent comment for replies, and up to five earlier messages in chat. It sends no author names. Before using it, consider TypeSafe's data processing terms and the fact that the commenters did not give their text to Epeszűrő directly.

## License

MIT License ([LICENSE](LICENSE), [Hungarian translation](LICENSE.hu.md)): free to use, modify and distribute, commercially too. The only condition is that the copyright notice (© Cziczlavicz Péter) stays in the code or documentation. If you use it, we'd be glad to hear about it or to see Epeszűrő mentioned in your project.

**Author:** Cziczlavicz Péter
