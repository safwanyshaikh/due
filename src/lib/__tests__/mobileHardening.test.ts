import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('native app hardening (round-2 mobile, static checks)', () => {
  it('Android: no backups or device transfer, content:// only, narrow FileProvider, minified release, private recents', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(manifest).not.toMatch(/android:scheme="file"/);
    const rules = read('android/app/src/main/res/xml/data_extraction_rules.xml');
    expect(rules).toMatch(/<cloud-backup>[\s\S]*<exclude domain="root" path="\." \/>/);
    expect(rules).toMatch(/<device-transfer>[\s\S]*<exclude domain="sharedpref" path="\." \/>/);
    const paths = read('android/app/src/main/res/xml/file_paths.xml');
    expect(paths).not.toMatch(/<external-path|<root-path|<files-path/);
    expect(paths).not.toMatch(/path="\."/);
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/minifyEnabled true/);
    expect(read('android/app/proguard-rules.pro')).toContain('-keep class com.getcapacitor.** { *; }');
    expect(read('android/app/src/main/java/com/karigarai/due/MainActivity.java')).toContain('setRecentsScreenshotEnabled(false)');
  });

  it('iOS: WebView data excluded from backups, app-switcher cover, privacy manifest lists purchases and phone', () => {
    expect(read('ios/App/App/AppDelegate.swift')).toContain('isExcludedFromBackup = true');
    expect(read('ios/App/App/SceneDelegate.swift')).toContain('func sceneWillResignActive');
    const manifest = read('ios/App/App/PrivacyInfo.xcprivacy');
    for (const t of ['PurchaseHistory', 'PhoneNumber', 'EmailAddress', 'OtherFinancialInfo']) {
      expect(manifest).toContain(`NSPrivacyCollectedDataType${t}`);
    }
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  });
});
