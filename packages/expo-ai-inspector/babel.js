// Babel plugin entry: add `"expo-ai-inspector/babel"` to the plugins in babel.config.js.
// It is a no-op for production builds (Metro reports isDev=false).
module.exports = require("@expo-ai/inspector-transform").default;
