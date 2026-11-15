import { strict as assert } from "node:assert";
import { runInNewContext } from "node:vm";

const source = await Deno.readTextFile(new URL("../cup.js", import.meta.url));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createApp(requestPermission) {
    const listeners = new Map();
    const elements = new Map();
    const timers = new Map();
    let timerId = 0;
    const element = (id) => {
        if (!elements.has(id)) {
            elements.set(id, {
                hidden: false,
                disabled: false,
                textContent: "",
                style: {},
                attributes: {},
                setAttribute(name, value) { this.attributes[name] = value; },
                getContext: () => ({}),
                contains(target) { return target === this; },
                addEventListener(type, handler) {
                    listeners.set(`${id}:${type}`, handler);
                },
            });
        }
        return elements.get(id);
    };
    const window = {
        addEventListener(type, handler) {
            const handlers = listeners.get(type) || [];
            handlers.push(handler);
            listeners.set(type, handlers);
        },
        removeEventListener(type, handler) {
            listeners.set(type, (listeners.get(type) || []).filter((item) => item !== handler));
        },
    };
    const context = {
        window,
        document: {
            getElementById: element,
            querySelector: element,
            createElement: element,
        },
        DeviceMotionEvent: { requestPermission },
        console: { error() {} },
        setTimeout(callback, delay) {
            timers.set(++timerId, { callback, delay });
            return timerId;
        },
        clearTimeout(id) { timers.delete(id); },
    };
    runInNewContext(source, context);
    return {
        element,
        run(code) { return runInNewContext(code, context); },
        acceleration() { return runInNewContext("rawAccelX", context); },
        axes() { return runInNewContext("[rawAccelX, rawAccelY, rawAccelZ]", context); },
        rawTilt() { return runInNewContext("rawGravityTilt", context); },
        rawDepth() { return runInNewContext("rawGravityDepth", context); },
        setOrientation(angle) { window.screen = { orientation: { angle } }; },
        dispatch(type, event) {
            for (const handler of [...(listeners.get(type) || [])]) handler(event);
        },
        clickButton() { listeners.get("motionPermissionBtn:click")(); },
        clickReset() { listeners.get("resetBtn:click")(); },
        timerDelays() { return Array.from(timers.values(), (timer) => timer.delay); },
        runTimers() {
            for (const { callback } of timers.values()) callback();
            timers.clear();
        },
    };
}

Deno.test("requests motion permission on touch release and receives acceleration", async () => {
    let requests = 0;
    const app = createApp(() => {
        requests++;
        return Promise.resolve("granted");
    });
    const event = { isTrusted: true, target: app.element("canvas") };
    app.dispatch("pointerdown", event);
    assert.equal(requests, 0);
    app.dispatch("pointerup", { ...event, isTrusted: false });
    assert.equal(requests, 0);
    app.dispatch("pointerup", event);
    assert.equal(requests, 1);
    await flush();
    assert.equal(app.element("motionPermission").hidden, false);
    assert.equal(app.element("motionPermissionBtn").hidden, true);
    app.dispatch("devicemotion", { acceleration: { x: 4 } });
    assert.equal(app.element("motionPermission").hidden, true);
    assert.equal(app.acceleration(), 4);
    app.runTimers();
    assert.equal(app.element("motionPermission").hidden, true);
});

Deno.test("screen-relative axes follow orientation and accept partial sensor data", async () => {
    const app = createApp(() => Promise.resolve("granted"));
    app.clickButton();
    await flush();
    app.dispatch("devicemotion", { acceleration: { x: 2, y: 3, z: 4 } });
    assert.deepEqual(Array.from(app.axes()), [2, 3, 4]);
    app.setOrientation(90);
    app.dispatch("devicemotion", { acceleration: { x: 2, y: 3, z: 4 } });
    const [x, y, z] = app.axes();
    assert.ok(Math.abs(x - 3) < 1e-10);
    assert.ok(Math.abs(y + 2) < 1e-10);
    assert.equal(z, 4);
    app.dispatch("devicemotion", { acceleration: { x: null, y: null, z: 5 } });
    assert.deepEqual(Array.from(app.axes()), [0, 0, 5]);
});

Deno.test("gravity sensor detects static tilt and follows screen orientation", async () => {
    const app = createApp(() => Promise.resolve("granted"));
    app.clickButton();
    await flush();
    app.dispatch("devicemotion", {
        acceleration: null,
        accelerationIncludingGravity: { x: -4, y: 8, z: 4 },
    });
    assert.ok(Math.abs(app.rawTilt() - Math.atan2(4, 8)) < 1e-10);
    assert.ok(Math.abs(app.rawDepth() - Math.atan2(4, 8)) < 1e-10);
    assert.deepEqual(["gravityXInfo", "gravityYInfo", "gravityZInfo"].map(id => app.element(id).textContent),
        ["-4.0", "8.0", "4.0"]);
    assert.equal(app.element("tiltXInfo").textContent, "26.6");
    assert.equal(app.element("tiltZInfo").textContent, "26.6");
    assert.equal(app.element("orientationInfo").textContent, "0");
    app.setOrientation(90);
    app.dispatch("devicemotion", {
        acceleration: null,
        accelerationIncludingGravity: { x: -4, y: 8, z: 4 },
    });
    assert.ok(Math.abs(app.rawTilt() - Math.atan2(-8, 4)) < 1e-10);
    assert.ok(Math.abs(app.rawDepth() - Math.atan2(4, 4)) < 1e-10);
    assert.equal(app.element("tiltXInfo").textContent, "-63.4");
    assert.equal(app.element("tiltZInfo").textContent, "45.0");
    assert.equal(app.element("orientationInfo").textContent, "90");
    app.dispatch("devicemotion", { acceleration: null, accelerationIncludingGravity: null });
    for (const id of ["gravityXInfo", "gravityYInfo", "gravityZInfo", "tiltXInfo", "tiltZInfo"]) {
        assert.equal(app.element(id).textContent, "未取得");
    }
});

Deno.test("inverted sensors calibrate upright near 180 degrees on both axes", async () => {
    const app = createApp(() => Promise.resolve("granted"));
    app.clickButton();
    await flush();
    const motion = (xDegrees, zDegrees) => app.dispatch("devicemotion", {
        acceleration: null,
        accelerationIncludingGravity: {
            x: 9.8 * Math.tan(xDegrees * Math.PI / 180),
            y: -9.8,
            z: 9.8 * Math.tan(zDegrees * Math.PI / 180),
        },
    });
    motion(0, 0);
    assert.equal(app.run("gravityPolarity"), -1);
    for (const [x, z] of [[30, 30], [-30, -30], [30.01, 0], [0, -30.01]]) {
        motion(x, z);
        assert.equal(app.element("resetBtn").attributes["aria-disabled"],
            Math.abs(x) <= 30 && Math.abs(z) <= 30 ? "false" : "true");
    }
    app.dispatch("devicemotion", { accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 } });
    assert.equal(app.run("gravityPolarity"), -1);
    assert.equal(app.element("resetBtn").attributes["aria-disabled"], "true");
});

Deno.test("the first inverted reading at the 30-degree boundary establishes the upright reference", async () => {
    const app = createApp(() => Promise.resolve("granted"));
    app.clickButton();
    await flush();
    const axis = 9.8 * Math.tan(Math.PI / 6);
    app.dispatch("devicemotion", {
        accelerationIncludingGravity: { x: axis, y: -9.8, z: -axis },
    });
    assert.equal(app.run("gravityPolarity"), -1);
    assert.equal(app.element("resetBtn").attributes["aria-disabled"], "false");
});

Deno.test("reset requires a recent upright gravity reading", async () => {
    const app = createApp(() => Promise.resolve("granted"));
    app.run("globalThis.resets = 0; fillCup = () => resets++");
    const button = app.element("resetBtn");
    app.clickReset();
    assert.equal(app.run("resets"), 0);
    assert.equal(button.attributes["aria-disabled"], "true");
    assert.match(app.element("resetWarning").textContent, /端末を立てた状態でボタンを押してください/);

    app.clickButton();
    await flush();
    const motion = (gravity) => app.dispatch("devicemotion", {
        acceleration: null, accelerationIncludingGravity: gravity,
    });
    const tilted = (degrees) => ({
        x: 9.8 * Math.sin(degrees * Math.PI / 180),
        y: 9.8 * Math.cos(degrees * Math.PI / 180),
        z: 0,
    });
    motion(tilted(29));
    assert.equal(button.attributes["aria-disabled"], "false");
    assert.equal(app.element("resetWarning").textContent, "");
    app.clickReset();
    assert.equal(app.run("resets"), 1);

    app.setOrientation(90);
    app.clickReset();
    assert.equal(button.attributes["aria-disabled"], "true");
    assert.equal(app.run("resets"), 1);
    app.setOrientation(0);
    for (const gravity of [tilted(31), { x: 0, y: 0, z: 9.8 },
        { x: 0, y: -9.8, z: 0 }, { x: 0, y: 0, z: 0 },
        { x: null, y: 9.8, z: 0 }, null]) {
        motion(gravity);
        assert.equal(button.attributes["aria-disabled"], "true");
        app.clickReset();
        assert.equal(app.run("resets"), 1);
    }

    app.setOrientation(90);
    motion({ x: -9.8, y: 0, z: 0 });
    assert.equal(button.attributes["aria-disabled"], "false");
    assert.equal(app.element("resetWarning").textContent, "");
    app.clickReset();
    assert.equal(app.run("resets"), 2);
    app.run("resetSensorTime = Date.now() - 2001");
    app.clickReset();
    assert.equal(button.attributes["aria-disabled"], "true");
    assert.equal(app.run("resets"), 2);
});

Deno.test("reset warning disappears after three seconds and repeated taps restart the timer", () => {
    const app = createApp(() => Promise.resolve("granted"));
    app.clickReset();
    assert.match(app.element("resetWarning").textContent, /端末を立てた状態/);
    assert.deepEqual(app.timerDelays(), [3000]);
    app.clickReset();
    assert.deepEqual(app.timerDelays(), [3000]);
    app.runTimers();
    assert.equal(app.element("resetWarning").textContent, "");
});

Deno.test("reports missing sensor data after permission is granted", async () => {
    const app = createApp(() => Promise.resolve("granted"));
    app.dispatch("pointerup", { isTrusted: true, target: app.element("canvas") });
    await flush();
    app.dispatch("devicemotion", { acceleration: null });
    app.runTimers();
    assert.match(app.element("motionPermissionStatus").textContent, /受信できません/);
});

Deno.test("denied or failed requests can be retried from the button", async () => {
    let requests = 0;
    const app = createApp(() => {
        requests++;
        if (requests === 1) return Promise.reject(new Error("not activated"));
        if (requests === 2) return Promise.resolve("denied");
        return Promise.resolve("granted");
    });
    const button = app.element("motionPermissionBtn");
    app.dispatch("pointerup", { isTrusted: true, target: button });
    assert.equal(requests, 0);
    app.clickButton();
    await flush();
    assert.match(app.element("motionPermissionStatus").textContent, /取得できません/);
    app.clickButton();
    await flush();
    assert.match(app.element("motionPermissionStatus").textContent, /拒否/);
    app.clickButton();
    await flush();
    assert.equal(requests, 3);
    assert.equal(button.hidden, true);
});
