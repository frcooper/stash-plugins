// Scaffolds a new UI plugin.
//
// usage: npm run new -- <PluginId> ["Display Name"]
import fs from "node:fs";
import path from "node:path";
import { ID_PATTERN, PLUGINS_DIR } from "./lib.mjs";

const [id, displayName = id] = process.argv.slice(2);
if (!id || !ID_PATTERN.test(id)) {
  console.error(`usage: npm run new -- <PluginId> ["Display Name"]  (id must match ${ID_PATTERN})`);
  process.exit(1);
}

const dir = path.join(PLUGINS_DIR, id);
if (fs.existsSync(dir)) {
  console.error(`plugins/${id} already exists`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

const files = {
  [`${id}.yml`]: `name: ${displayName}
description: TODO
version: 0.1.0
ui:
  javascript:
    - ${id}.js
`,
  [`${id}.js`]: `(function () {
  "use strict";

  const api = window.PluginApi;
})();
`,
  "README.md": `# ${displayName}

TODO
`,
  "CHANGELOG.md": `# Changelog

## 0.1.0

- Initial release.
`,
};

for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), content);
}
console.log(`created plugins/${id}`);
