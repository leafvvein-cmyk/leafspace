import { Capacitor } from '@capacitor/core';

export const platform = Capacitor.getPlatform();
export const isNative = Capacitor.isNativePlatform();

export function requireNativePlugin(name) {
  if (!Capacitor.isNativePlatform()) throw new Error('此功能仅在安装的手机 App 中使用。');
  if (!Capacitor.isPluginAvailable(name)) throw new Error(`手机组件 ${name} 未正确安装，请更新 App；不会改用浏览器存储。`);
}

export async function openDiaryStore(namespace = 'learning') {
  if (Capacitor.isNativePlatform()) {
    requireNativePlugin('CapacitorSQLite');
    const { openNativeStore } = await import('./native-store.js');
    return openNativeStore(namespace);
  }
  const { createLocalStore } = await import('./local-store.js');
  return createLocalStore(namespace);
}

export async function bindNativeLifecycle({ save, back, reportError, onActive = () => {} }) {
  if (!isNative) return () => {};
  requireNativePlugin('App');
  const { App } = await import('@capacitor/app');
  const handles = [];
  const cleanExports = () => import('./native-export.js').then(({ cleanNativeExports }) => cleanNativeExports()).catch(reportError);
  void cleanExports();
  handles.push(await App.addListener('appStateChange', ({ isActive }) => {
    onActive(isActive);
    if (!isActive) save().catch(reportError);
    else void cleanExports();
  }));
  if (platform === 'android') {
    let handlingBack = false;
    handles.push(await App.addListener('backButton', async () => {
      if (handlingBack) return;
      handlingBack = true;
      try {
        const dialog = document.querySelector('dialog[open]');
        if (dialog) { dialog.close(); return; }
        // back() awaits prepareLeave and reports false on save failure. Never
        // minimize an app whose unsaved text failed to reach local storage.
        if (await back()) await App.minimizeApp();
      } catch (error) { reportError(error); }
      finally { handlingBack = false; }
    }));
  }
  const { Keyboard } = await import('@capacitor/keyboard');
  requireNativePlugin('Keyboard');
  handles.push(await Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('keyboard-open')));
  handles.push(await Keyboard.addListener('keyboardWillHide', () => document.body.classList.remove('keyboard-open')));
  return () => { for (const handle of handles) handle.remove(); };
}
