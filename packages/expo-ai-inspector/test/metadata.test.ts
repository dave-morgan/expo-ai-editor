import { describe, expect, it } from "vitest";
import { collectText, getDisplayName, hostChildren } from "../src/inspection/fiber";
import { buildSelection, parseSourceProp } from "../src/inspection/metadata";
import { buildTree, fn, FiberTag } from "./fibers";

const Text = fn("Text");
const View = fn("View");
const ProfileHeader = fn("ProfileHeader");
const ProfileScreen = fn("ProfileScreen");
const AppText = fn("AppText");
const bounds = { x: 24.04, y: 120, width: 280, height: 40 };

/*
 * ProfileScreen (user)
 *   ProfileHeader        __aiSource=app/profile.tsx:20:6, owner ProfileScreen
 *     View (lib)         __aiSource=src/components/ProfileHeader.tsx:10:4, owner ProfileHeader
 *       RCTView (host)
 *         Text (lib)     __aiSource=src/components/ProfileHeader.tsx:42:6, owner ProfileHeader
 *           RCTText      style
 *             "Welcome back"
 */
function profileTree() {
  return buildTree({
    tag: FiberTag.HostRoot,
    type: null,
    children: [
      {
        tag: FiberTag.FunctionComponent,
        type: ProfileScreen,
        name: "ProfileScreen",
        children: [
          {
            tag: FiberTag.FunctionComponent,
            type: ProfileHeader,
            name: "ProfileHeader",
            owner: "ProfileScreen",
            props: { __aiSource: "app/profile.tsx:20:6" },
            children: [
              {
                tag: FiberTag.ForwardRef,
                type: { render: View },
                owner: "ProfileHeader",
                props: { __aiSource: "src/components/ProfileHeader.tsx:10:4", testID: "header" },
                children: [
                  {
                    tag: FiberTag.HostComponent,
                    type: "RCTView",
                    name: "headerView",
                    props: { testID: "header" },
                    children: [
                      {
                        tag: FiberTag.FunctionComponent,
                        type: Text,
                        owner: "ProfileHeader",
                        props: {
                          __aiSource: "src/components/ProfileHeader.tsx:42:6",
                          children: "Welcome back",
                          accessibilityRole: "header",
                        },
                        children: [
                          {
                            tag: FiberTag.HostComponent,
                            type: "RCTText",
                            name: "host",
                            props: {
                              style: [{ fontSize: 28, fontWeight: "700" }, { marginBottom: 16, transform: [{ scale: 1 }] }],
                              children: "Welcome back",
                            },
                            children: [{ tag: FiberTag.HostText, type: null, props: "Welcome back" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("parseSourceProp", () => {
  it("parses transform output and rejects junk", () => {
    expect(parseSourceProp("src/a b/C.tsx:12:4")).toEqual({ file: "src/a b/C.tsx", line: 12, column: 4 });
    expect(parseSourceProp("C:/x/y.tsx:3:0")).toEqual({ file: "C:/x/y.tsx", line: 3, column: 0 });
    expect(parseSourceProp("nope")).toBeNull();
    expect(parseSourceProp("a.tsx:0:1")).toBeNull();
    expect(parseSourceProp(42)).toBeNull();
  });
});

describe("buildSelection", () => {
  it("separates host element, owning component and JSX source", () => {
    const { byName } = profileTree();
    const selection = buildSelection({ host: byName.get("host")!, bounds, screen: "/profile", hitTestStrategy: "fabric-native" });
    expect(selection.elementType).toBe("Text");
    expect(selection.componentName).toBe("ProfileHeader");
    expect(selection.source).toEqual({ file: "src/components/ProfileHeader.tsx", line: 42, column: 6 });
    expect(selection.componentSource).toEqual({ file: "app/profile.tsx", line: 20, column: 6 });
    expect(selection.sourceOrigin).toBe("babel-transform");
    expect(selection.confidence).toBe("high");
    expect(selection.visibleText).toBe("Welcome back");
    expect(selection.accessibilityRole).toBe("header");
    expect(selection.style).toEqual({ fontSize: 28, fontWeight: "700", marginBottom: 16 });
    expect(selection.bounds.x).toBe(24);
    expect(selection.screen).toBe("/profile");
    const names = selection.hierarchy.map((f) => `${f.name}${f.isLibrary ? "[lib]" : ""}`);
    expect(names).toEqual(["Text[lib]", "View[lib]", "ProfileHeader", "ProfileScreen"]);
  });

  it("points at the usage site when text is passed through a reusable component", () => {
    const { byName } = buildTree({
      tag: FiberTag.HostRoot,
      type: null,
      children: [
        {
          tag: FiberTag.FunctionComponent,
          type: ProfileHeader,
          name: "ProfileHeader",
          children: [
            {
              tag: FiberTag.FunctionComponent,
              type: AppText,
              name: "AppText",
              owner: "ProfileHeader",
              props: { __aiSource: "src/components/ProfileHeader.tsx:42:6", children: "Welcome back", variant: "title" },
              children: [
                {
                  tag: FiberTag.FunctionComponent,
                  type: Text,
                  owner: "AppText",
                  props: { __aiSource: "src/ui/AppText.tsx:9:9", children: "Welcome back" },
                  children: [{ tag: FiberTag.HostComponent, type: "RCTText", name: "host", props: { children: "Welcome back" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const selection = buildSelection({ host: byName.get("host")!, bounds });
    expect(selection.componentName).toBe("AppText");
    expect(selection.source?.file).toBe("src/ui/AppText.tsx");
    expect(selection.confidenceNotes.join(" ")).toContain("src/components/ProfileHeader.tsx:42");
  });

  it("never fabricates a source when nothing is tagged", () => {
    const { byName } = buildTree({
      tag: FiberTag.HostRoot,
      type: null,
      children: [{ tag: FiberTag.FunctionComponent, type: View, children: [{ tag: FiberTag.HostComponent, type: "RCTView", name: "host" }] }],
    });
    const selection = buildSelection({ host: byName.get("host")!, bounds, hitTestStrategy: "geometry", overlappingCandidates: 5 });
    expect(selection.source).toBeUndefined();
    expect(selection.sourceOrigin).toBe("none");
    expect(selection.confidence).toBe("none");
    expect(selection.confidenceNotes.some((n) => n.includes("babel"))).toBe(true);
    expect(selection.confidenceNotes.some((n) => n.includes("geometry"))).toBe(true);
    expect(selection.elementType).toBe("View");
  });

  it("uses legacy _debugSource with medium confidence", () => {
    const { byName } = buildTree({
      tag: FiberTag.HostRoot,
      type: null,
      children: [{ tag: FiberTag.HostComponent, type: "RCTView", name: "host" }],
    });
    const host = byName.get("host")!;
    host._debugSource = { fileName: "C:\\app\\src\\A.tsx", lineNumber: 7, columnNumber: 2 };
    const selection = buildSelection({ host, bounds });
    expect(selection.source).toEqual({ file: "C:/app/src/A.tsx", line: 7, column: 2 });
    expect(selection.sourceOrigin).toBe("react-debug-source");
    expect(selection.confidence).toBe("medium");
  });

  it("reports medium confidence when the nearest tag is several components up", () => {
    const Lib1 = fn("Lib1");
    const Lib2 = fn("Lib2");
    const { byName } = buildTree({
      tag: FiberTag.HostRoot,
      type: null,
      children: [
        {
          tag: FiberTag.FunctionComponent,
          type: ProfileScreen,
          name: "Screen",
          children: [
            {
              tag: FiberTag.FunctionComponent,
              type: Lib1,
              owner: "Screen",
              props: { __aiSource: "app/index.tsx:5:2" },
              children: [
                {
                  tag: FiberTag.FunctionComponent,
                  type: Lib2,
                  children: [{ tag: FiberTag.FunctionComponent, type: Lib2, children: [{ tag: FiberTag.HostComponent, type: "RCTView", name: "host" }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    const selection = buildSelection({ host: byName.get("host")!, bounds });
    expect(selection.confidence).toBe("medium");
    expect(selection.componentName).toBe("ProfileScreen");
  });
});

describe("fiber helpers", () => {
  it("names forwardRef/memo types and collects text", () => {
    expect(getDisplayName({ render: fn("Inner") })).toBe("Inner");
    expect(getDisplayName({ type: fn("Memoed") })).toBe("Memoed");
    expect(getDisplayName("RCTView")).toBe("RCTView");
    const { byName } = profileTree();
    expect(collectText(byName.get("headerView")!)).toBe("Welcome back");
  });

  it("finds host children through composites", () => {
    const { root } = buildTree({
      tag: FiberTag.HostRoot,
      type: null,
      children: [
        { tag: FiberTag.FunctionComponent, type: View, children: [{ tag: FiberTag.HostComponent, type: "RCTView", name: "a" }] },
        { tag: FiberTag.HostComponent, type: "RCTView", name: "b", children: [{ tag: FiberTag.HostComponent, type: "RCTView" }] },
      ],
    });
    expect(hostChildren(root)).toHaveLength(2);
  });
});
