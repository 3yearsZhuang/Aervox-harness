import { beforeEach, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
const mock = vi.hoisted(() => ({
  assets: vi.fn(), model: vi.fn(), destroy: vi.fn(), addChild: vi.fn(),
}));
vi.mock('pixi.js', () => ({
  Container: class {},
  Application: class {
    view = document.createElement('canvas');
    stage = { addChild: mock.addChild };
    ticker = { remove: vi.fn() };
    destroy = mock.destroy;
  },
}));
vi.mock('../src/live2d/model', () => ({ fetchModel3Json: mock.assets }));
vi.mock('@sekai-world/pixi-live2d-display-mulmotion/cubism4', () => ({ Live2DModel: { from: mock.model } }));
import { AervoxLive2DController } from '../src/live2d/controller';
import type { AervoxLive2DModel } from '../src/live2d/model';
const assets = { manifest: { FileReferences: {} }, manifestUrl: 'http://localhost/model.json' };
beforeEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});

it('does not start rendering if asset fetch finishes after disposal', async () => {
  let resolve!: (value: unknown) => void;
  mock.assets.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const controller = new AervoxLive2DController(document.createElement('div'));
  const pending = controller.load({} as AervoxLive2DModel);
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.destroy();
  resolve(assets);
  await assertion;
  expect(mock.model).not.toHaveBeenCalled();
  expect(mock.destroy).toHaveBeenCalledOnce();
  expect(controller.assets).toBeNull();
});

it('destroys a model that resolves after disposal without attaching it to the stage', async () => {
  mock.assets.mockResolvedValue(assets);
  let resolve!: (value: unknown) => void;
  mock.model.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const controller = new AervoxLive2DController(document.createElement('div'));
  const pending = controller.load({} as AervoxLive2DModel);
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(mock.model).toHaveBeenCalledOnce());
  controller.destroy();
  const lateModel = { destroy: vi.fn() };
  resolve(lateModel);
  await assertion;
  await flushPromises();
  expect(lateModel.destroy).toHaveBeenCalledOnce();
  expect(mock.addChild).not.toHaveBeenCalled();
  expect(mock.destroy).toHaveBeenCalledOnce();
});
