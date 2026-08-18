# qa/ — browser test harnesses

Headless **Firefox Developer Edition** driven via **Marionette** (protocol 3: length-prefixed JSON over raw TCP on port 2828) from **Node 24, zero dependencies**. Requires Firefox at `/Applications/Firefox Developer Edition.app` (path configurable at the top of each script).

| Script | What it does | Run |
|---|---|---|
| `tc_browser_qa.js` | Visual scenario shots (day/night, biomes, torch lighting, boss, inventory, death screen) + checks report (dayF ramp, light gradient, entities, page errors) | `node qa/tc_browser_qa.js` |
| `tc_save_qa.js` | 3-slot save/load suite — 19 checks: menu flow, click + F5 + pause-menu saves, full state restore fidelity, delete, all-slots-full routing | `node qa/tc_save_qa.js` |
| `tc_readme_shots.js` | Captures the 8 README screenshots into `screenshots/` | `node qa/tc_readme_shots.js` |

All scripts take an optional `index.html` path argument (default: repo root).

**Marionette gotchas** (learned the hard way — keep when extending):
- `executeScript` scripts are **function bodies**: explicit `return` required; result in `body.value`.
- The script sandbox sees `window` properties but **not** top-level `let`/`const` → always go through the `window.TC` debug API.
- `--height=815` yields a ~730px viewport (1:1 1280×720 canvas); `--height=720` letterboxes to 635px.
- Real user gestures don't exist in headless: Web Audio state checks should tolerate a suspended `AudioContext`.
