import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const json = (relative) => JSON.parse(read(relative));

describe('native package metadata', () => {
  const client = json('apps/client/package.json');
  const mobile = json('apps/mobile/package.json');
  const capacitor = json('apps/mobile/capacitor.config.json');
  const android = read('apps/mobile/android/app/build.gradle');
  const manifest = read('apps/mobile/android/app/src/main/AndroidManifest.xml');
  const strings = read('apps/mobile/android/app/src/main/res/values/strings.xml');
  const backupRules = read('apps/mobile/android/app/src/main/res/xml/backup_rules.xml');
  const extractionRules = read('apps/mobile/android/app/src/main/res/xml/data_extraction_rules.xml');
  const ios = read('apps/mobile/ios/App/App.xcodeproj/project.pbxproj');
  const plist = read('apps/mobile/ios/App/App/Info.plist');

  it('keeps the Web, Android and iOS versions aligned', () => {
    expect(mobile.version).toBe(client.version);
    expect(android).toContain(`versionName "${client.version}"`);
    expect([...ios.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((match) => match[1])).toEqual([client.version, client.version]);
  });

  it('keeps the app name and development bundle identity aligned', () => {
    expect(capacitor.appName).toBe('日记');
    expect(strings).toContain('<string name="app_name">日记</string>');
    expect(plist).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>日记<\/string>/);
    expect(android).toContain(`applicationId "${capacitor.appId}"`);
    expect([...ios.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((match) => match[1])).toEqual([capacitor.appId, capacitor.appId]);
  });

  it('contains no Capacitor default launcher artwork signatures', () => {
    const vector = read('apps/mobile/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml');
    const background = read('apps/mobile/android/app/src/main/res/values/ic_launcher_background.xml');
    expect(vector).not.toContain('66.94,46.02');
    expect(vector).toContain('#FFFCF7');
    expect(background).toContain('#8D4F39');
  });

  it('keeps private native storage out of logs, cleartext traffic and system backups', () => {
    expect(capacitor.loggingBehavior).toBe('none');
    expect(capacitor.android.allowMixedContent).toBe(false);
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    for (const rules of [backupRules, extractionRules]) {
      expect(rules).toContain('<exclude domain="database" path="." />');
      expect(rules).toContain('<exclude domain="sharedpref" path="." />');
    }
    expect(plist).not.toContain('NSAllowsArbitraryLoads');
  });
});
