import appPackage from '../../../package.json';
import { CURRENT_VERSION, RELEASES, getLatestRelease } from './releases';

describe('What\'s New release metadata', () => {
  it('keeps the advertised version aligned with the application build', () => {
    expect(CURRENT_VERSION).toBe(appPackage.version);
    expect(getLatestRelease().version).toBe(CURRENT_VERSION);
    expect(RELEASES[0]?.version).toBe(CURRENT_VERSION);
  });

  it('preserves the corrected recent release history without duplicates', () => {
    const versions = RELEASES.map((release) => release.version);

    expect(versions).toContain('0.1.21');
    expect(versions).toContain('0.1.22');
    expect(new Set(versions).size).toBe(versions.length);
  });
});
