# Stash plugins

Plugins for [Stash](https://github.com/stashapp/stash), published as a plugin source so they install and update from inside Stash like the community plugins.

| Plugin | Description |
|---|---|
| [Frame Step](plugins/FrameStep) | Frame-by-frame stepping in the scene player. |

## Install

1. In Stash, open **Settings → Plugins → Available Plugins** and click **Add Source**.
2. Fill in:
   - **Name:** `frcooper`
   - **Source URL:** `https://frcooper.github.io/stash-plugins/index.yml`
   - **Local path:** `frcooper`
3. Expand the new source, tick the plugins you want, and click **Install**.

Stash shows updates under **Installed Plugins → Check for updates**.

## Repository layout

```
plugins/<PluginId>/
  <PluginId>.yml     plugin config; the file name is the plugin ID
  CHANGELOG.md       one "## x.y.z" section per released version
  README.md
  ...                everything in the folder ships in the zip (dotfiles excluded)
scripts/             validate / build / version check / release tagging / scaffolding
.github/workflows/   CI on pull requests, deploy to GitHub Pages on main
```

Every plugin folder becomes `<PluginId>.zip` plus an entry in `index.yml`. Nothing else needs registering.

## Versioning

Each plugin is versioned on its own with [semver](https://semver.org) in the `version:` field of its yml.

- **Any change to a plugin's folder needs a version bump** and a matching `## x.y.z` section in its `CHANGELOG.md`. CI enforces this on pull requests, and the deploy enforces it on `main`.
- The index `date` is the time of the last commit that touched the plugin's folder. Stash compares that date, not the version, to decide whether an update is available, so it changes only when that plugin changes.
- After each successful deploy, the workflow tags the release as `<PluginId>/v<version>`, e.g. `FrameStep/v0.1.0`.
- Zips are built with fixed timestamps and file order, so a plugin's `sha256` only changes when its contents do.

## Development

Requires Node 24.2 or later.

```bash
npm install
```

Create a new plugin from the template:

```bash
npm run new -- MyPlugin "My Plugin"
```

Check all plugins (yml fields, semver, changelog entry, referenced files, JS syntax, dependencies):

```bash
npm run validate
```

Build the site into `_site/` the same way CI does:

```bash
npm run build
```

Check versions were bumped against a branch or commit:

```bash
npm run check-versions -- main
```

To try a local build in Stash, serve `_site/` (e.g. `npx http-server _site -p 8090`) and add `http://localhost:8090/index.yml` as a source.

### Plugin dependencies

If a plugin needs another plugin from this repo, declare it with a comment in its yml. The build copies it into the index's `requires` field, so Stash installs both:

```yaml
# requires: OtherPlugin, AnotherPlugin
```

## Releasing

1. Change the plugin, bump `version` in its yml, and add a `CHANGELOG.md` entry.
2. Merge to `main`. The Deploy workflow validates, publishes to GitHub Pages, and tags the release.

### One-time GitHub setup

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
