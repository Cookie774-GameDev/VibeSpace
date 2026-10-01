import path from 'node:path';
import { defineConfig, mergeConfig } from 'vite';

import appConfig from './app/vite.config';

export default mergeConfig(
  appConfig,
  defineConfig({
    server: {
      fs: {
        allow: [path.resolve(__dirname)],
      },
    },
  }),
);
