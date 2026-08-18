"use strict";
/* Real-browser visual QA for index.html using headless Firefox + Marionette.
   Run: node qa/tc_browser_qa.js [path/to/index.html] -> shots in qa/shots/.
   Protocol (Firefox 153, marionetteProtocol 3): length-prefixed JSON over raw TCP.
     Command:  [0, id, name, paramsObj]
     Response: [1, id, errorObjOrNull, body]
   executeScript: params {script, args}, body {value}. Script is a function BODY:
     - must use explicit `return`
     - runs in a sandbox whose global prototype is the page window:
       window properties (window.TC) resolve as bare identifiers, but top-level
       let/const (gameTime, biome, ...) do NOT. Use the window.TC debug API.
   Node 24, no dependencies. */
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
    if (!Array.isArray(msg)) { console.log('  (info msg:', JSON.stringify(msg).slice(0, 120), ')'); return; }
    const [type, id, err, body] = msg;
    if (type === 1 && pending.has(id)) {
      const { res, rej, name } = pending.get(id); pending.delete(id);
      if (err) {
        const m = (typeof err === 'object' && err) ? (err.message || JSON.stringify(err)) : String(err);
        const st = (body && body.stacktrace) ? ' | ' + String(body.stacktrace).split('\n').slice(0, 2).join(' ') : '';
        rej(new Error(`${name}: ${m}${st}`));
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
      if (i < 3) console.log('boot poll ' + i + ': ' + JSON.stringify(v));
      ready = v === true;
      if (ready) break;
    } catch (e) { if (i < 3) console.log('boot poll ' + i + ' ERR: ' + e.message); }
    await sleep(300);
  }
  if (!ready) {
    try { console.log('final state:', JSON.stringify(await exec('return {rs:document.readyState,tc:!!window.TC,href:location.href.slice(0,70),title:document.title};'))); } catch (e) { console.log('final state ERR:', e.message); }
    console.error('GAME DID NOT BOOT. ff log tail:\n' + ffLog.slice(-1500)); ff.kill('SIGKILL'); process.exit(1);
  }
  console.log('game booted (window.TC present)');

  await exec('window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @"+(e.lineno||"?"))});window.addEventListener("unhandledrejection",function(e){window.__errs.push("rejection: "+((e.reason&&e.reason.message)||e.reason))});return true;');

  // The game boots to the title screen now — start a world so the gameplay scenarios run
  await exec('TC.startNewWorld(0);return "ok";');
  await sleep(1000);

  const scenarios = [
    ['01_spawn_day', 'return "ok";', 2000],
    ['02_noon', 'TC.setGameTime(300*0.20);return "ok";', 1000],
    ['03_sunset', 'TC.setGameTime(300*0.50);return "ok";', 1000],
    ['04_night', 'TC.setGameTime(300*0.75);return "ok";', 3500],
    ['05_snow_biome', 'return (function(){function clear(x0,x1){for(var c=x0;c<=x1;c++){if(c<0||c>=400)continue;for(var r=TC.surf[c]-9;r<TC.surf[c];r++){var v=TC.world[r*400+c];if(v===5||v===6)return false;}}return true;}var x=-1,fb=-1;for(var i=0;i<400;i++){if(TC.biome[i]!==2)continue;if(clear(i-2,i+2)){x=i;break;}if(fb<0&&clear(i-1,i))fb=i;}if(x<0)x=fb;if(x<0)return "NO_SNOW";TC.setGameTime(300*0.25);var p=TC.player;p.x=x*16-6;p.y=TC.surf[x]*16-25;p.vy=0;p.vx=0;p.apex=p.y;p.hp=100;return "col"+x;})();', 3500],
    ['06_desert_biome', 'return (function(){function clear(x0,x1){for(var c=x0;c<=x1;c++){if(c<0||c>=400)continue;for(var r=TC.surf[c]-9;r<TC.surf[c];r++){var v=TC.world[r*400+c];if(v===5||v===6)return false;}}return true;}var x=-1,fb=-1;for(var i=0;i<400;i++){if(TC.biome[i]!==1)continue;if(clear(i-2,i+2)){x=i;break;}if(fb<0&&clear(i-1,i))fb=i;}if(x<0)x=fb;if(x<0)return "NO_DESERT";TC.setGameTime(300*0.3);var p=TC.player;p.x=x*16-6;p.y=TC.surf[x]*16-25;p.vy=0;p.vx=0;p.apex=p.y;p.hp=100;return "col"+x;})();', 3500],
    ['07_underground_torch_night', 'return (function(){var x=TC.spawnCol,y=-1;for(var r=TC.surf[x]+6;r<180;r++){if(TC.world[r*400+x]===0&&TC.world[(r+1)*400+x]!==0&&TC.world[(r+1)*400+x]!==11){y=r;break;}}if(y<0)return "NO_POCKET";TC.setTile(x+1,y-1,11);TC.setGameTime(300*0.75);var p=TC.player;p.x=x*16+2;p.y=y*16-24;p.vy=0;p.vx=0;p.apex=p.y;p.hp=100;return "floor"+y;})();', 1500],
    ['08_boss', 'TC.setUI(false);TC.spawnBoss();return "summoned";', 2600],
    ['09_ui_inventory', 'TC.addItem("torch",16);TC.addItem("iron_ore",20);TC.addItem("iron_bar",5);TC.addItem("potion",3);TC.addItem("gel",15);TC.addItem("wood",30);TC.setSelected(3);TC.setUI(true);return "ok";', 800],
    ['10_death_screen', 'TC.setUI(false);var p=TC.player;p.hp=1;p.dead=false;TC.hurtPlayer(99);return "dead";', 700],
    ['11_light_gradient_day', 'return (function(){for(var base=0;base<400;base+=7){var c=-1;for(var x=base;x<base+7&&x<400;x++){var ok=true;for(var r=TC.surf[x]-8;r<TC.surf[x];r++){if(TC.world[r*400+x]!==0){ok=false;break;}}if(ok){c=x;break;}}if(c>=0){TC.setGameTime(300*0.2);var p=TC.player;p.x=c*16-6;p.y=TC.surf[c]*16-25;p.vy=0;p.vx=0;p.apex=p.y;p.hp=100;p.dead=false;return "col"+c;}}return "NO_COLUMN";})();', 2000],
  ];

  const results = [];
  for (const [name, js, wait] of scenarios) {
    let setupRes;
    try { setupRes = await exec(js); } catch (e) { setupRes = 'SETUP_ERROR: ' + e.message; }
    await sleep(wait);
    await shot(name);
    let extra = '';
    if (name === '07_underground_torch_night') {
      try { extra = ' lightAtPlayer=' + (await exec('return TC.lightAt(TC.player.x+6,TC.player.y+12).toFixed(2);')); } catch (e) { extra = ' lightAtPlayer=ERR'; }
    }
    results.push(name + ': setup=' + JSON.stringify(setupRes) + extra);
  }

  const checks = {};
  checks.dayF_at_times = await exec('return [0.2,0.47,0.5,0.55,0.75,0.97].map(function(ph){TC.setGameTime(300*ph);return dayInfo().dayF.toFixed(2);}).join(",");');
  checks.light_gradient_day = await exec('return (function(){var p=TC.player;var c=Math.round((p.x+6)/16-0.4);var s=TC.surf[c];var f=[];for(var r=s;r<=s+13;r++)f.push(TC.lightAt(c*16+8,r*16+8).toFixed(2));return "col"+c+" s"+s+" "+f.join(",");})();');
  checks.light_gradient_spawn = await exec('return (function(){var x=TC.spawnCol,s=TC.surf[x],f=[];for(var r=s;r<=s+13;r++)f.push(TC.lightAt(x*16+8,r*16+8).toFixed(2));TC.setGameTime(300*0.2);return f.join(",");})();');
  checks.player_state = await exec('return (function(){var p=TC.player;return "px="+p.x.toFixed(0)+" py="+p.y.toFixed(0)+" light="+TC.lightAt(p.x+6,p.y+12).toFixed(2)+" hp="+p.hp+" dead="+p.dead+" nan="+(isNaN(p.x)||isNaN(p.y));})();');
  checks.entities = await exec('return TC.entities.map(function(e){return e.type+":"+Math.round(e.hp);}).join(",");');
  checks.pageErrors = await exec('return JSON.stringify(window.__errs||[]);');
  checks.seed = await exec('return "seed="+TC.SEED+" spawnCol="+TC.spawnCol;');

  console.log('\n=== CHECKS ===');
  for (const [k, v] of Object.entries(checks)) console.log(k + ': ' + v);
  console.log('\n=== SCENARIO LOG ===');
  results.forEach(r => console.log(r));

  try { send('WebDriver:DeleteSession', {}); } catch {}
  sock.destroy();
  ff.kill('SIGTERM');
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(0); }, 1500);
})().catch(e => { console.error('DRIVER FAILED:', e.message || e); try { sock.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(1), 1000); });
