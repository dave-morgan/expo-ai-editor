export interface ExpoAIOptions {
  exclude?: string[];
}
export declare function withExpoAI<
  T extends {
    projectRoot?: string;
    resolver?: { blockList?: RegExp | RegExp[] };
  },
>(
  config: T,
  options?: ExpoAIOptions,
): Omit<T, "resolver"> & {
  resolver: NonNullable<T["resolver"]> & { blockList: RegExp[] };
};
