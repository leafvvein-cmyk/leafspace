import { describe, expect, it, vi } from 'vitest';
import { inspectMobileEnvironment } from '../../scripts/mobile-doctor.mjs';

function check({ missing = '', javaStatus = 0, compilerStatus = 0, compilerVersion = 21, license = 'a'.repeat(40), versions = ['35.0.0'] } = {}) {
  const run = vi.fn((command) => command.includes('javac')
    ? { status: compilerStatus, stdout: `javac ${compilerVersion}.0.1` }
    : { status: javaStatus, stderr: 'openjdk version "21.0.1"' });
  const report = inspectMobileEnvironment({ DIARY_JAVA_HOME: '/test/jdk', DIARY_ANDROID_SDK: '/test/sdk', VITE_API_BASE_URL: 'https://diary.example/api/v1' }, {
    exists: (path) => !missing || !path.replaceAll('\\', '/').includes(missing),
    read: () => { if (license === null) throw new Error('unreadable'); return license; },
    list: () => versions, run,
  });
  return { report, run };
}
describe('Android preflight (mocked environment; not a native build)', () => {
  it('accepts complete tool prerequisites without claiming an APK was built', () => {
    const { report, run } = check();
    expect(report.readyForAndroidBuildAttempt).toBe(true);
    expect(report.requiredBuildTools).toBe('35.0.0');
    expect(report.nativeAppActionCount).toBe(0);
    expect(report.appLauncherInstalled).toBe(true);
    expect(report.nativeAppActionsReady).toBe(true);
    expect(report.releaseGaps).toContainEqual(expect.stringContaining('尚未登记'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([, args]) => args.length === 1 && args[0] === '-version')).toBe(true);
  });

  it('reports the absent App Launcher without blocking a build when the product action catalog is still empty', () => {
    const { report } = check({ missing: '@capacitor/app-launcher' });
    expect(report.appLauncherInstalled).toBe(false);
    expect(report.nativeAppActionsReady).toBe(true);
    expect(report.readyForAndroidBuildAttempt).toBe(true);
    expect(report.releaseGaps).toContainEqual(expect.stringContaining('@capacitor/app-launcher'));
  });
  it('rejects failed Java even if it prints a valid version', () => {
    expect(check({ javaStatus: 1 }).report.readyForAndroidBuildAttempt).toBe(false);
  });
  it('rejects a JRE without a working compiler', () => {
    expect(check({ compilerStatus: null }).report.compilerAvailable).toBe(false);
  });
  it('rejects a compiler older than the runtime requirement', () => {
    expect(check({ compilerVersion: 17 }).report.readyForAndroidBuildAttempt).toBe(false);
  });
  it.each(['', 'unrelated file', null])('does not mistake invalid license records for acceptance: %s', (license) => {
    expect(check({ license }).report.licensesPresent).toBe(false);
    expect(check({ license }).report.readyForAndroidBuildAttempt).toBe(false);
  });
  it('rejects another build tools version when the default required version is absent', () => {
    const { report } = check({ versions: ['34.0.0'], missing: 'build-tools/35.0.0' });
    expect(report.buildTools).toEqual(['34.0.0']);
    expect(report.readyForAndroidBuildAttempt).toBe(false);
  });
  it('rejects a partial build tools download', () => {
    expect(check({ missing: 'lib/apksigner.jar' }).report.missingBuildToolFiles).toEqual(['lib/apksigner.jar']);
  });
  it('rejects an incomplete Gradle wrapper', () => {
    const { report } = check({ missing: 'gradle-wrapper.jar' });
    expect(report.androidProject).toBe(false);
    expect(report.readyForAndroidBuildAttempt).toBe(false);
  });
  it.each([undefined, 'http://diary.example/api/v1', 'https://user@diary.example/api/v1', 'https://diary.example/api/v1?token=secret'])('rejects a missing or unsafe native API URL: %s', (value) => {
    const env = { DIARY_JAVA_HOME: '/test/jdk', DIARY_ANDROID_SDK: '/test/sdk', ...(value ? { VITE_API_BASE_URL: value } : {}) };
    const report = inspectMobileEnvironment(env, {
      exists: () => true,
      read: () => 'a'.repeat(40),
      list: () => ['35.0.0'],
      run: (command) => command.includes('javac') ? { status: 0, stdout: 'javac 21.0.1' } : { status: 0, stderr: 'openjdk version "21.0.1"' },
    });
    expect(report.nativeApiReady).toBe(false);
    expect(report.readyForAndroidBuildAttempt).toBe(false);
  });
});
