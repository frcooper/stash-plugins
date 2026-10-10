// Checks every plugin under plugins/ is well-formed. Exits non-zero on errors.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import semver from "semver";
import {
  ID_PATTERN,
  changelogHasVersion,
  isUrl,
  loadPlugins,
  packageFiles,
} from "./lib.mjs";

export function validate(plugins = loadPlugins()) {
  const errors = [];
  const ids = new Set(plugins.map((p) => p.id));

  if (plugins.length === 0) errors.push("no plugins found under plugins/");

  for (const p of plugins) {
    const err = (msg) => errors.push(`${p.id}: ${msg}`);

    if (!ID_PATTERN.test(p.id)) {
      err(`directory name must match ${ID_PATTERN}`);
    }
    if (p.raw == null) {
      err(`missing ${p.id}.yml (the yml must be named after its directory)`);
      continue;
    }
    if (p.parseError) {
      err(`invalid yaml: ${p.parseError}`);
      continue;
    }

    const c = p.config;
    for (const field of ["name", "description", "version"]) {
      if (typeof c[field] !== "string" || !c[field].trim()) {
        err(`"${field}" is required`);
      }
    }
    if (typeof c.version === "string" && semver.valid(c.version) !== c.version) {
      err(`version "${c.version}" is not semver (e.g. 1.2.3, no leading v)`);
    } else if (
      typeof c.version === "string" &&
      !changelogHasVersion(p.dir, c.version)
    ) {
      err(`CHANGELOG.md has no "## ${c.version}" entry`);
    }

    const ui = c.ui ?? {};
    for (const kind of ["javascript", "css"]) {
      for (const f of ui[kind] ?? []) {
        if (!isUrl(f) && !fs.existsSync(path.join(p.dir, f))) {
          err(`ui.${kind} file not found: ${f}`);
        }
      }
    }

    for (const dep of p.requires) {
      if (!ids.has(dep)) err(`# requires: "${dep}" is not a plugin in this repo`);
    }

    for (const f of packageFiles(p.dir)) {
      if (f.endsWith(".js")) {
        try {
          execFileSync(process.execPath, ["--check", path.join(p.dir, f)], {
            stdio: "pipe",
          });
        } catch (e) {
          err(`syntax error in ${f}\n${e.stderr}`);
        }
      }
    }
  }

  return errors;
}

if (import.meta.main) {
  const errors = validate();
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  console.log("all plugins valid");
}
