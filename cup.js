// 紙コップ水シミュレーター: 断面図の紙コップ + Verlet 粒子による水
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const info = document.getElementById('info');

let S = 1;            // スケール (canvas幅/360)
let CUP, WATER;
const TARGET_COUNT = 320;
const particles = [];

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
    const maxWidth = Math.min(window.innerWidth - 40, 600);
    const maxHeight = Math.min(window.innerHeight * 0.7, 800);
    const aspect = 0.6;
    if (maxWidth / maxHeight > 1 / aspect) {
        canvas.height = maxHeight;
        canvas.width = maxHeight * aspect;
    } else {
        canvas.width = maxWidth;
        canvas.height = maxWidth / aspect;
    }
    S = canvas.width / 360;
    const h = 170 * S;
    CUP = {
        x: canvas.width / 2,
        y: canvas.height * 0.45,
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
    const fillTop = CUP.h / 2 - CUP.h * 0.6;
    for (let y = bottom, row = 0; y > fillTop && particles.length < TARGET_COUNT; y -= gap * 0.9, row++) {
        const hw = halfWidth(y) - WATER.r - CUP.wall;
        for (let x = -hw + (row % 2) * gap / 2; x <= hw && particles.length < TARGET_COUNT; x += gap) {
            spawn(x, y);
        }
    }
}

// 傾き入力
let deviceTilt = 0;
let hasPermission = false;
let listening = false;

function enableInputs() {
    document.getElementById('permissionPrompt').classList.add('hidden');
}

async function requestPermission() {
    try {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission === 'granted') {
                hasPermission = true;
                window.addEventListener('deviceorientation', handleDeviceOrientation);
            } else {
                window.addEventListener('mousemove', handleMouseMove);
            }
        } else {
            window.addEventListener('deviceorientation', handleDeviceOrientation);
            window.addEventListener('mousemove', handleMouseMove);
        }
    } catch (e) {
        window.addEventListener('mousemove', handleMouseMove);
    }
    enableInputs();
}

function handleDeviceOrientation(event) {
    if (event.gamma === null || event.gamma === undefined) return;
    hasPermission = true;
    deviceTilt = event.gamma * Math.PI / 180;
}

function handleMouseMove(event) {
    if (hasPermission) return;
    const rect = canvas.getBoundingClientRect();
    const t = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    deviceTilt = Math.max(-1, Math.min(1, t)) * 1.5;
}

// タップで水を足す
canvas.addEventListener('pointerdown', () => {
    if (particles.length >= TARGET_COUNT) return;
    const n = Math.min(60, TARGET_COUNT - particles.length);
    for (let i = 0; i < n; i++) {
        spawn((Math.random() - 0.5) * CUP.tw, -CUP.h / 2 - Math.random() * 60 * S);
    }
});

// 物理
function step() {
    const { r, gravity } = WATER;
    const rot = CUP.tilt;
    const c = Math.cos(rot), s = Math.sin(rot);
    const t = CUP.wall / 2;

    for (const p of particles) {
        const vx = (p.x - p.px) * 0.995;
        const vy = (p.y - p.py) * 0.995;
        p.px = p.x; p.py = p.y;
        p.x += vx;
        p.y += vy + gravity;
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
        const gap = r + t;

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
    CUP.tilt += (deviceTilt - CUP.tilt) * 0.18;
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

function drawCupBack() {
    ctx.save();
    ctx.translate(CUP.x, CUP.y);
    ctx.rotate(CUP.tilt);
    cupPath(0);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
    // 内側の奥の面
    ctx.beginPath();
    ctx.ellipse(0, -CUP.h / 2, CUP.tw, CUP.tw * 0.16, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(214,196,168,0.55)';
    ctx.fill();
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

    // 半透明の紙の胴体 + 縦のグラデーション
    cupPath(0);
    const g = ctx.createLinearGradient(-CUP.tw, 0, CUP.tw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.05)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(120,130,150,0.22)');
    ctx.fillStyle = g;
    ctx.fill();

    // 赤い帯の模様
    ctx.save();
    cupPath(0);
    ctx.clip();
    ctx.fillStyle = 'rgba(214,50,48,0.8)';
    const bandTop = top + CUP.h * 0.55, bandBot = top + CUP.h * 0.78;
    ctx.fillRect(-CUP.tw, bandTop, CUP.tw * 2, bandBot - bandTop);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = -4; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(i * CUP.tw * 0.24, (bandTop + bandBot) / 2, CUP.h * 0.025, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();

    // 紙の壁 (厚み)
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#f4ead7';
    ctx.lineWidth = CUP.wall;
    ctx.beginPath();
    ctx.moveTo(-CUP.tw, top);
    ctx.lineTo(-CUP.bw, bot);
    ctx.lineTo(CUP.bw, bot);
    ctx.lineTo(CUP.tw, top);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(140,110,70,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 縁のロール (巻き込み)
    ctx.strokeStyle = '#fffaf0';
    ctx.lineWidth = CUP.wall * 1.6;
    ctx.beginPath();
    ctx.moveTo(-CUP.tw - 1, top);
    ctx.lineTo(CUP.tw + 1, top);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(140,110,70,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 底の折り返し
    ctx.fillStyle = '#e6d9bf';
    ctx.fillRect(-CUP.bw - CUP.wall / 2, bot, CUP.bw * 2 + CUP.wall, CUP.wall * 1.2);

    // ハイライト
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3 * S;
    ctx.beginPath();
    ctx.moveTo(-CUP.tw * 0.8, top + 12 * S);
    ctx.lineTo(-CUP.bw * 0.82, bot - 14 * S);
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

    const angle = (CUP.tilt * 180 / Math.PI).toFixed(1);
    info.textContent = `Angle: ${angle}° | Water: ${particles.length}`;
    requestAnimationFrame(animate);
}

document.getElementById('permissionAllow').addEventListener('click', requestPermission);
document.getElementById('permissionDeny').addEventListener('click', () => {
    window.addEventListener('mousemove', handleMouseMove);
    enableInputs();
});
window.addEventListener('resize', layout);

window.addEventListener('load', () => {
    layout();
    animate();
    if (!(typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function')) {
        requestPermission();
    }
});
