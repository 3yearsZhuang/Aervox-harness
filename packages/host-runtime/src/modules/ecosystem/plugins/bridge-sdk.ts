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
  var parentWindow = window.parent;
  var parentOrigin = null;

  function clearPending(reason) {
    pending.forEach(function (entry) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    });
    pending.clear();
  }

  function send(message) {
    message.nonce = nonce;
    parentWindow.postMessage(message, parentOrigin && parentOrigin !== "null" ? parentOrigin : "*");
  }

  function call(method, args) {
    if (!context || !nonce || !parentWindow || parentWindow === window) return Promise.reject(new Error("bridge is not ready"));
    if (pending.size >= 32) return Promise.reject(new Error("too many pending bridge calls"));
    return new Promise(function (resolve, reject) {
      var id = "req_" + (++seq);
      var timer = setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("bridge call timeout: " + method));
        }
      }, 15000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      send({ type: "aervox:page:call", id: id, method: method, args: args || {} });
    });
  }

  function validContext(value) {
    return value && typeof value === "object" && typeof value.pluginId === "string"
      && value.pluginId && typeof value.pageId === "string" && value.pageId;
  }

  function notifyContext() {
    contextHandlers.slice().forEach(function (handler) { try { handler(context); } catch (e) {} });
  }

  window.addEventListener("message", function (event) {
    if (!parentWindow || parentWindow === window || event.source !== parentWindow) return;
    if (parentOrigin !== null && event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "aervox:page:init" && typeof data.nonce === "string" && data.nonce.length >= 16 && validContext(data.context)) {
      parentOrigin = event.origin;
      if (nonce && (data.nonce !== nonce || data.context.pluginId !== context.pluginId || data.context.pageId !== context.pageId)) {
        clearPending("page session changed");
      }
      nonce = data.nonce;
      context = data.context;
      readyResolve && readyResolve(context);
      readyResolve = null;
      notifyContext();
      return;
    }
    if (!context || data.nonce !== nonce) return;
    if (data.type === "aervox:page:context") {
      if (!validContext(data.context) || data.context.pluginId !== context.pluginId || data.context.pageId !== context.pageId) return;
      context = data.context;
      notifyContext();
      return;
    }
    if (data.type === "aervox:page:result" && typeof data.id === "string" && pending.has(data.id)) {
      var entry = pending.get(data.id);
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok === true) entry.resolve(data.value); else entry.reject(new Error(String(data.error || "bridge error")));
    }
  });

  window.addEventListener("pagehide", function () {
    clearPending("page closed");
    context = null;
    nonce = "";
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
      var result = call("notify", {
        type: input.type || "info",
        message: String(input.message || "")
      });
      result.catch(function () {});
      return result;
    },
    close: function () {
      var result = call("close", {});
      result.catch(function () {});
      return result;
    },
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
