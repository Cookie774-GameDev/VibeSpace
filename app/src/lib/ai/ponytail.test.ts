import { describe, expect, it } from 'vitest';

import {
  ponytailArtifact,
  ponytailAuditRaw,
  ponytailFullInstructions,
  ponytailRawSkill,
  ponytailSkillCatalog,
  ponytailSource,
} from './ponytail';

describe('pinned Ponytail bundle', () => {
  it('exposes the exact repository, release, and commit used to build the app artifact', () => {
    expect(ponytailSource).toEqual({
      repository: 'https://github.com/DietrichGebert/ponytail',
      release: 'v4.10.0',
      commit: '1d95ff7d39de12d87014ea40d4e22201bddc501b',
    });
    expect(ponytailArtifact.source).toEqual(ponytailSource);
  });

  it('exports the exact upstream builder output and original skill bytes', () => {
    expect(ponytailFullInstructions).toContain('PONYTAIL MODE ACTIVE — level: full');
    expect(ponytailFullInstructions).toContain('| **full** |');
    expect(ponytailFullInstructions).not.toContain('| **ultra** |');
    expect(ponytailRawSkill).toContain('name: ponytail');
    expect(ponytailAuditRaw).toContain('name: ponytail-audit');
    expect(ponytailAuditRaw).toContain('ponytail-review, repo-wide.');
    expect(ponytailArtifact.instructions.sha256).toBe(
      'da4fb09cff2f6726691ce6591cebc38c95597d79da132e49c6fa2665c4e8a3ff',
    );
  });

  it('keeps stock catalog records tied to the pinned upstream paths and hashes', () => {
    expect(ponytailSkillCatalog).toEqual([
      {
        name: 'ponytail',
        path: 'skills/ponytail/SKILL.md',
        sha256: '1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2',
      },
      {
        name: 'ponytail-audit',
        path: 'skills/ponytail-audit/SKILL.md',
        sha256: '5560b8e383dbe2ddfddc873a1e2bf2e586e23e0cd7d995537482b2315331f6d1',
      },
    ]);
  });
});
