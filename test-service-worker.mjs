import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./service-worker.js", import.meta.url), "utf8");

test("push notifications use the FBP icon and open their destination", async () => {
  const handlers = new Map();
  let notification;
  const appWindow = {
    url: "https://fbp26.github.io/fbp-stats/",
    navigate: async url => { appWindow.navigatedTo = url; return appWindow; },
    focus: async () => { appWindow.focused = true; },
  };
  const self = {
    addEventListener: (type, handler) => handlers.set(type, handler),
    registration: {
      scope: "https://fbp26.github.io/fbp-stats/",
      showNotification: async (title, options) => { notification = { title, options }; },
    },
    clients: {
      matchAll: async () => [appWindow],
      openWindow: async () => { throw new Error("Existing app window should be used."); },
    },
  };
  vm.runInNewContext(source, { self, URL, caches: {}, fetch: () => {} });

  let displayed;
  handlers.get("push")({
    data: { json: () => ({ title: "FBP Week 4 recap", body: "Jim: 11-5, tied for 1st.", url: "#live-analysis", tag: "fbp-weekly-result" }) },
    waitUntil: promise => { displayed = promise; },
  });
  await displayed;
  assert.equal(notification.title, "FBP Week 4 recap");
  assert.equal(notification.options.icon, "https://fbp26.github.io/fbp-stats/icons/fbp-192.png");
  assert.equal(notification.options.badge, notification.options.icon);
  assert.equal(notification.options.tag, "fbp-weekly-result");

  let opened;
  handlers.get("notificationclick")({
    notification: { data: notification.options.data, close: () => {} },
    waitUntil: promise => { opened = promise; },
  });
  await opened;
  assert.equal(appWindow.navigatedTo, "https://fbp26.github.io/fbp-stats/#live-analysis");
  assert.equal(appWindow.focused, true);
});