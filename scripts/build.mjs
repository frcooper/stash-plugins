// Builds the plugin source that Stash installs from:
//   <outdir>/index.yml       package index (Settings > Plugins > Available Plugins)
//   <outdir>/<id>.zip        one zip per plugin, files at the zip root
//   <outdir>/index.html      human-readable landing page
//
// usage: node scripts/build.mjs [outdir]   (default: _site)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import YAML from "yaml";
import { ROOT, loadPlugins, packageFiles, tryGit } from "./lib.mjs";
import { validate } from "./validate.mjs";

const outdir = path.resolve(ROOT, process.argv[2] ?? "_site");

const plugins = loadPlugins();
const errors = validate(plugins);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

// Stash flags an installed plugin as upgradable when the index date is newer
// than the installed one, so the date must move whenever the plugin changes:
// use the last commit that touched its directory.
function lastChange(p) {
  const rel = path.relative(ROOT, p.dir).replaceAll("\\", "/");
  const dirty = tryGit("status", "--porcelain", "--", rel);
  const committed = tryGit("log", "-1", "--format=%ct %h", "--", rel);
  if (dirty || !committed) {
    console.warn(`warning: ${p.id} has uncommitted changes, dating it now`);
    return { date: new Date(), commit: null };
  }
  const [ts, commit] = committed.split(" ");
  return { date: new Date(Number(ts) * 1000), commit };
}

// Stash's package time format: "2006-01-02 15:04:05", UTC
function stashTime(d) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

const index = [];
for (const p of plugins) {
  const { date, commit } = lastChange(p);

  // fixed mtimes and sorted entries, so the zip (and its sha256) only change
  // when the plugin's contents do
  const entries = {};
  for (const f of packageFiles(p.dir)) {
    entries[f] = [fs.readFileSync(path.join(p.dir, f)), { mtime: date }];
  }
  const zip = zipSync(entries, { level: 9 });
  const zipName = `${p.id}.zip`;
  fs.writeFileSync(path.join(outdir, zipName), zip);

  const metadata = { description: p.config.description };
  if (p.config.url) metadata.url = p.config.url;
  if (commit) metadata.commit = commit;

  const entry = {
    id: p.id,
    name: p.config.name,
    version: p.config.version,
    date: stashTime(date),
    path: zipName,
    sha256: crypto.createHash("sha256").update(zip).digest("hex"),
    metadata,
  };
  if (p.requires.length) entry.requires = p.requires;
  index.push(entry);

  console.log(`${p.id} ${p.config.version} (${Object.keys(entries).length} files)`);
}

fs.writeFileSync(path.join(outdir, "index.yml"), YAML.stringify(index));

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const rows = index
  .map(
    (e) =>
      `<tr><td><a href="${esc(e.path)}">${esc(e.name)}</a></td><td>${esc(e.version)}</td><td>${esc(e.date)} UTC</td><td>${esc(e.metadata.description)}</td></tr>`
  )
  .join("\n");
fs.writeFileSync(
  path.join(outdir, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stash plugins</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.5; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #8884; padding: .4rem .6rem; text-align: left; vertical-align: top; }
  code { background: #8882; padding: .1rem .3rem; border-radius: 4px; word-break: break-all; }
</style>
</head>
<body>
<h1>Stash plugins</h1>
<p>In Stash, open <b>Settings → Plugins → Available Plugins → Add Source</b> and use this URL:</p>
<p><code id="src">index.yml</code></p>
<table>
<thead><tr><th>Plugin</th><th>Version</th><th>Updated</th><th>Description</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<script>document.getElementById("src").textContent = new URL("index.yml", location.href).href;</script>
</body>
</html>
`
);

console.log(`wrote ${index.length} plugin(s) to ${path.relative(ROOT, outdir) || "."}`);
