/**
 * Aervox｜思隅 @aervox/api — 插件 Page Bridge SDK（CR-006）
 *
 * 注入到插件 Page iframe 的 `window.AervoxPluginPageBridge`：
 * - 只允许宿主动作：读取上下文、读取/保存本插件配置、通知、关闭；
 * - 通过 postMessage + nonce 与宿主窗口通信，宿主是唯一读写配置的可信方；
 * - 禁止 iframe 直接访问 API / Cookie / LocalStorage / 父 DOM。
 */
export const BRIDGE_SDK = `(function () {
  "use strict";
  var pending = new Map();
  var seq = 0;
  var nonce = "";
  var context = null;
  var contextHandlers = [];
  var readyResolve = null;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });
  var warned = false;

  function send(message) {
    if (!window.parent) return;
    message.nonce = nonce;
    window.parent.postMessage(message, "*");
  }

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = "req_" + (++seq);
      pending.set(id, { resolve: resolve, reject: reject });
      send({ type: "aervox:page:call", id: id, method: method, args: args || {} });
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("bridge call timeout: " + method));
        }
      }, 15000);
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "aervox:page:init" && typeof data.nonce === "string") {
      nonce = data.nonce;
      context = data.context || null;
      readyResolve && readyResolve(context);
      return;
    }
    if (data.nonce !== nonce) return;
    if (data.type === "aervox:page:context") {
      context = data.context || context;
      contextHandlers.slice().forEach(function (handler) { try { handler(context); } catch (e) {} });
      return;
    }
    if (data.type === "aervox:page:result" && pending.has(data.id)) {
      var entry = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.value); else entry.reject(new Error(data.error || "bridge error"));
    }
  });

  var bridge = {
    ready: function () { return readyPromise; },
    getContext: function () { return context; },
    getConfig: function () { return call("getConfig", {}); },
    saveConfig: function (input) {
      if (!input || typeof input !== "object") return Promise.reject(new Error("saveConfig requires {values, secretValues}"));
      return call("saveConfig", {
        values: input.values || {},
        secretValues: input.secretValues || {}
      });
    },
    notify: function (input) {
      if (!input || typeof input !== "object") return;
      call("notify", {
        type: input.type || "info",
        message: String(input.message || "")
      });
    },
    close: function () { call("close", {}); },
    onContext: function (handler) {
      if (typeof handler === "function") contextHandlers.push(handler);
      return function () {
        var i = contextHandlers.indexOf(handler);
        if (i >= 0) contextHandlers.splice(i, 1);
      };
    }
  };

  Object.defineProperty(window, "AervoxPluginPageBridge", {
    value: bridge,
    writable: false,
    configurable: false
  });
})();
`;
