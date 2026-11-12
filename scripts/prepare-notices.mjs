import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Preserve upstream licenses without selecting a license for this extension.
await mkdir('notices', { recursive: true });
for (const [source, destination] of [
  ['node_modules/@angular/compiler/LICENSE', 'angular-compiler-LICENSE.txt'],
  ['node_modules/typescript/LICENSE.txt', 'typescript-LICENSE.txt'],
  ['node_modules/typescript/ThirdPartyNoticeText.txt', 'typescript-ThirdPartyNotices.txt'],
]) {
  await writeFile(`notices/${destination}`, await readFile(source));
}
