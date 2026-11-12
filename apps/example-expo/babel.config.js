module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // Tags JSX with source locations for the AI inspector. No-op in production builds.
    plugins: ["expo-ai-inspector/babel"],
  };
};
