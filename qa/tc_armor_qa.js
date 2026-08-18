"use strict";
/* Worn-armor model QA for index.html: equip iron/gold/dia helm+chest+legs in the
   armor slots (inv[50..52]), sample canvas pixels on the player sprite, and verify
   the character is tinted with the material (crown/shoulders bright, body main,
   rims/sleeves/boots dark) while face, belt and (unequipped) pieces keep base colors.
   Also checks jump + walk frames pick up the recolor.
   Run: node qa/tc_armor_qa.js [path/to/index.html] -> shots in qa/shots/.
   Protocol: headless Firefox + Marionette (length-prefixed JSON over TCP 2828),
   Node 24, zero dependencies. See tc_browser_qa.js for the full write-up. */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const FIREFOX = '/Applications/Firefox Developer Edition.app/Contents/MacOS/Firefox';
const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const PORT = 2828;
const PROFILE = '/tmp/tc_ff_profile_' + Date.now();
const OUT = path.join(__dirname, 'shots');
const url = 'file://' + FILE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// expected colors [r,g,b]
const BASE = {
  hair: [122, 74, 34], skin: [232, 180, 140], eye: [26, 26, 34], shirt: [58, 104, 200],
  belt: [38, 38, 48], pants: [70, 70, 88], boots: [58, 42, 28],
};
// [main, dark, bright]
const MAT = {
  iron: [[201, 206, 214], [141, 147, 156], [232, 236, 242]],
  gold: [[242, 210, 60], [195, 154, 24], [255, 233, 122]],
  dia: [[92, 232, 240], [42, 160, 174], [194, 248, 252]],
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  try { execSync('pkill -f "Firefox.*--marionette" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
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
    if (!Array.isArray(msg)) return;
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
      if (!Number.isFinite(len) || len < 0) break;
      if (stream.length < ci + 1 + len) break;
      const json = stream.slice(ci + 1, ci + 1 + len).toString();
      stream = stream.slice(ci + 1 + len);
      try { handleMsg(JSON.parse(json)); } catch (e) { console.error('frame parse error:', e.message); }
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

  // script must be a function body with explicit return; result in body.value
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
  if (!ready) { console.error('GAME DID NOT BOOT. ff log tail:\n' + ffLog.slice(-1500)); ff.kill('SIGKILL'); process.exit(1); }
  console.log('game booted (window.TC present)');

  await exec('window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @"+(e.lineno||"?"))});return true;');

  // fresh world at noon (dayF=1 -> no light tint on pixels), player idle & right-facing
  await exec('TC.startNewWorld(0);TC.setGameTime(300*0.2);var p=TC.player;p.vx=0;p.vy=0;p.face=1;p.inv=0;return "ok";');
  await sleep(1200);
  await waitCam();

  // sample sprite pixels at fixed offsets from the player's top-left screen corner
  const SAMPLE = `return (function(){
    var p=TC.player,c=document.getElementById('game'),g=c.getContext('2d');
    var x=Math.floor(p.x-TC.camX),y=Math.floor(p.y-TC.camY);
    function px(dx,dy){var d=g.getImageData(x+dx,y+dy,1,1).data;return [d[0],d[1],d[2]];}
    var settled=Math.abs(TC.camX-(p.x-634))<0.004&&Math.abs(TC.camY-(p.y-368))<0.004;
    return {x:x,y:y,face:p.face,onGround:p.onGround,dead:p.dead,settled:settled,light:TC.lightAt(p.x+6,p.y+12),
      crown:px(4,0),dome:px(4,2),rim:px(3,3),faceSkin:px(4,4),eye:px(4,5),
      shoulder:px(5,8),chest:px(5,10),sleeve:px(1,10),hand:px(1,11),hem:px(5,12),
      belt:px(5,13),pants:px(4,15),boot:px(4,22)};
  })();`;

  // camera lerps (0.12/frame) toward the player center - wait until it has settled
  // to sub-pixel so the sprite's screen position is stable between read and render
  async function waitCam() {
    for (let i = 0; i < 80; i++) {
      const ok = await exec('var p=TC.player;return Math.abs(TC.camX-(p.x-634))<0.004&&Math.abs(TC.camY-(p.y-368))<0.004;');
      if (ok === true) return;
      await sleep(50);
    }
  }

  const eq = (helm, chest, legs) => `
    TC.inv[50]=${helm ? `{id:'armor_${helm}_helm',count:1}` : 'null'};
    TC.inv[51]=${chest ? `{id:'armor_${chest}_chest',count:1}` : 'null'};
    TC.inv[52]=${legs ? `{id:'armor_${legs}_legs',count:1}` : 'null'};
    var p=TC.player;p.vx=0;p.inv=0;p.face=1;return "ok";`;

  const rgb = a => `(${a[0]},${a[1]},${a[2]})`;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

  // probe name -> expected color, per scenario
  function expectBaseline() {
    return {
      crown: BASE.hair, dome: BASE.hair, rim: BASE.hair,
      faceSkin: BASE.skin, eye: BASE.eye,
      shoulder: BASE.shirt, chest: BASE.shirt, sleeve: BASE.skin, hand: BASE.skin, hem: BASE.shirt,
      belt: BASE.belt, pants: BASE.pants, boot: BASE.boots,
    };
  }
  function expectFull(m) {
    const [main, dark, bright] = MAT[m];
    const e = expectBaseline();
    return Object.assign(e, {
      crown: bright, dome: main, rim: dark,
      shoulder: bright, chest: main, sleeve: dark, hem: dark,
      pants: main, boot: dark,
    });
  }
  function expectPart(m, part) {
    const [main, dark, bright] = MAT[m];
    const e = expectBaseline();
    if (part === 'helm') Object.assign(e, { crown: bright, dome: main, rim: dark });
    if (part === 'chest') Object.assign(e, { shoulder: bright, chest: main, sleeve: dark, hem: dark });
    if (part === 'legs') Object.assign(e, { pants: main, boot: dark });
    return e;
  }

  let pass = 0, fail = 0;
  const failures = [];
  async function scenario(name, setupJS, expected) {
    await exec(setupJS);
    await sleep(150); // >=1 rAF so buildPlayerSprites() has rebuilt & rendered
    await waitCam();
    const s = await exec(SAMPLE);
    let bad = [];
    if (s.dead || !s.onGround || s.face !== 1 || s.light < 0.99)
      bad.push(`state off: dead=${s.dead} onGround=${s.onGround} face=${s.face} light=${s.light} at (${s.x},${s.y})`);
    if (!s.settled) bad.push('camera not settled');
    for (const k of Object.keys(expected)) {
      if (!same(s[k], expected[k])) bad.push(`${k}=(${s[k].join(',')}) want ${rgb(expected[k])}`);
    }
    if (bad.length) { fail++; failures.push(name + ': ' + bad.join('; ')); console.log('FAIL ' + name); bad.forEach(b => console.log('     ' + b)); }
    else { pass++; console.log('PASS ' + name); }
    await shot('armor_' + name);
  }

  console.log('\n=== armor model checks ===');
  await scenario('none', eq(null, null, null), expectBaseline());
  await scenario('iron_full', eq('iron', 'iron', 'iron'), expectFull('iron'));
  await scenario('gold_full', eq('gold', 'gold', 'gold'), expectFull('gold'));
  await scenario('dia_full', eq('dia', 'dia', 'dia'), expectFull('dia'));
  await scenario('iron_helm_only', eq('iron', null, null), expectPart('iron', 'helm'));
  await scenario('gold_chest_only', eq(null, 'gold', null), expectPart('gold', 'chest'));
  await scenario('dia_legs_only', eq(null, null, 'dia'), expectPart('dia', 'legs'));
  await scenario('none_again', eq(null, null, null), expectBaseline());

  // jump frame: airborne, all-walk-safe probe (4,15) must still carry the material
  console.log('\n=== jump frame ===');
  await exec(eq('gold', 'gold', 'gold'));
  await sleep(100);
  let jumpOk = false, jumpInfo = '';
  for (let i = 0; i < 30 && !jumpOk; i++) {
    const r = await exec(`var p=TC.player;if(p.onGround)p.vy=-8;
      var c=document.getElementById('game'),g=c.getContext('2d');
      var x=Math.floor(p.x-TC.camX),y=Math.floor(p.y-TC.camY);
      var d=g.getImageData(x+4,y+15,1,1).data;
      return {air:!p.onGround,px:[d[0],d[1],d[2]]};`);
    if (r.air && same(r.px, MAT.gold[0])) jumpOk = true;
    jumpInfo = `air=${r.air} px=(${r.px.join(',')})`;
    await sleep(40);
  }
  if (jumpOk) { pass++; console.log('PASS jump_frame_gold ' + jumpInfo); }
  else { fail++; failures.push('jump_frame_gold: never saw airborne+gold at (4,15) | last ' + jumpInfo); console.log('FAIL jump_frame_gold | last ' + jumpInfo); }
  await shot('armor_jump_gold');

  // walk frame: give it velocity; while |vx|>0.4 the frame is walkX and probe (4,15)
  // (pants pixel present in every walk frame) must carry the material
  console.log('\n=== walk frame ===');
  await exec(`var p=TC.player;p.vx=3;p.vy=0;p.face=1;return "ok";`);
  let walkOk = false, walkInfo = '';
  for (let i = 0; i < 40 && !walkOk; i++) {
    const r = await exec(`var p=TC.player;if(p.onGround)p.vx=3;
      var c=document.getElementById('game'),g=c.getContext('2d');
      var x=Math.floor(p.x-TC.camX),y=Math.floor(p.y-TC.camY);
      var d=g.getImageData(x+4,y+15,1,1).data;
      return {vx:p.vx,px:[d[0],d[1],d[2]]};`);
    if (Math.abs(r.vx) > 0.4 && same(r.px, MAT.gold[0])) walkOk = true;
    walkInfo = `vx=${r.vx.toFixed(2)} px=(${r.px.join(',')})`;
    await sleep(40);
  }
  if (walkOk) { pass++; console.log('PASS walk_frame_gold ' + walkInfo); }
  else { fail++; failures.push('walk_frame_gold: never saw moving+gold at (4,15) | last ' + walkInfo); console.log('FAIL walk_frame_gold | last ' + walkInfo); }
  await shot('armor_walk_gold');

  // inventory UI with a full gold set (eyeball item icons + armor slots)
  await exec(`var p=TC.player;p.vx=0;p.inv=0;p.face=1;TC.setUI(true);return "ok";`);
  await sleep(400);
  await shot('armor_ui_gold');

  const pageErrors = await exec('return JSON.stringify(window.__errs||[]);');
  console.log('\npageErrors: ' + pageErrors);
  if (pageErrors !== '[]') { fail++; failures.push('pageErrors: ' + pageErrors); }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (failures.length) failures.forEach(f => console.log('  - ' + f));

  try { send('WebDriver:DeleteSession', {}); } catch {}
  sock.destroy();
  ff.kill('SIGTERM');
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(fail > 0 ? 1 : 0); }, 1500);
})().catch(e => { console.error('DRIVER FAILED:', e.message || e); try { sock.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 1000); });
