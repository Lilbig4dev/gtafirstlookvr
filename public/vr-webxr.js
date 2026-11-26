/* Meta Quest 3 WebXR runtime: Full 360 Spherical VR World Projection + Complete Touch Plus Controls (Combat, Character Switch, Weapon Wheel, Phone/Detonator, Driving, Menus). */
(() => {
  'use strict';

  const DEADZONE = 0.14;
  const LOOK_STICK_SPEED = 1150;
  const HEAD_LOOK_YAW_SENS = 560;
  const HEAD_LOOK_PITCH_SENS = 500;

  // Full 360x180 Immersive VR Sphere (optical infinity, zero 2D box borders)
  const SPHERE_RADIUS = 20.0;
  // Game perspective frustum mapped cleanly at exact 16:9 aspect ratio (66° vertical FOV, ~98° horizontal FOV)
  const GAME_V_FOV_DEG = 66.0;
  const TAN_HALF_V = Math.tan((GAME_V_FOV_DEG * Math.PI) / 360);
  const TAN_HALF_H = TAN_HALF_V * (16 / 9);

  // Loading Screen / Pause Menu curved theater panel
  const THEATER_RADIUS = 2.4;
  const THEATER_H_ARC = (72 * Math.PI) / 180;
  const THEATER_HEIGHT = THEATER_RADIUS * THEATER_H_ARC * (9 / 16);

  // Quick Menu Toolbar (hidden during play; toggle with Left Grip + Y)
  const BAR_RADIUS = 2.0;
  const BAR_HEIGHT = 0.28;
  const BAR_Y = -0.74;
  const BAR_ARC = (64 * Math.PI) / 180;

  // Compact active-mode status strip (only shown when Phone / Driving / Char Switch / Weapon Wheel is active)
  const STATUS_RADIUS = 1.9;
  const STATUS_HEIGHT = 0.12;
  const STATUS_Y = -0.66;
  const STATUS_ARC = (44 * Math.PI) / 180;

  let xrSession = null;
  let xrRefSpace = null;
  let gl = null;
  let sphereProgram = null;
  let flatProgram = null;
  let rayProgram = null;
  let gameTex = null;
  let hudTex = null;
  let statusTex = null;
  let sphereMesh = null;
  let theaterMesh = null;
  let hudMesh = null;
  let statusMesh = null;
  let rayVao = null;
  let rayVbo = null;

  // Worker frame streaming
  let vrPort = null;
  let latestBitmap = null;
  let hasNewBitmap = false;

  // VR States
  let drivingMode = false;
  let phoneMode = false;
  let headLookEnabled = true;
  let invertPitchY = false;
  let vrOverlayOpen = false;
  let vrMenuCursorMode = false;

  // WebXR direct trigger/squeeze event tracking (backup in case gamepad.buttons lags or uses transient triggers)
  const xrSelectHeld = { left: false, right: false };
  const xrSqueezeHeld = { left: false, right: false };

  let prevHeadYaw = null;
  let prevHeadPitch = null;
  let anchorYaw = 0;
  let anchorPos = [0, 1.5, 0];
  let needsRecenter = true;

  let ownedKeys = new Set();
  let ownedMouse = 0;
  let remLookX = 0;
  let remLookY = 0;
  let prevTime = 0;
  let autoFirstPersonDone = false;

  // Key pulse queue
  const activePulses = new Map();
  const scheduledPulses = [];

  function schedulePulse(code, holdMs = 150, delayMs = 0, charCode = 0, mouseBit = 0) {
    const now = performance.now();
    scheduledPulses.push({ code, startMs: now + delayMs, holdMs, charCode, mouseBit });
  }

  function scheduleFirstPersonCycle() {
    schedulePulse('KeyV', 140, 0);
    schedulePulse('KeyV', 140, 320);
    schedulePulse('KeyV', 140, 640);
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
  let latchGrenade = false;
  let latchSkip = false;
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
  hudCanvas.height = 200;
  const hudCtx = hudCanvas.getContext('2d');
  let lastHudSig = '';

  const statusCanvas = document.createElement('canvas');
  statusCanvas.width = 896;
  statusCanvas.height = 72;
  const statusCtx = statusCanvas.getContext('2d');
  let lastStatusSig = '';

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
      setTimeout(() => { if (xrSession) scheduleFirstPersonCycle(); }, 1200);
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

  function getFreshViews() {
    const inp = window.__GTA5_INPUT__;
    if (!inp) return null;
    if (typeof inp.getViews === 'function') return { ...inp.getViews(), VK: inp.VK, getSize: inp.getSize, pushChar: inp.pushChar };
    return { keys: inp.keys, w: inp.w, VK: inp.VK, getSize: inp.getSize, pushChar: inp.pushChar };
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
    xrSelectHeld.left = false;
    xrSelectHeld.right = false;
    xrSqueezeHeld.left = false;
    xrSqueezeHeld.right = false;
    activePulses.clear();
    scheduledPulses.length = 0;
  }

  function writeInputs(nextKeys, nextMouse, dx, dy, dz, cursorUV) {
    const v = getFreshViews();
    if (!v) return;
    const { keys, w, VK, getSize, pushChar } = v;

    const now = performance.now();
    for (let i = scheduledPulses.length - 1; i >= 0; i--) {
      const p = scheduledPulses[i];
      if (now >= p.startMs) {
        scheduledPulses.splice(i, 1);
        activePulses.set(p.code, { until: now + p.holdMs, mouseBit: p.mouseBit || 0 });
        if (p.charCode && typeof pushChar === 'function') {
          pushChar(p.charCode);
        }
      }
    }
    for (const [code, info] of activePulses) {
      if (now < info.until) {
        nextKeys.add(code);
        if (info.mouseBit) nextMouse |= info.mouseBit;
      } else {
        activePulses.delete(code);
      }
    }

    Atomics.store(w, 6, 1); // FOCUS = 1
    Atomics.store(w, 7, vrMenuCursorMode ? 0 : 1); // LOCKED

    let W = 1280, H = 720;
    if (typeof getSize === 'function') {
      const s = getSize();
      if (s && s[0] && s[1]) { W = s[0]; H = s[1]; }
    }

    if (vrMenuCursorMode && cursorUV) {
      Atomics.store(w, 0, Math.max(0, Math.min(W - 1, Math.round(cursorUV.u * W))));
      Atomics.store(w, 1, Math.max(0, Math.min(H - 1, Math.round(cursorUV.v * H))));
    } else {
      Atomics.store(w, 0, W >> 1);
      Atomics.store(w, 1, H >> 1);
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

  // ---- Math Helpers ----
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

  // Level-horizon rotation matrix (Yaw then Pitch, zero roll wobble)
  function mat4FromTranslationYawPitch(x, y, z, yaw, pitch) {
    // R = Ry(-yaw) * Rx(pitch)
    // Facing dir with yaw=0, pitch=0 is (0, 0, -1). Turning right makes yaw > 0 -> Ry(-yaw) rotates -Z toward +X.
    const cy = Math.cos(-yaw);
    const sy = Math.sin(-yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    return new Float32Array([
      cy,       0,      -sy,     0,
      sy * sp,  cp,      cy * sp, 0,
      sy * cp, -sp,      cy * cp, 0,
      x,        y,       z,      1
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

  function extractHeadYawPitch(orientation) {
    const dir = transformRayDir(orientation);
    const yaw = Math.atan2(dir[0], -dir[2]);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
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
    // 1. Full 360x180 Immersive VR Spherical Reprojection Shader
    // Reprojects the rectilinear 16:9 game frame across true 3D rays (zero curvature distortion, zero stretching)
    // and smoothly blurs/extends the sky, horizon, and ground across the entire 360 sphere so there are ZERO 2D box borders.
    const sVs = `#version 300 es
      layout(location = 0) in vec3 a_pos;
      uniform mat4 u_mvp;
      out vec3 v_dir;
      void main() {
        gl_Position = u_mvp * vec4(a_pos, 1.0);
        v_dir = a_pos;
      }
    `;
    const sFs = `#version 300 es
      precision highp float;
      in vec3 v_dir;
      uniform sampler2D u_tex;
      uniform float u_tanHalfH;
      uniform float u_tanHalfV;
      uniform float u_stereoOffset;
      out vec4 fragColor;

      vec3 sampleEdgeBlurred(vec2 uv, float blurAmt) {
        float o = blurAmt * 0.032;
        vec3 acc = texture(u_tex, uv).rgb * 0.36;
        acc += texture(u_tex, clamp(uv + vec2( o,  0.0), 0.002, 0.998)).rgb * 0.16;
        acc += texture(u_tex, clamp(uv + vec2(-o,  0.0), 0.002, 0.998)).rgb * 0.16;
        acc += texture(u_tex, clamp(uv + vec2(0.0,  o),  0.002, 0.998)).rgb * 0.16;
        acc += texture(u_tex, clamp(uv + vec2(0.0, -o),  0.002, 0.998)).rgb * 0.16;
        return acc;
      }

      void main() {
        vec3 d = normalize(v_dir);
        // Pinhole camera look-ahead (+Z away behind viewer, -Z straight ahead)
        float frontZ = max(-d.z, 0.18);
        vec2 proj = vec2(d.x, d.y) / frontZ;
        vec2 rawUV = vec2(
          0.5 + 0.5 * (proj.x / u_tanHalfH) + u_stereoOffset,
          0.5 - 0.5 * (proj.y / u_tanHalfV)
        );
        vec2 clampedUV = clamp(rawUV, vec2(0.002), vec2(0.998));

        vec2 over = max(vec2(0.0) - rawUV, rawUV - vec2(1.0));
        float outDist = max(0.0, max(over.x, over.y));

        vec3 core = texture(u_tex, clampedUV).rgb;
        if (outDist <= 0.0005 && d.z < 0.0) {
          fragColor = vec4(core, 1.0);
          return;
        }

        float blurAmt = smoothstep(0.0, 0.45, outDist + max(0.0, d.z) * 0.6);
        vec3 ext = sampleEdgeBlurred(clampedUV, blurAmt);
        // Gentle darkening far behind head (> 105 deg off-axis)
        float rearDim = 1.0 - 0.55 * smoothstep(-0.15, 0.75, d.z);
        vec3 finalRgb = mix(core, ext, clamp(blurAmt, 0.0, 1.0)) * rearDim;
        fragColor = vec4(finalRgb, 1.0);
      }
    `;
    sphereProgram = gl.createProgram();
    gl.attachShader(sphereProgram, createShader(gl.VERTEX_SHADER, sVs));
    gl.attachShader(sphereProgram, createShader(gl.FRAGMENT_SHADER, sFs));
    gl.linkProgram(sphereProgram);
    sphereProgram.uMvp = gl.getUniformLocation(sphereProgram, 'u_mvp');
    sphereProgram.uTex = gl.getUniformLocation(sphereProgram, 'u_tex');
    sphereProgram.uTanHalfH = gl.getUniformLocation(sphereProgram, 'u_tanHalfH');
    sphereProgram.uTanHalfV = gl.getUniformLocation(sphereProgram, 'u_tanHalfV');
    sphereProgram.uStereoOffset = gl.getUniformLocation(sphereProgram, 'u_stereoOffset');

    // 2. Curved UI / Theater / Menu Shader
    const fVs = `#version 300 es
      layout(location = 0) in vec3 a_pos;
      layout(location = 1) in vec2 a_uv;
      uniform mat4 u_mvp;
      out vec2 v_uv;
      void main() {
        gl_Position = u_mvp * vec4(a_pos, 1.0);
        v_uv = a_uv;
      }
    `;
    const fFs = `#version 300 es
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
    flatProgram = gl.createProgram();
    gl.attachShader(flatProgram, createShader(gl.VERTEX_SHADER, fVs));
    gl.attachShader(flatProgram, createShader(gl.FRAGMENT_SHADER, fFs));
    gl.linkProgram(flatProgram);
    flatProgram.uMvp = gl.getUniformLocation(flatProgram, 'u_mvp');
    flatProgram.uTex = gl.getUniformLocation(flatProgram, 'u_tex');
    flatProgram.uAlpha = gl.getUniformLocation(flatProgram, 'u_alpha');

    // 3. Laser Pointer Shader
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

    sphereMesh = buildFullSphere(SPHERE_RADIUS, 48, 32);
    theaterMesh = buildCurvedQuad(THEATER_RADIUS, THEATER_HEIGHT, THEATER_H_ARC, 0, 36);
    hudMesh = buildCurvedQuad(BAR_RADIUS, BAR_HEIGHT, BAR_ARC, BAR_Y, 24);
    statusMesh = buildCurvedQuad(STATUS_RADIUS, STATUS_HEIGHT, STATUS_ARC, STATUS_Y, 16);

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
    statusTex = createDynamicTexture();
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

  function buildFullSphere(radius, hSegs, vSegs) {
    const verts = [];
    const indices = [];
    for (let iy = 0; iy <= vSegs; iy++) {
      const phi = (0.5 - iy / vSegs) * Math.PI; // +pi/2 zenith to -pi/2 nadir
      const cosPhi = Math.cos(phi);
      const y = Math.sin(phi) * radius;
      for (let ix = 0; ix <= hSegs; ix++) {
        const theta = (ix / hSegs) * Math.PI * 2;
        const x = Math.sin(theta) * cosPhi * radius;
        const z = -Math.cos(theta) * cosPhi * radius;
        verts.push(x, y, z);
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
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: indices.length };
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

  // ---- Loading Screen Interactive Canvas ----
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
    ctx.font = 'bold 50px system-ui, sans-serif';
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
    ctx.fillText('Point + Trigger (or A / X / Y) · L-Grip+Y: VR Menu · L-Grip+X: Char Switch · L-Stick: Phone', 640, 610);

    gl.bindTexture(gl.TEXTURE_2D, gameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mirrorCanvas);
  }

  // ---- VR Quick Menu (L-Grip + Y) ----
  const TOOLBAR_BUTTONS = [
    { id: 'michael',     label: () => 'MICHAEL (F5)' },
    { id: 'franklin',    label: () => 'FRANKLIN (F6)' },
    { id: 'trevor',      label: () => 'TREVOR (F7)' },
    { id: 'firstperson', label: () => '1ST PERSON' },
    { id: 'phone',       label: () => phoneMode ? 'PHONE: ON' : 'PHONE' },
    { id: 'mode',        label: () => drivingMode ? 'DRIVING' : 'ON FOOT' },
    { id: 'headlook',    label: () => 'HEAD: ' + (headLookEnabled ? 'ON' : 'OFF') },
    { id: 'inverty',     label: () => 'INV Y: ' + (invertPitchY ? 'ON' : 'OFF') },
    { id: 'pause',       label: () => 'PAUSE / MAP' },
    { id: 'recenter',    label: () => 'RECENTER' },
    { id: 'exit',        label: () => 'EXIT VR' },
  ];

  function activateToolbarButton(id) {
    if (id === 'michael') {
      schedulePulse('F5', 180, 0);
      vrOverlayOpen = false;
    } else if (id === 'franklin') {
      schedulePulse('F6', 180, 0);
      vrOverlayOpen = false;
    } else if (id === 'trevor') {
      schedulePulse('F7', 180, 0);
      vrOverlayOpen = false;
    } else if (id === 'firstperson') {
      scheduleFirstPersonCycle();
      vrOverlayOpen = false;
    } else if (id === 'phone') {
      togglePhoneMode();
      vrOverlayOpen = false;
    } else if (id === 'mode') {
      drivingMode = !drivingMode;
    } else if (id === 'headlook') {
      headLookEnabled = !headLookEnabled;
      prevHeadYaw = null;
      prevHeadPitch = null;
    } else if (id === 'inverty') {
      invertPitchY = !invertPitchY;
    } else if (id === 'pause') {
      schedulePulse('Escape', 150, 0);
      vrMenuCursorMode = !vrMenuCursorMode;
      vrOverlayOpen = vrMenuCursorMode;
    } else if (id === 'recenter') {
      needsRecenter = true;
    } else if (id === 'exit') {
      if (xrSession) xrSession.end();
    }
  }

  function togglePhoneMode() {
    phoneMode = !phoneMode;
    if (phoneMode) {
      schedulePulse('ArrowUp', 160, 0, 0, 4);
      schedulePulse('Numpad8', 160, 0);
    } else {
      schedulePulse('Backspace', 140, 0, 8, 2);
      schedulePulse('Escape', 140, 160);
    }
  }

  function updateHudTexture() {
    const sig = `${drivingMode}|${phoneMode}|${headLookEnabled}|${invertPitchY}|${vrMenuCursorMode}|${hoveredToolbarIdx}`;
    if (sig === lastHudSig) return;
    lastHudSig = sig;

    const c = hudCtx;
    c.clearRect(0, 0, 1280, 200);
    c.fillStyle = 'rgba(8, 16, 12, 0.94)';
    c.beginPath();
    c.roundRect(8, 8, 1264, 184, 16);
    c.fill();
    c.strokeStyle = 'rgba(124, 197, 118, 0.65)';
    c.lineWidth = 2;
    c.stroke();

    const padX = 14;
    const gap = 6;
    const btnW = (1280 - padX * 2 - gap * (TOOLBAR_BUTTONS.length - 1)) / TOOLBAR_BUTTONS.length;

    for (let i = 0; i < TOOLBAR_BUTTONS.length; i++) {
      const b = TOOLBAR_BUTTONS[i];
      const bx = padX + i * (btnW + gap);
      const hovered = hoveredToolbarIdx === i;
      const activeAccent =
        (b.id === 'phone' && phoneMode) ||
        (b.id === 'inverty' && invertPitchY) ||
        (b.id === 'headlook' && headLookEnabled) ||
        (b.id === 'mode' && drivingMode) ||
        (b.id === 'pause' && vrMenuCursorMode);

      c.fillStyle = hovered ? '#2d6b4d' : activeAccent ? '#1a4230' : '#12211b';
      c.beginPath();
      c.roundRect(bx, 18, btnW, 74, 10);
      c.fill();
      c.strokeStyle = hovered ? '#a7f3d0' : activeAccent ? '#7cc576' : '#415e51';
      c.lineWidth = hovered ? 3 : 1.5;
      c.stroke();

      c.fillStyle = b.id === 'exit' ? '#fca5a5' : '#ffffff';
      c.font = 'bold 12px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(b.label(), bx + btnW / 2, 60);
    }

    c.textAlign = 'center';
    c.font = '15px system-ui, sans-serif';
    c.fillStyle = '#cbd5e1';
    c.fillText(
      'RT: Shoot | R-Grip: Aim | L-Grip: Weapon Wheel | L-Grip+X: Char Switch | L-Grip+A: Interact (E) | L-Stick Click: Phone',
      640,
      126
    );
    c.fillStyle = '#94a3b8';
    c.fillText(
      'L-Grip+B: Stealth/Crouch | R-Grip+B: Grenade/Detonate | L-Grip+L-Stick: Pause | L+R Grip: Driving | L+R Stick: Recenter',
      640,
      154
    );

    gl.bindTexture(gl.TEXTURE_2D, hudTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hudCanvas);
  }

  function updateStatusTexture(text) {
    if (text === lastStatusSig) return;
    lastStatusSig = text;
    const c = statusCtx;
    c.clearRect(0, 0, 896, 72);
    c.fillStyle = 'rgba(8, 20, 14, 0.88)';
    c.beginPath();
    c.roundRect(6, 6, 884, 60, 14);
    c.fill();
    c.strokeStyle = '#7cc576';
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = '#d1fae5';
    c.font = 'bold 20px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(text, 448, 44);

    gl.bindTexture(gl.TEXTURE_2D, statusTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, statusCanvas);
  }

  function getStickAxes(pad) {
    if (!pad || !pad.axes || pad.axes.length === 0) return [0, 0];
    let x = pad.axes[0] || 0;
    let y = pad.axes[1] || 0;
    if (pad.axes.length >= 4 && Math.abs(x) < 0.02 && Math.abs(y) < 0.02) {
      if (Math.abs(pad.axes[2]) > 0.02 || Math.abs(pad.axes[3]) > 0.02) {
        x = pad.axes[2];
        y = pad.axes[3];
      }
    }
    return [applyDeadzone(x), applyDeadzone(y)];
  }

  let activeStatusText = '';

  // ---- Quest 3 Input & Raycast Processing ----
  function processQuestInputs(session, frame, pose, dt) {
    const nextKeys = new Set();
    let nextMouse = 0;
    let dz = 0;
    let leftPad = null;
    let rightPad = null;
    const raysToDraw = [];
    activeStatusText = '';

    hoveredToolbarIdx = -1;
    hoveredLoadBtn = null;
    screenCursorUV = null;

    const ready = isWorldReady();
    if (ready && !autoFirstPersonDone && window.__GTA5_INPUT__) {
      autoFirstPersonDone = true;
      setTimeout(() => { if (xrSession) scheduleFirstPersonCycle(); }, 1500);
    }

    const showBar = !ready || vrOverlayOpen;

    for (const src of session.inputSources) {
      // Ignore hand-tracking stub sources so physical Touch Plus controllers never get overwritten
      if (src.gamepad && !src.hand && src.gamepad.buttons && src.gamepad.buttons.length > 0) {
        if (src.handedness === 'left') leftPad = src.gamepad;
        else if (src.handedness === 'right') rightPad = src.gamepad;
      }

      if (src.targetRaySpace && (showBar || vrMenuCursorMode)) {
        const rayPose = frame.getPose(src.targetRaySpace, xrRefSpace);
        if (rayPose) {
          const origin = rayPose.transform.position;
          const dir = transformRayDir(rayPose.transform.orientation);
          const localRay = worldToLocalRay(origin, dir, anchorPos[0], anchorPos[1], anchorPos[2], anchorYaw);
          const barHit = showBar ? intersectCurvedPanel(localRay, BAR_RADIUS, BAR_HEIGHT, BAR_ARC, BAR_Y) : null;
          const scrHit = (!ready || vrMenuCursorMode)
            ? intersectCurvedPanel(localRay, THEATER_RADIUS, THEATER_HEIGHT, THEATER_H_ARC, 0)
            : null;

          const hand = src.handedness === 'left' ? 'left' : 'right';
          const b0 = src.gamepad && src.gamepad.buttons && src.gamepad.buttons[0];
          const trigDown = !!(b0 && (b0.pressed || b0.value > 0.45)) || xrSelectHeld[hand];
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

    const btn = (pad, idx) => !!(pad && pad.buttons[idx] && (pad.buttons[idx].pressed || pad.buttons[idx].value > 0.35));
    const trig = (pad, idx) => (pad && pad.buttons[idx] ? Math.max(pad.buttons[idx].value || 0, pad.buttons[idx].pressed ? 1 : 0) : 0);

    const lGrip = btn(leftPad, 1) || xrSqueezeHeld.left;
    const rGrip = btn(rightPad, 1) || xrSqueezeHeld.right;
    const lTrig = Math.max(trig(leftPad, 0), xrSelectHeld.left ? 1 : 0);
    const rTrig = Math.max(trig(rightPad, 0), xrSelectHeld.right ? 1 : 0);
    const lStickClick = btn(leftPad, 3);
    const rStickClick = btn(rightPad, 3);
    const btnX = btn(leftPad, 4);
    const btnY = btn(leftPad, 5);
    const btnA = btn(rightPad, 4);
    const btnB = btn(rightPad, 5);

    // Direct loading screen button shortcuts
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
    // 1. Left Grip + Right Grip: Switch On-Foot <-> Driving Mode
    const comboMode = lGrip && rGrip;
    if (comboMode && !latchModeToggle) { drivingMode = !drivingMode; latchModeToggle = true; }
    else if (!comboMode) latchModeToggle = false;

    // 2. Left Stick Click + Right Stick Click: Recenter VR View
    const comboRecenter = lStickClick && rStickClick;
    if (comboRecenter && !latchRecenter) {
      needsRecenter = true;
      latchRecenter = true;
    } else if (!comboRecenter) latchRecenter = false;

    // 3. Left Grip + Y: Toggle VR Quick Menu
    const comboOverlay = lGrip && btnY;
    if (comboOverlay && !latchOverlay) {
      vrOverlayOpen = !vrOverlayOpen;
      latchOverlay = true;
    } else if (!comboOverlay) latchOverlay = false;

    // 4. Left Grip + Left Stick Click: Pause Menu / Map (Esc)
    const comboPause = lGrip && lStickClick;
    if (comboPause && !latchPause) {
      schedulePulse('Escape', 150, 0);
      vrMenuCursorMode = !vrMenuCursorMode;
      vrOverlayOpen = vrMenuCursorMode;
      latchPause = true;
    } else if (!comboPause) latchPause = false;

    const [lx, ly] = getStickAxes(leftPad);
    const [rx, ry] = getStickAxes(rightPad);

    // Left Stick always moves / steers
    if (!vrMenuCursorMode) {
      if (lx < -0.15) nextKeys.add('KeyA');
      if (lx > 0.15) nextKeys.add('KeyD');
      if (!drivingMode) {
        if (ly < -0.15) nextKeys.add('KeyW');
        if (ly > 0.15) nextKeys.add('KeyS');
      } else {
        if (ly < -0.35) nextKeys.add('Numpad8');
        if (ly > 0.35) nextKeys.add('Numpad2');
      }
    }

    const anySystemCombo = comboMode || comboRecenter || comboOverlay || comboPause;

    if (ready && !anySystemCombo) {
      // Right Stick Click -> Toggle First Person / Cycle Camera (V)
      if (rStickClick && !latchCamClick) {
        schedulePulse('KeyV', 140, 0);
        latchCamClick = true;
      } else if (!rStickClick) latchCamClick = false;

      if (vrMenuCursorMode) {
        activeStatusText = 'PAUSE / MAP: Point + Trigger (or A Select · B Back · L-Grip+L-Stick Exit)';
        if (ly < -0.35) nextKeys.add('ArrowUp');
        if (ly > 0.35) nextKeys.add('ArrowDown');
        if (lx < -0.35) nextKeys.add('ArrowLeft');
        if (lx > 0.35) nextKeys.add('ArrowRight');
        if (rTrig > 0.2 && hoveredToolbarIdx < 0) nextMouse |= 1;
        if (btnA) schedulePulse('Enter', 130, 0, 13);
        if (btnB) schedulePulse('Backspace', 130, 0, 8);
      } else if (phoneMode) {
        activeStatusText = 'PHONE MODE: R-Stick Navigate · A / Trigger = Detonate · B = Back · L-Stick Click = Close';
        if (lStickClick && !latchPhoneToggle) { togglePhoneMode(); latchPhoneToggle = true; }
        else if (!lStickClick) latchPhoneToggle = false;

        if (ry < -0.45 && !latchPhoneDir.up) { schedulePulse('ArrowUp', 130, 0); latchPhoneDir.up = true; }
        else if (ry >= -0.3) latchPhoneDir.up = false;

        if (ry > 0.45 && !latchPhoneDir.down) { schedulePulse('ArrowDown', 130, 0); latchPhoneDir.down = true; }
        else if (ry <= 0.3) latchPhoneDir.down = false;

        if (rx < -0.45 && !latchPhoneDir.left) { schedulePulse('ArrowLeft', 130, 0); latchPhoneDir.left = true; }
        else if (rx >= -0.3) latchPhoneDir.left = false;

        if (rx > 0.45 && !latchPhoneDir.right) { schedulePulse('ArrowRight', 130, 0); latchPhoneDir.right = true; }
        else if (rx <= 0.3) latchPhoneDir.right = false;

        if ((btnA || rTrig > 0.25) && !latchPhoneDir.ok) {
          schedulePulse('Enter', 150, 0, 13, 1);
          latchPhoneDir.ok = true;
        } else if (!btnA && rTrig <= 0.15) latchPhoneDir.ok = false;

        if (btnB && !latchPhoneDir.back) {
          schedulePulse('Backspace', 150, 0, 8, 2);
          latchPhoneDir.back = true;
        } else if (!btnB) latchPhoneDir.back = false;

        if (lTrig > 0.15) nextKeys.add('ShiftLeft');
      } else if (drivingMode) {
        activeStatusText = 'DRIVING MODE: RT Gas · LT Brake · R-Grip/A Handbrake · B Drive-By · Y Exit · L+R Grip On-Foot';
        if (rTrig > 0.12) nextKeys.add('KeyW');
        if (lTrig > 0.12) nextKeys.add('KeyS');
        if (rGrip || btnA) nextKeys.add('Space');
        if (btnB) nextMouse |= 1;
        if (btnX) nextKeys.add('KeyQ');
        if (btnY) nextKeys.add('KeyF');
        if (lGrip && btnA) nextKeys.add('KeyH');
        if (lStickClick) nextKeys.add('KeyE');
        if (lGrip && rTrig > 0.4 && !latchNextWep) { dz += 1; latchNextWep = true; }
        else if (rTrig <= 0.25) latchNextWep = false;
      } else {
        // On-Foot Combat & Story Mode Complete Controls
        // Left Stick Click -> Open Phone (Up Arrow + MMB)
        if (!lGrip && lStickClick && !latchPhoneToggle) {
          togglePhoneMode();
          latchPhoneToggle = true;
        } else if (!lStickClick) latchPhoneToggle = false;

        if (lGrip) {
          // Left Grip Modifier: Weapon Wheel (Tab), Character Switch (AltLeft/F5/F6/F7), Interact (E), Stealth (Ctrl), Special (CapsLock)
          if (btnX) {
            if (!xHoldStart) xHoldStart = performance.now();
            if (performance.now() - xHoldStart > 220) {
              // Hold Left Grip + X -> Character Switch Wheel (AltLeft + Right Stick / F5 Michael / F6 Franklin / F7 Trevor)
              activeStatusText = 'CHARACTER SWITCH: R-Stick Select · A=Michael(F5) · LT=Franklin(F6) · B=Trevor(F7)';
              nextKeys.add('AltLeft');
              if (btnA) nextKeys.add('F5');
              if (lTrig > 0.25) nextKeys.add('F6');
              if (btnB) nextKeys.add('F7');
            }
          } else {
            if (xHoldStart && performance.now() - xHoldStart <= 220) {
              schedulePulse('CapsLock', 150, 0); // Tap Left Grip + X -> Special Ability
            }
            xHoldStart = 0;

            activeStatusText = 'WEAPON WHEEL (R-Stick Select) · A=Interact(E) · B=Crouch(Ctrl) · Hold X=Switch Char';
            nextKeys.add('Tab'); // Hold Left Grip -> Weapon Wheel

            if (btnA && !latchInteract) { schedulePulse('KeyE', 160, 0); latchInteract = true; }
            else if (!btnA) latchInteract = false;

            if (btnB) nextKeys.add('ControlLeft'); // Stealth / Crouch

            if (rTrig > 0.35 && !latchNextWep) { dz += 1; latchNextWep = true; }
            else if (rTrig <= 0.2) latchNextWep = false;

            if (lTrig > 0.35 && !latchPrevWep) { dz -= 1; latchPrevWep = true; }
            else if (lTrig <= 0.2) latchPrevWep = false;
          }
        } else {
          xHoldStart = 0;

          // 1. SHOOT: Right Trigger ALWAYS fires weapon (Mouse Left = bit 1)
          if (rTrig > 0.12 && !(vrOverlayOpen && hoveredToolbarIdx >= 0)) {
            nextMouse |= 1;
          }

          // 2. AIM: Right Grip holds aim down sights (Mouse Right = bit 2)
          if (rGrip) {
            nextMouse |= 2;
            // Right Grip + B = Throw Grenade / Quick Detonate Sticky Bomb (KeyG)
            if (btnB && !latchGrenade) { schedulePulse('KeyG', 150, 0); latchGrenade = true; }
            else if (!btnB) latchGrenade = false;
            // Right Grip + A = Skip Cutscene / Confirm (Enter + Space)
            if (btnA && !latchSkip) { schedulePulse('Enter', 150, 0, 13); schedulePulse('Space', 150, 0); latchSkip = true; }
            else if (!btnA) latchSkip = false;
          } else {
            latchGrenade = false;
            latchSkip = false;
            if (btnA) nextKeys.add('Space'); // Jump / Climb
            if (btnB) nextKeys.add('KeyR');  // Reload / Melee
          }

          if (lTrig > 0.12) nextKeys.add('ShiftLeft'); // Sprint
          if (btnX) nextKeys.add('KeyQ');              // Take Cover
          if (btnY) nextKeys.add('KeyF');              // Enter / Exit Vehicle
        }
      }
    } else {
      xHoldStart = 0;
      if (!lStickClick) latchPhoneToggle = false;
      if (!rStickClick) latchCamClick = false;
    }

    // Camera Look: Right Thumbstick & Headset Head-Look
    let dx = 0, dy = 0;
    if (!vrMenuCursorMode) {
      if (!phoneMode) {
        remLookX += rx * LOOK_STICK_SPEED * dt;
        const pitchFactor = invertPitchY ? -1 : 1;
        remLookY += ry * LOOK_STICK_SPEED * dt * pitchFactor;
      }

      if (headLookEnabled && pose && ready) {
        const { yaw, pitch } = extractHeadYawPitch(pose.transform.orientation);
        if (prevHeadYaw !== null && prevHeadPitch !== null) {
          const dYaw = wrapAngleDelta(yaw - prevHeadYaw);
          const dPitch = wrapAngleDelta(pitch - prevHeadPitch);
          remLookX += dYaw * HEAD_LOOK_YAW_SENS;
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
    const { yaw: headYaw, pitch: headPitch } = extractHeadYawPitch(pose.transform.orientation);
    const p = pose.transform.position;

    if (needsRecenter) {
      anchorYaw = headYaw;
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
    if (ready && activeStatusText && !showBar) updateStatusTexture(activeStatusText);

    const useImmersiveSphere = ready && !vrMenuCursorMode;
    const sphereModelMat = mat4FromTranslationYawPitch(p.x, p.y, p.z, headYaw, headPitch);
    const theaterModelMat = mat4FromTranslationYaw(anchorPos[0], anchorPos[1], anchorPos[2], anchorYaw);
    const hudModelMat = mat4FromTranslationYaw(p.x, p.y, p.z, headYaw);

    for (let eyeIdx = 0; eyeIdx < pose.views.length; eyeIdx++) {
      const view = pose.views[eyeIdx];
      const vp = baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const vpMat = mat4Multiply(view.projectionMatrix, viewMat);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      if (useImmersiveSphere) {
        const mvp = mat4Multiply(vpMat, sphereModelMat);
        gl.useProgram(sphereProgram);
        gl.uniformMatrix4fv(sphereProgram.uMvp, false, mvp);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, gameTex);
        gl.uniform1i(sphereProgram.uTex, 0);
        gl.uniform1f(sphereProgram.uTanHalfH, TAN_HALF_H);
        gl.uniform1f(sphereProgram.uTanHalfV, TAN_HALF_V);
        const stereoOffset = view.eye === 'left' ? -0.0018 : view.eye === 'right' ? 0.0018 : 0.0;
        gl.uniform1f(sphereProgram.uStereoOffset, stereoOffset);
        gl.bindVertexArray(sphereMesh.vao);
        gl.drawElements(gl.TRIANGLES, sphereMesh.count, gl.UNSIGNED_SHORT, 0);
      } else {
        const mvp = mat4Multiply(vpMat, theaterModelMat);
        gl.useProgram(flatProgram);
        gl.uniformMatrix4fv(flatProgram.uMvp, false, mvp);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, gameTex);
        gl.uniform1i(flatProgram.uTex, 0);
        gl.uniform1f(flatProgram.uAlpha, 1.0);
        gl.bindVertexArray(theaterMesh.vao);
        gl.drawElements(gl.TRIANGLES, theaterMesh.count, gl.UNSIGNED_SHORT, 0);
      }

      if (ready && activeStatusText && !showBar) {
        const stMvp = mat4Multiply(vpMat, hudModelMat);
        gl.useProgram(flatProgram);
        gl.uniformMatrix4fv(flatProgram.uMvp, false, stMvp);
        gl.bindTexture(gl.TEXTURE_2D, statusTex);
        gl.uniform1f(flatProgram.uAlpha, 0.94);
        gl.bindVertexArray(statusMesh.vao);
        gl.drawElements(gl.TRIANGLES, statusMesh.count, gl.UNSIGNED_SHORT, 0);
      }

      if (showBar) {
        const barBaseMat = useImmersiveSphere ? hudModelMat : theaterModelMat;
        const barMvp = mat4Multiply(vpMat, barBaseMat);
        gl.useProgram(flatProgram);
        gl.uniformMatrix4fv(flatProgram.uMvp, false, barMvp);
        gl.bindTexture(gl.TEXTURE_2D, hudTex);
        gl.uniform1f(flatProgram.uAlpha, 0.96);
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

      // Request Touch Plus controllers cleanly without hand-tracking stubs overriding inputSources
      xrSession = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor']
      });

      xrSession.addEventListener('selectstart', (e) => {
        if (e.inputSource && e.inputSource.handedness === 'left') xrSelectHeld.left = true;
        else if (e.inputSource && e.inputSource.handedness === 'right') xrSelectHeld.right = true;
      });
      xrSession.addEventListener('selectend', (e) => {
        if (e.inputSource && e.inputSource.handedness === 'left') xrSelectHeld.left = false;
        else if (e.inputSource && e.inputSource.handedness === 'right') xrSelectHeld.right = false;
      });
      xrSession.addEventListener('squeezestart', (e) => {
        if (e.inputSource && e.inputSource.handedness === 'left') xrSqueezeHeld.left = true;
        else if (e.inputSource && e.inputSource.handedness === 'right') xrSqueezeHeld.right = true;
      });
      xrSession.addEventListener('squeezeend', (e) => {
        if (e.inputSource && e.inputSource.handedness === 'left') xrSqueezeHeld.left = false;
        else if (e.inputSource && e.inputSource.handedness === 'right') xrSqueezeHeld.right = false;
      });

      window.__GTA5_VR_ACTIVE = true;
      vrOverlayOpen = false;
      if (vrPort) vrPort.postMessage({ vrActive: true, ack: true });
      if (vrBtn) vrBtn.textContent = 'Exit VR';
      needsRecenter = true;
      prevHeadYaw = null;
      prevHeadPitch = null;
      prevTime = 0;

      if (isWorldReady() && !autoFirstPersonDone) {
        autoFirstPersonDone = true;
        setTimeout(() => { if (xrSession) scheduleFirstPersonCycle(); }, 350);
      }

      xrSession.addEventListener('end', () => {
        xrSession = null;
        xrRefSpace = null;
        window.__GTA5_VR_ACTIVE = false;
        phoneMode = false;
        drivingMode = false;
        vrMenuCursorMode = false;
        vrOverlayOpen = false;
        if (vrPort) vrPort.postMessage({ vrActive: false, ack: true });
        releaseAllVRInputs();
        if (vrBtn) vrBtn.textContent = 'VR Mode (Quest 3)';
      });

      await gl.makeXRCompatible();
      const layer = new XRWebGLLayer(xrSession, gl, { framebufferScaleFactor: 1.0 });
      xrSession.updateRenderState({ baseLayer: layer, depthNear: 0.1, depthFar: 150.0 });

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
