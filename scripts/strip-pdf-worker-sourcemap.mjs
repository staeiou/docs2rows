import { readdir, readFile, writeFile } from "node:fs/promises";

const assetsDir = new URL("../dist/assets/", import.meta.url);
const sourceMapPattern = /\n\/\/# sourceMappingURL=pdf\.worker\.mjs\.map\s*$/;

for (const filename of await readdir(assetsDir)) {
  if (!/^pdf\.worker-.*\.mjs$/.test(filename)) continue;
  const fileUrl = new URL(filename, assetsDir);
  const content = await readFile(fileUrl, "utf8");
  const stripped = content.replace(sourceMapPattern, "");
  if (stripped !== content) await writeFile(fileUrl, stripped);
}
