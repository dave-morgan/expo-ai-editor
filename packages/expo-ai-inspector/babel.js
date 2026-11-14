// Babel plugin entry: add `"@dave-morgan/expo-ai-inspector/babel"` to the plugins in babel.config.js.
// It is a no-op for production builds (Metro reports isDev=false).
module.exports = require("@dave-morgan/expo-ai-inspector-transform").default;
