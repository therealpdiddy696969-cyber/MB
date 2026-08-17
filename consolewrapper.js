(function installStructuredConsoleBridge(oldConsole) {
  "use strict";
  var allowed = new Set(["stage", "ready", "warning", "crash", "relay", "clipboard"]);
  function forward(method, args) {
    var first = args[0];
    if (typeof first === "string" && first.indexOf("BALATRO_WEB_BRIDGE ") === 0) {
      try {
        var payload = JSON.parse(first.slice("BALATRO_WEB_BRIDGE ".length));
        var type = payload && payload.type;
        var bridge = window.BalatroWebBridge;
        if (allowed.has(type) && bridge && typeof bridge[type] === "function") bridge[type](payload);
        else oldConsole.warn("Rejected unknown Balatro web bridge event", type);
      } catch (error) {
        oldConsole.warn("Rejected malformed Balatro web bridge event", error);
      }
      return;
    }
    if (typeof first === "string" && first.indexOf("callJavascriptFunction") !== -1) {
      oldConsole.warn("Blocked legacy arbitrary JavaScript bridge call");
      return;
    }
    if (typeof first === "string" && /Oops! The game crashed|StackTrace.*error/i.test(first)) {
      window.BalatroWebBridge?.crash?.({ message: first });
    } else if (typeof first === "string" && /LOADING:\s*end/i.test(first)) {
      window.BalatroWebBridge?.ready?.({ message: "Steamodded startup completed" });
    }
    oldConsole[method].apply(oldConsole, args);
  }
  var wrapped = {};
  ["log", "info", "warn", "error"].forEach(function(method) {
    wrapped[method] = function() { forward(method, Array.prototype.slice.call(arguments)); };
  });
  ["clear", "assert", "group", "groupCollapsed", "groupEnd"].forEach(function(method) {
    wrapped[method] = typeof oldConsole[method] === "function" ? oldConsole[method].bind(oldConsole) : function() {};
  });
  window.console = wrapped;
})(window.console);
