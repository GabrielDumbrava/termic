// @vitest-environment node
//
// Every `<Trans>` must resolve its key in the namespace it will ACTUALLY use.
//
// `useTranslation("panels")` binds `t` to that namespace, but `<Trans>` does
// not inherit it: with no `t={t}` and no `ns="..."` it looks the key up in
// `defaultNS` ("common"), misses, and renders the key itself. That is not a
// crash and not a type error, so it ships: the PR card told people
// "pr.cliMissingBody" and the clone dialog dropped the whole line that names
// the destination (its `<code>` lives in the translation, so a missed key
// takes the element with it, testid and all).
//
// Static rather than a render test on purpose: it covers every call site,
// including the ones no spec opens.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import en from "@/locales/en";

const SRC = path.join(__dirname, "..");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

/** The `<Trans .../>` elements in one file, with the namespaces each could
 *  resolve against. */
function transUsages(source: string): { key: string; namespaces: string[] }[] {
  // Namespaces this file binds `t` to; `useTranslation()` with no argument is
  // the default namespace.
  const bound = [...source.matchAll(/useTranslation\((?:"([^"]+)")?\)/g)].map(m => m[1] ?? "common");
  const out: { key: string; namespaces: string[] }[] = [];
  for (let i = source.indexOf("<Trans"); i >= 0; i = source.indexOf("<Trans", i + 1)) {
    const end = source.indexOf("/>", i);
    const el = source.slice(i, end >= 0 ? end + 2 : i + 400);
    const key = el.match(/i18nKey="([^"]+)"/)?.[1];
    if (!key) continue;
    const explicit = el.match(/\sns="([^"]+)"/)?.[1];
    const namespaces = explicit
      ? [explicit]
      // `t={t}` carries whatever the file bound; without either, i18next
      // falls back to defaultNS.
      : /\st=\{/.test(el) ? (bound.length ? bound : ["common"])
        : ["common"];
    out.push({ key, namespaces });
  }
  return out;
}

const catalog = en as unknown as Record<string, Record<string, unknown>>;

/** Walk a dotted key through one namespace's catalog. A `count` key is stored
 *  under i18next's plural suffixes rather than the bare name, so "x.skipped"
 *  legitimately exists only as "x.skipped_one" / "x.skipped_other". */
function resolves(ns: string, key: string): boolean {
  const parts = key.split(".");
  const leaf = parts.pop()!;
  let node: unknown = catalog[ns];
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "object" || node === null) return false;
  const bag = node as Record<string, unknown>;
  return [leaf, `${leaf}_one`, `${leaf}_other`].some(k => typeof bag[k] === "string");
}

describe("<Trans> namespaces", () => {
  const files = tsxFiles(SRC);

  it("finds the call sites at all (the scan is load-bearing)", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true, which is the failure mode this test class has.
    const total = files.reduce((n, f) => n + transUsages(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(50);
  });

  it("resolves every key in a namespace the element actually uses", () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const { key, namespaces } of transUsages(readFileSync(file, "utf8"))) {
        if (namespaces.some(ns => resolves(ns, key))) continue;
        broken.push(
          `${path.relative(SRC, file)}: "${key}" is not in ${namespaces.join(" | ")}`
          + ` (add ns="<namespace>" or t={t})`,
        );
      }
    }
    expect(broken).toEqual([]);
  });
});
