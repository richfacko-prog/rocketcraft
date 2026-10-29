import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Match, Mode, EndResult } from './game/Match';
import type { Difficulty } from './game/AI';
import { Garage } from './game/Garage';
import { MenuNav } from './game/MenuNav';
import { OnlineMenu } from './ui/Online';
import { controlGuide, type Scheme } from './game/Input';

const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

async function boot() {
  await RAPIER.init();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // image-based lighting so metallic / clear-coat paints have something to reflect
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 0.4;
  const match = new Match(scene, window.innerWidth / window.innerHeight);

  const $ = (id: string) => document.getElementById(id)!;
  const menu = $('menu');
  const pause = $('pause');
  const end = $('end');
  const garage = new Garage(renderer.domElement, envMap, match.playerDesign, (d) => {
    match.playerDesign = d;
  });
  $('loading').classList.add('hidden');
  menu.classList.remove('hidden');

  let mode: Mode = '1v1';
  let diff: Difficulty = 'pro';
  for (const seg of document.querySelectorAll<HTMLElement>('.seg')) {
    seg.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      if (seg.dataset.group === 'mode') mode = b.dataset.v as Mode;
      else if (seg.dataset.group === 'scheme') {
        match.input.setScheme(b.dataset.v as Scheme);
        renderControls();
        match.hud.setBallCam(match.cam.ballCam, match.ballCamKey());
      } else diff = b.dataset.v as Difficulty;
    });
  }

  // controls table on the main menu follows the chosen scheme
  const renderControls = () => {
    const box = $('menu-controls');
    box.replaceChildren();
    const scheme = match.input.scheme;
    const col = (title: string, rows: [string, string][], tip?: string) => {
      const c = document.createElement('div');
      c.className = 'col';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      const table = document.createElement('table');
      for (const [k, v] of rows) {
        const tr = table.insertRow();
        tr.insertCell().textContent = k;
        tr.insertCell().textContent = v;
      }
      c.append(h3, table);
      if (tip) {
        const p = document.createElement('p');
        p.className = 'tip';
        p.textContent = tip;
        c.append(p);
      }
      box.append(c);
    };
    const extra: [string, string][] = [
      ['[ ] / Wheel', 'Camera distance'],
      ['H', 'Hide control guide'],
      ['Esc', 'Pause'],
    ];
    col(scheme === 'rl' ? 'KEYBOARD + MOUSE (RL DEFAULT)' : 'KEYBOARD ONLY', [...controlGuide(scheme, false), ...extra], scheme === 'rl' ? 'These are Rocket League’s default PC bindings. Switch to “Keyboard only” to play without a mouse.' : 'No mouse needed, in matches or in menus (arrow keys + Enter).');
    col('GAMEPAD (RL DEFAULT)', [...controlGuide(scheme, true), ['Start', 'Pause'], ['Back', 'Scoreboard']]);
  };
  for (const b of document.querySelectorAll<HTMLElement>('.seg[data-group="scheme"] button')) b.classList.toggle('sel', b.dataset.v === match.input.scheme);
  renderControls();

  const blurActive = () => (document.activeElement as HTMLElement | null)?.blur();
  const startGame = () => {
    menu.classList.add('hidden');
    end.classList.add('hidden');
    pause.classList.add('hidden');
    match.start(mode, diff);
    blurActive();
  };
  const toMenu = () => {
    pause.classList.add('hidden');
    end.classList.add('hidden');
    match.quit();
    menu.classList.remove('hidden');
  };
  $('play').addEventListener('click', startGame);
  let lastWasOnline = false;
  $('again').addEventListener('click', () => (lastWasOnline ? backToOnline() : startGame()));
  $('tomenu').addEventListener('click', () => (lastWasOnline ? (end.classList.add('hidden'), match.quit(), online.hide(), menu.classList.remove('hidden')) : toMenu()));
  $('quit').addEventListener('click', () => (match.online ? backToOnline('You left the match.') : toMenu()));
  $('resume').addEventListener('click', () => {
    match.setPaused(false);
    pause.classList.add('hidden');
    blurActive();
  });
  $('restart').addEventListener('click', () => {
    pause.classList.add('hidden');
    match.restart();
    blurActive();
  });

  // online play
  const online = new OnlineMenu(
    () => match.playerDesign,
    (setup) => {
      end.classList.add('hidden');
      pause.classList.add('hidden');
      match.startOnline(setup);
      blurActive();
    },
    () => menu.classList.remove('hidden'),
  );
  const backToOnline = (message?: string) => {
    pause.classList.add('hidden');
    end.classList.add('hidden');
    if (match.state !== 'idle') match.quit();
    online.returnFromMatch();
    if (message) setTimeout(() => ($('on-status').textContent = message), 50);
  };
  online.onDisconnect = (reason) => backToOnline(reason);
  match.onAbort = (reason) => backToOnline(reason);
  $('open-online').addEventListener('click', () => {
    menu.classList.add('hidden');
    void online.show();
  });

  // garage
  $('open-garage').addEventListener('click', () => {
    menu.classList.add('hidden');
    garage.show(match.playerDesign);
  });
  $('g-back').addEventListener('click', () => {
    garage.hide();
    menu.classList.remove('hidden');
  });

  // pause-menu camera settings
  const dist = $('set-dist') as HTMLInputElement;
  const fov = $('set-fov') as HTMLInputElement;
  const ballcam = $('set-ballcam') as HTMLInputElement;
  const syncSettings = () => {
    dist.value = String(match.cam.distance);
    fov.value = String(match.cam.baseFov);
    ballcam.checked = match.cam.ballCam;
    $('set-dist-v').textContent = match.cam.distance.toFixed(1);
    $('set-fov-v').textContent = `${match.cam.baseFov}°`;
  };
  dist.addEventListener('input', () => {
    match.cam.setDistance(Number(dist.value));
    syncSettings();
  });
  fov.addEventListener('input', () => {
    match.cam.setFov(Number(fov.value));
    syncSettings();
  });
  ballcam.addEventListener('change', () => {
    match.cam.ballCam = ballcam.checked;
    match.cam.save();
    match.hud.setBallCam(match.cam.ballCam, match.ballCamKey());
  });
  match.onPauseToggle = (p) => {
    pause.classList.toggle('hidden', !p);
    $('restart').classList.toggle('hidden', !!match.online);
    $('pause-note').classList.toggle('hidden', !match.online);
    if (p) syncSettings();
  };

  match.onEnd = (r: EndResult) => {
    lastWasOnline = !!r.online;
    $('again').textContent = r.online ? 'BACK TO ONLINE' : 'PLAY AGAIN';
    const playerTeam = r.cars.find((c) => c.isPlayer)?.team ?? 0;
    $('end-title').textContent = r.winner === playerTeam ? 'VICTORY!' : 'DEFEAT';
    $('end-title').className = r.winner === 0 ? 'b' : 'o';
    $('end-note').textContent = r.online ? 'Online result saved to the leaderboard.' : '';
    $('end-blue').textContent = String(r.score[0]);
    $('end-orange').textContent = String(r.score[1]);
    const rows = [...r.cars].sort((a, b) => a.team - b.team || b.score - a.score);
    $('end-stats').innerHTML =
      '<tr><th>PLAYER</th><th>SCORE</th><th>GOALS</th><th>ASSISTS</th><th>SAVES</th><th>SHOTS</th><th>DEMOS</th></tr>' +
      rows
        .map(
          (c) =>
            `<tr class="t${c.team} ${c.isPlayer ? 'me' : ''}"><td>${esc(c.name)}</td><td>${c.score}</td><td>${c.goals}</td><td>${c.assists}</td><td>${c.saves}</td><td>${c.shots}</td><td>${c.demos}</td></tr>`,
        )
        .join('');
    end.classList.remove('hidden');
  };

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    match.cam.camera.aspect = w / h;
    match.cam.camera.updateProjectionMatrix();
    garage.resize(w, h);
  };
  window.addEventListener('resize', onResize);

  // keyboard / gamepad menu navigation (no mouse needed)
  const nav = new MenuNav((overlay) => {
    if (overlay === 'garage') $('g-back').click();
    else if (overlay === 'pause') $('resume').click();
  });

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    nav.pollGamepad(dt);
    if (online.open) online.tick();
    if (garage.open) {
      garage.render(renderer, dt);
    } else {
      if (!(window as unknown as { __manual?: boolean }).__manual) match.frame(dt);
      match.particles.setViewport(renderer.domElement.height, match.cam.camera.fov);
      renderer.render(scene, match.cam.camera);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // debug / test handles
  const w = window as unknown as { __match: Match; __garage: Garage };
  w.__match = match;
  w.__garage = garage;
}

boot().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) l.innerHTML = `<div class="loading-text">Failed to start: ${String(e)}</div>`;
});
