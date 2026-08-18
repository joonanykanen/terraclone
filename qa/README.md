# qa/ — browser test harnesses

Headless **Firefox Developer Edition** driven via **Marionette** (protocol 3: length-prefixed JSON over raw TCP on port 2828) from **Node 24, zero dependencies**. Requires Firefox at `/Applications/Firefox Developer Edition.app` (path configurable at the top of each script).

| Script | What it does | Run |
|---|---|---|
| `tc_browser_qa.js` | Visual scenario shots (day/night, biomes, torch lighting, boss, inventory, death screen) + checks report (dayF ramp, light gradient, entities, page errors) | `node qa/tc_browser_qa.js` |
| `tc_save_qa.js` | 3-slot save/load suite — 19 checks: menu flow, click + F5 + pause-menu saves, full state restore fidelity, delete, all-slots-full routing | `node qa/tc_save_qa.js` |
| `tc_armor_qa.js` | Worn-armor model — 10 checks: pixel-samples the player sprite with iron/gold/dia helm/chest/legs (full + per-piece sets), face/belt stay visible, jump + walk frames pick up the tint | `node qa/tc_armor_qa.js` |
| `tc_boss_qa.js` | King Slime difficulty — 17 checks: 950 HP / 44 contact dmg, half-armor boss damage, swattable gel spits, landing shockwave, 30% enrage, coin+gel drops, save/load of a live boss, page errors (see flaky note below) | `node qa/tc_boss_qa.js` |
| `tc_readme_shots.js` | Captures the 8 README screenshots into `screenshots/` | `node qa/tc_readme_shots.js` |

All scripts take an optional `index.html` path argument (default: repo root).

**Marionette gotchas** (learned the hard way — keep when extending):
- `executeScript` scripts are **function bodies**: explicit `return` required; result in `body.value`.
- The script sandbox sees `window` properties but **not** top-level `let`/`const` → always go through the `window.TC` debug API.
- `--height=815` yields a ~730px viewport (1:1 1280×720 canvas); `--height=720` letterboxes to 635px.
- Real user gestures don't exist in headless: Web Audio state checks should tolerate a suspended `AudioContext`.

**Known flaky checks** (not regression signals — re-run the suite once before investigating):
- `tc_boss_qa.js`: `player saw gel spits during fight` and `no-armor player is in real danger (min hp < 60 or died)` can fail together (e.g. `min=100 died=false sawProj=false`). The boss only spits while the player is 60–480 px away, but its hops move it 100–170 px each, so in unlucky runs the boss never enters the band during the whole 7.5 s observation window and fires no spits at all (`sawProj=false`). The other ~15 checks are deterministic.
