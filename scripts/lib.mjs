import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const PLUGINS_DIR = path.join(ROOT, "plugins");

// Stash uses the yml file name as the plugin ID and the package ID as the
// install directory, so keep IDs to characters that are safe in both.
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function git(...args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

export function loadPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => loadPlugin(d.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadPlugin(id) {
  const dir = path.join(PLUGINS_DIR, id);
  const ymlPath = path.join(dir, `${id}.yml`);
  const raw = fs.existsSync(ymlPath) ? fs.readFileSync(ymlPath, "utf8") : null;
  return { id, dir, ymlPath, raw, ...parseConfig(raw) };
}

export function parseConfig(raw) {
  if (raw == null) return { config: null, parseError: null, requires: [] };
  try {
    return {
      config: YAML.parse(raw) ?? {},
      parseError: null,
      requires: parseRequires(raw),
    };
  } catch (e) {
    return { config: null, parseError: e.message, requires: [] };
  }
}

// Package dependencies use the same comment convention as stashapp/CommunityScripts:
//   # requires: OtherPlugin, AnotherPlugin
export function parseRequires(raw) {
  const m = raw.match(/^#\s*requires:(.*)$/m);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Files shipped in a plugin's zip, as sorted posix paths relative to its
// directory. Dotfiles are left out.
export function packageFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

export function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

export function changelogHasVersion(dir, version) {
  const file = path.join(dir, "CHANGELOG.md");
  if (!fs.existsSync(file)) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`, "m").test(
    fs.readFileSync(file, "utf8")
  );
}
