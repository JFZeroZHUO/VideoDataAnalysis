import { build } from 'vite';
import { buildExtension } from './build-extension.mjs';

process.env.VITE_STORAGE_MODE = 'extension';
await buildExtension();
await build({ build: { outDir: 'dist-web' } });
