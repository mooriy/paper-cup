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
        setTimeout(callback) {
            timers.set(++timerId, callback);
            return timerId;
        },
        clearTimeout(id) { timers.delete(id); },
    };
    runInNewContext(source, context);
    return {
        element,
        acceleration() { return runInNewContext("rawAccelX", context); },
        dispatch(type, event) {
            for (const handler of [...(listeners.get(type) || [])]) handler(event);
        },
        clickButton() { listeners.get("motionPermissionBtn:click")(); },
        runTimers() {
            for (const callback of timers.values()) callback();
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
