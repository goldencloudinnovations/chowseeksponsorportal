import { copyFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'assets'), { recursive: true });
await copyFile(resolve(root, 'index.html'), resolve(dist, 'index.html'));
await copyFile(resolve(root, 'CNAME'), resolve(dist, 'CNAME'));
await copyFile(resolve(root, 'src/styles.css'), resolve(dist, 'assets/styles.css'));

execFileSync('tsc', ['-p', resolve(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
console.log('Built Chowseek restaurant portal → dist/');
