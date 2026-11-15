import { strict as assert } from "node:assert";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../cup.js", import.meta.url));

function createSimulation() {
    const listeners = new Map();
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, {
            style: {},
            setAttribute() {},
            addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
            getContext: () => ({}),
        });
        return elements.get(id);
    };
    const context = {
        window: { addEventListener() {}, removeEventListener() {} },
        document: { getElementById: element, querySelector: element, createElement: element },
        console, setTimeout, clearTimeout,
    };
    runInNewContext(source, context);
    runInNewContext(`
        S = 1;
        canvas.height = 844;
        CUP = { baseX: 195, x: 195, y: 200, h: 170, tw: 78, bw: 52,
                wall: 4, tilt: 0, waterTilt: 0, prevTilt: 0 };
        CUP.k = (CUP.bw - CUP.tw) / CUP.h;
        CUP.L = Math.sqrt(1 + CUP.k * CUP.k);
        WATER = { r: 5.2, gravity: WATER_GRAVITY, lateralForce: 0.45 };
        fillCup();
    `, context);
    return {
        run: (code) => runInNewContext(code, context),
        tap: () => listeners.get("canvas:pointerdown")(),
        setSensitivity: (value) => {
            element("sensitivity").value = String(value);
            listeners.get("sensitivity:input")();
            return element("sensitivityValue").textContent;
        },
    };
}

Deno.test("default sensitivity matches the previous 3.0x setting", () => {
    const { run } = createSimulation();
    for (const acceleration of [1, 1.6, 2, 4, -2, 20]) {
        run(`accelX = ${acceleration}`);
        const expected = Math.min(0.8, Math.max(0, Math.abs(acceleration) - 1.5) * 4.5 / 9.8)
            * (acceleration < 0 ? 1 : -1);
        assert.ok(Math.abs(run("lateral()") - expected) < 1e-12);
    }
});

Deno.test("sensitivity slider supports 10.0x and controls all motion axes", async () => {
    const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
    assert.match(html, /id="sensitivity" min="0\.2" max="10" step="0\.1" value="1"/);
    const app = createSimulation();
    assert.equal(app.setSensitivity(10), "10.0x");
    const expected = -(1.6 - 1.5) * 45 / 9.8;
    assert.ok(Math.abs(app.run("motionInput(1.6)") - expected) < 1e-12);
    assert.equal(app.run("motionInput(3)"), -0.8);
    assert.equal(app.setSensitivity(1), "1.0x");
    assert.ok(Math.abs(app.run("motionInput(1.6)") - expected / 10) < 1e-12);
});

Deno.test("waves continue after input and converge exactly flat", () => {
    for (const direction of [-1, 1]) {
        const { run } = createSimulation();
        run(`for (let i = 0; i < 30; i++) updateSurface(${direction} * 0.3)`);
        const tilted = run("surface.at(-1) - surface[0]");
        assert.ok(Math.abs(tilted) > 5);
        const before = run("JSON.stringify(surface)");
        run("updateSurface(0)");
        assert.notEqual(run("JSON.stringify(surface)"), before);
        run("for (let i = 0; i < 900; i++) updateSurface(0)");
        assert.equal(run("surface.every(h => h === 0)"), true);
        assert.equal(run("surfaceVelocity.every(v => v === 0)"), true);
    }
});

Deno.test("vertical and depth inputs generate distinct waves in either direction and settle", () => {
    for (const axis of ["vertical", "depth"]) {
        for (const direction of [-1, 1]) {
            const { run } = createSimulation();
            const args = axis === "vertical" ? `0, ${direction} * 0.3, 0` : `0, 0, ${direction} * 0.3`;
            run(`for (let i = 0; i < 30; i++) updateSurface(${args})`);
            if (axis === "vertical") {
                assert.ok(run("Math.max(...surface.map(Math.abs))") > 1);
                assert.ok(Math.abs(run("surface[0] - surface.at(-1)")) < 1e-10);
                assert.equal(run("depthWave"), 0);
            } else {
                assert.ok(run("depthWave") * direction > 1);
                assert.equal(run("surface.every(h => h === 0)"), true);
            }
            run("for (let i = 0; i < 900; i++) updateSurface(0, 0, 0)");
            assert.equal(run("surface.every(h => h === 0)"), true);
            assert.equal(run("depthWave"), 0);
            assert.equal(run("depthVelocity"), 0);
        }
    }
});

Deno.test("device acceleration drives each axis through the normal update loop", () => {
    for (const axis of ["x", "y", "z"]) {
        for (const direction of [-1, 1]) {
            const { run } = createSimulation();
            run(`for (let i = 0; i < 30; i++) {
                handleDeviceMotion({ acceleration: { x: ${axis === "x" ? direction * 4 : 0},
                    y: ${axis === "y" ? direction * 4 : 0}, z: ${axis === "z" ? direction * 4 : 0} } });
                update();
            }`);
            if (axis === "z") {
                assert.ok(Math.abs(run("depthWave")) > 1);
            } else {
                assert.ok(run("Math.max(...surface.map(Math.abs))") > 1);
            }
            run("for (let i = 0; i < 1000; i++) update()");
            assert.equal(run("surface.every(h => h === 0)"), true);
            assert.equal(run("depthWave"), 0);
        }
    }
});

Deno.test("static gravity tilt sets the water plane without rotating the cup", () => {
    const { run } = createSimulation();
    run(`rawGravityTilt = 0.3;
        for (let i = 0; i < 100; i++) update();`);
    assert.ok(Math.abs(run("CUP.waterTilt - 0.3")) < 0.001);
    assert.equal(run("CUP.tilt"), 0);
    assert.ok(Math.abs(run("surface.at(-1) - surface[0]")) < 1e-10);
    assert.ok(Math.abs(run(`waterArea(waterLevel()) -
        (2 * CUP.bw * CUP.h * 0.8 +
        (CUP.tw - CUP.bw) * CUP.h * 0.8 ** 2) * waterCount / initialCount`)) < 0.001);
});

Deno.test("static front-back tilt creates a persistent depth response", () => {
    const { run } = createSimulation();
    run(`rawGravityDepth = 0.3;
        for (let i = 0; i < 100; i++) update();`);
    assert.ok(run("Math.abs(depthWave) > 1"));
    assert.equal(run("surface.every(h => h === 0)"), true);
});

Deno.test("depth overflow creates droplets and preserves water accounting", () => {
    for (const sign of [-1, 1]) {
        const { run } = createSimulation();
        run(`globalThis.initial = waterCount;
            for (let i = 0; i < 180; i++) { updateSurface(0, 0, ${sign} * 0.8); spillWater(); }`);
        assert.ok(run("waterCount < initial"));
        assert.equal(run("waterCount + particles.length"), run("initial"));
        assert.ok(run("particles.every(p => p.depthSpill)"));
        run("for (let i = 0; i < 10; i++) stepDroplets(0)");
        assert.equal(run("waterCount + particles.length"), run("initial"));
    }
});

Deno.test("water level preserves volume with waves and changes with water count", () => {
    const { run } = createSimulation();
    const initial = run("waterLevel()");
    run("for (let i = 0; i < 30; i++) updateSurface(0.25)");
    const area = run("waterArea(waterLevel())");
    const expected = run(`(2 * CUP.bw * CUP.h * 0.8 +
        (CUP.tw - CUP.bw) * CUP.h * 0.8 ** 2) * waterCount / initialCount`);
    assert.ok(Math.abs(area - expected) < 0.001);
    run("surface.fill(0); waterCount = Math.floor(initialCount / 2)");
    assert.ok(run("waterLevel()") > initial);
    for (const fraction of [0.1, 0.5, 1]) {
        run(`waterCount = Math.round(initialCount * ${fraction}); CUP.tilt = 0.025`);
        const actual = run("waterArea(waterLevel())");
        const target = run(`(2 * CUP.bw * CUP.h * 0.8 +
            (CUP.tw - CUP.bw) * CUP.h * 0.8 ** 2) * waterCount / initialCount`);
        assert.ok(Math.abs(actual - target) < 0.001);
    }
});

Deno.test("overflow reduces cup water and creates falling droplets", () => {
    const { run } = createSimulation();
    run(`
        globalThis.initial = waterCount;
        for (let i = 0; i < 180; i++) { updateSurface(0.8); spillWater(); }
    `);
    assert.ok(run("waterCount < initial"));
    assert.equal(run("waterCount + particles.length"), run("initial"));
    assert.ok(run("particles.every(p => !p.incoming)"));
    const y = run("particles[0].y");
    run("for (let i = 0; i < 10; i++) stepDroplets(0)");
    assert.ok(run("particles[0].y") > y);
});

Deno.test("refill drops are counted on reaching the surface and cannot overfill", () => {
    const app = createSimulation();
    const { run } = app;
    run("waterCount = initialCount - 10");
    app.tap();
    app.tap();
    assert.equal(run("particles.length"), 10);
    assert.equal(run("waterCount"), run("initialCount - 10"));
    run(`
        for (const p of particles) { p.x = CUP.x; p.px = p.x; p.y = CUP.y - CUP.h / 2 - 0.01; p.py = p.y - 1; }
        stepDroplets(0);
    `);
    assert.equal(run("waterCount"), run("initialCount - 10"));
    run("for (let i = 0; i < 80; i++) stepDroplets(0)");
    assert.equal(run("waterCount"), run("initialCount"));
    assert.equal(run("particles.length"), 0);
});

Deno.test("reset restores water and clears waves and droplets", () => {
    const { run } = createSimulation();
    run("waterCount = 0; spawn(0, -CUP.h, 0, 0, true); updateSurface(0.5, 0.5, 0.5); fillCup()");
    assert.equal(run("waterCount"), run("initialCount"));
    assert.equal(run("particles.length"), 0);
    assert.equal(run("surface.every(h => h === 0)"), true);
    assert.equal(run("surfaceVelocity.every(v => v === 0)"), true);
    assert.equal(run("depthWave"), 0);
    assert.equal(run("depthVelocity"), 0);
});

Deno.test("spilled drops that return through the opening are restored at the surface", () => {
    const { run } = createSimulation();
    run(`
        waterCount = initialCount - 1;
        spawn(0, -CUP.h / 2 - 0.01, 0, 1);
        for (let i = 0; i < 80; i++) stepDroplets(0);
    `);
    assert.equal(run("waterCount"), run("initialCount"));
    assert.equal(run("particles.length"), 0);
});

Deno.test("physics updates match across display refresh rates", () => {
    const snapshots = [];
    for (const fps of [30, 60, 120]) {
        const { run } = createSimulation();
        run(`rawAccelX = 5; advancePhysics(0);
            for (let i = 1; i <= ${fps} * 3; i++) advancePhysics(i * 1000 / ${fps});`);
        assert.equal(run("time"), 180);
        snapshots.push(run("JSON.stringify({ surface, surfaceVelocity, waterCount })"));
    }
    assert.equal(snapshots[0], snapshots[1]);
    assert.equal(snapshots[1], snapshots[2]);
});

Deno.test("long frame gaps are bounded", () => {
    const { run } = createSimulation();
    run("advancePhysics(0); advancePhysics(5000)");
    assert.equal(run("time"), 6);
});
