// @ts-check
/**
 * Expo config plugin for expo-ai-inspector.
 *
 * - Configures microphone + speech recognition permissions through expo-speech-recognition's own
 *   plugin (when it is installed), so developers do not edit native projects by hand.
 * - Adds an iOS local-network usage description (the inspector talks to the bridge on your LAN).
 *
 * The plugin only adds permission strings; the inspector itself renders nothing in production.
 * Usage in app.json: "plugins": [["@dave-morgan/expo-ai-inspector", { "microphonePermission": "..." }]]
 */
const { withInfoPlist, withPlugins, createRunOncePlugin } = require("expo/config-plugins");

const pkg = require("./package.json");

/** @type {import("expo/config-plugins").ConfigPlugin<{ microphonePermission?: string; speechRecognitionPermission?: string; localNetworkPermission?: string; speech?: boolean } | void>} */
const withExpoAiInspector = (config, props) => {
  const options = props || {};
  const plugins = [];

  let hasSpeech;
  try {
    require.resolve("expo-speech-recognition/app.plugin.js", { paths: [config._internal?.projectRoot ?? process.cwd()] });
    hasSpeech = true;
  } catch {
    hasSpeech = false;
  }
  if (hasSpeech && options.speech !== false) {
    plugins.push([
      "expo-speech-recognition",
      {
        microphonePermission: options.microphonePermission ?? "Allow $(PRODUCT_NAME) to use the microphone to dictate UI change requests during development.",
        speechRecognitionPermission:
          options.speechRecognitionPermission ?? "Allow $(PRODUCT_NAME) to transcribe your spoken UI change requests on this device.",
      },
    ]);
  }

  config = withPlugins(config, plugins);
  config = withInfoPlist(config, (cfg) => {
    if (!cfg.modResults.NSLocalNetworkUsageDescription) {
      cfg.modResults.NSLocalNetworkUsageDescription =
        options.localNetworkPermission ?? "Allow $(PRODUCT_NAME) to reach the Expo AI Bridge on your development machine.";
    }
    return cfg;
  });
  return config;
};

module.exports = createRunOncePlugin(withExpoAiInspector, pkg.name, pkg.version);
