// Every `t("…")` literal in the app must resolve to a real en string.
//
// parity.test.ts compares en against zh-CN, so a key missing from BOTH passes
// it, and i18next renders a missing key as the key itself. That is how
// `newTask.membersLabelOf` shipped to main: the multi-repo New Task dialog drew
// the literal text "newTask.membersLabelOf" where "Members (1 of 2)" belonged,
// on every platform and in every language, and nine e2e cases failed on text
// that could never appear. The e2e i18n guard only walks the screens it opens,
// and this dialog needs a multi-repo project to exist, so nothing caught it.
//
// Source-level like CommandPalette.coverage.test.ts, and for the same reason:
// rendering every dialog would mean constructing a plausible world and would
// only prove the strings resolve in THAT world.
//
// Limits worth knowing. Only string literals are checked, so a key built by
// interpolation is invisible here (the e2e guard is what covers those). And a
// bare key is accepted when ANY namespace the file uses defines it, which is
// looser than i18next at runtime; tightening that would mean tracking which `t`
// came from which `useTranslation` call, and the loose version already catches
// the failure this exists for: a key that exists nowhere.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./en";
import { NAMESPACES } from "@/lib/i18n";

type Tree = Record<string, unknown>;

function flatten(tree: Tree, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.add(key);
    else if (v && typeof v === "object") for (const n of flatten(v as Tree, key)) out.add(n);
  }
  return out;
}

const KEYS: Record<string, Set<string>> = Object.fromEntries(
  NAMESPACES.map(ns => [ns, flatten((en as Record<string, Tree>)[ns] ?? {})]),
);

/** i18next appends a plural suffix when `count` is passed, so the base key can
 *  legitimately be absent while its forms are there. */
const PLURAL_SUFFIXES = ["", "_one", "_other", "_zero", "_two", "_few", "_many"];
const resolves = (ns: string, key: string) =>
  PLURAL_SUFFIXES.some(s => KEYS[ns]?.has(key + s));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sourceFiles(p, out); continue; }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(p);
  }
  return out;
}

describe("translation keys used in the app", () => {
  const files = sourceFiles("src");

  it("finds the locale tree at all", () => {
    // Guards the loader: if `en` stops having these shapes, every assertion
    // below would pass against empty sets.
    expect(NAMESPACES.length).toBeGreaterThan(4);
    for (const ns of NAMESPACES) expect(KEYS[ns].size, `${ns} is empty`).toBeGreaterThan(0);
  });

  it("resolves every literal key to an en string", () => {
    const missing: string[] = [];
    for (const file of files) {
      // Comments first: this module's own doc comment shows `t("general.language")`
      // as an EXAMPLE, and a guard that reports its own documentation is a guard
      // people turn off.
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // The namespaces this file's `t` can be bound to. `useTranslation()` with
      // no argument is the default namespace, "common".
      const declared = [...src.matchAll(/useTranslation\(\s*"([A-Za-z-]+)"/g)].map(m => m[1]);
      // A lib/store file has no `useTranslation`: it takes `t` as a parameter
      // from whichever component calls it (taskGroups.ts does), so which
      // namespace it lands in is not knowable here. Accept any of them rather
      // than report a key that exists.
      const used = new Set<string>(declared.length ? [...declared, "common"] : NAMESPACES);
      for (const m of src.matchAll(/\bt\(\s*"([A-Za-z0-9_.:-]+)"/g)) {
        const raw = m[1];
        const qualified = raw.includes(":");
        const ns = qualified ? raw.slice(0, raw.indexOf(":")) : null;
        const key = qualified ? raw.slice(raw.indexOf(":") + 1) : raw;
        // A bare word is almost always somebody's local helper called `t`, not
        // a translation (the test files are excluded, but lib code has them
        // too). A real key is namespaced or dotted.
        if (!qualified && !key.includes(".")) continue;
        const ok = qualified
          ? resolves(ns!, key)
          : [...used].some(n => resolves(n, key));
        if (!ok) missing.push(`${raw}  (${file})`);
      }
    }
    expect(missing,
      "These keys are passed to t() but exist in no en namespace, so i18next "
      + "renders the key itself on screen:\n  " + missing.join("\n  "),
    ).toEqual([]);
  });
});
