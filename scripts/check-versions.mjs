// Fails if a plugin's files changed since <base> without its version going up.
//
// usage: node scripts/check-versions.mjs <base-ref>
import path from "node:path";
import semver from "semver";
import { ROOT, PLUGINS_DIR, loadPlugin, parseConfig, tryGit } from "./lib.mjs";
import fs from "node:fs";

const base = process.argv[2];
if (!base || /^0+$/.test(base) || tryGit("cat-file", "-e", `${base}^{commit}`) == null) {
  console.log(`no usable base commit (${base || "none"}), skipping version check`);
  process.exit(0);
}

const pluginsRel = path.relative(ROOT, PLUGINS_DIR).replaceAll("\\", "/");
const changed = new Set(
  (tryGit("diff", "--name-only", base, "HEAD", "--", pluginsRel) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((f) => f.split("/")[1])
);

const errors = [];
for (const id of [...changed].sort()) {
  if (!fs.existsSync(path.join(PLUGINS_DIR, id))) {
    console.log(`${id}: removed`);
    continue;
  }
  const now = loadPlugin(id).config?.version;
  const old = parseConfig(tryGit("show", `${base}:${pluginsRel}/${id}/${id}.yml`)).config
    ?.version;

  if (old == null) {
    console.log(`${id}: new plugin at ${now}`);
  } else if (!semver.valid(now) || !semver.valid(old) || !semver.gt(now, old)) {
    errors.push(
      `${id}: files changed but version went from ${old} to ${now} — bump "version" in ${id}.yml and add a CHANGELOG.md entry`
    );
  } else {
    console.log(`${id}: ${old} -> ${now}`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
if (changed.size === 0) console.log("no plugin changes");
