import path from 'node:path';
import { createRequire } from 'node:module';
import base from '../../../../app/vitest.config';
const root = path.resolve(__dirname, '../../../..');
const appRequire = createRequire(path.join(root, 'app/package.json'));
export default {
  ...base,
  resolve: {
    ...base.resolve,
    dedupe: ['react', 'react-dom'],
    alias: {
      ...base.resolve.alias,
      '@testing-library/react': appRequire.resolve('@testing-library/react'),
      'fake-indexeddb/auto': appRequire.resolve('fake-indexeddb/auto'),
      vitest: path.join(path.dirname(appRequire.resolve('vitest/package.json')), 'dist/index.js'),
      '@tauri-apps/api/core': appRequire.resolve('@tauri-apps/api/core'),
    },
  },
  test: {
    ...base.test,
    include: [path.join(__dirname, 'draft.test.tsx')],
    maxWorkers: 1,
    setupFiles: [path.join(root, 'app/src/test/setup.ts')],
  },
};





