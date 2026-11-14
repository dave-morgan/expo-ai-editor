const path = require("node:path");

function directoryPattern(directory) {
  const segments = directory.split(/[\\/]/);
  const escaped = segments.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[\\\\/]")}(?:[\\\\/]|$)`);
}

function withExpoAI(config, { exclude = [] } = {}) {
  const root = path.resolve(config.projectRoot ?? process.cwd());
  const existing = config.resolver?.blockList;
  return {
    ...config,
    resolver: {
      ...config.resolver,
      blockList: [
        ...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]),
        ...[".expo-ai", ...exclude].map((directory) =>
          directoryPattern(path.resolve(root, directory)),
        ),
      ],
    },
  };
}

module.exports = { withExpoAI };
