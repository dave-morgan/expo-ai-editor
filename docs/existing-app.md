# Add to an existing app

Checklist for adding the inspector to an Expo app that is not this repo's example. Every item was
needed in the first real-app integration (Expo SDK 58, Expo Router, bun, physical Pixel 6); see
[issue #1](https://github.com/dave-morgan/expo-ai-editor/issues/1).

You need two packages: `@dave-morgan/expo-ai-inspector` (in the app) and `@dave-morgan/expo-ai-bridge` (on your computer).
The `@dave-morgan/expo-ai-*` packages are internal dependencies and install with them.

## 1. Install

**From GitHub Packages** (no npm account or npm scope needed):

Add this scope mapping to your app's project-level `.npmrc`:

```ini
@dave-morgan:registry=https://npm.pkg.github.com
```

GitHub requires authentication even for public npm packages. Create a personal access token
(classic) with `read:packages`, then log in (use that token as the password):

```sh
npm login --scope=@dave-morgan --registry=https://npm.pkg.github.com --auth-type=legacy
```

Keep the token in your user-level npm configuration, outside the repository. See
[GitHub's npm registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
Then install:

```sh
npx expo install @dave-morgan/expo-ai-inspector expo-speech-recognition react-native-view-shot expo-secure-store expo-dev-client
npm install --save-dev @dave-morgan/expo-ai-bridge      # or: bun add -d / pnpm add -D / yarn add -D
```

**From a GitHub release** (no GitHub token, no submodule, no hand-packed tarballs). Each release attaches
packed tarballs (`workspace:*` already rewritten). Point the two packages, and the internal
`@dave-morgan/expo-ai-*` packages they depend on, at the release URLs:

```jsonc
// package.json (replace 0.1.0 with the release you want)
{
  "dependencies": {
    "@dave-morgan/expo-ai-inspector": "https://github.com/dave-morgan/expo-ai-editor/releases/download/v0.1.0/dave-morgan-expo-ai-inspector-0.1.0.tgz",
  },
  "devDependencies": {
    "@dave-morgan/expo-ai-bridge": "https://github.com/dave-morgan/expo-ai-editor/releases/download/v0.1.0/dave-morgan-expo-ai-bridge-0.1.0.tgz",
  },
  // npm and bun: "overrides"; pnpm: "pnpm.overrides"; yarn: "resolutions"
  "overrides": {
    "@dave-morgan/expo-ai-protocol": "https://github.com/dave-morgan/expo-ai-editor/releases/download/v0.1.0/dave-morgan-expo-ai-protocol-0.1.0.tgz",
    "@dave-morgan/expo-ai-inspector-transform": "https://github.com/dave-morgan/expo-ai-editor/releases/download/v0.1.0/dave-morgan-expo-ai-inspector-transform-0.1.0.tgz",
    "@dave-morgan/expo-ai-t3-adapter": "https://github.com/dave-morgan/expo-ai-editor/releases/download/v0.1.0/dave-morgan-expo-ai-t3-adapter-0.1.0.tgz",
  },
}
```

npm and bun cannot install a git dependency from a subdirectory of a pnpm monorepo, so do not
point at the repository itself. If you need an unreleased build, run
`npx -y pnpm@10.34.9 pack:all` in a clone and use the `file:` paths of the tarballs it writes.

### Peer dependencies

`@dave-morgan/expo-ai-inspector` declares these as peer dependencies. Only the first three are required; the
rest are optional and the feature degrades without them.

| Package                         | Required | Without it                                       |
| ------------------------------- | -------- | ------------------------------------------------ |
| `expo`, `react`, `react-native` | yes      | —                                                |
| `expo-speech-recognition`       | no       | No dictation; typed instructions only            |
| `react-native-view-shot`        | no       | No screenshots sent with instructions            |
| `expo-secure-store`             | no       | Pairing is forgotten on every app reload         |
| `expo-constants`                | no       | Bridge URL and project id are not auto-detected  |
| `expo-router`                   | no       | Current route is not included in the instruction |

`expo-speech-recognition` and `react-native-view-shot` are native modules: **rebuild the
development client** after adding them (`npx expo run:android`, `npx expo run:ios`, or an EAS
development build). Expo Go cannot load them.

## 2. Config plugin (`app.json`)

```json
{ "expo": { "plugins": ["@dave-morgan/expo-ai-inspector"] } }
```

Adds the microphone / speech-recognition permission strings (through `expo-speech-recognition`'s
plugin) and the iOS local-network description. Rebuild the dev client after changing plugins.

## 3. Babel

Append `@dave-morgan/expo-ai-inspector/babel` **after** your other plugins (macro plugins such as
`@lingui/babel-plugin-lingui-macro` must run first):

```js
// babel.config.js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // ...your plugins
      "@dave-morgan/expo-ai-inspector/babel", // last
    ],
  };
};
```

The plugin only tags JSX in development builds. Restart Metro with `-c` after adding it.

## 4. Metro

```js
// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const { withExpoAI } = require("@dave-morgan/expo-ai-inspector/metro");

module.exports = withExpoAI(getDefaultConfig(__dirname), {
  // Only if you keep a checkout of expo-ai-tools inside the app (submodule, vendor folder):
  // exclude: ["vendor/expo-ai-tools"],
});
```

`withExpoAI` keeps your existing `resolver.blockList` and adds:

- `.expo-ai/` — screenshots the bridge writes there must not trigger Metro reloads;
- every `exclude` folder — Metro otherwise watches and resolves the monorepo's own sources, and
  its duplicate `react` / `react-native` copies break the bundle.

## 5. TypeScript, ESLint, git

- **`.gitignore`**: nothing to do. The bridge writes a `.gitignore` containing `*` into the
  `.expo-ai/` folder it creates. (Adding `.expo-ai/` to your own `.gitignore` is harmless.)
- **TypeScript / ESLint**: only needed if a checkout of this repo lives inside the app; exclude
  that folder (`"exclude": ["vendor/expo-ai-tools"]` in `tsconfig.json`, and the same path in
  ESLint's `ignores`).

## 6. Mount the inspector

Render it once, as the **last child inside your top-level providers**, so it draws above the app
and can read router state:

```tsx
// app/_layout.tsx (Expo Router)
import { AIInspector } from "@dave-morgan/expo-ai-inspector";

export default function RootLayout() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Stack />
        {__DEV__ && <AIInspector />}
      </I18nProvider>
    </ThemeProvider>
  );
}
```

Props are listed in [setup](setup.md#1-install-into-your-expo-app).

## 7. Bridge config

In the app (or repo) root, `expo-ai-bridge.config.json`:

```json
{
  "projects": [{ "id": "my-app", "root": ".", "t3Project": "." }]
}
```

`id` must equal your Expo `slug` (or the inspector's `projectId` prop). `t3Project` is the folder
T3 Code knows the project by. If you run the app from a **git worktree** (including T3 Code's own
worktrees), the bridge maps a worktree path to the main checkout automatically and prints
`T3 project: <worktree> → <main checkout>`.

```sh
npx expo-ai-bridge doctor
npx expo-ai-bridge start
```

## 8. Device

- Emulator / simulator: works with the defaults.
- **Physical Android over USB**: see [Physical Android over USB](physical-android.md) —
  `adb reverse` for both Metro and the bridge, custom Metro ports, proxies.
- Physical device over Wi-Fi: `npx expo-ai-bridge start --lan`.

## Releasing

Maintainers: keep all five package versions in sync, then push the matching `v*` tag
(for example, `v0.1.0`). The release workflow builds and tests, publishes all five packages to
GitHub Packages with the repository's automatic `GITHUB_TOKEN` (`packages: write`), and attaches
the packed tarballs to a public GitHub release. No `NPM_TOKEN` secret is needed.

[Download releases](https://github.com/dave-morgan/expo-ai-editor/releases/latest).
When using release URLs, keep the three overrides above: the tarballs contain versioned internal
dependencies that otherwise resolve through a registry.
