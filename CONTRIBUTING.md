# Contributing

1. `npx -y pnpm@10.34.9 install`
2. Make changes with tests. Run `npx -y pnpm@10.34.9 build && npx -y pnpm@10.34.9 test && npx -y pnpm@10.34.9 typecheck`.
3. Protocol changes go in `packages/protocol` first; keep them backwards compatible or bump `PROTOCOL_VERSION`.
4. Anything touching React or React Native internals belongs in `packages/expo-ai-inspector/src/inspection/fiber.ts` or `hit-test.ts`, behind a fallback.
5. Never add code paths that run shell commands with request data, read T3 Code's database, or send audio off the device.
6. Device-facing changes: run the manual checklist in `docs/limitations.md` on at least one platform and note the result in the PR.
