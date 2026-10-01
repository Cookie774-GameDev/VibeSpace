import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../migrations/0004_runtime_v2.sql', import.meta.url),
  'utf8',
);

describe('0004 intelligence runtime migration', () => {
  it('is additive and keeps existing news history intact', () => {
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|INDEX)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+news_items\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS intelligence_news_events');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS benchmark_datasets_v2');
  });

  it('stores independent leases and run audits for news and benchmarks', () => {
    expect(migration).toContain('intelligence_pipeline_leases');
    expect(migration).toContain('intelligence_pipeline_runs');
    expect(migration).toContain("'news-hourly'");
    expect(migration).toContain("'benchmarks-hourly'");
  });

  it('enforces the Artificial Analysis score scale at the database boundary', () => {
    expect(migration).toMatch(/intelligence_index\s+REAL\s+NOT NULL/i);
    expect(migration).toMatch(/intelligence_index\s*>=\s*0/i);
    expect(migration).toMatch(/intelligence_index\s*<\s*200/i);
    expect(migration).toContain('benchmark_current_v2');
  });

  it('adds first-class media, source health, and source references', () => {
    for (const token of [
      'image_url',
      'image_credit',
      'video_url',
      'media_type',
      'media_source',
      'intelligence_news_source_health',
      'intelligence_news_event_sources',
    ]) {
      expect(migration).toContain(token);
    }
  });
});
