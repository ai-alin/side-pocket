// 打包成可以上传 Chrome 应用商店的 zip：只放插件运行需要的文件，放在 dist/ 里。
// 运行：npm run pack
// manifest 里的 key 只在本地开发时用来固定插件 id，商店不接受带 key 的包，这里去掉。
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
delete manifest.key;

const files = readdirSync(root).filter((f) => /\.(js|html|css)$/.test(f));
const stage = mkdtempSync(join(tmpdir(), 'side-pocket-pack-'));
for (const f of files) cpSync(join(root, f), join(stage, f));
cpSync(join(root, 'icons'), join(stage, 'icons'), { recursive: true });
cpSync(join(root, '_locales'), join(stage, '_locales'), { recursive: true });
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `side-pocket-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', '-X', out, '.', '-x', '.DS_Store', '-x', '*/.DS_Store'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`已打包 ${out}`);
console.log(execFileSync('unzip', ['-l', out]).toString());
