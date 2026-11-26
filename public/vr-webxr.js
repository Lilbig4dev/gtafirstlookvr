/* Meta Quest 3 WebXR runtime, direct worker ImageBitmap stream, 3D laser pointer UI, and Touch Plus controller bridge for PlayGTA5. */
(() => {
  'use strict';

  const DEADZONE = 0.16;
  const LOOK_STICK_SPEED = 1150;
  const HEAD_LOOK_YAW_SENS = 920;
  const HEAD_LOOK_PITCH_SENS = 760;

  const SCREEN_RADIUS = 2.6;
  const SCREEN_HEIGHT = 1.72;
  const SCREEN_ARC = (68 * Math.PI) / 180;

  const BAR_RADIUS = 2.48;
  const BAR_HEIGHT = 0.26;
  const BAR_Y = -1.06;
  const BAR_ARC = (56 * Math.PI) / 180;

  let xrSession = null;
  let xrRefSpace = null;
  let gl = null;
  let glProgram = null;
  let rayProgram = null;
  let gameTex = null;
  let hudTex = null;
  let screenMesh = null;
  let hudMesh = null;
  let rayVao = null;
  let rayVbo = null;

  // Direct frame stream from wgpu_worker.js (works even when 2D browser window is hidden/minimized)
  let vrPort = null;
  let latestBitmap = null;
  let hasNewBitmap = false;

  let drivingMode = false;
  let headLookEnabled = true;
  let followMode = false;
  let vrMenuCursorMode = false;

  let prevHeadYaw = null;
  let prevHeadPitch = null;
  let anchorYaw = 0;
  let anchorPos = [0, 1.55, 0];
  let needsRecenter = true;

  let ownedKeys = new Set();
  let ownedMouse = 0;
  let remLookX = 0;
  let remLookY = 0;
  let prevTime = 0;
  let autoFirstPersonDone = false;

  // Queued key pulses so 30fps GTA V reliably sees discrete taps (120ms hold)
  const activePulses = new Map(); // code -> expireMs
  const scheduledPulses = [];     // { code, startMs, holdMs }

  function schedulePulse(code, holdMs = 120, delayMs = 0) {
    const now = performance.now();
    scheduledPulses.push({ code, startMs: now + delayMs, holdMs });
  }

  function scheduleFirstPersonTriple() {
    schedulePulse('KeyV', 120, 0);
    schedulePulse('KeyV', 120, 260);
    schedulePulse('KeyV', 120, 520);
  }

  // Edge-triggered combo/trigger latches
  let latchModeToggle = false;
  let latchPause = false;
  let latchHeadLook = false;
  let latchScreenMode = false;
  let latchRecenter = false;
  let latchCursorMode = false;
  let latchStoryBtn = false;
  let latchSandboxBtn = false;
  let latchMap6Btn = false;
  let latchFpsClick = false;
  let latchDriveCamClick = false;
  const triggerLatches = { left: false, right: false };

  // Hover state for 3D laser pointers
  let hoveredToolbarIdx = -1;
  let hoveredLoadBtn = null;
  let screenCursorUV = null;

  const mirrorCanvas = document.createElement('canvas');
  mirrorCanvas.width = 1280;
  mirrorCanvas.height = 720;
  const mirrorCtx = mirrorCanvas.getContext('2d');

  const hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1280;
  hudCanvas.height = 176;
  const hudCtx = hudCanvas.getContext('2d');
  let lastHudSignature = '';

  const vrBtn = document.getElementById('vr-mode-btn');
  const controlsBtn = document.getElementById('vr-controls-btn');
  const controlsModal = document.getElementById('vr-controls-modal');
  const controlsClose = document.getElementById('vr-controls-close');
  const vrToast = document.getElementById('vr-toast');

  function showToast(msg, ms = 4500) {
    if (!vrToast) return;
    vrToast.textContent = msg;
    vrToast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { vrToast.hidden = true; }, ms);
  }

  function attachVrPort(port) {
    if (!port || vrPort === port) return;
    vrPort = port;
    vrPort.onmessage = (ev) => {
      const d = ev.data;
      if (!d || !d.bitmap) return;
      if (latestBitmap) {
        try { latestBitmap.close(); } catch {}
      }
      latestBitmap = d.bitmap;
      hasNewBitmap = true;
      if (!xrSession) {
        try { vrPort.postMessage({ ack: true }); } catch {}
      }
    };
    vrPort.postMessage({ vrActive: !!xrSession });
  }

  if (window.__GTA5_VR_PORT__) attachVrPort(window.__GTA5_VR_PORT__);
  window.addEventListener('gta5-vr-port', (e) => attachVrPort(e.detail));

  window.addEventListener('gta5-world-ready', () => {
    if (xrSession && !autoFirstPersonDone) {
      autoFirstPersonDone = true;
      setTimeout(() => { if (xrSession) scheduleFirstPersonTriple(); }, 400);
    }
  });

  function applyDeadzone(v) {
    if (!Number.isFinite(v)) return 0;
    const clamped = Math.max(-1, Math.min(1, v));
    const abs = Math.abs(clamped);
    if (abs <= DEADZONE) return 0;
    return Math.sign(clamped) * ((abs - DEADZONE) / (1 - DEADZONE));
  }

  function isWorldReady() {
    const st = window.__GTA5_LOAD_STATE__;
    if (st && st.ready) return true;
    const loadEl = document.getElementById('loading');
    return !loadEl || loadEl.classList.contains('done');
  }

  // ---- Shared-memory input writer (WasmInputBlock) ----
  function getFreshViews() {
    const inp = window.__GTA5_INPUT__;
    if (!inp) return null;
    if (typeof inp.getViews === 'function') return { ...inp.getViews(), VK: inp.VK, getSize: inp.getSize };
    return { keys: inp.keys, w: inp.w, VK: inp.VK, getSize: inp.getSize };
  }

  function releaseAllVRInputs() {
    const v = getFreshViews();
    if (v) {
      for (const code of ownedKeys) {
        const vk = v.VK[code];
        if (vk) Atomics.store(v.keys, vk, 0);
      }
      const curBtn = Atomics.load(v.w, 5);
      Atomics.store(v.w, 5, curBtn & ~ownedMouse);
    }
    ownedKeys.clear();
    ownedMouse = 0;
    remLookX = 0;
    remLookY = 0;
    activePulses.clear();
    scheduledPulses.length = 0;
  }

  function writeInputs(nextKeys, nextMouse, dx, dy, dz, cursorUV) {
    const v = getFreshViews();
    if (!v) return;
    const { keys, w, VK, getSize } = v;

    // Apply any scheduled/active pulses (120ms holds so 30fps engine never misses taps)
    const now = performance.now();
    for (let i = scheduledPulses.length - 1; i >= 0; i--) {
      if (now >= scheduledPulses[i].startMs) {
        const p = scheduledPulses.splice(i, 1)[0];
        activePulses.set(p.code, now + p.holdMs);
      }
    }
    for (const [code, until] of activePulses) {
      if (now < until) nextKeys.add(code);
      else activePulses.delete(code);
    }

    // Keep engine focused and locked during gameplay unless cursor mode is active
    Atomics.store(w, 6, 1); // FOCUS = 1
    Atomics.store(w, 7, vrMenuCursorMode ? 0 : 1); // LOCKED

    if (vrMenuCursorMode && cursorUV && typeof getSize === 'function') {
      const [W, H] = getSize();
      const mx = Math.max(0, Math.min(W - 1, Math.round(cursorUV.u * W)));
      const my = Math.max(0, Math.min(H - 1, Math.round(cursorUV.v * H)));
      Atomics.store(w, 0, mx);
      Atomics.store(w, 1, my);
    }

    for (const code of new Set([...ownedKeys, ...nextKeys])) {
      const vk = VK[code];
      if (vk) Atomics.store(keys, vk, nextKeys.has(code) ? 0x80 : 0);
    }
    ownedKeys = nextKeys;

    const curBtn = Atomics.load(w, 5);
    Atomics.store(w, 5, (curBtn & ~ownedMouse) | nextMouse);
    ownedMouse = nextMouse;

    if (dx) Atomics.add(w, 2, dx);
    if (dy) Atomics.add(w, 3, dy);
    if (dz) Atomics.add(w, 4, dz);
  }

  // ---- 4x4 Column-Major Matrix & Ray Helpers ----
  function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function mat4FromTranslationYaw(x, y, z, yaw) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return new Float32Array([
      c, 0, -s, 0,
      0, 1,  0, 0,
      s, 0,  c, 0,
      x, y,  z, 1
    ]);
  }

  // Inverse of rigid translation+yaw matrix
  function worldToLocalRay(origin, dir, ax, ay, az, yaw) {
    const tx = origin.x - ax;
    const ty = origin.y - ay;
    const tz = origin.z - az;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return {
      ox: c * tx - s * tz,
      oy: ty,
      oz: s * tx + c * tz,
      dx: c * dir[0] - s * dir[2],
      dy: dir[1],
      dz: s * dir[0] + c * dir[2],
    };
  }

  function transformRayDir(q) {
    // Rotate local -Z (0, 0, -1) by quaternion q
    const { x, y, z, w } = q;
    const ix = -w * 0 + y * (-1) - z * 0;
    const iy = -w * 0 + z * 0 - x * (-1);
    const iz = w * (-1) + x * 0 - y * 0;
    const iw = -x * 0 - y * 0 - z * (-1);
    const rx = ix * w + iw * -x + iy * -z - iz * -y;
    const ry = iy * w + iw * -y + iz * -x - ix * -z;
    const rz = iz * w + iw * -z + ix * -y - iy * -x;
    return [rx, ry, rz];
  }

  function intersectCurvedPanel(ray, radius, height, arcRad, yOffset) {
    const a = ray.dx * ray.dx + ray.dz * ray.dz;
    if (a < 1e-6) return null;
    const b = 2 * (ray.ox * ray.dx + ray.oz * ray.dz);
    const c = ray.ox * ray.ox + ray.oz * ray.oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const candidates = [(-b + sq) / (2 * a), (-b - sq) / (2 * a)];
    let best = null;
    for (const t of candidates) {
      if (t <= 0.1 || t > 12) continue;
      const hx = ray.ox + t * ray.dx;
      const hy = ray.oy + t * ray.dy;
      const hz = ray.oz + t * ray.dz;
      if (hz >= 0) continue; // front hemisphere only
      const angle = Math.atan2(hx, -hz);
      if (Math.abs(angle) > arcRad * 0.5) continue;
      const v = (yOffset + height * 0.5 - hy) / height;
      if (v < 0 || v > 1) continue;
      const u = angle / arcRad + 0.5;
      if (!best || t < best.t) best = { t, u, v };
    }
    return best;
  }

  function quatToYawPitch(q) {
    const { x, y, z, w } = q;
    const siny_cosp = 2 * (w * y - z * x);
    const cosy_cosp = 1 - 2 * (y * y + x * x);
    const yaw = Math.atan2(siny_cosp, cosy_cosp);
    const sinp = 2 * (w * x + y * z);
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
    return { yaw, pitch };
  }

  function wrapAngleDelta(d) {
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // ---- WebGL2 Shaders & Meshes ----
  function createShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('WebXR shader error: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function initWebGLResources() {
    const vsSrc = `#version 300 es
      layout(location = 0) in vec3 a_pos;
      layout(location = 1) in vec2 a_uv;
      uniform mat4 u_mvp;
      out vec2 v_uv;
      void main() {
        gl_Position = u_mvp * vec4(a_pos, 1.0);
        v_uv = a_uv;
      }
    `;
    const fsSrc = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_tex;
      uniform float u_alpha;
      out vec4 fragColor;
      void main() {
        vec4 col = texture(u_tex, v_uv);
        fragColor = vec4(col.rgb, col.a * u_alpha);
      }
    `;
    glProgram = gl.createProgram();
    gl.attachShader(glProgram, createShader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(glProgram, createShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(glProgram);
    glProgram.uMvp = gl.getUniformLocation(glProgram, 'u_mvp');
    glProgram.uTex = gl.getUniformLocation(glProgram, 'u_tex');
    glProgram.uAlpha = gl.getUniformLocation(glProgram, 'u_alpha');

    // Simple laser pointer line/dot shader
    const rVs = `#version 300 es
      layout(location = 0) in vec3 a_pos;
      uniform mat4 u_vp;
      void main() {
        gl_Position = u_vp * vec4(a_pos, 1.0);
        gl_PointSize = 10.0;
      }
    `;
    const rFs = `#version 300 es
      precision mediump float;
      uniform vec4 u_color;
      out vec4 fragColor;
      void main() {
        fragColor = u_color;
      }
    `;
    rayProgram = gl.createProgram();
    gl.attachShader(rayProgram, createShader(gl.VERTEX_SHADER, rVs));
    gl.attachShader(rayProgram, createShader(gl.FRAGMENT_SHADER, rFs));
    gl.linkProgram(rayProgram);
    rayProgram.uVp = gl.getUniformLocation(rayProgram, 'u_vp');
    rayProgram.uColor = gl.getUniformLocation(rayProgram, 'u_color');

    screenMesh = buildCurvedQuad(SCREEN_RADIUS, SCREEN_HEIGHT, SCREEN_ARC, 0, 36);
    hudMesh = buildCurvedQuad(BAR_RADIUS, BAR_HEIGHT, BAR_ARC, BAR_Y, 24);

    rayVao = gl.createVertexArray();
    gl.bindVertexArray(rayVao);
    rayVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, rayVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 24, gl.DYNAMIC_DRAW); // 2 vertices * 3 floats
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    gameTex = createDynamicTexture();
    hudTex = createDynamicTexture();
  }

  function createDynamicTexture() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function buildCurvedQuad(radius, height, arcRad, yOffset, segs) {
    const verts = [];
    const indices = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const angle = (t - 0.5) * arcRad;
      const x = Math.sin(angle) * radius;
      const z = -Math.cos(angle) * radius;
      const yTop = yOffset + height * 0.5;
      const yBot = yOffset - height * 0.5;
      verts.push(x, yTop, z, t, 0.0);
      verts.push(x, yBot, z, t, 1.0);
      if (i < segs) {
        const b = i * 2;
        indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: indices.length };
  }

  // ---- Interactive Loading Screen Canvas (with clickable laser buttons) ----
  const LOAD_BUTTONS = [
    { id: 'story', label: 'STORY MODE (A)', x: 140, y: 460, w: 300, h: 74 },
    { id: 'map5',  label: 'SANDBOX · GTA V (X)', x: 490, y: 460, w: 300, h: 74 },
    { id: 'map6',  label: 'SANDBOX · GTA VI (Y)', x: 840, y: 460, w: 300, h: 74 },
  ];

  function updateLoadingMirrorTexture() {
    const st = window.__GTA5_LOAD_STATE__ || { pct: 0, label: 'Starting...', dataMB: 0, startMode: 0 };
    const ctx = mirrorCtx;
    ctx.fillStyle = '#070a09';
    ctx.fillRect(0, 0, 1280, 720);

    const grad = ctx.createRadialGradient(640, 320, 40, 640, 320, 620);
    grad.addColorStop(0, '#163829');
    grad.addColorStop(1, '#070a09');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1280, 720);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 52px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GRAND THEFT AUTO V · QUEST 3 VR', 640, 170);

    ctx.fillStyle = '#9fe2bf';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillText((st.label || 'Starting...') + ' (' + (st.pct || 0) + '%)', 640, 245);

    if (st.dataMB > 0) {
      ctx.fillStyle = '#7ea89a';
      ctx.font = '21px monospace';
      ctx.fillText('Game data streamed: ' + st.dataMB + ' MB', 640, 290);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(290, 330, 700, 16);
    ctx.fillStyle = '#7cc576';
    ctx.fillRect(290, 330, 7 * Math.max(0, Math.min(100, st.pct || 0)), 16);

    const modeMap = { story: 1, map5: 2, map6: 3 };
    for (const b of LOAD_BUTTONS) {
      const selected = st.startMode === modeMap[b.id];
      const hovered = hoveredLoadBtn === b.id;
      ctx.fillStyle = selected ? '#2e6f4f' : hovered ? '#24523d' : '#13241d';
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 14);
      ctx.fill();
      ctx.strokeStyle = selected || hovered ? '#7cc576' : '#4a6b5b';
      ctx.lineWidth = hovered ? 4 : 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 21px system-ui, sans-serif';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + 44);
    }

    ctx.fillStyle = '#b4cbc0';
    ctx.font = '19px system-ui, sans-serif';
    ctx.fillText('Point controller laser + pull Trigger to click · Sandbox drops straight into Los Santos with weapons', 640, 610);

    gl.bindTexture(gl.TEXTURE_2D, gameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mirrorCanvas);
  }

  // ---- Interactive 7-Button VR Toolbar ----
  const TOOLBAR_BUTTONS = [
    { id: 'firstperson', label: () => '1ST PERSON (V)' },
    { id: 'mode',        label: () => drivingMode ? 'MODE: DRIVING' : 'MODE: ON FOOT' },
    { id: 'headlook',    label: () => 'HEAD-LOOK: ' + (headLookEnabled ? 'ON' : 'OFF') },
    { id: 'screen',      label: () => 'SCREEN: ' + (followMode ? 'FOLLOW' : 'THEATER') },
    { id: 'cursor',      label: () => 'CURSOR: ' + (vrMenuCursorMode ? 'ON' : 'OFF') },
    { id: 'pause',       label: () => 'PAUSE / MAP' },
    { id: 'recenter',    label: () => 'RECENTER' },
    { id: 'exit',        label: () => 'EXIT VR' },
  ];

  function activateToolbarButton(id) {
    if (id === 'firstperson') {
      scheduleFirstPersonTriple();
    } else if (id === 'mode') {
      drivingMode = !drivingMode;
    } else if (id === 'headlook') {
      headLookEnabled = !headLookEnabled;
      prevHeadYaw = null;
      prevHeadPitch = null;
    } else if (id === 'screen') {
      followMode = !followMode;
      needsRecenter = true;
    } else if (id === 'cursor') {
      vrMenuCursorMode = !vrMenuCursorMode;
    } else if (id === 'pause') {
      schedulePulse('Escape', 130, 0);
      vrMenuCursorMode = !vrMenuCursorMode;
    } else if (id === 'recenter') {
      needsRecenter = true;
    } else if (id === 'exit') {
      if (xrSession) xrSession.end();
    }
  }

  function updateHudTexture() {
    const sig = `${drivingMode}|${headLookEnabled}|${followMode}|${vrMenuCursorMode}|${hoveredToolbarIdx}`;
    if (sig === lastHudSignature) return;
    lastHudSignature = sig;

    const c = hudCtx;
    c.clearRect(0, 0, 1280, 176);
    c.fillStyle = 'rgba(10, 18, 15, 0.9)';
    c.beginPath();
    c.roundRect(8, 8, 1264, 160, 18);
    c.fill();
    c.strokeStyle = 'rgba(124, 197, 118, 0.55)';
    c.lineWidth = 2;
    c.stroke();

    const padX = 20;
    const gap = 8;
    const btnW = (1280 - padX * 2 - gap * (TOOLBAR_BUTTONS.length - 1)) / TOOLBAR_BUTTONS.length;

    for (let i = 0; i < TOOLBAR_BUTTONS.length; i++) {
      const b = TOOLBAR_BUTTONS[i];
      const bx = padX + i * (btnW + gap);
      const hovered = hoveredToolbarIdx === i;
      const activeAccent =
        (b.id === 'mode' && drivingMode) ||
        (b.id === 'headlook' && headLookEnabled) ||
        (b.id === 'cursor' && vrMenuCursorMode);

      c.fillStyle = hovered ? '#2d6b4d' : activeAccent ? '#1a4230' : '#12211b';
      c.beginPath();
      c.roundRect(bx, 22, btnW, 66, 10);
      c.fill();
      c.strokeStyle = hovered ? '#a7f3d0' : activeAccent ? '#7cc576' : '#415e51';
      c.lineWidth = hovered ? 3 : 1.5;
      c.stroke();

      c.fillStyle = b.id === 'exit' ? '#fca5a5' : '#ffffff';
      c.font = 'bold 14px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(b.label(), bx + btnW / 2, 60);
    }

    c.textAlign = 'center';
    c.font = '18px system-ui, sans-serif';
    c.fillStyle = '#cbd5e1';
    c.fillText(
      drivingMode
        ? 'DRIVING: RT Gas | LT Brake | L-Stick Steer | A/R-Grip Handbrake | B Camera | Y Exit Car | L+R Grip: On-Foot'
        : 'ON-FOOT: L-Stick Move | R-Stick & Head Aim | RT Fire | R-Grip Aim | A Jump | B Sprint | X Reload | Y Car | L+R Grip: Driving',
      640,
      134
    );

    gl.bindTexture(gl.TEXTURE_2D, hudTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hudCanvas);
  }

  // ---- Quest 3 Input & Raycast Processing ----
  function processQuestInputs(session, frame, pose, dt) {
    const nextKeys = new Set();
    let nextMouse = 0;
    let dz = 0;
    let leftPad = null;
    let rightPad = null;
    const raysToDraw = [];

    hoveredToolbarIdx = -1;
    hoveredLoadBtn = null;
    screenCursorUV = null;

    const ready = isWorldReady();
    if (ready && !autoFirstPersonDone && window.__GTA5_INPUT__) {
      autoFirstPersonDone = true;
      setTimeout(() => { if (xrSession) scheduleFirstPersonTriple(); }, 350);
    }

    for (const src of session.inputSources) {
      if (src.gamepad) {
        if (src.handedness === 'left') leftPad = src.gamepad;
        else if (src.handedness === 'right') rightPad = src.gamepad;
      }

      if (src.targetRaySpace) {
        const rayPose = frame.getPose(src.targetRaySpace, xrRefSpace);
        if (rayPose) {
          const origin = rayPose.transform.position;
          const dir = transformRayDir(rayPose.transform.orientation);
          const localRay = worldToLocalRay(origin, dir, anchorPos[0], anchorPos[1], anchorPos[2], anchorYaw);
          const barHit = intersectCurvedPanel(localRay, BAR_RADIUS, BAR_HEIGHT, BAR_ARC, BAR_Y);
          const scrHit = intersectCurvedPanel(localRay, SCREEN_RADIUS, SCREEN_HEIGHT, SCREEN_ARC, 0);

          const hand = src.handedness === 'left' ? 'left' : 'right';
          const trigVal = src.gamepad && src.gamepad.buttons[0] ? src.gamepad.buttons[0].value : 0;
          const trigDown = trigVal > 0.55;
          const trigJustClicked = trigDown && !triggerLatches[hand];
          triggerLatches[hand] = trigDown;

          let hitDist = 3.2;
          let hitColor = [0.49, 0.77, 0.46, 0.65];

          if (barHit) {
            hitDist = barHit.t;
            hitColor = [0.65, 0.95, 0.82, 0.95];
            const idx = Math.max(0, Math.min(TOOLBAR_BUTTONS.length - 1, Math.floor(barHit.u * TOOLBAR_BUTTONS.length)));
            hoveredToolbarIdx = idx;
            if (trigJustClicked) {
              activateToolbarButton(TOOLBAR_BUTTONS[idx].id);
            }
          } else if (scrHit) {
            hitDist = scrHit.t;
            if (!ready) {
              const px = scrHit.u * 1280;
              const py = scrHit.v * 720;
              for (const b of LOAD_BUTTONS) {
                if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
                  hoveredLoadBtn = b.id;
                  hitColor = [0.65, 0.95, 0.82, 0.95];
                  if (trigJustClicked) {
                    const actFn = window.__GTA5_ACT__ || (window.__GTA5_LOAD_STATE__ && window.__GTA5_LOAD_STATE__.act);
                    if (typeof actFn === 'function') actFn(b.id);
                  }
                }
              }
            } else if (vrMenuCursorMode) {
              hitColor = [1.0, 0.85, 0.4, 0.95];
              if (src.handedness === 'right' || !screenCursorUV) {
                screenCursorUV = { u: scrHit.u, v: scrHit.v };
              }
            }
          }

          if (!ready || vrMenuCursorMode || barHit) {
            raysToDraw.push({
              x0: origin.x, y0: origin.y, z0: origin.z,
              x1: origin.x + dir[0] * hitDist,
              y1: origin.y + dir[1] * hitDist,
              z1: origin.z + dir[2] * hitDist,
              color: hitColor,
            });
          }
        }
      }
    }

    const btn = (pad, idx) => !!(pad && pad.buttons[idx] && (pad.buttons[idx].pressed || pad.buttons[idx].value > 0.5));
    const trig = (pad, idx) => (pad && pad.buttons[idx] ? pad.buttons[idx].value : 0);
    const stick = (pad) => {
      if (!pad || !pad.axes) return [0, 0];
      if (pad.axes.length >= 4 && (Math.abs(pad.axes[2]) > 0.02 || Math.abs(pad.axes[3]) > 0.02)) {
        return [applyDeadzone(pad.axes[2]), applyDeadzone(pad.axes[3])];
      }
      if (pad.axes.length >= 4) {
        return [applyDeadzone(pad.axes[2]), applyDeadzone(pad.axes[3])];
      }
      return [applyDeadzone(pad.axes[0]), applyDeadzone(pad.axes[1])];
    };

    const lGrip = btn(leftPad, 1);
    const rGrip = btn(rightPad, 1);
    const lStickClick = btn(leftPad, 3);
    const rStickClick = btn(rightPad, 3);
    const btnX = btn(leftPad, 4);
    const btnY = btn(leftPad, 5);
    const btnA = btn(rightPad, 4);
    const btnB = btn(rightPad, 5);

    // Loading screen controller shortcuts
    if (!ready) {
      const actFn = window.__GTA5_ACT__ || (window.__GTA5_LOAD_STATE__ && window.__GTA5_LOAD_STATE__.act);
      if (typeof actFn === 'function') {
        if (btnA && !latchStoryBtn) { actFn('story'); latchStoryBtn = true; }
        else if (!btnA) latchStoryBtn = false;

        if (btnX && !latchSandboxBtn) { actFn('map5'); latchSandboxBtn = true; }
        else if (!btnX) latchSandboxBtn = false;

        if (btnY && !latchMap6Btn) { actFn('map6'); latchMap6Btn = true; }
        else if (!btnY) latchMap6Btn = false;
      }
    }

    // System Combos
    const comboMode = lGrip && rGrip;
    if (comboMode && !latchModeToggle) { drivingMode = !drivingMode; latchModeToggle = true; }
    else if (!comboMode) latchModeToggle = false;

    const comboPause = lStickClick && rStickClick;
    if (comboPause && !latchPause) {
      schedulePulse('Escape', 130, 0);
      vrMenuCursorMode = !vrMenuCursorMode;
      latchPause = true;
    } else if (!comboPause) latchPause = false;

    const comboHead = lGrip && btnX;
    if (comboHead && !latchHeadLook) {
      headLookEnabled = !headLookEnabled;
      prevHeadYaw = null;
      prevHeadPitch = null;
      latchHeadLook = true;
    } else if (!comboHead) latchHeadLook = false;

    const comboScreen = lGrip && btnY;
    if (comboScreen && !latchScreenMode) {
      followMode = !followMode;
      needsRecenter = true;
      latchScreenMode = true;
    } else if (!comboScreen) latchScreenMode = false;

    const comboRecenter = btnX && btnY;
    if (comboRecenter && !latchRecenter) {
      needsRecenter = true;
      latchRecenter = true;
    } else if (!comboRecenter) latchRecenter = false;

    const comboCursor = lGrip && btnB;
    if (comboCursor && !latchCursorMode) {
      vrMenuCursorMode = !vrMenuCursorMode;
      latchCursorMode = true;
    } else if (!comboCursor) latchCursorMode = false;

    const [lx, ly] = stick(leftPad);
    const [rx, ry] = stick(rightPad);

    if (lx < -0.15) nextKeys.add('KeyA');
    if (lx > 0.15) nextKeys.add('KeyD');

    const hoveringUI = hoveredToolbarIdx >= 0 || hoveredLoadBtn !== null;

    if (!comboMode && !comboHead && !comboScreen && !comboRecenter && !comboCursor && !comboPause) {
      if (vrMenuCursorMode) {
        // Menu navigation with sticks & trigger click
        if (ly < -0.35) nextKeys.add('ArrowUp');
        if (ly > 0.35) nextKeys.add('ArrowDown');
        if (lx < -0.35) nextKeys.add('ArrowLeft');
        if (lx > 0.35) nextKeys.add('ArrowRight');
        if (!hoveringUI && trig(rightPad, 0) > 0.35) nextMouse |= 1;
        if (btnA) nextKeys.add('Enter');
        if (btnB) nextKeys.add('Backspace');
      } else if (drivingMode) {
        if (trig(rightPad, 0) > 0.15 || ly < -0.3) nextKeys.add('KeyW');
        if (trig(leftPad, 0) > 0.15 || ly > 0.3) nextKeys.add('KeyS');
        if (rGrip || btnA) nextKeys.add('Space');
        if (lGrip) nextKeys.add('KeyE');
        if (btnB && !latchDriveCamClick) { schedulePulse('KeyV', 120, 0); latchDriveCamClick = true; }
        else if (!btnB) latchDriveCamClick = false;
        if (btnX) nextKeys.add('KeyQ');
        if (btnY) nextKeys.add('KeyF');
        if (rStickClick) nextKeys.add('KeyC');
        if (lStickClick) nextKeys.add('KeyH');
      } else {
        if (ly < -0.15) nextKeys.add('KeyW');
        if (ly > 0.15) nextKeys.add('KeyS');
        if (!hoveringUI && trig(rightPad, 0) > 0.2) nextMouse |= 1; // Fire weapon
        if (rGrip) nextMouse |= 2;                                   // Aim down sights
        if (trig(leftPad, 0) > 0.25) nextKeys.add('ControlLeft');    // Stealth / Crouch
        if (lGrip) nextKeys.add('Tab');                              // Weapon Wheel
        if (btnA) nextKeys.add('Space');                             // Jump / Climb
        if (btnB) nextKeys.add('ShiftLeft');                         // Sprint
        if (btnX) nextKeys.add('KeyR');                              // Reload
        if (btnY) nextKeys.add('KeyF');                              // Enter / Exit Vehicle
        if (rStickClick) nextKeys.add('KeyC');                       // Look Behind
        if (lStickClick && !latchFpsClick) { schedulePulse('KeyV', 120, 0); latchFpsClick = true; }
        else if (!lStickClick) latchFpsClick = false;
      }
    }

    // Camera Look: Right Thumbstick + Headset Orientation
    let dx = 0, dy = 0;
    if (!vrMenuCursorMode) {
      remLookX += rx * LOOK_STICK_SPEED * dt;
      remLookY += ry * LOOK_STICK_SPEED * dt;

      if (headLookEnabled && pose && ready) {
        const { yaw, pitch } = quatToYawPitch(pose.transform.orientation);
        if (prevHeadYaw !== null && prevHeadPitch !== null) {
          const dYaw = wrapAngleDelta(yaw - prevHeadYaw);
          const dPitch = wrapAngleDelta(pitch - prevHeadPitch);
          remLookX += (-dYaw) * HEAD_LOOK_YAW_SENS;
          remLookY += (-dPitch) * HEAD_LOOK_PITCH_SENS;
        }
        prevHeadYaw = yaw;
        prevHeadPitch = pitch;
      } else {
        prevHeadYaw = null;
        prevHeadPitch = null;
      }

      dx = Math.trunc(remLookX);
      dy = Math.trunc(remLookY);
      remLookX -= dx;
      remLookY -= dy;
    } else {
      prevHeadYaw = null;
      prevHeadPitch = null;
    }

    writeInputs(nextKeys, nextMouse, dx, dy, dz, screenCursorUV);
    return raysToDraw;
  }

  // ---- WebXR Frame Loop ----
  function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const dt = Math.min(0.05, Math.max(0.001, prevTime ? (time - prevTime) / 1000 : 0.016));
    prevTime = time;

    const pose = frame.getViewerPose(xrRefSpace);
    const rays = processQuestInputs(xrSession, frame, pose, dt);
    if (!pose) return;

    const { yaw } = quatToYawPitch(pose.transform.orientation);
    const p = pose.transform.position;

    if (needsRecenter || followMode) {
      anchorYaw = yaw;
      anchorPos = [p.x, p.y, p.z];
      needsRecenter = false;
    }

    const baseLayer = xrSession.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    gl.clearColor(0.012, 0.018, 0.016, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Upload texture: prefer direct worker ImageBitmap (works even when 2D browser window is hidden!), then gameCanvas, then loading mirror
    const ready = isWorldReady();
    if (!ready) {
      updateLoadingMirrorTexture();
    } else if (hasNewBitmap && latestBitmap) {
      gl.bindTexture(gl.TEXTURE_2D, gameTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, latestBitmap);
      hasNewBitmap = false;
      if (vrPort) {
        try { vrPort.postMessage({ ack: true }); } catch {}
      }
    } else if (!latestBitmap) {
      const gameCanvas = document.getElementById('canvas');
      if (gameCanvas && gameCanvas.width > 0 && gameCanvas.height > 0) {
        gl.bindTexture(gl.TEXTURE_2D, gameTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gameCanvas); } catch {}
      }
    }

    updateHudTexture();

    const modelMat = mat4FromTranslationYaw(anchorPos[0], anchorPos[1], anchorPos[2], anchorYaw);

    for (const view of pose.views) {
      const vp = baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const vpMat = mat4Multiply(view.projectionMatrix, viewMat);
      const mvp = mat4Multiply(vpMat, modelMat);

      gl.useProgram(glProgram);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(glProgram.uMvp, false, mvp);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gameTex);
      gl.uniform1i(glProgram.uTex, 0);
      gl.uniform1f(glProgram.uAlpha, 1.0);
      gl.bindVertexArray(screenMesh.vao);
      gl.drawElements(gl.TRIANGLES, screenMesh.count, gl.UNSIGNED_SHORT, 0);

      gl.bindTexture(gl.TEXTURE_2D, hudTex);
      gl.uniform1f(glProgram.uAlpha, 0.96);
      gl.bindVertexArray(hudMesh.vao);
      gl.drawElements(gl.TRIANGLES, hudMesh.count, gl.UNSIGNED_SHORT, 0);

      // Draw controller laser rays & endpoint dots
      if (rays && rays.length) {
        gl.useProgram(rayProgram);
        gl.uniformMatrix4fv(rayProgram.uVp, false, vpMat);
        gl.bindVertexArray(rayVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, rayVbo);
        for (const r of rays) {
          gl.uniform4fv(rayProgram.uColor, r.color);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([r.x0, r.y0, r.z0, r.x1, r.y1, r.z1]));
          gl.drawArrays(gl.LINES, 0, 2);
          gl.drawArrays(gl.POINTS, 1, 1);
        }
      }
    }

    gl.bindVertexArray(null);
  }

  async function startVR() {
    if (xrSession) {
      await xrSession.end();
      return;
    }

    if (!navigator.xr) {
      showToast('WebXR is not available in this browser. Open this page in Meta Quest 3 Browser or Chrome/Edge with Quest Link.');
      if (controlsModal) controlsModal.hidden = false;
      return;
    }

    let supported = false;
    try {
      supported = await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      supported = false;
    }

    if (!supported) {
      showToast('No VR headset detected (immersive-vr unsupported here). Open on Meta Quest 3 Browser or connect via Quest Link.');
      if (controlsModal) controlsModal.hidden = false;
      return;
    }

    try {
      const xrCanvas = document.createElement('canvas');
      gl = xrCanvas.getContext('webgl2', {
        xrCompatible: true,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance'
      });
      if (!gl) throw new Error('WebGL2 context unavailable for WebXR.');

      initWebGLResources();

      xrSession = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      });

      window.__GTA5_VR_ACTIVE = true;
      if (vrPort) vrPort.postMessage({ vrActive: true, ack: true });
      if (vrBtn) vrBtn.textContent = 'Exit VR';
      needsRecenter = true;
      prevHeadYaw = null;
      prevHeadPitch = null;
      prevTime = 0;

      if (isWorldReady() && !autoFirstPersonDone) {
        autoFirstPersonDone = true;
        setTimeout(() => { if (xrSession) scheduleFirstPersonTriple(); }, 350);
      }

      xrSession.addEventListener('end', () => {
        xrSession = null;
        xrRefSpace = null;
        window.__GTA5_VR_ACTIVE = false;
        if (vrPort) vrPort.postMessage({ vrActive: false, ack: true });
        releaseAllVRInputs();
        if (vrBtn) vrBtn.textContent = 'VR Mode (Quest 3)';
      });

      await gl.makeXRCompatible();
      const layer = new XRWebGLLayer(xrSession, gl, { framebufferScaleFactor: 1.0 });
      xrSession.updateRenderState({ baseLayer: layer, depthNear: 0.1, depthFar: 100.0 });

      try {
        xrRefSpace = await xrSession.requestReferenceSpace('local-floor');
      } catch {
        xrRefSpace = await xrSession.requestReferenceSpace('local');
      }

      xrSession.requestAnimationFrame(onXRFrame);
    } catch (err) {
      xrSession = null;
      window.__GTA5_VR_ACTIVE = false;
      if (vrPort) vrPort.postMessage({ vrActive: false, ack: true });
      releaseAllVRInputs();
      if (vrBtn) vrBtn.textContent = 'VR Mode (Quest 3)';
      showToast('Failed to start WebXR session: ' + (err && err.message ? err.message : err));
    }
  }

  if (vrBtn) vrBtn.addEventListener('click', startVR);
  if (controlsBtn && controlsModal) controlsBtn.addEventListener('click', () => { controlsModal.hidden = !controlsModal.hidden; });
  if (controlsClose && controlsModal) controlsClose.addEventListener('click', () => { controlsModal.hidden = true; });
})();
