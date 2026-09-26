import { beforeEach, describe, expect, it } from 'vitest';

import { loadAllAgents, loadAllSkills } from './loader';
import { skillRegistry } from './registry';
import { useSkillsStore } from './skillsStore';

interface FakeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/');
}

function skillRaw(name: string, body: string, enabled = true): string {
  return `---
name: ${name}
title: ${name}
enabled: ${enabled}
---
${body}`;
}

function fakeFilesystem(input: {
  directories: Record<string, FakeEntry[] | 'symlink_blocked'>;
  files: Record<string, string>;
}) {
  const listCalls: Array<{ path: string; root?: string | null; strictProjectBoundary?: boolean }> =
    [];
  const readCalls: Array<{
    path: string;
    maxBytes: number;
    root?: string | null;
    strictProjectBoundary?: boolean;
  }> = [];

  return {
    listCalls,
    readCalls,
    capability: {
      async listDirectory(
        path: string,
        options: { root?: string | null; strictProjectBoundary?: boolean },
      ) {
        listCalls.push({ path, ...options });
        const value = input.directories[normalize(path)];
        if (value === 'symlink_blocked') {
          return {
            ok: false as const,
            path,
            error: { code: 'symlink_blocked' as const },
          };
        }
        if (!value) {
          return { ok: false as const, path, error: { code: 'not_found' as const } };
        }
        return { ok: true as const, path, entries: value };
      },
      async readTextFile(
        path: string,
        maxBytes: number,
        options: { root?: string | null; strictProjectBoundary?: boolean },
      ) {
        readCalls.push({ path, maxBytes, ...options });
        const content = input.files[normalize(path)];
        if (content === undefined) {
          return { ok: false as const, path, error: { code: 'not_found' as const } };
        }
        return { ok: true as const, path, content };
      },
    },
  };
}

describe('bounded Skills 2.0 discovery', () => {
  beforeEach(() => {
    useSkillsStore.setState({
      customSkills: [],
      presetOverrides: {},
      deletedPresets: [],
    });
  });

  it('bundles the Prompt Forge upgrader package as a built-in skill', async () => {
    const skill = (await loadAllSkills()).find(
      (manifest) => manifest.name === 'prompt-forge-upgrader',
    );

    expect(skill).toMatchObject({
      title: 'Prompt Forge Upgrader',
      source: 'builtin',
      kind: 'skill',
    });
    expect(skill?.body).toContain('# Prompt Forge upgrade contract');
  });

  it('exposes the stock Ponytail whole-repo audit as a separate manual built-in skill', async () => {
    const skill = (await loadAllSkills()).find((manifest) => manifest.name === 'ponytail-audit');

    expect(skill).toMatchObject({
      name: 'ponytail-audit',
      title: 'Ponytail Audit',
      source: 'builtin',
      kind: 'skill',
    });
    expect(skill?.description).toContain('Whole-repo audit for over-engineering.');
    expect(skill?.body).toContain(
      'ponytail-review, repo-wide. Scan the whole tree instead of a diff.',
    );
    expect(skill?.trigger).toBeUndefined();
    expect(skill?.tools).toBeUndefined();
    expect(skill?.filePath).toBe('/third_party/ponytail/skills/ponytail-audit/SKILL.md');
  });

  it('loads only the pinned Ponytail skill manifests from the prepared upstream artifact', async () => {
    const skills = await loadAllSkills();
    const ponytailSkills = skills.filter(
      (manifest) => manifest.name === 'ponytail' || manifest.name === 'ponytail-audit',
    );

    expect(ponytailSkills).toHaveLength(2);
    expect(ponytailSkills.map((skill) => skill.filePath).sort()).toEqual([
      '/third_party/ponytail/skills/ponytail-audit/SKILL.md',
      '/third_party/ponytail/skills/ponytail/SKILL.md',
    ]);
  });

  it('uses the exact project root and gives project packages precedence over trusted user packages', async () => {
    const fs = fakeFilesystem({
      directories: {
        'C:/repo/.jarvis/skills': [
          {
            name: 'shared',
            path: 'C:\\repo\\.jarvis\\skills\\shared',
            isDir: true,
          },
          {
            name: 'project-only.md',
            path: 'C:\\repo\\.jarvis\\skills\\project-only.md',
            isDir: false,
            size: 88,
          },
        ],
        'C:/repo/.jarvis/skills/shared': [
          {
            name: 'SKILL.md',
            path: 'C:\\repo\\.jarvis\\skills\\shared\\SKILL.md',
            isDir: false,
            size: 80,
          },
        ],
        'C:/user/.jarvis/skills': [
          {
            name: 'Shared.md',
            path: 'C:\\user\\.jarvis\\skills\\Shared.md',
            isDir: false,
            size: 76,
          },
          {
            name: 'user-only.md',
            path: 'C:\\user\\.jarvis\\skills\\user-only.md',
            isDir: false,
            size: 84,
          },
        ],
        'C:/repo/.jarvis/agents': [],
        'C:/user/.jarvis/agents': [],
      },
      files: {
        'C:/repo/.jarvis/skills/shared/SKILL.md': skillRaw('shared', 'project body'),
        'C:/repo/.jarvis/skills/project-only.md': skillRaw('project-only', 'project only'),
        'C:/user/.jarvis/skills/Shared.md': skillRaw('shared', 'user body'),
        'C:/user/.jarvis/skills/user-only.md': skillRaw('user-only', 'user only'),
      },
    });

    const manifests = await loadAllSkills({
      projectRoot: 'C:\\repo',
      userRoot: 'C:\\user',
      trustUserRoot: true,
      fs: fs.capability,
    } as Parameters<typeof loadAllSkills>[0]);

    expect(
      manifests
        .filter((manifest) => manifest.source !== 'builtin')
        .map(({ name, source, body }) => ({ name, source, body })),
    ).toEqual([
      { name: 'project-only', source: 'project', body: 'project only' },
      { name: 'shared', source: 'project', body: 'project body' },
      { name: 'user-only', source: 'user', body: 'user only' },
    ]);
    expect(fs.listCalls[0]).toEqual({
      path: 'C:\\repo\\.jarvis\\skills',
      root: 'C:\\repo',
      strictProjectBoundary: true,
    });
    expect(fs.readCalls.every((call) => call.maxBytes === 64 * 1024)).toBe(true);
    expect(
      fs.readCalls.every(
        (call) => call.strictProjectBoundary === true && call.path.startsWith(call.root!),
      ),
    ).toBe(true);
  });

  it('requires explicit trust before reading an injected user root', async () => {
    const fs = fakeFilesystem({
      directories: {
        'C:/user/.jarvis/skills': [
          {
            name: 'private.md',
            path: 'C:\\user\\.jarvis\\skills\\private.md',
            isDir: false,
            size: 80,
          },
        ],
      },
      files: {
        'C:/user/.jarvis/skills/private.md': skillRaw('private', 'must not be read'),
      },
    });
    const rejections: unknown[] = [];

    const manifests = await loadAllSkills({
      userRoot: 'C:\\user',
      fs: fs.capability,
      onReject: (event: unknown) => rejections.push(event),
    } as Parameters<typeof loadAllSkills>[0]);

    expect(manifests.every((manifest) => manifest.source === 'builtin')).toBe(true);
    expect(fs.listCalls).toEqual([]);
    expect(fs.readCalls).toEqual([]);
    expect(rejections).toContainEqual({ source: 'user', code: 'untrusted' });
  });

  it('rejects traversal names, symlink escapes, and same-source case collisions without reading them', async () => {
    const secret = 'SECRET-CONTENT-MUST-NOT-LEAK';
    const fs = fakeFilesystem({
      directories: {
        'C:/repo/.jarvis/skills': [
          {
            name: '../escape.md',
            path: 'C:\\outside\\escape.md',
            isDir: false,
            size: 80,
          },
          {
            name: 'Alpha.md',
            path: 'C:\\repo\\.jarvis\\skills\\Alpha.md',
            isDir: false,
            size: 80,
          },
          {
            name: 'alpha.md',
            path: 'C:\\repo\\.jarvis\\skills\\alpha.md',
            isDir: false,
            size: 80,
          },
          {
            name: 'linked',
            path: 'C:\\repo\\.jarvis\\skills\\linked',
            isDir: true,
          },
        ],
        'C:/repo/.jarvis/skills/linked': 'symlink_blocked',
      },
      files: {
        'C:/repo/.jarvis/skills/Alpha.md': skillRaw('alpha', secret),
        'C:/repo/.jarvis/skills/alpha.md': skillRaw('alpha', secret),
      },
    });
    const rejections: unknown[] = [];

    const manifests = await loadAllSkills({
      projectRoot: 'C:\\repo',
      fs: fs.capability,
      onReject: (event: unknown) => rejections.push(event),
    } as Parameters<typeof loadAllSkills>[0]);

    expect(manifests.every((manifest) => manifest.source === 'builtin')).toBe(true);
    expect(fs.readCalls).toEqual([]);
    expect(rejections).toEqual(
      expect.arrayContaining([
        { source: 'project', code: 'invalid_path' },
        { source: 'project', code: 'collision' },
        { source: 'project', code: 'symlink_blocked' },
      ]),
    );
    expect(JSON.stringify(rejections)).not.toContain(secret);
  });

  it('rejects malformed, oversized, and disabled packages while keeping errors content-free', async () => {
    const fs = fakeFilesystem({
      directories: {
        'C:/repo/.jarvis/skills': [
          {
            name: 'malformed.md',
            path: 'C:\\repo\\.jarvis\\skills\\malformed.md',
            isDir: false,
            size: 40,
          },
          {
            name: 'oversized.md',
            path: 'C:\\repo\\.jarvis\\skills\\oversized.md',
            isDir: false,
            size: 64 * 1024 + 1,
          },
          {
            name: 'disabled.md',
            path: 'C:\\repo\\.jarvis\\skills\\disabled.md',
            isDir: false,
            size: 80,
          },
        ],
      },
      files: {
        'C:/repo/.jarvis/skills/malformed.md': '---\\nname: malformed',
        'C:/repo/.jarvis/skills/oversized.md': skillRaw('oversized', 'too large'),
        'C:/repo/.jarvis/skills/disabled.md': skillRaw('disabled', 'disabled body', false),
      },
    });
    const rejections: unknown[] = [];

    const manifests = await loadAllSkills({
      projectRoot: 'C:\\repo',
      fs: fs.capability,
      onReject: (event: unknown) => rejections.push(event),
    } as Parameters<typeof loadAllSkills>[0]);

    expect(manifests.every((manifest) => manifest.source === 'builtin')).toBe(true);
    expect(fs.readCalls.map((call) => normalize(call.path))).not.toContain(
      'C:/repo/.jarvis/skills/oversized.md',
    );
    expect(rejections).toEqual(
      expect.arrayContaining([
        { source: 'project', code: 'malformed' },
        { source: 'project', code: 'oversized' },
        { source: 'project', code: 'disabled' },
      ]),
    );
    expect(JSON.stringify(rejections)).not.toContain('disabled body');
  });

  it('preserves embedded loading when no discovery capability is requested', async () => {
    expect(await loadAllSkills()).toEqual(await loadAllSkills({}));
    expect((await loadAllSkills()).every((manifest) => manifest.source === 'builtin')).toBe(true);
  });

  it('discovers bounded project agent packages with the same provenance rules', async () => {
    const fs = fakeFilesystem({
      directories: {
        'C:/repo/.jarvis/agents': [
          {
            name: 'reviewer',
            path: 'C:\\repo\\.jarvis\\agents\\reviewer',
            isDir: true,
          },
        ],
        'C:/repo/.jarvis/agents/reviewer': [
          {
            name: 'AGENT.md',
            path: 'C:\\repo\\.jarvis\\agents\\reviewer\\AGENT.md',
            isDir: false,
            size: 80,
          },
        ],
      },
      files: {
        'C:/repo/.jarvis/agents/reviewer/AGENT.md': `---
name: reviewer
kind: agent
enabled: true
---
Review carefully.`,
      },
    });

    const agents = await loadAllAgents({
      projectRoot: 'C:\\repo',
      fs: fs.capability,
    } as Parameters<typeof loadAllAgents>[0]);

    expect(agents.filter((agent) => agent.source === 'project')).toEqual([
      expect.objectContaining({
        name: 'reviewer',
        kind: 'agent',
        body: 'Review carefully.',
      }),
    ]);
  });

  it('merges discovered project skills into the registry without removing embedded presets', async () => {
    const fs = fakeFilesystem({
      directories: {
        'C:/repo/.jarvis/skills': [
          {
            name: 'project-skill.md',
            path: 'C:\\repo\\.jarvis\\skills\\project-skill.md',
            isDir: false,
            size: 80,
          },
        ],
        'C:/repo/.jarvis/agents': [],
      },
      files: {
        'C:/repo/.jarvis/skills/project-skill.md': skillRaw(
          'project-skill',
          'Project registry body',
        ),
      },
    });

    const manifests = await skillRegistry.reload({
      projectRoot: 'C:\\repo',
      fs: fs.capability,
    } as Parameters<typeof skillRegistry.reload>[0]);

    expect(manifests.filter((manifest) => manifest.isPreset)).toHaveLength(5);
    expect(skillRegistry.get('project-skill')).toEqual(
      expect.objectContaining({
        source: 'project',
        body: 'Project registry body',
      }),
    );
  });
});
