"use strict";
/* Save/load (3-slot) QA for index.html, same harness style as tc_browser_qa.js.
   Run: node qa/tc_save_qa.js [path/to/index.html] -> shots in qa/shots/save/.
   Headless Firefox + Marionette (protocol 3, length-prefixed JSON over TCP).
   Tests: title menu, new world, save slots (click + F5 + pause menu), restore fidelity,
   delete, all-slots-full routing, page errors. Screenshots -> qa_shots/save/. */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const FIREFOX = '/Applications/Firefox Developer Edition.app/Contents/MacOS/Firefox';
const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const PORT = 2828;
const PROFILE = '/tmp/tc_ff_profile_' + Date.now();
const OUT = path.join(__dirname, 'shots', 'save');
const url = 'file://' + FILE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  try { execSync('pkill -f "tc_ff_profile" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
  await sleep(500);

  console.log('launching headless firefox...');
  const ff = spawn(FIREFOX, ['--headless', '--marionette', '--width=1280', '--height=815',
    '-profile', PROFILE, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.on('data', () => {});
  let ffLog = '';
  ff.stderr.on('data', d => { ffLog += d.toString(); });

  const start = Date.now();
  let up = false;
  while (Date.now() - start < 45000) {
    try { await new Promise((res, rej) => { const c = net.connect(PORT, '127.0.0.1'); c.on('connect', () => { c.end(); res(); }); c.on('error', rej); }); up = true; break; } catch {}
    await sleep(300);
  }
  if (!up) { console.error('FIREFOX DID NOT START:\n' + ffLog.slice(-2000)); ff.kill('SIGKILL'); process.exit(1); }
  console.log('marionette port up');

  const sock = await new Promise((res, rej) => { const s = net.connect(PORT, '127.0.0.1', () => res(s)); s.on('error', rej); setTimeout(() => rej(new Error('tcp timeout')), 5000); });

  let nextId = 1;
  const pending = new Map();
  let stream = Buffer.alloc(0);

  function handleMsg(msg) {
    if (!Array.isArray(msg)) { console.log('  (info msg:', JSON.stringify(msg).slice(0, 120), ')'); return; }
    const [type, id, err, body] = msg;
    if (type === 1 && pending.has(id)) {
      const { res, rej, name } = pending.get(id); pending.delete(id);
      if (err) {
        const m = (typeof err === 'object' && err) ? (err.message || JSON.stringify(err)) : String(err);
        rej(new Error(`${name}: ${m}`));
      } else res(body);
    }
  }
  sock.on('data', chunk => {
    stream = Buffer.concat([stream, chunk]);
    for (;;) {
      const ci = stream.indexOf(0x3a);
      if (ci < 0) break;
      const len = parseInt(stream.slice(0, ci).toString(), 10);
      if (!Number.isFinite(len) || len < 0) { console.error('bad frame header:', stream.slice(0, ci).toString()); break; }
      if (stream.length < ci + 1 + len) break;
      const json = stream.slice(ci + 1, ci + 1 + len).toString();
      stream = stream.slice(ci + 1 + len);
      try { handleMsg(JSON.parse(json)); } catch (e) { console.error('frame parse error:', e.message, json.slice(0, 100)); }
    }
  });
  sock.on('error', e => console.error('socket error:', e.message));

  function send(name, params) {
    return new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej, name });
      const j = Buffer.from(JSON.stringify([0, id, name, params]));
      sock.write(Buffer.from(j.length + ':' + j));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout: ' + name)); } }, 90000);
    });
  }

  async function exec(script) {
    const body = await send('WebDriver:ExecuteScript', { script, args: [] });
    return body && 'value' in body ? body.value : body;
  }

  async function shot(name) {
    const body = await send('WebDriver:TakeScreenshot', { full: false });
    let b64 = typeof body === 'string' ? body : (body && (body.value || body.data));
    if (typeof b64 !== 'string') throw new Error('screenshot: unexpected body ' + JSON.stringify(body).slice(0, 200));
    if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
    const p = `${OUT}/${name}.png`;
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    console.log('  shot -> ' + p + ' (' + Math.round(fs.statSync(p).size / 1024) + ' KB)');
  }

  const sess = await send('WebDriver:NewSession', { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
  console.log('session ok:', JSON.stringify(sess).slice(0, 140));
  await send('WebDriver:Navigate', { url });

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const v = await exec('return document.readyState==="complete" && !!window.TC;');
      ready = v === true;
      if (ready) break;
    } catch (e) {}
    await sleep(300);
  }
  if (!ready) {
    console.error('GAME DID NOT BOOT. ff log tail:\n' + ffLog.slice(-1500)); ff.kill('SIGKILL'); process.exit(1);
  }
  console.log('game booted (window.TC present)');

  await exec('window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @"+(e.lineno||"?"))});window.addEventListener("unhandledrejection",function(e){window.__errs.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});return true;');
  // input helpers: click in canvas coords (1280x720 space), dispatch real key events
  await exec('window.__click=function(cx,cy,button){var c=document.getElementById("game");var r=c.getBoundingClientRect();var sx=1280/r.width,sy=720/r.height;c.dispatchEvent(new MouseEvent("mousedown",{button:button||0,clientX:r.left+cx/sx,clientY:r.top+cy/sy,bubbles:true,cancelable:true}));return true;};window.__key=function(code){window.dispatchEvent(new KeyboardEvent("keydown",{code:code}));return true;};return true;');
  // canvas-space button centers (deterministic layout)
  const BTN = {
    titleNew: [640, 334], titleLoad: [640, 398],
    cardPlay: i => [725, 195 + i * 140], cardDel: i => [817, 195 + i * 140], cardNew: i => [640, 195 + i * 140],
    back: [640, 555],
    pauseResume: [640, 292], pauseSave: [640, 348], pauseSlot: i => [520 + i * 81.33 + 38.67, 404], pauseMenu: [640, 464],
  };

  const results = [];
  let pass = 0, fail = 0;
  function check(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  [' + extra + ']' : '')); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
  }
  async function step(name, js, wait) {
    let res;
    try { res = await exec(js); } catch (e) { res = 'SETUP_ERROR: ' + e.message; }
    if (wait) await sleep(wait);
    results.push(name + ': ' + JSON.stringify(res));
    return res;
  }
  async function clickAt(name, b) {
    console.log('  click ' + name + ' @' + b[0] + ',' + b[1]);
    await exec('return __click(' + b[0] + ',' + b[1] + ');');
    await sleep(250);
  }

  /* ---- 1. title screen ---- */
  await sleep(800);
  await shot('01_title');
  check('starts at title', await exec('return TC.menuState;') === 'title');

  /* ---- 2. New World from title -> playing ---- */
  await clickAt('title:New World', BTN.titleNew);
  check('new world -> playing', await exec('return TC.menuState;') === 'playing');
  await step('worldA_spawn', 'return "seed="+TC.SEED+" spawnCol="+TC.spawnCol;', 2500);
  await shot('02_worldA_day');

  /* ---- 3. mutate world A, save to slot 0, snapshot ---- */
  await step('mutate_A', 'return (function(){' +
    'TC.entities.forEach(function(e){if(e.type!=="king")e.dead=true;}); /* remove random spawns (no drops) */' +
    'var p=TC.player,x=TC.spawnCol,s=TC.surf[x];' +
    'TC.setTile(x+2,s-1,11);          /* torch */' +
    'TC.setTile(x+4,s,0);             /* dig a floor tile */' +
    'TC.setTile(x-3,s+2,9);           /* diamond block */' +
    'TC.addItem("gel",5);TC.addItem("iron_bar",7);' +
    'p.hp=57;TC.setSelected(3);TC.setGameTime(300*0.3);' +
    'TC.spawnBoss();' +
    'var e=TC.makeEntity("slime",p.x+120,p.y-40);TC.killEntity(e); /* gel drop */' +
    'return "ok";})();', 700);
  await step('freeze_A', 'TC.entities.forEach(function(e){e.vx=0;e.vy=0;e.t=1.5;});return TC.entities.length+" ents";', 100);
  // save + snapshot in ONE exec so there is zero skew between saved state and snapshot
  await step('save_snapshot_A', 'TC.saveSlot(0);window.__snap={seed:TC.SEED,gt:TC.gameTime,world:Array.from(TC.world),biome:Array.from(TC.biome),surf:Array.from(TC.surf),px:TC.player.x,py:TC.player.y,hp:TC.player.hp,face:TC.player.face,inv:JSON.parse(JSON.stringify(TC.inv)),sel:TC.selected,ents:TC.entities.map(function(e){return [e.type,e.x,e.y,e.hp,e.small?1:0];}),drops:TC.drops.map(function(d){return [d.x,d.y,d.item,d.count];}),spx:TC.spawnX,spy:TC.spawnY,spc:TC.spawnCol};return "saved "+TC.drops.length+" drops, "+TC.entities.length+" ents, hp="+TC.player.hp;', 100);
  check('save slot 0', await exec('return !!TC.getSaveSlots()[0];') === true);
  await shot('03_worldA_saved');
  await step('newWorld_B', 'return TC.startNewWorld(1)||"ok";', 1500);
  check('world B playing, new seed', await exec('return TC.menuState==="playing" && TC.SEED!==window.__snap.seed;'));
  await shot('04_worldB');
  await exec('return __key("Escape");'); await sleep(300);
  check('Esc -> paused', await exec('return TC.menuState;') === 'paused');
  await shot('05_pause_menu');
  await clickAt('pause:Save Game (F5)', BTN.pauseSave);
  check('pause F5 saved to slot 1 (selected)', await exec('var s=TC.getSaveSlots();return s[1] && s[1].seed===TC.SEED;'));
  await clickAt('pause:Slot 2 button', BTN.pauseSlot(1));
  check('pause slot-2 click saved', await exec('var s=TC.getSaveSlots();return s[1] && s[1].seed===TC.SEED && s[0] && s[0].seed===window.__snap.seed;'));
  await clickAt('pause:Main Menu', BTN.pauseMenu);
  check('main menu -> title', await exec('return TC.menuState;') === 'title');

  /* ---- 5. save select screen ---- */
  await clickAt('title:Load World', BTN.titleLoad);
  check('load world -> saveSelect', await exec('return TC.menuState;') === 'saveSelect');
  await sleep(300);
  await shot('06_save_select');
  check('slot states (filled, filled, empty)', await exec('var s=TC.getSaveSlots();return !!s[0] && !!s[1] && !s[2];'));

  /* ---- 6. Play slot 0 -> restore world A ---- */
  await clickAt('slot0:Play', BTN.cardPlay(0));
  check('play slot0 -> playing', await exec('return TC.menuState;') === 'playing');
  await sleep(200);
  const restore = await step('restore_check', 'return (function(){var s=window.__snap,out=[];var w=TC.world,diff=0;for(var i=0;i<w.length&&diff<=3;i++){if(w[i]!==s.world[i])diff++;}out.push("world:"+(diff===0)+"/"+diff);out.push("seed:"+(TC.SEED===s.seed));out.push("biome:"+(Array.prototype.join.call(TC.biome,",")===s.biome.join(",")));out.push("surf:"+(Array.prototype.join.call(TC.surf,",")===s.surf.join(",")));var p=TC.player;out.push("px:"+(Math.abs(p.x-s.px)<1)+" py:"+(Math.abs(p.y-s.py)<1)+" hp:"+(p.hp===s.hp)+" face:"+(p.face===s.face));out.push("inv:"+(JSON.stringify(TC.inv)===JSON.stringify(s.inv)));out.push("sel:"+(TC.selected===s.sel));out.push("spawn:"+(TC.spawnX===s.spx&&TC.spawnY===s.spy&&TC.spawnCol===s.spc));out.push("gt:"+(Math.abs(TC.gameTime-s.gt)<1.5));var es=TC.entities,eo=s.ents,ok=es.length===eo.length;for(var i=0;ok&&i<es.length;i++){var a=es[i],b=eo[i];ok=(a.type===b[0]&&Math.abs(a.x-b[1])<30&&Math.abs(a.y-b[2])<30&&Math.abs(a.hp-b[3])<=2&&(a.small?1:0)===b[4]);}out.push("ents:"+ok+"("+es.length+"vs"+eo.length+")");var ds=TC.drops,dd=s.drops,okd=ds.length===dd.length;for(var j=0;okd&&j<ds.length;j++){var c=ds[j],e=dd[j];okd=(c.item===e[2]&&c.count===e[3]&&Math.hypot(c.x-e[0],c.y-e[1])<25);}out.push("drops:"+okd+"("+ds.length+"vs"+dd.length+")");return out.join(" ");})();', 100);
  console.log('  restore detail: ' + restore);
  check('full restore of world A', String(restore).indexOf('world:')===0 && String(restore).indexOf('false')<0, restore);
  await shot('07_worldA_loaded');

  /* ---- 7. F5 quick save (real key event) ---- */
  const lpBefore = await exec('return TC.getSaveSlots()[0].lastPlayed;');
  await exec('return __key("F5");'); await sleep(200);
  const lpAfter = await exec('return TC.getSaveSlots()[0].lastPlayed;');
  check('F5 quick-saves to selected slot 0', lpAfter > lpBefore, lpBefore + ' -> ' + lpAfter);

  /* ---- 8. Esc pause/resume ---- */
  await exec('return __key("Escape");'); await sleep(200);
  check('Esc pauses', await exec('return TC.menuState;') === 'paused');
  await exec('return __key("Escape");'); await sleep(200);
  check('Esc resumes', await exec('return TC.menuState;') === 'playing');

  /* ---- 9. delete slot 1, new world from empty slot 2 ---- */
  await exec('return __key("Escape");'); await sleep(200);
  await clickAt('pause:Main Menu', BTN.pauseMenu);
  await clickAt('title:Load World', BTN.titleLoad);
  await sleep(300);
  await clickAt('slot1:Delete', BTN.cardDel(1));
  check('slot 1 deleted', await exec('var s=TC.getSaveSlots();return !s[1] && !!s[0] && !s[2];'));
  await clickAt('slot2:New World', BTN.cardNew(2));
  check('new world from empty slot 2', await exec('return TC.menuState;') === 'playing');
  await step('worldC', 'return "seed="+TC.SEED+" slot="+(function(){try{return 2}catch(e){return "?"}})();', 1000);
  await shot('08_worldC');

  /* ---- 10. all slots full -> New World routes to save select ---- */
  await step('fill_slots', 'return TC.saveSlot(2) && TC.saveSlot(1) && TC.saveSlot(0);', 200);
  check('all 3 slots filled', await exec('var s=TC.getSaveSlots();return !!s[0]&&!!s[1]&&!!s[2];'));
  await exec('return __key("Escape");'); await sleep(200);
  await clickAt('pause:Main Menu', BTN.pauseMenu);
  await clickAt('title:New World (all full)', BTN.titleNew);
  check('all-full New World -> saveSelect', await exec('return TC.menuState;') === 'saveSelect');
  await sleep(300);
  await shot('09_save_select_full');

  /* ---- final checks ---- */
  const checks = {};
  checks.pageErrors = await exec('return JSON.stringify(window.__errs||[]);');
  checks.slotSummary = await exec('return TC.getSaveSlots().map(function(s){return s?("day"+s.day+"/"+(s.night?"N":"D")+"/hp"+s.hp+"/"+Math.round((s.data.length/1024))+"KB"):"empty";}).join(" | ");');
  checks.storageBytes = await exec('return (localStorage.getItem("terraria_clone_saves_v2")||"").length;');
  checks.currentWorld = await exec('return "seed="+TC.SEED+" menu="+TC.menuState;');

  console.log('\n=== CHECKS ===');
  for (const [k, v] of Object.entries(checks)) console.log(k + ': ' + v);
  console.log('\n=== STEP LOG ===');
  results.forEach(r => console.log(r));
  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');

  try { send('WebDriver:DeleteSession', {}); } catch {}
  sock.destroy();
  ff.kill('SIGTERM');
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(fail > 0 ? 1 : 0); }, 1500);
})().catch(e => { console.error('DRIVER FAILED:', e.message || e); try { sock.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 1000); });
