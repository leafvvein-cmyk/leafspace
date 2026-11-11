import { registerPlugin } from '@capacitor/core';
import { NATIVE_APP_ACTIONS } from '@diary/contracts/app-actions';
import { isNative, platform, requireNativePlugin } from './platform.js';

// Product-approved actions belong here after their exact Android package,
// iOS scheme and business parameters have been supplied. Task records store
// only the stable id; they never accept an arbitrary scheme or package name.
export { NATIVE_APP_ACTIONS } from '@diary/contracts/app-actions';

const defaultPlugin = registerPlugin('AppLauncher');
const idPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

function checkedTarget(value, targetPlatform) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('原生 App 动作目标配置无效');
  if (targetPlatform === 'android' && packagePattern.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new Error('原生 App 动作目标配置无效'); }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) || ['http:', 'https:', 'javascript:', 'data:', 'file:'].includes(url.protocol)
    || url.username || url.password) throw new Error('原生 App 动作必须使用已登记的安全 URL scheme');
  return value;
}

export function validateNativeAppActionRegistry(registry = NATIVE_APP_ACTIONS) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('原生 App 动作白名单无效');
  const result = [];
  for (const [id, definition] of Object.entries(registry)) {
    if (!idPattern.test(id) || typeof definition?.label !== 'string' || !definition.label.trim() || [...definition.label.trim()].length > 80) {
      throw new Error('原生 App 动作白名单无效');
    }
    const targets = {};
    for (const targetPlatform of ['android', 'ios']) if (definition[targetPlatform]) targets[targetPlatform] = checkedTarget(definition[targetPlatform], targetPlatform);
    if (!Object.keys(targets).length) throw new Error('原生 App 动作缺少平台目标');
    result.push(Object.freeze({ id, label: definition.label.trim(), ...targets }));
  }
  return Object.freeze(result);
}

export function configuredNativeAppActions(registry = NATIVE_APP_ACTIONS) {
  return validateNativeAppActionRegistry(registry).map(({ id, label, android, ios }) => ({ id, label, platforms: [android && 'android', ios && 'ios'].filter(Boolean) }));
}

export function createNativeAppActionLauncher({ native = isNative, currentPlatform = platform, registry = NATIVE_APP_ACTIONS, plugin = defaultPlugin,
  ensurePlugin = () => requireNativePlugin('AppLauncher') } = {}) {
  const definitions = new Map(validateNativeAppActionRegistry(registry).map((definition) => [definition.id, definition]));
  return async (id) => {
    if (!native || !['android', 'ios'].includes(currentPlatform)) throw new Error('这个动作只能在安装的手机 App 中使用');
    const definition = definitions.get(id), target = definition?.[currentPlatform];
    if (!definition || !target) throw new Error('这个 App 动作未在当前平台登记');
    ensurePlugin();
    const availability = await plugin.canOpenUrl({ url: target });
    if (!availability?.value) throw new Error(`未找到可执行“${definition.label}”的 App，请先安装或更新目标 App`);
    const result = await plugin.openUrl({ url: target });
    if (!result?.completed) throw new Error(`系统没有完成“${definition.label}”动作`);
    return { id, label: definition.label, completed: true };
  };
}

export const launchNativeAppAction = createNativeAppActionLauncher();
