import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

it('initializes the actual Pixi shader system and uploads uniforms with JavaScript code generation disabled', async () => {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      contents: `
        import './src/mobile/native-renderer';
        import { ShaderSystem } from 'pixi.js';
        const calls = [];
        const renderer = { gl: {
          uniform1f: (...args) => calls.push(['float', ...args]),
          uniform2f: (...args) => calls.push(['vec2', ...args]),
          uniform4f: (...args) => calls.push(['vec4', ...args]),
        } };
        const shader = new ShaderSystem(renderer);
        shader.shader = { program: { uniformData: {
          alpha: { type: 'float', size: 1, isArray: false },
          offset: { type: 'vec2', size: 1, isArray: false },
          tint: { type: 'vec4', size: 1, isArray: false },
        } } };
        shader.syncUniforms({ uniforms: { alpha: 0.75, offset: [4, 8], tint: [1, 0.5, 0.25, 1] } }, {
          uniformData: {
            alpha: { location: 'alpha', value: 0 },
            offset: { location: 'offset', value: [0, 0] },
            tint: { location: 'tint', value: [0, 0, 0, 0] },
          },
        });
        globalThis.uploads = calls;
      `,
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022',
  });
  const sandbox = createContext({}, { codeGeneration: { strings: false, wasm: false } });
  expect(() => runInContext('new Function("return 1")', sandbox)).toThrow();
  runInContext(result.outputFiles[0]!.text, sandbox);
  expect(sandbox.uploads).toEqual([
    ['float', 'alpha', 0.75], ['vec2', 'offset', 4, 8], ['vec4', 'tint', 1, 0.5, 0.25, 1],
  ]);
});
