// 紙コップ水シミュレーター: 断面図の紙コップ + Verlet 粒子による水
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
// 横加速度 (m/s²) から重力に対する横方向の割合を求める
const lateral = () => {
    const a = Math.abs(accelX) - ACCEL_DEADZONE;
    if (a <= 0) return 0;
    const v = Math.min(MAX_LATERAL, a * sensitivity / 9.8);
    return accelX < 0 ? v : -v; // 端末が右へ加速すると水は左へ偏る
};
let S = 1;            // スケール (canvas幅/360)
let CUP, WATER;
const TARGET_COUNT = 800; // 初期水位80%に必要な粒子数
const particles = [];
let initialCount = 1;
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
    WATER = { r: 5.2 * S, gravity: 0.45 * S };
    layer.width = Math.ceil(canvas.width * RES);
    layer.height = Math.ceil(canvas.height * RES);
    makeSprite(WATER.r * 3.2 * RES);
    statusEl.style.top = (CUP.y + h / 2 + 16) + 'px';
    sensitivityEl.style.top = (CUP.y + h / 2 + 16 + 56) + 'px';
    fillCup();
}

const halfWidth = (y) => CUP.tw + (CUP.bw - CUP.tw) * ((y + CUP.h / 2) / CUP.h);

function spawn(lx, ly) {
    const c = Math.cos(CUP.tilt), s = Math.sin(CUP.tilt);
    const x = CUP.x + lx * c - ly * s;
    const y = CUP.y + lx * s + ly * c;
    particles.push({ x, y, px: x, py: y, inside: true });
}

// コップの約6割まで水を満たす
function fillCup() {
    particles.length = 0;
    const gap = WATER.r * 1.7;
    const bottom = CUP.h / 2 - WATER.r - CUP.wall;
    const fillTop = CUP.h / 2 - CUP.h * 0.8;
    for (let y = bottom, row = 0; y > fillTop && particles.length < TARGET_COUNT; y -= gap * 0.9, row++) {
        const hw = halfWidth(y) - WATER.r - CUP.wall;
        for (let x = -hw + (row % 2) * gap / 2; x <= hw && particles.length < TARGET_COUNT; x += gap) {
            spawn(x, y);
        }
    }
    initialCount = particles.length || 1;
}

// 傾き入力
let accelX = 0; // ローパス後の横加速度 (m/s²)
let rawAccelX = 0;
let hasPermission = false;
let listening = false;

async function requestPermission() {
    try {
        if (typeof DeviceMotionEvent !== 'undefined' &&
            typeof DeviceMotionEvent.requestPermission === 'function') {
            const permission = await DeviceMotionEvent.requestPermission();
            if (permission === 'granted') {
                hasPermission = true;
                window.addEventListener('devicemotion', handleDeviceMotion);
            } else {
                window.addEventListener('mousemove', handleMouseMove);
            }
        } else {
            window.addEventListener('devicemotion', handleDeviceMotion);
            window.addEventListener('mousemove', handleMouseMove);
        }
    } catch (e) {
        window.addEventListener('mousemove', handleMouseMove);
    }
}

function handleDeviceMotion(event) {
    const a = event.acceleration;
    if (!a || a.x === null || a.x === undefined) return;
    hasPermission = true;
    rawAccelX = a.x;
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
    if (particles.length >= initialCount) return;
    const n = Math.min(60, initialCount - particles.length);
    for (let i = 0; i < n; i++) {
        spawn((Math.random() - 0.5) * CUP.tw, -CUP.h / 2 - Math.random() * 60 * S);
    }
});

// 物理
function step() {
    const { r, gravity } = WATER;
    const rot = CUP.tilt;
    // 水にかかる重力は端末の傾きに追従 (コップ自体は傾かない)
    const gx = lateral() * gravity, gy = gravity;
    const c = Math.cos(rot), s = Math.sin(rot);
    const t = CUP.wall / 2;

    const calm = gx === 0;
    for (const p of particles) {
        const vx = calm ? 0 : (p.x - p.px) * 0.995; // 揺れがない時は横に流れない
        const vy = (p.y - p.py) * 0.995;
        p.px = p.x; p.py = p.y;
        p.x += vx;
        p.x += gx;
        p.y += vy + gy;
    }

    // 粒子同士の反発 (水の体積と粘り気)
    const H = r * 2.1;
    const n = particles.length;
    for (let i = 0; i < n; i++) {
        const a = particles[i];
        for (let j = i + 1; j < n; j++) {
            const b = particles[j];
            const dx = b.x - a.x;
            if (dx > H || dx < -H) continue;
            const dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= H * H || d2 === 0) continue;
            const d = Math.sqrt(d2);
            const push = (H - d) * 0.5 * 0.55 / d;
            a.x -= dx * push; a.y -= dy * push;
            b.x += dx * push; b.y += dy * push;
        }
    }

    // コップの壁との衝突 (コップのローカル座標系で処理)
    for (const p of particles) {
        const rx = p.x - CUP.x, ry = p.y - CUP.y;
        let lx = rx * c + ry * s;
        let ly = -rx * s + ry * c;
        const top = -CUP.h / 2, bot = CUP.h / 2;
        const gap = r * 1.9 + t; // 水の描画の広がり分も壁から離す

        if (p.inside) {
            if (ly < top) {
                if (Math.abs(lx) > CUP.tw) p.inside = false; // 縁を越えてこぼれた
            } else {
                const sign = lx < 0 ? -1 : 1;
                const nx = sign / CUP.L, ny = -CUP.k / CUP.L;
                const pen = (Math.abs(lx) - halfWidth(ly)) / CUP.L + gap;
                if (pen > 0) { lx -= nx * pen; ly -= ny * pen; }
                if (ly > bot - gap) ly = bot - gap;
            }
        } else {
            if (ly < top && Math.abs(lx) < CUP.tw - gap) {
                p.inside = true; // 口から戻った
            } else if (ly > top - r && ly < bot + gap) {
                const hw = halfWidth(Math.max(ly, top)) + gap;
                if (Math.abs(lx) < hw) {
                    // 壁の外側にいる粒子は最も近い外面へ押し出す
                    const toSide = hw - Math.abs(lx);
                    const toBottom = bot + gap - ly;
                    if (toBottom < toSide) ly = bot + gap;
                    else lx = (lx < 0 ? -1 : 1) * hw;
                }
            }
        }

        p.x = CUP.x + lx * c - ly * s;
        p.y = CUP.y + lx * s + ly * c;
    }

    // 画面外に落ちた水は消す
    for (let i = particles.length - 1; i >= 0; i--) {
        if (particles[i].y > canvas.height + 80 * S) particles.splice(i, 1);
    }
}

function update() {
    CUP.prevTilt = CUP.tilt;
    time += 1;
    // ほとんど揺れていない時は揺らさない
    // 入力を平滑化 (ローパス) して手の微振動を抑える
    rawAccelX *= 0.9; // 入力が途絶えたら減衰 (マウス用)
    accelX += (rawAccelX - accelX) * 0.08;
    const mag = Math.min(1, Math.abs(lateral()) * 2);
    shakeX = Math.sin(time * 0.9) * mag * 1.8 * S;
    shakeA = Math.sin(time * 1.3) * mag * 0.006;
    CUP.x = CUP.baseX + shakeX;
    CUP.tilt = lateral() * CUP_TILT_RATIO + shakeA;
    const sub = 3;
    for (let i = 0; i < sub; i++) step();
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

function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    update();
    drawShadow();
    drawCupBack();
    drawWater();
    drawCupFront();

    const angle = accelX.toFixed(1);
    const inside = particles.reduce((n, p) => n + (p.inside ? 1 : 0), 0);
    const pct = Math.min(100, Math.round(inside / initialCount * 100));
    info.textContent = `Accel: ${angle} m/s²`;
    waterPercent.textContent = `水の残量: ${pct}%`;
    requestAnimationFrame(animate);
}

// iOS は操作中にしか許可を要求できないので、最初のタップで要求する
if (typeof DeviceMotionEvent !== 'undefined' &&
    typeof DeviceMotionEvent.requestPermission === 'function') {
    window.addEventListener('pointerdown', requestPermission, { once: true });
}
document.getElementById('resetBtn').addEventListener('click', fillCup);
window.addEventListener('resize', layout);

window.addEventListener('load', () => {
    layout();
    animate();
    if (!(typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function')) {
        requestPermission();
    }
});
