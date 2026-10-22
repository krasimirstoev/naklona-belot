import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
export default defineConfig({
  plugins: [react(), {
    name:'cache-built-shell',
    async closeBundle() {
      const html=await readFile('dist/client/index.html','utf8');
      const assets=(await readdir('dist/client/assets')).map(f=>'/assets/'+f);
      const fonts=(await readdir('dist/client/fonts')).filter(f=>!f.endsWith('.txt')).map(f=>'/fonts/'+f);
      const back=await readFile('dist/client/cards/back.svg');
      const version=createHash('sha256').update(html).update(back).digest('hex').slice(0,12);
      const source=(await readFile('public/sw.js','utf8')).replace("'naklona-v1'",`'naklona-${version}'`).replace("self.addEventListener('install'",`SHELL.push(...${JSON.stringify([...assets,...fonts])});\nself.addEventListener('install'`);
      await writeFile('dist/client/sw.js',source);
    }
  }],
  build: { outDir: 'dist/client' }
});
