import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clickByText, clickWhenVisible, dismissOverlays, requireTermicApi, snap, waitForAppShell, waitGone, waitVisible } from "../helpers";

// The Todos view's project filter, a multi-select. Cases: it opens on All
// projects with every project's rows; ticking a project narrows to it and
// leaves the menu open; a second tick covers both and the trigger counts
// them; a ticked box paints its border in its fill colour and a click on the
// box lands on the row; the pick is saved and survives leaving the view; All
// clears it and closes the menu; a picked project that is removed falls back
// to every project without the saved pick being rewritten.
//
// Rows are SEEDED into the Todos cache: the fixture's origin is a local path,
// which no forge CLI answers for, so a real fetch would never fill the list.
describe("todos project filter", () => {
  let dir = "";
  let otherId = "";
  let otherName = "";
  let fixtureId = "";
  const OTHER_TITLE = "e2e-todos-other-issue";
  const FIXTURE_TITLE = "e2e-todos-fixture-issue";
  const TRIGGER = '[data-testid="todos-project-filter"]';
  const option = (id: string) => `[data-testid="todos-project-option"][data-project-id="${id}"]`;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-todos-"));
    execSync(
      `git -C "${dir}" init -q && git -C "${dir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(async () => {
    await browser.execute(async (pid) => {
      const t = window.__termic!;
      // Straight to the store, not through the setter: the setter fetches,
      // and a fetch landing after clearCache would leave entries behind.
      t.useTodos.setState({ selectedProjectIds: [], kindFilter: "all" });
      localStorage.removeItem("todosProjects");
      t.useTodos.getState().clearCache();
      if (pid) {
        try { await t.ipc.projectRemove(pid); } catch { /* already gone */ }
      }
      await t.useApp.getState().loadAll();
    }, otherId);
    await dismissOverlays();
    rmSync(dir, { recursive: true, force: true });
  });

  const triggerText = async () =>
    (await browser.execute((s) => (document.querySelector(s) as HTMLElement | null)?.innerText.trim() ?? "", TRIGGER)) as string;

  const rowTexts = async () =>
    (await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="todos-row"]'), (r) => (r as HTMLElement).innerText),
    )) as string[];

  const waitFor = async (pred: () => Promise<boolean>, msg: string) =>
    browser.waitUntil(pred, { timeout: 8_000, timeoutMsg: msg });

  const waitTrigger = (label: string) =>
    waitFor(async () => (await triggerText()) === label, `trigger never read "${label}"`);

  const waitRows = (titles: string[]) =>
    waitFor(async () => {
      const rows = await rowTexts();
      return rows.length === titles.length && titles.every((t) => rows.some((r) => r.includes(t)));
    }, `rows never became [${titles.join(", ")}]`);

  // Radix opens on pointerdown, so a bare .click() isn't enough.
  const openPicker = async () => {
    await waitVisible(TRIGGER);
    await browser.execute((s) => {
      const el = document.querySelector(s) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }, TRIGGER);
    await waitVisible('[data-testid="todos-project-all"]');
  };

  const tick = async (id: string) => {
    await waitVisible(option(id));
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), option(id));
  };

  const checked = async (id: string) =>
    (await browser.execute((s) => document.querySelector(s)?.getAttribute("aria-checked") ?? null, option(id))) as string | null;

  const saved = async () =>
    (await browser.execute(() => localStorage.getItem("todosProjects"))) as string | null;

  it("opens on All projects with every project's rows", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    const proj = (await browser.execute(async (d) => await window.__termic!.ipc.projectAdd(d), dir)) as any;
    otherId = proj.id;
    otherName = proj.name;
    fixtureId = (await browser.execute(
      () => window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id as string,
    )) as string;

    await browser.execute((rows) => {
      const t = window.__termic!;
      const cache: Record<string, unknown> = {};
      for (const [pid, pname, title, n] of rows) {
        cache[`${pid}:issues:assigned`] = {
          status: "ok",
          // Ahead of now, so the TTL cannot lapse mid-spec and send a real
          // fetch over the seeded rows.
          fetchedAt: Date.now() + 60 * 60 * 1000,
          items: [{
            id: `${pid}:issue:${n}`, kind: "issue", projectId: pid, projectName: pname, action: "assigned",
            issue: {
              provider: "github", number: n, title, url: "", body: "", author: "alice",
              comments: 0, labels: [], updated_at: "2026-10-24T10:00:00Z",
            },
          }],
        };
      }
      localStorage.removeItem("todosProjects");
      // Issues only, so the view asks for nothing the seed does not hold.
      t.useTodos.setState({ cache, selectedProjectIds: [], kindFilter: "issues", scopeFilter: "for_me", searchQuery: "" });
    }, [
      [fixtureId, "fixture-repo", FIXTURE_TITLE, 1],
      [otherId, otherName, OTHER_TITLE, 2],
    ] as Array<[string, string, string, number]>);
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());

    await clickWhenVisible('[data-testid="nav-todos"]');
    await waitVisible('[data-testid="todos-view"]');
    await waitRows([FIXTURE_TITLE, OTHER_TITLE]);
    expect(await triggerText()).toBe("All projects");
  });

  it("narrows to a ticked project and leaves the menu open", async () => {
    await openPicker();
    expect(await checked(otherId)).toBe("false");

    await tick(otherId);
    await waitTrigger(otherName);
    await waitRows([OTHER_TITLE]);
    // Still open, and the row reports the tick.
    expect(await checked(otherId)).toBe("true");
    expect(await checked(fixtureId)).toBe("false");
    await snap("todos-filter-one-project.png");
  });

  it("covers both projects after a second tick and counts them on the trigger", async () => {
    await tick(fixtureId);
    await waitTrigger("2 projects");
    await waitRows([FIXTURE_TITLE, OTHER_TITLE]);
    expect(await checked(fixtureId)).toBe("true");
    expect(await checked(otherId)).toBe("true");
    await snap("todos-filter-two-projects.png");
  });

  it("paints a ticked box's border in its fill, and a click on the box lands on the row", async () => {
    // The tick is carried by colour alone, so the painted colours are what
    // say it took. Polled: the fill eases in over the box's transition.
    await waitFor(async () => {
      const { border, fill } = (await browser.execute((s) => {
        const box = document.querySelector(`${s} [role="checkbox"]`) as HTMLElement;
        const cs = getComputedStyle(box);
        return { border: cs.borderTopColor, fill: cs.backgroundColor };
      }, option(fixtureId))) as { border: string; fill: string };
      return border === fill;
    }, "ticked box border never matched its fill");

    // The box is a picture, not a second control: a click on it must reach
    // the row, the one thing that toggles.
    const hitsRow = (await browser.execute((s) => {
      const row = document.querySelector(s) as HTMLElement;
      const r = (row.querySelector('[role="checkbox"]') as HTMLElement).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && hit.closest('[data-testid="todos-project-option"]') === row && !hit.closest('[role="checkbox"]');
    }, option(fixtureId))) as boolean;
    expect(hitsRow).toBe(true);
  });

  it("saves the pick and keeps it after leaving the view", async () => {
    expect(JSON.parse((await saved()) ?? "null")?.slice().sort()).toEqual([fixtureId, otherId].sort());

    await browser.keys(["Escape"]);
    await waitGone('[data-testid="todos-project-all"]');
    await clickByText("Dashboard");
    await waitGone('[data-testid="todos-view"]');
    await clickWhenVisible('[data-testid="nav-todos"]');
    await waitVisible('[data-testid="todos-view"]');
    await waitTrigger("2 projects");
  });

  it("clears the pick and closes the menu on All projects", async () => {
    await openPicker();
    await browser.execute(() => (document.querySelector('[data-testid="todos-project-all"]') as HTMLElement).click());
    await waitGone('[data-testid="todos-project-all"]');
    await waitTrigger("All projects");
    await waitRows([FIXTURE_TITLE, OTHER_TITLE]);
    expect(await saved()).toBeNull();
  });

  it("falls back to every project when the picked one is removed, keeping the saved pick", async () => {
    await openPicker();
    await tick(otherId);
    await waitTrigger(otherName);
    await browser.keys(["Escape"]);
    await waitGone('[data-testid="todos-project-all"]');

    await browser.execute(async (pid) => {
      const t = window.__termic!;
      await t.ipc.projectRemove(pid);
      await t.useApp.getState().loadAll();
    }, otherId);
    const removed = otherId;
    otherId = "";

    await waitTrigger("All projects");
    await waitRows([FIXTURE_TITLE]);
    // Derived on read, never written back.
    expect(JSON.parse((await saved()) ?? "null")).toEqual([removed]);
  });
});
