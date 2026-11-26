/* Meta Quest 3 WebXR runtime: Full-FOV VR Dome + Direct Worker ImageBitmap Stream + Complete Touch Plus Controls (incl. Phone, Weapons, Driving, Pause/Map). */
(() => {
  'use strict';

  const DEADZONE = 0.16;
  const LOOK_STICK_SPEED = 1150;
  const HEAD_LOOK_YAW_SENS = 780;
  const HEAD_LOOK_PITCH_SENS = 680;

  // Theater / Loading Screen curved panel dimensions
  const THEATER_RADIUS = 2.5;
  const THEATER_HEIGHT = 1.66;
  const THEATER_ARC = (70 * Math.PI) / 180;

  // Full-VR Immersive Dome dimensions (fills Quest 3 FOV edge-to-edge with no 2D monitor border)
  const DOME_RADIUS = 1.35;
  const DOME_HEIGHT = 2.05;
  const DOME_ARC = (108 * Math.PI) / 180;

  // Hidden quick-menu toolbar dimensions (only shown when toggled with Left Grip + Y)
  const BAR_RADIUS = 2.35;
  const BAR_HEIGHT = 0.26;
  const BAR_Y = -0.95;
  const BAR_ARC = (58 * Math.PI) / 180;

  let xrSession = null;
  let xrRefSpace = null;
  let gl = null;
  let glProgram = null;
  let rayProgram = null;
  let gameTex = null;
  let hudTex = null;
  let phoneHudTex = null;
  let theaterMesh = null;
  let domeMesh = null;
  let hudMesh = null;
  let phoneBannerMesh = null;
  let rayVao = null;
  let rayVbo = null;

  // Direct frame stream from wgpu_worker.js (works even when 2D browser window is closed/hidden)
  let vrPort = null;
  let latestBitmap = null;
  let hasNewBitmap = false;

  // VR State
  let drivingMode = false;
  let phoneMode = false;
  let headLookEnabled = true;
  let fullVrMode = true; // true = Full-FOV Immersive VR (no 2D screen borders); false = Curved Theater
  let vrOverlayOpen = false; // false during gameplay = zero 2D menus cluttering view; toggle with L-Grip + Y
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

  // Queued key pulses (120ms+ holds so GTA V's 30fps loop always registers taps)
  const activePulses = new Map();
  const scheduledPulses = [];

  function schedulePulse(code, holdMs = 130, delayMs = 0) {
    const now = performance.now();
    scheduledPulses.push({ code, startMs: now + delayMs, holdMs });
  }

  function scheduleFirstPersonTriple() {
    schedulePulse('KeyV', 130, 0);
    schedulePulse('KeyV', 130, 280);
    schedulePulse('KeyV', 130, 560);
  }

  // Edge latches
  let latchModeToggle = false;
  let latchPause = false;
  let latchOverlay = false;
  let latchPhoneToggle = false;
  let latchRecenter = false;
  let latchStoryBtn = false;
  let latchSandboxBtn = false;
  let latchMap6Btn = false;
  let latchCamClick = false;
  let latchPhoneDir = { up: false, down: false, left: false, right: false, ok: false, back: false };
  let latchNextWep = false;
  let latchPrevWep = false;
  let latchInteract = false;
  let latchSpecial = false;
  let xHoldStart = 0;
  const triggerLatches = { left: false, right: false };

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
  let lastHudSig = '';

  const phoneCanvas = document.createElement('canvas');
  phoneCanvas.width = 768;
  phoneCanvas.height = 80;
  const phoneCtx = phoneCanvas.getContext('2d');
  let lastPhoneSig = '';

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
      setTimeout(() => { if (xrSession) scheduleFirstPersonTriple(); }, 1200);
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

    Atomics.store(w, 6, 1); // FOCUS = 1
    Atomics.store(w, 7, vrMenuCursorMode ? 0 : 1); // LOCKED

    if (vrMenuCursorMode && cursorUV && typeof getSize === 'function') {
      const [W, H] = getSize();
      Atomics.store(w, 0, Math.max(0, Math.min(W - 1, Math.round(cursorUV.u * W))));
      Atomics.store(w, 1, Math.max(0, Math.min(H - 1, Math.round(cursorUV.v * H))));
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

  // ---- Math & Raycast Helpers ----
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

  function mat4FromQuatTranslation(q, x, y, z) {
    const { x: qx, y: qy, z: qz, w: qw } = q;
    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;
    return new Float32Array([
      1 - 2 * (yy + zz), 2 * (xy + wz),     2 * (xz - wy),     0,
      2 * (xy - wz),     1 - 2 * (xx + zz), 2 * (yz + wx),     0,
      2 * (xz + wy),     2 * (yz - wx),     1 - 2 * (xx + yy), 0,
      x,                 y,                 z,                 1
    ]);
  }

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
    const { x, y, z, w } = q;
    const ix = y * (-1);
    const iy = -x * (-1);
    const iz = w * (-1);
    const iw = -z * (-1);
    return [
      ix * w + iw * -x + iy * -z - iz * -y,
      iy * w + iw * -y + iz * -x - ix * -z,
      iz * w + iw * -z + ix * -y - iy * -x,
    ];
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
      if (hz >= 0) continue;
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
      uniform float u_uvShift;
      out vec4 fragColor;
      void main() {
        vec2 uv = vec2(clamp(v_uv.x + u_uvShift, 0.0, 1.0), v_uv.y);
        vec4 col = texture(u_tex, uv);
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
    glProgram.uUvShift = gl.getUniformLocation(glProgram, 'u_uvShift');

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

    theaterMesh = buildCurvedQuad(THEATER_RADIUS, THEATER_HEIGHT, THEATER_ARC, 0, 36);
    domeMesh = buildSphericalDome(DOME_RADIUS, DOME_ARC, (74 * Math.PI) / 180, 36, 20);
    hudMesh = buildCurvedQuad(BAR_RADIUS, BAR_HEIGHT, BAR_ARC, BAR_Y, 24);
    phoneBannerMesh = buildCurvedQuad(1.3, 0.14, (44 * Math.PI) / 180, -0.58, 16);

    rayVao = gl.createVertexArray();
    gl.bindVertexArray(rayVao);
    rayVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, rayVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 24, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    gameTex = createDynamicTexture();
    hudTex = createDynamicTexture();
    phoneHudTex = createDynamicTexture();
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
      verts.push(x, yOffset + height * 0.5, z, t, 0.0);
      verts.push(x, yOffset - height * 0.5, z, t, 1.0);
      if (i < segs) {
        const b = i * 2;
        indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
    }
    return uploadMesh(verts, indices);
  }

  function buildSphericalDome(radius, hArc, vArc, hSegs, vSegs) {
    const verts = [];
    const indices = [];
    for (let iy = 0; iy <= vSegs; iy++) {
      const v = iy / vSegs;
      const phi = (0.5 - v) * vArc; // +vArc/2 top, -vArc/2 bottom
      const cosPhi = Math.cos(phi);
      const y = Math.sin(phi) * radius;
      for (let ix = 0; ix <= hSegs; ix++) {
        const u = ix / hSegs;
        const theta = (u - 0.5) * hArc;
        const x = Math.sin(theta) * cosPhi * radius;
        const z = -Math.cos(theta) * cosPhi * radius;
        verts.push(x, y, z, u, v);
      }
    }
    const stride = hSegs + 1;
    for (let iy = 0; iy < vSegs; iy++) {
      for (let ix = 0; ix < hSegs; ix++) {
        const a = iy * stride + ix;
        const b = a + stride;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return uploadMesh(verts, indices);
  }

  function uploadMesh(verts, indices) {
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

  // ---- Interactive Loading Screen Canvas ----
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
    ctx.fillText('Point controller + Trigger (or press A / X / Y) · L-Stick Click opens Phone · L-Grip+Y opens VR Menu', 640, 610);

    gl.bindTexture(gl.TEXTURE_2D, gameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mirrorCanvas);
  }

  // ---- Hidden VR Quick Menu (L-Grip + Y to show/hide) ----
  const TOOLBAR_BUTTONS = [
    { id: 'firstperson', label: () => '1ST PERSON (V)' },
    { id: 'viewstyle',   label: () => fullVrMode ? 'VIEW: FULL VR' : 'VIEW: THEATER' },
    { id: 'mode',        label: () => drivingMode ? 'MODE: DRIVING' : 'MODE: ON FOOT' },
    { id: 'phone',       label: () => phoneMode ? 'PHONE: ON' : 'PHONE (UP)' },
    { id: 'headlook',    label: () => 'HEAD-LOOK: ' + (headLookEnabled ? 'ON' : 'OFF') },
    { id: 'cursor',      label: () => 'CURSOR: ' + (vrMenuCursorMode ? 'ON' : 'OFF') },
    { id: 'pause',       label: () => 'PAUSE / MAP' },
    { id: 'exit',        label: () => 'EXIT VR' },
  ];

  function activateToolbarButton(id) {
    if (id === 'firstperson') {
      scheduleFirstPersonTriple();
      vrOverlayOpen = false;
    } else if (id === 'viewstyle') {
      fullVrMode = !fullVrMode;
      needsRecenter = true;
    } else if (id === 'mode') {
      drivingMode = !drivingMode;
    } else if (id === 'phone') {
      togglePhoneMode();
      vrOverlayOpen = false;
    } else if (id === 'headlook') {
      headLookEnabled = !headLookEnabled;
      prevHeadYaw = null;
      prevHeadPitch = null;
    } else if (id === 'cursor') {
      vrMenuCursorMode = !vrMenuCursorMode;
    } else if (id === 'pause') {
      schedulePulse('Escape', 140, 0);
      vrMenuCursorMode = !vrMenuCursorMode;
      if (vrMenuCursorMode) fullVrMode = false;
    } else if (id === 'exit') {
      if (xrSession) xrSession.end();
    }
  }

  function togglePhoneMode() {
    phoneMode = !phoneMode;
    if (phoneMode) {
      schedulePulse('ArrowUp', 140, 0);
    } else {
      schedulePulse('Backspace', 120, 0);
      schedulePulse('Backspace', 120, 180);
    }
  }

  function updateHudTexture() {
    const sig = `${fullVrMode}|${drivingMode}|${phoneMode}|${headLookEnabled}|${vrMenuCursorMode}|${hoveredToolbarIdx}`;
    if (sig === lastHudSig) return;
    lastHudSig = sig;

    const c = hudCtx;
    c.clearRect(0, 0, 1280, 176);
    c.fillStyle = 'rgba(10, 18, 15, 0.92)';
    c.beginPath();
    c.roundRect(8, 8, 1264, 160, 18);
    c.fill();
    c.strokeStyle = 'rgba(124, 197, 118, 0.6)';
    c.lineWidth = 2;
    c.stroke();

    const padX = 18;
    const gap = 8;
    const btnW = (1280 - padX * 2 - gap * (TOOLBAR_BUTTONS.length - 1)) / TOOLBAR_BUTTONS.length;

    for (let i = 0; i < TOOLBAR_BUTTONS.length; i++) {
      const b = TOOLBAR_BUTTONS[i];
      const bx = padX + i * (btnW + gap);
      const hovered = hoveredToolbarIdx === i;
      const activeAccent =
        (b.id === 'viewstyle' && fullVrMode) ||
        (b.id === 'mode' && drivingMode) ||
        (b.id === 'phone' && phoneMode) ||
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
      c.font = 'bold 13px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(b.label(), bx + btnW / 2, 60);
    }

    c.textAlign = 'center';
    c.font = '17px system-ui, sans-serif';
    c.fillStyle = '#cbd5e1';
    c.fillText(
      'RT: Shoot | R-Grip: Aim | L-Stick Click: Phone | R-Stick Click: 1st Person | L-Grip+A: Interact (E) | L-Grip+Y: Hide Menu',
      640,
      134
    );

    gl.bindTexture(gl.TEXTURE_2D, hudTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hudCanvas);
  }

  function updatePhoneBannerTexture() {
    const sig = String(phoneMode);
    if (sig === lastPhoneSig) return;
    lastPhoneSig = sig;
    const c = phoneCtx;
    c.clearRect(0, 0, 768, 80);
    c.fillStyle = 'rgba(10, 22, 16, 0.88)';
    c.beginPath();
    c.roundRect(6, 6, 756, 68, 14);
    c.fill();
    c.strokeStyle = '#7cc576';
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = '#a7f3d0';
    c.font = 'bold 22px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('PHONE MODE: R-Stick Navigate · A Select/Detonate · B Back · L-Stick Click Close', 384, 48);

    gl.bindTexture(gl.TEXTURE_2D, phoneHudTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, phoneCanvas);
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
      setTimeout(() => { if (xrSession) scheduleFirstPersonTriple(); }, 1500);
    }

    const showBar = !ready || vrOverlayOpen;

    for (const src of session.inputSources) {
      if (src.gamepad) {
        if (src.handedness === 'left') leftPad = src.gamepad;
        else if (src.handedness === 'right') rightPad = src.gamepad;
      }

      // Only raycast lasers when loading screen, quick overlay, or menu cursor mode is active
      if (src.targetRaySpace && (showBar || vrMenuCursorMode)) {
        const rayPose = frame.getPose(src.targetRaySpace, xrRefSpace);
        if (rayPose) {
          const origin = rayPose.transform.position;
          const dir = transformRayDir(rayPose.transform.orientation);
          const localRay = worldToLocalRay(origin, dir, anchorPos[0], anchorPos[1], anchorPos[2], anchorYaw);
          const barHit = showBar ? intersectCurvedPanel(localRay, BAR_RADIUS, BAR_HEIGHT, BAR_ARC, BAR_Y) : null;
          const scrHit = (!ready || vrMenuCursorMode)
            ? intersectCurvedPanel(localRay, THEATER_RADIUS, THEATER_HEIGHT, THEATER_ARC, 0)
            : null;

          const hand = src.handedness === 'left' ? 'left' : 'right';
          const trigVal = src.gamepad && src.gamepad.buttons[0] ? src.gamepad.buttons[0].value : 0;
          const trigDown = trigVal > 0.55;
          const trigJustClicked = trigDown && !triggerLatches[hand];
          triggerLatches[hand] = trigDown;

          let hitDist = 2.8;
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

    const btn = (pad, idx) => !!(pad && pad.buttons[idx] && (pad.buttons[idx].pressed || pad.buttons[idx].value > 0.45));
    const trig = (pad, idx) => (pad && pad.buttons[idx] ? pad.buttons[idx].value : 0);
    const stick = (pad) => {
      if (!pad || !pad.axes) return [0, 0];
      if (pad.axes.length >= 4) {
        const ax = Math.abs(pad.axes[2]) > 0.02 || Math.abs(pad.axes[3]) > 0.02 ? pad.axes[2] : pad.axes[0];
        const ay = Math.abs(pad.axes[2]) > 0.02 || Math.abs(pad.axes[3]) > 0.02 ? pad.axes[3] : pad.axes[1];
        return [applyDeadzone(ax), applyDeadzone(ay)];
      }
      return [applyDeadzone(pad.axes[0]), applyDeadzone(pad.axes[1])];
    };

    const lGrip = btn(leftPad, 1);
    const rGrip = btn(rightPad, 1);
    const lTrig = trig(leftPad, 0);
    const rTrig = trig(rightPad, 0);
    const lStickClick = btn(leftPad, 3);
    const rStickClick = btn(rightPad, 3);
    const btnX = btn(leftPad, 4);
    const btnY = btn(leftPad, 5);
    const btnA = btn(rightPad, 4);
    const btnB = btn(rightPad, 5);

    // Loading screen direct controller shortcuts
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

    // ---- Combos ----
    // 1. Left Grip + Right Grip -> Switch On-Foot / Driving
    const comboMode = lGrip && rGrip;
    if (comboMode && !latchModeToggle) { drivingMode = !drivingMode; latchModeToggle = true; }
    else if (!comboMode) latchModeToggle = false;

    // 2. Left Stick Click + Right Stick Click -> Pause Menu (Esc)
    const comboPause = lStickClick && rStickClick;
    if (comboPause && !latchPause) {
      schedulePulse('Escape', 140, 0);
      vrMenuCursorMode = !vrMenuCursorMode;
      if (vrMenuCursorMode) { fullVrMode = false; vrOverlayOpen = true; }
      else { fullVrMode = true; vrOverlayOpen = false; }
      latchPause = true;
    } else if (!comboPause) latchPause = false;

    // 3. Left Grip + Y -> Toggle VR Quick Overlay Menu
    const comboOverlay = lGrip && btnY;
    if (comboOverlay && !latchOverlay) {
      vrOverlayOpen = !vrOverlayOpen;
      if (vrOverlayOpen && !fullVrMode) needsRecenter = true;
      latchOverlay = true;
    } else if (!comboOverlay) latchOverlay = false;

    // 4. X + Y -> Recenter view
    const comboRecenter = btnX && btnY;
    if (comboRecenter && !latchRecenter) {
      needsRecenter = true;
      latchRecenter = true;
    } else if (!comboRecenter) latchRecenter = false;

    const [lx, ly] = stick(leftPad);
    const [rx, ry] = stick(rightPad);

    const anyCombo = comboMode || comboPause || comboOverlay || comboRecenter;

    // Left Stick always moves character / steers
    if (!vrMenuCursorMode) {
      if (lx < -0.15) nextKeys.add('KeyA');
      if (lx > 0.15) nextKeys.add('KeyD');
      if (!drivingMode) {
        if (ly < -0.15) nextKeys.add('KeyW');
        if (ly > 0.15) nextKeys.add('KeyS');
      } else {
        // Aircraft / bike pitch on Left Stick Up/Down via Numpad8/2 (aliased harmlessly for cars)
        if (ly < -0.35) nextKeys.add('Numpad8');
        if (ly > 0.35) nextKeys.add('Numpad2');
      }
    }

    if (!anyCombo && ready) {
      // Right Stick Click -> Cycle Camera / First Person (V)
      if (rStickClick && !latchCamClick) {
        schedulePulse('KeyV', 140, 0);
        latchCamClick = true;
      } else if (!rStickClick) latchCamClick = false;

      if (vrMenuCursorMode) {
        // Pause / Map cursor mode
        if (ly < -0.35) nextKeys.add('ArrowUp');
        if (ly > 0.35) nextKeys.add('ArrowDown');
        if (lx < -0.35) nextKeys.add('ArrowLeft');
        if (lx > 0.35) nextKeys.add('ArrowRight');
        if (hoveredToolbarIdx < 0 && rTrig > 0.35) nextMouse |= 1;
        if (btnA) nextKeys.add('Enter');
        if (btnB) nextKeys.add('Backspace');
      } else if (phoneMode) {
        // Phone navigation mode (Left Stick Click toggles back to combat)
        if (lStickClick && !latchPhoneToggle) { togglePhoneMode(); latchPhoneToggle = true; }
        else if (!lStickClick) latchPhoneToggle = false;

        if (ry < -0.45 && !latchPhoneDir.up) { schedulePulse('ArrowUp', 120, 0); latchPhoneDir.up = true; }
        else if (ry >= -0.3) latchPhoneDir.up = false;

        if (ry > 0.45 && !latchPhoneDir.down) { schedulePulse('ArrowDown', 120, 0); latchPhoneDir.down = true; }
        else if (ry <= 0.3) latchPhoneDir.down = false;

        if (rx < -0.45 && !latchPhoneDir.left) { schedulePulse('ArrowLeft', 120, 0); latchPhoneDir.left = true; }
        else if (rx >= -0.3) latchPhoneDir.left = false;

        if (rx > 0.45 && !latchPhoneDir.right) { schedulePulse('ArrowRight', 120, 0); latchPhoneDir.right = true; }
        else if (rx <= 0.3) latchPhoneDir.right = false;

        if ((btnA || rTrig > 0.5) && !latchPhoneDir.ok) { schedulePulse('Enter', 130, 0); latchPhoneDir.ok = true; }
        else if (!btnA && rTrig <= 0.3) latchPhoneDir.ok = false;

        if (btnB && !latchPhoneDir.back) { schedulePulse('Backspace', 130, 0); latchPhoneDir.back = true; }
        else if (!btnB) latchPhoneDir.back = false;
      } else if (drivingMode) {
        // Driving / Flying controls
        if (rTrig > 0.12) nextKeys.add('KeyW'); // Accelerate
        if (lTrig > 0.12) nextKeys.add('KeyS'); // Brake / Reverse
        if (rGrip || btnA) nextKeys.add('Space'); // Handbrake
        if (btnB) nextMouse |= 1;                 // Drive-by Fire
        if (btnX) nextKeys.add('KeyQ');           // Radio Wheel
        if (btnY) nextKeys.add('KeyF');           // Exit Vehicle
        if (lGrip && btnA) nextKeys.add('KeyH');  // Headlights
        else if (lGrip) nextKeys.add('KeyH');
        if (lStickClick) nextKeys.add('KeyE');    // Horn
      } else {
        // On-Foot Combat & Exploration Controls
        if (lGrip) {
          // Left Grip Modifier Layer (Weapon Wheel + Quick Actions)
          nextKeys.add('Tab'); // Hold Left Grip = Weapon Wheel (Right Stick selects weapon)

          if (btnA && !latchInteract) { schedulePulse('KeyE', 140, 0); latchInteract = true; }
          else if (!btnA) latchInteract = false;

          if (btnB) nextKeys.add('ControlLeft'); // Stealth / Crouch

          if (btnX) {
            if (!xHoldStart) xHoldStart = performance.now();
            if (performance.now() - xHoldStart > 420) nextKeys.add('AltLeft'); // Character Switch Wheel
          } else if (xHoldStart) {
            if (performance.now() - xHoldStart <= 420) schedulePulse('CapsLock', 130, 0); // Special Ability
            xHoldStart = 0;
          }

          if (rTrig > 0.45 && !latchNextWep) { dz += 1; latchNextWep = true; }
          else if (rTrig <= 0.25) latchNextWep = false;

          if (lTrig > 0.45 && !latchPrevWep) { dz -= 1; latchPrevWep = true; }
          else if (lTrig <= 0.25) latchPrevWep = false;
        } else {
          // Standard On-Foot (Right Trigger ALWAYS fires when overlay is closed!)
          if (!(vrOverlayOpen && hoveredToolbarIdx >= 0) && rTrig > 0.15) nextMouse |= 1; // SHOOT (Mouse Left)
          if (rGrip) nextMouse |= 2;                                                    // AIM (Mouse Right)
          if (lTrig > 0.15) nextKeys.add('ShiftLeft');                                  // SPRINT
          if (btnA) nextKeys.add('Space');                                              // JUMP / CLIMB
          if (btnB) nextKeys.add('KeyR');                                               // RELOAD / MELEE
          if (btnX) nextKeys.add('KeyQ');                                               // TAKE COVER
          if (btnY) nextKeys.add('KeyF');                                               // ENTER / EXIT VEHICLE

          // Left Stick Click -> Open Phone & enter Phone Navigation Mode
          if (lStickClick && !latchPhoneToggle) { togglePhoneMode(); latchPhoneToggle = true; }
          else if (!lStickClick) latchPhoneToggle = false;
        }
      }
    } else {
      if (!lStickClick) latchPhoneToggle = false;
      if (!rStickClick) latchCamClick = false;
    }

    // Camera Look: Right Thumbstick (when not in Phone / Menu Cursor) + Headset Head-Look
    let dx = 0, dy = 0;
    if (!vrMenuCursorMode) {
      if (!phoneMode) {
        remLookX += rx * LOOK_STICK_SPEED * dt;
        remLookY += ry * LOOK_STICK_SPEED * dt;
      }

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

    const ready = isWorldReady();
    const { yaw } = quatToYawPitch(pose.transform.orientation);
    const p = pose.transform.position;

    if (needsRecenter || (!ready && false)) {
      anchorYaw = yaw;
      anchorPos = [p.x, p.y, p.z];
      needsRecenter = false;
    }

    const baseLayer = xrSession.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

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

    const showBar = !ready || vrOverlayOpen;
    if (showBar) updateHudTexture();
    if (ready && phoneMode) updatePhoneBannerTexture();

    // In Full-VR mode during gameplay, lock dome to head pose so world fills 100% of vision with zero 2D borders
    const useFullDome = ready && fullVrMode && !vrMenuCursorMode;
    const screenModelMat = useFullDome
      ? mat4FromQuatTranslation(pose.transform.orientation, p.x, p.y, p.z)
      : mat4FromTranslationYaw(anchorPos[0], anchorPos[1], anchorPos[2], anchorYaw);

    const hudModelMat = mat4FromTranslationYaw(p.x, p.y, p.z, yaw);

    for (let eyeIdx = 0; eyeIdx < pose.views.length; eyeIdx++) {
      const view = pose.views[eyeIdx];
      const vp = baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const vpMat = mat4Multiply(view.projectionMatrix, viewMat);
      const mvp = mat4Multiply(vpMat, screenModelMat);

      gl.useProgram(glProgram);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(glProgram.uMvp, false, mvp);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gameTex);
      gl.uniform1i(glProgram.uTex, 0);
      gl.uniform1f(glProgram.uAlpha, 1.0);
      // Subtle per-eye convergence shift in Full-VR mode for comfortable infinity/mid-ground focus
      const stereoShift = useFullDome ? (view.eye === 'left' ? -0.0022 : view.eye === 'right' ? 0.0022 : 0.0) : 0.0;
      gl.uniform1f(glProgram.uUvShift, stereoShift);

      const activeMesh = useFullDome ? domeMesh : theaterMesh;
      gl.bindVertexArray(activeMesh.vao);
      gl.drawElements(gl.TRIANGLES, activeMesh.count, gl.UNSIGNED_SHORT, 0);

      gl.uniform1f(glProgram.uUvShift, 0.0);

      // Minimal Phone Mode helper strip only when Phone Mode is active
      if (ready && phoneMode) {
        const phoneMvp = mat4Multiply(vpMat, hudModelMat);
        gl.uniformMatrix4fv(glProgram.uMvp, false, phoneMvp);
        gl.bindTexture(gl.TEXTURE_2D, phoneHudTex);
        gl.uniform1f(glProgram.uAlpha, 0.94);
        gl.bindVertexArray(phoneBannerMesh.vao);
        gl.drawElements(gl.TRIANGLES, phoneBannerMesh.count, gl.UNSIGNED_SHORT, 0);
      }

      // VR Quick Menu toolbar ONLY when loading OR explicitly opened with Left Grip + Y
      if (showBar) {
        const barBaseMat = useFullDome ? hudModelMat : screenModelMat;
        const barMvp = mat4Multiply(vpMat, barBaseMat);
        gl.uniformMatrix4fv(glProgram.uMvp, false, barMvp);
        gl.bindTexture(gl.TEXTURE_2D, hudTex);
        gl.uniform1f(glProgram.uAlpha, 0.96);
        gl.bindVertexArray(hudMesh.vao);
        gl.drawElements(gl.TRIANGLES, hudMesh.count, gl.UNSIGNED_SHORT, 0);
      }

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
      vrOverlayOpen = false;
      fullVrMode = true;
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
        phoneMode = false;
        vrMenuCursorMode = false;
        vrOverlayOpen = false;
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
