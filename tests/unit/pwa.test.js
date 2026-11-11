import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPwa } from '../../apps/client/src/services/pwa.js';

function harness({ prepare = async () => {}, reply = { ok: true } } = {}) {
  const serviceWorker = new EventTarget();
  let port;
  const worker = { postMessage: vi.fn((_message, ports) => {
    port = ports[0];
    if (reply) port.postMessage(reply);
  }) };
  const registration = Object.assign(new EventTarget(), { waiting: worker });
  serviceWorker.register = vi.fn(async () => registration);
  serviceWorker.ready = Promise.resolve(registration);
  vi.stubGlobal('__DIARY_PWA__', true);
  vi.stubGlobal('__DIARY_BUILD_ID__', 'build-a');
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const reload = vi.fn(), cancelUpdate = vi.fn(), prepareUpdate = vi.fn(prepare);
  vi.stubGlobal('location', { reload });
  // Deterministic message delivery; actual SW installation is a separate browser gate.
  vi.stubGlobal('MessageChannel', class {
    constructor() {
      this.port1 = { close: vi.fn(), onmessage: null };
      this.port2 = { close: vi.fn(), postMessage: (data) => this.port1.onmessage?.({ data }) };
    }
  });
  const pwa = createPwa({ prepareUpdate, cancelUpdate });
  const control = (target = worker) => {
    serviceWorker.controller = target;
    serviceWorker.dispatchEvent(new Event('controllerchange'));
  };
  return { pwa, worker, reload, cancelUpdate, prepareUpdate, control, reply: (data) => port.postMessage(data) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('PWA safe update lifecycle', () => {
  it('prevents duplicate install prompts and preserves actual installation confirmation', async () => {
    const h = harness();
    let resolveChoice;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = vi.fn(async () => {});
    event.userChoice = new Promise((resolve) => { resolveChoice = resolve; });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const run = h.pwa.install(); await h.pwa.install();
    expect(event.prompt).toHaveBeenCalledOnce(); expect(h.pwa.view().installing).toBe(true);
    window.dispatchEvent(new Event('appinstalled'));
    resolveChoice({ outcome: 'accepted' }); await run;
    expect(h.pwa.view()).toMatchObject({ installed: true, installing: false, canInstall: false });
    expect(h.pwa.view().status).toBe('已安装为独立窗口。');
  });
  it('recovers after acknowledged activation stalls; late control cannot reload edited work', async () => {
    vi.useFakeTimers();
    const h = harness(); await h.pwa.start();
    const run = h.pwa.update();
    await vi.advanceTimersByTimeAsync(10000); await run;
    expect(h.cancelUpdate).toHaveBeenCalledOnce();
    expect(h.pwa.view().updating).toBe(false);
    h.control(); expect(h.reload).not.toHaveBeenCalled();
  });
  it('reloads only when the acknowledged requested worker takes control', async () => {
    const h = harness(); await h.pwa.start();
    const run = h.pwa.update(); await Promise.resolve();
    h.control({}); expect(h.reload).not.toHaveBeenCalled();
    h.control(); await run;
    expect(h.reload).toHaveBeenCalledOnce();
    expect(h.cancelUpdate).not.toHaveBeenCalled();
  });
  it('waits for acknowledgement if controller changes first', async () => {
    const h = harness({ reply: null }); await h.pwa.start();
    const run = h.pwa.update(); await Promise.resolve();
    h.control(); expect(h.reload).not.toHaveBeenCalled();
    h.reply({ ok: true }); await run; expect(h.reload).toHaveBeenCalledOnce();
  });
  it('rejects duplicate clicks while saving and never activates after save failure', async () => {
    let fail;
    const h = harness({ prepare: () => new Promise((_resolve, reject) => { fail = reject; }) });
    await h.pwa.start(); const run = h.pwa.update(); await h.pwa.update();
    expect(h.prepareUpdate).toHaveBeenCalledOnce();
    fail(new Error('保存失败')); await run;
    expect(h.worker.postMessage).not.toHaveBeenCalled();
    expect(h.cancelUpdate).toHaveBeenCalledOnce();
    expect(h.pwa.view().status).toBe('保存失败');
  });
  it('restores interaction when another window prevents activation', async () => {
    const h = harness({ reply: { ok: false, message: '请先关闭其他日记窗口' } });
    await h.pwa.start(); await h.pwa.update();
    expect(h.cancelUpdate).toHaveBeenCalledOnce();
    expect(h.pwa.view().status).toContain('关闭其他');
    h.control(); expect(h.reload).not.toHaveBeenCalled();
  });
});
