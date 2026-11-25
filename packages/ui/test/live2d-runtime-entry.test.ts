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

// 打包桌面端从 file:// 载入渲染层。file: 页面没有「应用根」，根绝对路径会被解析到
// 文件系统根；必须锚定到页面 URL，否则 "/live2d/..." 在打包态 404。
// http(s) 页面保持原有「源根」语义，手机由此保留 /m0 别名改写。
it('anchors root-absolute model references to the page under file://', async () => {
  const { resolveModelReference } = await import('../src/live2d/model');
  const page = 'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/index.html';
  const manifest = resolveModelReference('/live2d/mizuki/mizuki.model3.json', page, page);
  expect(manifest.protocol).toBe('file:');
  expect(manifest.pathname).toContain('/out/renderer/live2d/mizuki/mizuki.model3.json');
  // 动作元数据同样以应用根书写，且必须解析进模型目录，而不是重复拼接 mizuki/。
  const metadata = resolveModelReference('/live2d/mizuki/BuildMotionData.json', manifest.toString(), page);
  expect(metadata.pathname).toContain('/out/renderer/live2d/mizuki/BuildMotionData.json');
  expect(metadata.href.startsWith(new URL('.', manifest).href)).toBe(true);
});

it('keeps origin-root semantics for http pages and never rewrites the mobile /m0 root', async () => {
  const { resolveModelReference } = await import('../src/live2d/model');
  const httpPage = 'http://localhost:5174/index.html';
  const httpManifest = resolveModelReference('/live2d/mizuki/mizuki.model3.json', httpPage, httpPage);
  expect(httpManifest.protocol).toBe('http:');
  expect(httpManifest.pathname).toBe('/live2d/mizuki/mizuki.model3.json');

  // Cubism 规范要求模型内部引用相对 manifest 目录解析。
  expect(resolveModelReference('model/x.moc3', httpManifest.toString(), httpPage).pathname)
    .toBe('/live2d/mizuki/model/x.moc3');

  // 手机 APK 以 https://localhost/m0/ 承载，原生层把 /live2d/... 别名到 /m0。
  const m0Page = 'https://localhost/m0/index.html';
  expect(resolveModelReference('/live2d/mizuki/mizuki.model3.json', m0Page, m0Page).pathname)
    .toBe('/live2d/mizuki/mizuki.model3.json');
});
