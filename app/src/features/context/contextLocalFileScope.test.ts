import { beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// The original real picker/creation/scanner RED is retained separately.
// This interface-first cohort must report an assertion, not a module-load error,
// when the new pure admission helper has not yet been implemented.
let api: Record<string, (...args: any[]) => any> = {};
beforeAll(async () => {
  const path = resolve(__dirname, "contextLocalFileScope.ts");
  if (existsSync(path)) api = await import(/* @vite-ignore */ path);
});
function call(name: string, ...args: any[]) {
  expect(api[name], `Missing planned production function ${name}`).toBeTypeOf(
    "function",
  );
  return api[name]!(...args);
}
const scope = {
  version: 1,
  rootDir: "/owned/docs",
  filePath: "/owned/docs/selected.txt",
};
const file = () => ({
  sourceType: "local_file",
  rootDir: "/owned/docs",
  localFileScope: { ...scope },
});

describe("Context selected local file scope", () => {
  it("retains one immutable POSIX scope with a directory root", () => {
    const value = call("parseContextLocalFileScope", scope);
    expect(value).toEqual(scope);
    expect(Object.isFrozen(value)).toBe(true);
    expect(value).not.toBe(scope);
    expect(scope).toEqual({
      version: 1,
      rootDir: "/owned/docs",
      filePath: "/owned/docs/selected.txt",
    });
  });
  it("normalizes supported Windows picker separators without widening the path", () => {
    expect(
      call("parseContextLocalFileScope", {
        version: 1,
        rootDir: "C:\\Owned\\Docs\\",
        filePath: "C:\\Owned\\Docs\\selected.txt",
      }),
    ).toEqual({
      version: 1,
      rootDir: "C:/Owned/Docs",
      filePath: "C:/Owned/Docs/selected.txt",
    });
  });
  it("retains the existing normalizable verbatim drive picker form", () => {
    expect(
      call("parseContextLocalFileScope", {
        version: 1,
        rootDir: "\\\\?\\C:\\Owned",
        filePath: "\\\\?\\C:\\Owned\\selected.txt",
      }),
    ).toEqual({
      version: 1,
      rootDir: "C:/Owned",
      filePath: "C:/Owned/selected.txt",
    });
  });
  it.each([
    { version: 1, rootDir: "/", filePath: "/selected.txt" },
    { version: 1, rootDir: "C:/", filePath: "C:/selected.txt" },
  ])("preserves a filesystem root as the immediate parent: %j", (value) => {
    expect(call("parseContextLocalFileScope", value)).toEqual(value);
  });
  it.each([
    null,
    [],
    {},
    { ...scope, version: 2 },
    { ...scope, extra: true },
    { ...scope, filePath: "/owned/docs" },
    { ...scope, filePath: "/owned/docs/" },
    { ...scope, filePath: "/owned/docs/nested/selected.txt" },
    { ...scope, filePath: "/owned/docs-neighbor/selected.txt" },
    { ...scope, filePath: "/owned/docs/../docs/selected.txt" },
    { ...scope, rootDir: "/owned/./docs" },
    { ...scope, filePath: "/owned/docs/selected.txt\u0000" },
    {
      ...scope,
      rootDir: "relative/docs",
      filePath: "relative/docs/selected.txt",
    },
    {
      version: 1,
      rootDir: "C:/Owned",
      filePath: "C:/Owned/selected.txt:stream",
    },
    { version: 1, rootDir: "C:/Owned", filePath: "C:/Owned/selected.txt." },
    {
      version: 1,
      rootDir: "//server/share",
      filePath: "//server/share/selected.txt",
    },
    {
      version: 1,
      rootDir: "//?/UNC/server/share",
      filePath: "//?/UNC/server/share/selected.txt",
    },
  ])("rejects an invalid or broadened descriptor: %j", (value) => {
    expect(() => call("parseContextLocalFileScope", value)).toThrow(
      "context_local_file_scope_invalid",
    );
  });
  it("does not reinterpret a legacy local-file row as a directory grant", () => {
    expect(() =>
      call("readContextLocalFileScope", {
        sourceType: "local_file",
        rootDir: "/owned/docs/selected.txt",
      }),
    ).toThrow("context_local_file_scope_required");
  });
  it("leaves ordinary directory maps on their existing admission path", () => {
    const folder = { sourceType: "local_folder", rootDir: "/owned/docs" };
    expect(call("readContextLocalFileScope", folder)).toBeNull();
    expect(call("contextLocalFileScopeFingerprint", folder)).toBeNull();
    expect(call("contextLocalFileRelativePath", folder)).toBeNull();
    expect(() =>
      call("assertContextLocalFilePath", folder, "/owned/docs/sibling.txt"),
    ).not.toThrow();
  });
  it("rejects a file descriptor attached to a folder or a different parent root", () => {
    expect(() =>
      call("readContextLocalFileScope", {
        ...file(),
        sourceType: "local_folder",
      }),
    ).toThrow("context_local_file_scope_invalid");
    expect(() =>
      call("readContextLocalFileScope", { ...file(), rootDir: "/other" }),
    ).toThrow("context_local_file_scope_invalid");
  });
  it("allows the selected path and exposes only its relative filename", () => {
    expect(call("readContextLocalFileScope", file())).toEqual(scope);
    expect(() =>
      call("assertContextLocalFilePath", file(), "/owned/docs/selected.txt"),
    ).not.toThrow();
    expect(call("contextLocalFileRelativePath", file())).toBe("selected.txt");
  });
  it.each([
    "/owned/docs/sibling.txt",
    "/owned/docs/selected.txt.bak",
    "/owned/docs/nested/selected.txt",
    "/owned/docs/../docs/selected.txt",
  ])("refuses a different read candidate before IO: %s", (path) => {
    expect(() => call("assertContextLocalFilePath", file(), path)).toThrow(
      "context_local_file_path_denied",
    );
  });
  it("keeps POSIX case significant", () => {
    expect(() =>
      call("assertContextLocalFilePath", file(), "/owned/docs/SELECTED.txt"),
    ).toThrow("context_local_file_path_denied");
  });
  it("rejects POSIX backslash ambiguity before applying Windows separator rules", () => {
    expect(() =>
      call(
        "assertContextLocalFilePath",
        file(),
        String.raw`/owned/docs\selected.txt`,
      ),
    ).toThrow("context_local_file_path_denied");
    expect(() =>
      call("parseContextLocalFileScope", {
        version: 1,
        rootDir: String.raw`/owned/docs\nested`,
        filePath: String.raw`/owned/docs\nested/selected.txt`,
      }),
    ).toThrow("context_local_file_scope_invalid");
  });
  it("matches supported Windows ASCII case/separator aliases and fingerprints them equally", () => {
    const a = {
      sourceType: "local_file",
      rootDir: "C:/Owned/Docs",
      localFileScope: {
        version: 1,
        rootDir: "C:/Owned/Docs",
        filePath: "C:/Owned/Docs/selected.txt",
      },
    };
    const b = {
      sourceType: "local_file",
      rootDir: "c:\\owned\\docs",
      localFileScope: {
        version: 1,
        rootDir: "c:/owned/docs",
        filePath: "c:/owned/docs/SELECTED.TXT",
      },
    };
    expect(() =>
      call("assertContextLocalFilePath", a, "c:\\OWNED\\DOCS\\SELECTED.TXT"),
    ).not.toThrow();
    expect(call("contextLocalFileScopeFingerprint", a)).toBe(
      call("contextLocalFileScopeFingerprint", b),
    );
    expect(call("contextLocalFileScopeFingerprint", a)).not.toBe(
      call("contextLocalFileScopeFingerprint", {
        ...a,
        localFileScope: {
          ...a.localFileScope,
          filePath: "C:/Owned/Docs/sibling.txt",
        },
      }),
    );
  });
});
