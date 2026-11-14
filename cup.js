// 紙コップ水シミュレーター
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const info = document.getElementById('info');
const waterPercent = document.getElementById('waterPercent');

const statusEl = document.getElementById('status');
const sensitivityEl = document.querySelector('.sensitivity');
const sensitivityInput = document.getElementById('sensitivity');
const sensitivityValue = document.getElementById('sensitivityValue');
let sensitivity = 1;
sensitivityInput.addEventListener('input', () => {
    sensitivity = parseFloat(sensitivityInput.value);
    sensitivityValue.textContent = sensitivity.toFixed(1) + 'x';
});
const MAX_LATERAL = 0.8;  // 重力に対する横加速度の上限比
const ACCEL_DEADZONE = 1.5; // m/s² 未満 (手持ちの微振動) は無視
const BASE_SENSITIVITY = 4.5;
const WATER_GRAVITY = 0.08;
// 横加速度 (m/s²) から重力に対する横方向の割合を求める
const motionInput = (acceleration) => {
    const a = Math.abs(acceleration) - ACCEL_DEADZONE;
    if (a <= 0) return 0;
    const v = Math.min(MAX_LATERAL, a * sensitivity * BASE_SENSITIVITY / 9.8);
    return acceleration < 0 ? v : -v;
};
const lateral = () => motionInput(accelX);
let S = 1;            // スケール (canvas幅/360)
let CUP, WATER;
const TARGET_COUNT = 800;
const particles = [];
let initialCount = 1;
let waterCount = 0;
const SURFACE_POINTS = 33;
const surface = Array(SURFACE_POINTS).fill(0);
const surfaceVelocity = Array(SURFACE_POINTS).fill(0);
let depthWave = 0, depthVelocity = 0;
let spillCarry = 0;
const CUP_TILT_RATIO = 0.04; // ダッシュボード固定: コップはほぼ傾かない
let shakeX = 0, shakeA = 0, time = 0;

// 水を描画する低解像度レイヤー (メタボール合成用)
const RES = 0.5;
const layer = document.createElement('canvas');
const lctx = layer.getContext('2d', { willReadFrequently: true });
const sprite = document.createElement('canvas');

function makeSprite(r) {
    const size = Math.ceil(r * 2);
    sprite.width = sprite.height = size;
    const c = sprite.getContext('2d');
    const g = c.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
}

function layout() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    S = Math.min(canvas.width * 0.94 / 160, canvas.height * 0.6 / 170);
    const h = 170 * S;
    CUP = {
        baseX: canvas.width / 2,
        x: canvas.width / 2,
        y: canvas.height * 0.06 + h / 2 + 20 * S,
        h,
        tw: 78 * S,      // 口の半幅
        bw: 52 * S,      // 底の半幅
        wall: 4 * S,
        tilt: 0,
        prevTilt: 0
    };
    CUP.k = (CUP.bw - CUP.tw) / CUP.h;
    CUP.L = Math.sqrt(1 + CUP.k * CUP.k);
    WATER = { r: 5.2 * S, gravity: WATER_GRAVITY * S, lateralForce: 0.45 * S };
    layer.width = Math.ceil(canvas.width * RES);
    layer.height = Math.ceil(canvas.height * RES);
    makeSprite(WATER.r * 3.2 * RES);
    statusEl.style.top = (CUP.y + h / 2 + 16) + 'px';
    sensitivityEl.style.top = (CUP.y + h / 2 + 16 + 56) + 'px';
    fillCup();
}

const halfWidth = (y) => CUP.tw + (CUP.bw - CUP.tw) * ((y + CUP.h / 2) / CUP.h);

function spawn(lx, ly, vx = 0, vy = 0, incoming = false) {
    const c = Math.cos(CUP.tilt), s = Math.sin(CUP.tilt);
    const x = CUP.x + lx * c - ly * s;
    const y = CUP.y + lx * s + ly * c;
    particles.push({ x, y, px: x - (vx * c - vy * s),
        py: y - (vx * s + vy * c), incoming, entered: false });
}

function fillCup() {
    particles.length = 0;
    surface.fill(0);
    surfaceVelocity.fill(0);
    depthWave = 0;
    depthVelocity = 0;
    spillCarry = 0;
    const gap = WATER.r * 1.7;
    const bottom = CUP.h / 2 - WATER.r - CUP.wall;
    const fillTop = CUP.h / 2 - CUP.h * 0.8;
    let count = 0;
    for (let y = bottom, row = 0; y > fillTop && count < TARGET_COUNT; y -= gap * 0.9, row++) {
        const hw = halfWidth(y) - WATER.r - CUP.wall;
        for (let x = -hw + (row % 2) * gap / 2; x <= hw && count < TARGET_COUNT; x += gap) {
            count++;
        }
    }
    initialCount = count || 1;
    waterCount = count;
}

// 画面を垂直にしたときの画面左右・上下・画面前後の加速度
let accelX = 0; // ローパス後の横加速度 (m/s²)
let rawAccelX = 0;
let accelY = 0, accelZ = 0;
let rawAccelY = 0, rawAccelZ = 0;
let hasPermission = false;
let permissionPending = false;
let motionTimeout;
const motionPermission = document.getElementById('motionPermission');
const motionPermissionStatus = document.getElementById('motionPermissionStatus');
const motionPermissionBtn = document.getElementById('motionPermissionBtn');
const requiresMotionPermission = typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function';

async function requestPermission() {
    if (permissionPending || hasPermission) return;
    permissionPending = true;
    motionPermissionBtn.disabled = true;
    try {
        if (requiresMotionPermission) {
            const permission = await DeviceMotionEvent.requestPermission();
            if (permission === 'granted') {
                hasPermission = true;
                window.addEventListener('devicemotion', handleDeviceMotion);
                motionPermissionBtn.hidden = true;
                motionPermissionStatus.textContent = 'センサーのデータを待っています。';
                motionTimeout = setTimeout(() => {
                    motionPermissionStatus.textContent = 'センサーのデータを受信できません。Safariのモーションと画面の向きの設定を確認してください。';
                }, 5000);
            } else {
                window.addEventListener('mousemove', handleMouseMove);
                motionPermissionStatus.textContent = 'センサーの使用が拒否されました。Safariの設定を確認してください。';
            }
        } else {
            window.addEventListener('devicemotion', handleDeviceMotion);
            window.addEventListener('mousemove', handleMouseMove);
        }
    } catch (e) {
        console.error('Device motion permission request failed:', e);
        window.addEventListener('mousemove', handleMouseMove);
        motionPermission.hidden = false;
        motionPermissionStatus.textContent = 'センサーの許可を取得できませんでした。HTTPS接続とSafariの設定を確認し、もう一度お試しください。';
    } finally {
        permissionPending = false;
        motionPermissionBtn.disabled = false;
    }
}

function handlePermissionGesture(event) {
    if (!event.isTrusted || motionPermissionBtn.contains(event.target)) return;
    window.removeEventListener('pointerup', handlePermissionGesture, true);
    void requestPermission();
}

function handleDeviceMotion(event) {
    const a = event.acceleration;
    if (!a || ![a.x, a.y, a.z].some(Number.isFinite)) return;
    const x = Number.isFinite(a.x) ? a.x : 0;
    const y = Number.isFinite(a.y) ? a.y : 0;
    const angle = (window.screen?.orientation?.angle ?? window.orientation ?? 0) * Math.PI / 180;
    rawAccelX = x * Math.cos(angle) + y * Math.sin(angle);
    rawAccelY = -x * Math.sin(angle) + y * Math.cos(angle);
    rawAccelZ = Number.isFinite(a.z) ? a.z : 0;
    hasPermission = true;
    clearTimeout(motionTimeout);
    motionPermission.hidden = true;
}

function handleMouseMove(event) {
    if (hasPermission) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    // マウスの速度を加速度の代わりに使う
    if (lastMouseX !== null) rawAccelX = (x - lastMouseX) * 300;
    lastMouseX = x;
}
let lastMouseX = null;

// タップで水を足す
canvas.addEventListener('pointerdown', () => {
    const pending = particles.reduce((count, p) => count + (p.incoming ? 1 : 0), 0);
    const n = Math.min(60, initialCount - waterCount - pending);
    for (let i = 0; i < n; i++) {
        spawn((Math.random() - 0.5) * CUP.tw, -CUP.h / 2 - Math.random() * 60 * S, 0, 0, true);
    }
});

// 各横位置の水深を積分し、波があっても水量と水位を一致させる。
function waterArea(level) {
    let area = 0;
    const dx = 2 * CUP.tw / (SURFACE_POINTS - 1);
    for (let i = 0; i < SURFACE_POINTS; i++) {
        const x = -CUP.tw + i * dx;
        const bottom = Math.abs(x) <= CUP.bw ? CUP.h / 2 :
            -CUP.h / 2 + (CUP.tw - Math.abs(x)) / (CUP.tw - CUP.bw) * CUP.h;
        const top = Math.max(-CUP.h / 2, level + surface[i] - x * Math.tan(CUP.tilt));
        area += Math.max(0, bottom - top) * dx * (i === 0 || i === SURFACE_POINTS - 1 ? 0.5 : 1);
    }
    return area;
}

function waterLevel() {
    const depth = CUP.h * 0.8;
    const fullArea = 2 * CUP.bw * depth + (CUP.tw - CUP.bw) * depth * depth / CUP.h;
    const target = fullArea * waterCount / initialCount;
    let low = -CUP.h * 2, high = CUP.h;
    for (let i = 0; i < 30; i++) {
        const middle = (low + high) / 2;
        if (waterArea(middle) > target) low = middle;
        else high = middle;
    }
    return (low + high) / 2;
}

function updateSurface(input, vertical = 0, depth = 0) {
    const next = surface.map((height, i) => {
        const left = surface[Math.max(0, i - 1)];
        const right = surface[Math.min(SURFACE_POINTS - 1, i + 1)];
        const x = i * 2 / (SURFACE_POINTS - 1) - 1;
        const force = (left + right - 2 * height) * 0.12 - height * 0.008 +
            (input * x * 0.012 + vertical * x * x * 0.008) * CUP.tw;
        return (surfaceVelocity[i] + force) * 0.96;
    });
    const mean = next.reduce((sum, v) => sum + v, 0) / SURFACE_POINTS;
    for (let i = 0; i < SURFACE_POINTS; i++) {
        surfaceVelocity[i] = next[i] - mean;
        surface[i] += surfaceVelocity[i];
    }
    depthVelocity = (depthVelocity - depthWave * 0.008 + depth * CUP.tw * 0.012) * 0.96;
    depthWave += depthVelocity;
    if (depth === 0 && Math.abs(depthWave) < 0.002 * S &&
        Math.abs(depthVelocity) < 0.002 * S) {
        depthWave = 0;
        depthVelocity = 0;
    }
    if (input === 0 && vertical === 0 && surface.every((h, i) =>
        Math.abs(h) < 0.002 * S && Math.abs(surfaceVelocity[i]) < 0.002 * S)) {
        surface.fill(0);
        surfaceVelocity.fill(0);
    }
}

function spillWater() {
    if (waterCount === 0) return;
    const level = waterLevel();
    const tilt = Math.tan(CUP.tilt);
    const leftOverflow = Math.max(0, -CUP.h / 2 - (level + surface[0] + CUP.tw * tilt));
    const rightOverflow = Math.max(0, -CUP.h / 2 -
        (level + surface[SURFACE_POINTS - 1] - CUP.tw * tilt));
    const depthOverflow = Math.max(0, -CUP.h / 2 -
        (level + surface[Math.floor(SURFACE_POINTS / 2)] - Math.abs(depthWave)));
    const overflow = leftOverflow + rightOverflow + depthOverflow;
    if (overflow === 0) {
        spillCarry = 0;
        return;
    }
    spillCarry += overflow / S * 0.08;
    const count = Math.min(waterCount, Math.floor(spillCarry), 10);
    spillCarry -= count;
    for (let i = 0; i < count; i++) {
        if (depthOverflow > Math.max(leftOverflow, rightOverflow)) {
            spawn(0, -CUP.h / 2, 0, -0.5 * S);
            particles[particles.length - 1].depthSpill = true;
        } else {
            const side = leftOverflow > rightOverflow ? -1 : 1;
            spawn(side * (CUP.tw + WATER.r), -CUP.h / 2, side * S, 0);
        }
        waterCount--;
    }
}

function stepDroplets(input) {
    if (particles.length === 0) return;
    const c = Math.cos(CUP.tilt), s = Math.sin(CUP.tilt);
    const level = waterLevel();
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        const oldX = p.x, oldY = p.y;
        p.x += (p.x - p.px) * 0.99 + input * WATER.lateralForce;
        p.y += (p.y - p.py) * 0.99 + WATER.gravity;
        p.px = oldX; p.py = oldY;
        const rx = p.x - CUP.x, ry = p.y - CUP.y;
        let lx = rx * c + ry * s, ly = -rx * s + ry * c;
        const oldLy = -(oldX - CUP.x) * s + (oldY - CUP.y) * c;
        if (!p.entered && !p.depthSpill && oldLy < -CUP.h / 2 && ly >= -CUP.h / 2 &&
            Math.abs(lx) < CUP.tw - WATER.r) {
            p.entered = true;
        }
        const index = Math.max(0, Math.min(SURFACE_POINTS - 1,
            (lx / CUP.tw + 1) * (SURFACE_POINTS - 1) / 2));
        const lower = Math.floor(index), upper = Math.min(lower + 1, SURFACE_POINTS - 1);
        const wave = surface[lower] + (surface[upper] - surface[lower]) * (index - lower);
        if (p.entered && ly >= level + wave - lx * Math.tan(CUP.tilt) &&
            waterCount < initialCount) {
            waterCount++;
            surfaceVelocity[lower] += 0.03 * S;
            particles.splice(i, 1);
        } else if (!p.entered && !p.depthSpill && ly >= -CUP.h / 2 &&
            ly < CUP.h / 2 + WATER.r && Math.abs(lx) < halfWidth(ly) + WATER.r) {
            lx = (lx < 0 ? -1 : 1) * (halfWidth(ly) + WATER.r);
            p.x = CUP.x + lx * c - ly * s;
            p.y = CUP.y + lx * s + ly * c;
            p.px = p.x;
        } else if (p.y > canvas.height + 80 * S) {
            particles.splice(i, 1);
        }
    }
}

function update() {
    CUP.prevTilt = CUP.tilt;
    time += 1;
    // ほとんど揺れていない時は揺らさない
    // 入力を平滑化 (ローパス) して手の微振動を抑える
    rawAccelX *= 0.9; // 入力が途絶えたら減衰 (マウス用)
    rawAccelY *= 0.9;
    rawAccelZ *= 0.9;
    accelX += (rawAccelX - accelX) * 0.08;
    accelY += (rawAccelY - accelY) * 0.08;
    accelZ += (rawAccelZ - accelZ) * 0.08;
    const input = lateral();
    const vertical = motionInput(accelY);
    const depth = motionInput(accelZ);
    const mag = Math.min(1, Math.abs(input) * 2);
    shakeX = Math.sin(time * 0.9) * mag * 1.8 * S;
    shakeA = Math.sin(time * 1.3) * mag * 0.006;
    CUP.x = CUP.baseX + shakeX;
    CUP.tilt = input * CUP_TILT_RATIO + shakeA;
    updateSurface(input, vertical, depth);
    spillWater();
    for (let i = 0; i < 3; i++) stepDroplets(input);
}

const PHYSICS_FRAME_MS = 1000 / 60;
const MAX_FRAME_MS = 100;
let lastFrameTime = null;
let accumulatedTime = 0;

function advancePhysics(timestamp) {
    if (lastFrameTime === null) {
        lastFrameTime = timestamp;
        return;
    }
    const elapsed = Math.max(0, Math.min(timestamp - lastFrameTime, MAX_FRAME_MS));
    lastFrameTime = timestamp;
    accumulatedTime += elapsed;
    while (accumulatedTime + 1e-7 >= PHYSICS_FRAME_MS) {
        update();
        accumulatedTime -= PHYSICS_FRAME_MS;
    }
}

// 描画
function cupPath(inset) {
    const top = -CUP.h / 2, bot = CUP.h / 2;
    ctx.beginPath();
    ctx.moveTo(-CUP.tw + inset, top);
    ctx.lineTo(CUP.tw - inset, top);
    ctx.lineTo(CUP.bw - inset, bot);
    ctx.lineTo(-CUP.bw + inset, bot);
    ctx.closePath();
}

function drawShadow() {
    const lowest = CUP.y + CUP.h * 0.75;
    const g = ctx.createRadialGradient(CUP.x, lowest, 5, CUP.x, lowest, CUP.tw * 1.4);
    g.addColorStop(0, 'rgba(60,70,100,0.18)');
    g.addColorStop(1, 'rgba(60,70,100,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(CUP.x, lowest);
    ctx.scale(1, 0.18);
    ctx.translate(-CUP.x, -lowest);
    ctx.fillRect(0, lowest - CUP.tw * 1.5, canvas.width, CUP.tw * 3);
    ctx.restore();
}

const RIM_RATIO = 0.42; // 斜め上から見下ろした時の口の楕円の縦横比

function drawCupBack() {
    ctx.save();
    ctx.translate(CUP.x, CUP.y);
    ctx.rotate(CUP.tilt);
    const top = -CUP.h / 2, bot = CUP.h / 2;
    // 内側の壁 (口の楕円の内部)
    const g = ctx.createLinearGradient(0, top - CUP.tw * RIM_RATIO, 0, bot);
    g.addColorStop(0, '#f2f6f8');
    g.addColorStop(1, '#c9d3da');
    ctx.beginPath();
    ctx.ellipse(0, top, CUP.tw, CUP.tw * RIM_RATIO, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    // 底面
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(0, bot, CUP.bw, CUP.bw * RIM_RATIO, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    ctx.restore();
}

function drawWater() {
    if (waterCount > 0) {
        const level = waterLevel();
        const tilt = Math.tan(CUP.tilt);
        const span = Math.max(0, halfWidth(Math.max(-CUP.h / 2, Math.min(CUP.h / 2, level))));
        ctx.save();
        ctx.translate(CUP.x, CUP.y);
        ctx.rotate(CUP.tilt);
        cupPath(CUP.wall / 2);
        ctx.clip();
        ctx.beginPath();
        for (let i = 0; i < SURFACE_POINTS; i++) {
            const x = -CUP.tw + 2 * CUP.tw * i / (SURFACE_POINTS - 1);
            const arc = Math.sqrt(Math.max(0, 1 - (x / span) ** 2));
            const y = level + surface[i] - x * tilt + depthWave * arc;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.lineTo(CUP.tw, CUP.h / 2);
        ctx.lineTo(-CUP.tw, CUP.h / 2);
        ctx.closePath();
        const water = ctx.createLinearGradient(0, -CUP.h / 2, 0, CUP.h / 2);
        water.addColorStop(0, 'rgba(80,185,245,0.9)');
        water.addColorStop(1, 'rgba(30,115,215,0.9)');
        ctx.fillStyle = water;
        ctx.fill();
        ctx.beginPath();
        for (let i = 0; i < SURFACE_POINTS; i++) {
            const x = -span + 2 * span * i / (SURFACE_POINTS - 1);
            const index = (x / CUP.tw + 1) * (SURFACE_POINTS - 1) / 2;
            const lower = Math.floor(index), upper = Math.min(lower + 1, SURFACE_POINTS - 1);
            const wave = surface[lower] + (surface[upper] - surface[lower]) * (index - lower);
            const arc = Math.sqrt(Math.max(0, 1 - (x / span) ** 2));
            const y = level + wave - x * tilt - (span * RIM_RATIO * 0.45 + depthWave) * arc;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        for (let i = SURFACE_POINTS - 1; i >= 0; i--) {
            const x = -span + 2 * span * i / (SURFACE_POINTS - 1);
            const index = (x / CUP.tw + 1) * (SURFACE_POINTS - 1) / 2;
            const lower = Math.floor(index), upper = Math.min(lower + 1, SURFACE_POINTS - 1);
            const wave = surface[lower] + (surface[upper] - surface[lower]) * (index - lower);
            const arc = Math.sqrt(Math.max(0, 1 - (x / span) ** 2));
            ctx.lineTo(x, level + wave - x * tilt + depthWave * arc);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(95, 190, 245, 0.85)';
        ctx.fill();
        ctx.restore();
    }

    if (particles.length === 0) return;
    const w = layer.width, h = layer.height;
    lctx.clearRect(0, 0, w, h);
    const half = sprite.width / 2;
    for (const p of particles) {
        lctx.drawImage(sprite, p.x * RES - half, p.y * RES - half);
    }
    const img = lctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (a < 70) { d[i + 3] = 0; continue; }
        const edge = Math.min(1, (a - 70) / 40);
        const depth = Math.min(1, (a - 70) / 160);
        d[i] = 70 - depth * 40;
        d[i + 1] = 170 - depth * 55;
        d[i + 2] = 245 - depth * 30;
        d[i + 3] = edge * (170 + depth * 60);
        if (a < 110) { // 水面のハイライト
            d[i] = 190; d[i + 1] = 230; d[i + 2] = 255;
        }
    }
    lctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
}

function drawCupFront() {
    ctx.save();
    ctx.translate(CUP.x, CUP.y);
    ctx.rotate(CUP.tilt);
    const top = -CUP.h / 2, bot = CUP.h / 2;
    const rt = CUP.tw * RIM_RATIO, rb = CUP.bw * RIM_RATIO;

    // 手前側の胴体 (白い紙。水がうっすら透ける)
    ctx.beginPath();
    ctx.moveTo(-CUP.tw, top);
    ctx.ellipse(0, top, CUP.tw, rt, 0, Math.PI, 0, true);
    ctx.lineTo(CUP.bw, bot);
    ctx.ellipse(0, bot, CUP.bw, rb, 0, 0, Math.PI);
    ctx.closePath();
    const g = ctx.createLinearGradient(-CUP.tw, 0, CUP.tw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.7)');
    g.addColorStop(0.5, 'rgba(250,252,255,0.5)');
    g.addColorStop(1, 'rgba(205,213,222,0.75)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,170,185,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 縁のロール
    ctx.beginPath();
    ctx.ellipse(0, top, CUP.tw, rt, 0, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = CUP.wall * 1.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(160,170,185,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
}

function animate(timestamp) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    advancePhysics(timestamp);
    drawShadow();
    drawCupBack();
    drawWater();
    drawCupFront();

    const pct = Math.min(100, Math.round(waterCount / initialCount * 100));
    info.textContent = `加速度（左右 / 上下 / 前後）: ${accelX.toFixed(1)} / ${accelY.toFixed(1)} / ${accelZ.toFixed(1)} m/s²`;
    waterPercent.textContent = `水の残量: ${pct}%`;
    requestAnimationFrame(animate);
}

// iOS はタッチ完了後のユーザー操作中に許可を要求する
if (requiresMotionPermission) {
    motionPermission.hidden = false;
    motionPermissionStatus.textContent = '画面をタップしてモーションセンサーを有効にしてください。';
    window.addEventListener('pointerup', handlePermissionGesture, true);
}
motionPermissionBtn.addEventListener('click', () => {
    window.removeEventListener('pointerup', handlePermissionGesture, true);
    void requestPermission();
});
document.getElementById('resetBtn').addEventListener('click', fillCup);
window.addEventListener('resize', layout);

window.addEventListener('load', () => {
    layout();
    requestAnimationFrame(animate);
    if (!requiresMotionPermission) {
        requestPermission();
    }
});
