/* Meta Quest 3 WebXR runtime & Touch Plus controller bridge for PlayGTA5 (WebGPU + WasmInputBlock). */
(() => {
  'use strict';

  const DEADZONE = 0.18;
  const LOOK_STICK_SPEED = 1150;
  const HEAD_LOOK_YAW_SENS = 920;
  const HEAD_LOOK_PITCH_SENS = 760;

  let xrSession = null;
  let xrRefSpace = null;
  let gl = null;
  let glProgram = null;
  let gameTex = null;
  let hudTex = null;
  let screenMesh = null;
  let hudMesh = null;

  let drivingMode = false;
  let headLookEnabled = true;
  let followMode = false; // false = Theater Anchor (fixed in room, recenterable); true = Cockpit Follow
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

  // Edge-triggered combo latches
  let latchModeToggle = false;
  let latchPause = false;
  let latchHeadLook = false;
  let latchScreenMode = false;
  let latchRecenter = false;
  let latchCursorMode = false;
  let latchStoryBtn = false;
  let latchSandboxBtn = false;
  let latchMap5Btn = false;
  let latchFpsView = false;

  // Fallback 2D canvas used to render loading screen / status while #loading is active
  const mirrorCanvas = document.createElement('canvas');
  mirrorCanvas.width = 1280;
  mirrorCanvas.height = 720;
  const mirrorCtx = mirrorCanvas.getContext('2d');

  // Floating HUD strip canvas rendered below the curved GTA V screen in VR
  const hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024;
  hudCanvas.height = 128;
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

  function applyDeadzone(v) {
    if (!Number.isFinite(v)) return 0;
    const clamped = Math.max(-1, Math.min(1, v));
    const abs = Math.abs(clamped);
    if (abs <= DEADZONE) return 0;
    return Math.sign(clamped) * ((abs - DEADZONE) / (1 - DEADZONE));
  }

  // ---- Shared-memory input writer (WasmInputBlock) ----
  function releaseAllVRInputs() {
    const inp = window.__GTA5_INPUT__;
    if (inp) {
      for (const code of ownedKeys) {
        const vk = inp.VK[code];
        if (vk) Atomics.store(inp.keys, vk, 0);
      }
      const curBtn = Atomics.load(inp.w, 5);
      Atomics.store(inp.w, 5, curBtn & ~ownedMouse);
    }
    ownedKeys.clear();
    ownedMouse = 0;
    remLookX = 0;
    remLookY = 0;
  }

  function writeInputs(nextKeys, nextMouse, dx, dy, dz) {
    const inp = window.__GTA5_INPUT__;
    if (!inp) return;
    const { keys, w, VK } = inp;

    // Keep engine focused & locked during VR gameplay unless menu cursor mode is toggled
    Atomics.store(w, 6, 1); // FOCUS
    Atomics.store(w, 7, vrMenuCursorMode ? 0 : 1); // LOCKED

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

  // ---- 4x4 Column-Major Matrix Helpers ----
  function mat4Identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }

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

  function quatToYawPitch(q) {
    // q = {x, y, z, w}
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

  // ---- WebGL2 Curved Screen & HUD Builder ----
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
    const vs = createShader(gl.VERTEX_SHADER, vsSrc);
    const fs = createShader(gl.FRAGMENT_SHADER, fsSrc);
    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);
    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      throw new Error('WebXR program link error: ' + gl.getProgramInfoLog(glProgram));
    }
    glProgram.uMvp = gl.getUniformLocation(glProgram, 'u_mvp');
    glProgram.uTex = gl.getUniformLocation(glProgram, 'u_tex');
    glProgram.uAlpha = gl.getUniformLocation(glProgram, 'u_alpha');

    // Curved 16:9 cinema arc: radius 2.6m, arc ~68 deg, height ~1.72m
    screenMesh = buildCurvedQuad(2.6, 1.72, (68 * Math.PI) / 180, 0, 36);
    // Floating HUD bar tucked just below the main screen
    hudMesh = buildCurvedQuad(2.48, 0.24, (50 * Math.PI) / 180, -1.06, 20);

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
      // Top vertex (WebGL texImage2D on canvas: v=0 is top when UNPACK_FLIP_Y_WEBGL is false)
      verts.push(x, yTop, z, t, 0.0);
      // Bottom vertex
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

  function updateLoadingMirrorTexture() {
    const st = window.__GTA5_LOAD_STATE__ || { pct: 0, label: 'Starting...', dataMB: 0, waitingChoice: false, startMode: 0 };
    const ctx = mirrorCtx;
    ctx.fillStyle = '#070a09';
    ctx.fillRect(0, 0, 1280, 720);

    // Subtle Los Santos radial glow
    const grad = ctx.createRadialGradient(640, 340, 40, 640, 340, 600);
    grad.addColorStop(0, '#163528');
    grad.addColorStop(1, '#070a09');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1280, 720);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 54px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GRAND THEFT AUTO V · QUEST 3 VR', 640, 210);

    ctx.fillStyle = '#9fe2bf';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillText(st.label + ' (' + st.pct + '%)', 640, 290);

    if (st.dataMB > 0) {
      ctx.fillStyle = '#7ea89a';
      ctx.font = '22px monospace';
      ctx.fillText('Game data streamed: ' + st.dataMB + ' MB', 640, 335);
    }

    // Progress bar
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(290, 375, 700, 14);
    ctx.fillStyle = '#7cc576';
    ctx.fillRect(290, 375, 7 * Math.max(0, Math.min(100, st.pct)), 14);

    // Mode selection instructions inside VR
    ctx.fillStyle = '#e8f5ee';
    ctx.font = 'bold 24px system-ui, sans-serif';
    const modeName = st.startMode === 1 ? 'Story Mode' : st.startMode === 2 ? 'Sandbox (GTA V Map)' : st.startMode === 3 ? 'Sandbox (GTA VI Map)' : 'Waiting for choice';
    ctx.fillText('Mode: ' + modeName, 640, 460);

    ctx.fillStyle = '#c4d8ce';
    ctx.font = '21px system-ui, sans-serif';
    ctx.fillText('Press [A] Story Mode   ·   Press [X] Sandbox (GTA V Map)   ·   Press [Y] Sandbox (GTA VI Map)', 640, 520);
    ctx.fillText('Left Grip + Right Grip: Switch On-Foot / Driving   ·   Hold X + Y: Recenter VR Screen', 640, 565);

    gl.bindTexture(gl.TEXTURE_2D, gameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mirrorCanvas);
  }

  function updateHudTexture() {
    const sig = `${drivingMode}|${headLookEnabled}|${followMode}|${vrMenuCursorMode}`;
    if (sig === lastHudSignature) return;
    lastHudSignature = sig;

    const c = hudCtx;
    c.clearRect(0, 0, 1024, 128);
    c.fillStyle = 'rgba(10, 18, 15, 0.86)';
    c.beginPath();
    c.roundRect(12, 12, 1000, 104, 18);
    c.fill();
    c.strokeStyle = 'rgba(124, 197, 118, 0.55)';
    c.lineWidth = 2;
    c.stroke();

    c.textAlign = 'left';
    c.font = 'bold 24px system-ui, sans-serif';
    c.fillStyle = drivingMode ? '#ffd166' : '#7cc576';
    c.fillText(drivingMode ? 'MODE: DRIVING (L+R Grip)' : 'MODE: ON FOOT (L+R Grip)', 40, 52);

    c.fillStyle = headLookEnabled ? '#7cc576' : '#94a3b8';
    c.fillText('HEAD-LOOK: ' + (headLookEnabled ? 'ON' : 'OFF') + ' (L-Grip+X)', 400, 52);

    c.fillStyle = '#d1fae5';
    c.fillText('SCREEN: ' + (followMode ? 'FOLLOW' : 'THEATER') + ' (L-Grip+Y)', 700, 52);

    c.font = '20px system-ui, sans-serif';
    c.fillStyle = '#cbd5e1';
    c.fillText(
      drivingMode
        ? 'RT: Gas  |  LT: Brake  |  L-Stick: Steer  |  R-Grip/A: Handbrake  |  B: Camera (1st Person VR)  |  Y: Exit Car  |  X+Y: Recenter'
        : 'L-Stick: Move  |  R-Stick/Head: Aim  |  RT: Fire  |  R-Grip: Aim  |  A: Jump  |  B: Sprint  |  Y: Enter Car  |  X+Y: Recenter',
      40,
      92
    );

    gl.bindTexture(gl.TEXTURE_2D, hudTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hudCanvas);
  }

  // ---- Quest 3 Input Processing ----
  function processQuestInputs(session, pose, dt) {
    const nextKeys = new Set();
    let nextMouse = 0;
    let dz = 0;
    let leftPad = null;
    let rightPad = null;

    for (const src of session.inputSources) {
      if (!src.gamepad) continue;
      if (src.handedness === 'left') leftPad = src.gamepad;
      else if (src.handedness === 'right') rightPad = src.gamepad;
    }

    const btn = (pad, idx) => !!(pad && pad.buttons[idx] && (pad.buttons[idx].pressed || pad.buttons[idx].value > 0.5));
    const trig = (pad, idx) => (pad && pad.buttons[idx] ? pad.buttons[idx].value : 0);
    const stick = (pad) => {
      if (!pad || !pad.axes) return [0, 0];
      const ax = pad.axes.length >= 4 ? pad.axes[2] : pad.axes[0];
      const ay = pad.axes.length >= 4 ? pad.axes[3] : pad.axes[1];
      return [applyDeadzone(ax), applyDeadzone(ay)];
    };

    const lGrip = btn(leftPad, 1);
    const rGrip = btn(rightPad, 1);
    const lStickClick = btn(leftPad, 3);
    const rStickClick = btn(rightPad, 3);
    const btnX = btn(leftPad, 4);
    const btnY = btn(leftPad, 5);
    const btnA = btn(rightPad, 4);
    const btnB = btn(rightPad, 5);

    // Loading screen mode selection via Quest buttons
    const loadEl = document.getElementById('loading');
    const st = window.__GTA5_LOAD_STATE__;
    if (loadEl && st && typeof st.act === 'function') {
      if (btnA && !latchStoryBtn) { st.act('story'); latchStoryBtn = true; }
      else if (!btnA) latchStoryBtn = false;

      if (btnX && !latchSandboxBtn) { st.act('map5'); latchSandboxBtn = true; }
      else if (!btnX) latchSandboxBtn = false;

      if (btnY && !latchMap5Btn) { st.act('map6'); latchMap5Btn = true; }
      else if (!btnY) latchMap5Btn = false;
    }

    // Combo 1: Left Grip + Right Grip -> Toggle On-Foot / Driving
    const comboMode = lGrip && rGrip;
    if (comboMode && !latchModeToggle) {
      drivingMode = !drivingMode;
      latchModeToggle = true;
    } else if (!comboMode) {
      latchModeToggle = false;
    }

    // Combo 2: Left Stick Click + Right Stick Click -> Pause Menu (Escape)
    const comboPause = lStickClick && rStickClick;
    if (comboPause && !latchPause) {
      nextKeys.add('Escape');
      latchPause = true;
    } else if (!comboPause) {
      latchPause = false;
    }

    // Combo 3: Left Grip + X -> Toggle Head-Look
    const comboHead = lGrip && btnX;
    if (comboHead && !latchHeadLook) {
      headLookEnabled = !headLookEnabled;
      prevHeadYaw = null;
      prevHeadPitch = null;
      latchHeadLook = true;
    } else if (!comboHead) {
      latchHeadLook = false;
    }

    // Combo 4: Left Grip + Y -> Toggle Theater vs Follow Screen
    const comboScreen = lGrip && btnY;
    if (comboScreen && !latchScreenMode) {
      followMode = !followMode;
      needsRecenter = true;
      latchScreenMode = true;
    } else if (!comboScreen) {
      latchScreenMode = false;
    }

    // Combo 5: X + Y -> Recenter VR Screen in front of Quest headset
    const comboRecenter = btnX && btnY;
    if (comboRecenter && !latchRecenter) {
      needsRecenter = true;
      latchRecenter = true;
    } else if (!comboRecenter) {
      latchRecenter = false;
    }

    // Combo 6: Left Grip + B -> Toggle Menu Cursor Mode (unlocks pointer for pause map clicks)
    const comboCursor = lGrip && btnB;
    if (comboCursor && !latchCursorMode) {
      vrMenuCursorMode = !vrMenuCursorMode;
      latchCursorMode = true;
    } else if (!comboCursor) {
      latchCursorMode = false;
    }

    const [lx, ly] = stick(leftPad);
    const [rx, ry] = stick(rightPad);

    if (lx < -0.15) nextKeys.add('KeyA');
    if (lx > 0.15) nextKeys.add('KeyD');

    if (!comboMode && !comboHead && !comboScreen && !comboRecenter && !comboCursor && !comboPause) {
      if (drivingMode) {
        // Driving / Flying controls
        if (trig(rightPad, 0) > 0.15 || ly < -0.35) nextKeys.add('KeyW'); // Gas
        if (trig(leftPad, 0) > 0.15 || ly > 0.35) nextKeys.add('KeyS');   // Brake / Reverse
        if (rGrip || btnA) nextKeys.add('Space'); // Handbrake
        if (lGrip) nextKeys.add('KeyE');          // Horn
        if (btnB) nextKeys.add('KeyV');           // Cycle Camera (First-Person VR view)
        if (btnX) nextKeys.add('KeyQ');           // Radio Wheel
        if (btnY) nextKeys.add('KeyF');           // Exit Vehicle
        if (rStickClick) nextKeys.add('KeyC');    // Look Behind
        if (lStickClick) nextKeys.add('KeyH');    // Headlights
      } else {
        // On-Foot controls
        if (ly < -0.15) nextKeys.add('KeyW');
        if (ly > 0.15) nextKeys.add('KeyS');
        if (trig(rightPad, 0) > 0.25) nextMouse |= 1; // Fire (Left Mouse)
        if (rGrip) nextMouse |= 2;                    // Aim (Right Mouse)
        if (trig(leftPad, 0) > 0.25) nextKeys.add('ControlLeft'); // Stealth / Crouch
        if (lGrip) nextKeys.add('Tab');               // Weapon Wheel
        if (btnA) nextKeys.add('Space');              // Jump / Climb
        if (btnB) nextKeys.add('ShiftLeft');          // Sprint
        if (btnX) nextKeys.add('KeyR');               // Reload
        if (btnY) nextKeys.add('KeyF');               // Enter / Exit Vehicle
        if (rStickClick) nextKeys.add('KeyC');        // Look Behind
        if (lStickClick && !latchFpsView) { nextKeys.add('KeyV'); latchFpsView = true; }
        else if (!lStickClick) latchFpsView = false;
      }
    }

    // Camera Look: Right Thumbstick + Optional Quest 3 Head Orientation Deltas
    remLookX += rx * LOOK_STICK_SPEED * dt;
    remLookY += ry * LOOK_STICK_SPEED * dt;

    if (headLookEnabled && pose && !vrMenuCursorMode && !loadEl) {
      const { yaw, pitch } = quatToYawPitch(pose.transform.orientation);
      if (prevHeadYaw !== null && prevHeadPitch !== null) {
        const dYaw = wrapAngleDelta(yaw - prevHeadYaw);
        const dPitch = wrapAngleDelta(pitch - prevHeadPitch);
        // Negate dYaw because turning head right decreases yaw in WebXR right-handed coordinates
        remLookX += (-dYaw) * HEAD_LOOK_YAW_SENS;
        remLookY += (-dPitch) * HEAD_LOOK_PITCH_SENS;
      }
      prevHeadYaw = yaw;
      prevHeadPitch = pitch;
    } else {
      prevHeadYaw = null;
      prevHeadPitch = null;
    }

    const dx = Math.trunc(remLookX);
    const dy = Math.trunc(remLookY);
    remLookX -= dx;
    remLookY -= dy;

    writeInputs(nextKeys, nextMouse, dx, dy, dz);
  }

  // ---- WebXR Frame Loop ----
  function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const dt = Math.min(0.05, Math.max(0.001, prevTime ? (time - prevTime) / 1000 : 0.016));
    prevTime = time;

    const pose = frame.getViewerPose(xrRefSpace);
    processQuestInputs(xrSession, pose, dt);
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
    gl.clearColor(0.015, 0.02, 0.02, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Upload live GTA V WebGPU canvas OR loading screen mirror
    const loadingEl = document.getElementById('loading');
    const gameCanvas = document.getElementById('canvas');
    if (loadingEl && !loadingEl.classList.contains('done')) {
      updateLoadingMirrorTexture();
    } else if (gameCanvas && gameCanvas.width > 0 && gameCanvas.height > 0) {
      gl.bindTexture(gl.TEXTURE_2D, gameTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gameCanvas);
      } catch {
        updateLoadingMirrorTexture();
      }
    }

    updateHudTexture();

    const modelMat = mat4FromTranslationYaw(anchorPos[0], anchorPos[1], anchorPos[2], anchorYaw);

    gl.useProgram(glProgram);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    for (const view of pose.views) {
      const vp = baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      const viewMat = view.transform.inverse.matrix;
      const vpMat = mat4Multiply(view.projectionMatrix, viewMat);
      const mvp = mat4Multiply(vpMat, modelMat);
      gl.uniformMatrix4fv(glProgram.uMvp, false, mvp);

      // 1. Draw main GTA V curved screen
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gameTex);
      gl.uniform1i(glProgram.uTex, 0);
      gl.uniform1f(glProgram.uAlpha, 1.0);
      gl.bindVertexArray(screenMesh.vao);
      gl.drawElements(gl.TRIANGLES, screenMesh.count, gl.UNSIGNED_SHORT, 0);

      // 2. Draw floating Quest 3 control status bar beneath screen
      gl.bindTexture(gl.TEXTURE_2D, hudTex);
      gl.uniform1f(glProgram.uAlpha, 0.96);
      gl.bindVertexArray(hudMesh.vao);
      gl.drawElements(gl.TRIANGLES, hudMesh.count, gl.UNSIGNED_SHORT, 0);
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
      if (vrBtn) vrBtn.textContent = 'Exit VR';
      needsRecenter = true;
      prevHeadYaw = null;
      prevHeadPitch = null;
      prevTime = 0;

      xrSession.addEventListener('end', () => {
        xrSession = null;
        xrRefSpace = null;
        window.__GTA5_VR_ACTIVE = false;
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
      releaseAllVRInputs();
      if (vrBtn) vrBtn.textContent = 'VR Mode (Quest 3)';
      showToast('Failed to start WebXR session: ' + (err && err.message ? err.message : err));
    }
  }

  if (vrBtn) vrBtn.addEventListener('click', startVR);
  if (controlsBtn && controlsModal) controlsBtn.addEventListener('click', () => { controlsModal.hidden = !controlsModal.hidden; });
  if (controlsClose && controlsModal) controlsClose.addEventListener('click', () => { controlsModal.hidden = true; });
})();
