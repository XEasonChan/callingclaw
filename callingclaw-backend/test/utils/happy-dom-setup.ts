// Preload: register happy-dom globals for bun test
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:4000" });

// Patch: happy-dom elements have offsetWidth=0 (no layout engine).
// Override so visibility checks in page-extract JS pass.
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  get() { return 100; },
  configurable: true,
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get() { return 30; },
  configurable: true,
});
HTMLElement.prototype.getBoundingClientRect = function() {
  return { top: 10, left: 10, bottom: 40, right: 110, width: 100, height: 30, x: 10, y: 10, toJSON() { return this; } } as any;
};
document.elementFromPoint = function() { return null; } as any;
HTMLElement.prototype.scrollIntoView = function() {};
