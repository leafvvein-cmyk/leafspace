import { requireNativePlugin } from './platform.js';

const CANCELLATIONS = new Set(['appCancel', 'systemCancel', 'userCancel', 'userFallback']);
const BIOMETRY_LABELS = new Map([
  [1, 'Touch ID'], [2, 'Face ID'], [3, '指纹'], [4, '面容'], [5, '虹膜'],
]);

export async function createNativeBiometric({ plugin, requirePlugin = requireNativePlugin } = {}) {
  requirePlugin('BiometricAuthNative');
  const biometric = plugin ?? (await import('@aparajita/capacitor-biometric-auth')).BiometricAuth;
  async function status() {
    const result = await biometric.checkBiometry();
    const biometryLabel = BIOMETRY_LABELS.get(result.biometryType) ?? '生物识别';
    const available = Boolean(result.deviceIsSecure && (result.isAvailable || result.deviceIsSecure));
    return { available, biometryAvailable: Boolean(result.isAvailable), deviceIsSecure: Boolean(result.deviceIsSecure),
      label: result.isAvailable ? `${biometryLabel} 或设备凭据` : '设备锁屏凭据', reason: result.reason || '', code: result.code || '' };
  }
  async function authenticate() {
    try {
      await biometric.authenticate({ reason: '解锁你的日记', cancelTitle: '取消', allowDeviceCredential: true,
        iosFallbackTitle: '使用设备密码', androidTitle: '解锁日记', androidSubtitle: '使用生物识别或设备锁屏凭据',
        androidConfirmationRequired: false });
      return true;
    } catch (error) {
      if (CANCELLATIONS.has(error?.code)) return false;
      const failure = new Error(error?.message || '系统身份验证失败，请使用本机 PIN。', { cause: error });
      failure.code = error?.code || 'BIOMETRIC_FAILED';
      throw failure;
    }
  }
  return { status, authenticate };
}
