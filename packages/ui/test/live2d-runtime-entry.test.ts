import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('pixi.js', () => ({
  Container: class {},
  Application: class {
    view = document.createElement('canvas');
    stage = { addChild: vi.fn() };
    ticker = { remove: vi.fn() };
    destroy = vi.fn();
  },
}));
import { AervoxLive2DController } from '../src/live2d/controller';
import { DEFAULT_AERVOX_MODEL } from '../src/live2d/model';

const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../live2d/mizuki/mizuki.model3.json'), 'utf8'));
const motions = JSON.parse(readFileSync(path.resolve(__dirname, '../../live2d/mizuki/BuildMotionData.json'), 'utf8'));

beforeEach(() => {
  // Match a browser with only the native bundle's Cubism 3/4 Core. The real
  // renderer module is evaluated; only GPU/model creation is replaced below.
  vi.stubGlobal('Live2DCubismCore', {});
  vi.stubGlobal('Live2D', undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    if (path === '/live2d/mizuki/mizuki.model3.json') return new Response(JSON.stringify(manifest));
    if (path === '/live2d/mizuki/BuildMotionData.json') return new Response(JSON.stringify(motions));
    throw new Error(`Unexpected asset request: ${path}`);
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('reaches the Cubism 3 model factory with packaged assets regardless of the legacy runtime global (present: %s)', async legacyPresent => {
  if (legacyPresent) vi.stubGlobal('Live2D', {});
  const { Live2DModel } = await import('@sekai-world/pixi-live2d-display-mulmotion/cubism4');
  const factory = vi.spyOn(Live2DModel, 'from').mockRejectedValue(new Error('GPU factory boundary'));
  const controller = new AervoxLive2DController(document.createElement('div'));
  await expect(controller.load(DEFAULT_AERVOX_MODEL)).rejects.toThrow('GPU factory boundary');
  expect(Boolean(window.Live2D)).toBe(legacyPresent);
  expect(factory).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({
    Version: 3, url: expect.stringContaining('/live2d/mizuki/mizuki.model3.json'),
    FileReferences: expect.objectContaining({ Moc: 'model/20mizuki_normal_3.0_t04.moc3' }),
  }), expect.objectContaining({ autoUpdate: true }));
  expect(controller.status).toBe('error');
});

it('rejects a legacy Cubism 2 URL before requesting assets or the lazy renderer', async () => {
  const { Live2DModel } = await import('@sekai-world/pixi-live2d-display-mulmotion/cubism4');
  const factory = vi.spyOn(Live2DModel, 'from');
  const controller = new AervoxLive2DController(document.createElement('div'));
  await expect(controller.load({ ...DEFAULT_AERVOX_MODEL, modelUrl: '/live2d/legacy/model.json' })).rejects.toThrow('.model3.json');
  expect(fetch).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
});
