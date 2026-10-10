// Tags HEAD as <id>/v<version> for each plugin version that has no tag yet.
// Tags are created locally; the deploy workflow pushes them.
import { git, loadPlugins, tryGit } from "./lib.mjs";

for (const p of loadPlugins()) {
  const tag = `${p.id}/v${p.config.version}`;
  if (tryGit("rev-parse", "-q", "--verify", `refs/tags/${tag}`)) continue;
  git("tag", tag);
  console.log(`tagged ${tag}`);
}
