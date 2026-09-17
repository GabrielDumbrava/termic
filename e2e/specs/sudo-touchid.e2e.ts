import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell, waitForText, waitGone, waitVisible } from "../helpers";

// The "Enable Touch ID for sudo?" strip a terminal shows while it sits at a
// sudo password prompt. The e2e binary stands `perl` in for sudo and forces
// eligibility (TERMIC_E2E_FAKE_SUDO, sudo_touchid.rs), because a real sudo
// prompt can't be scripted and no runner has a sensor. Everything else is
// real: the prompt turns echo off on a real PTY, Rust reads that off the
// master, and the strip is driven by the event it emits.
describe("touch id for sudo offer", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => window.__termic!.usePrefs.getState().setOfferTouchIdForSudo(true));
    if (taskId) await archiveTask(taskId);
  });

  // What sudo does, in the order it does it: echo off, THEN the prompt. The
  // prompt is the output Rust's reader sees, so it is what triggers the check.
  const PROMPT = `perl -e '$|=1; system("stty -echo"); print "Password:"; <STDIN>; system("stty echo"); print "\\n"'\r`;

  const banner = (tabId: string) => `[data-tab-id="${tabId}"] [data-testid="sudo-touchid-banner"]`;

  const addShell = async (tabId: string) => {
    await browser.execute((id, t) => {
      window.__termic!.useApp.getState().addTab(id, { id: t, type: "terminal", cli: "shell", title: t } as any);
    }, taskId, tabId);
    await waitForShellPrompt(tabId);
  };

  const tab = (tabId: string) =>
    browser.execute(
      (id, t) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((x: any) => x.id === t) as any,
      taskId, tabId,
    );

  /** The shell has drawn its prompt: a live PTY that has produced output. */
  const waitForShellPrompt = (tabId: string) =>
    browser.waitUntil(async () => {
      const t = await tab(tabId);
      return !!t?.ptyId && !!t?.lastOutputAt;
    }, { timeout: 20_000, timeoutMsg: `shell ${tabId} never drew a prompt` });

  const type = async (tabId: string, text: string) => {
    const { ptyId } = await tab(tabId);
    await browser.execute(
      (p: string, s: string) => window.__termic!.ipc.ptyWrite(p, Array.from(new TextEncoder().encode(s))),
      ptyId as string, text,
    );
  };

  /** Answer the prompt and wait until the shell has printed past it, so a
   *  following assertion about the strip is made after Rust has seen output
   *  from a non-sudo foreground job. */
  const answer = async (tabId: string) => {
    const before = (await tab(tabId)).lastOutputAt;
    await type(tabId, "x\r");
    await browser.waitUntil(async () => (await tab(tabId)).lastOutputAt !== before, {
      timeout: 10_000, timeoutMsg: "no output after answering the prompt",
    });
  };

  /** Records whether the strip EVER mounted in `tabId`, so "it never showed"
   *  is asserted without sleeping. */
  const watchForBanner = (tabId: string) =>
    browser.execute((sel) => {
      const w = window as any;
      w.__sudoBannerSeen = !!document.querySelector(sel);
      w.__sudoBannerObs?.disconnect();
      w.__sudoBannerObs = new MutationObserver(() => {
        if (document.querySelector(sel)) w.__sudoBannerSeen = true;
      });
      w.__sudoBannerObs.observe(document.body, { childList: true, subtree: true });
    }, banner(tabId));
  const bannerWasSeen = () =>
    browser.execute(() => {
      const w = window as any;
      w.__sudoBannerObs?.disconnect();
      return !!w.__sudoBannerSeen;
    });

  it("shows at a password prompt and withdraws once sudo is gone", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-sudo-touchid");
    await addShell("sudo-a");

    // An ordinary command line never raises it: echo is on.
    await watchForBanner("sudo-a");
    await type("sudo-a", "echo hello\r");
    await browser.waitUntil(async () => !!(await tab("sudo-a")).lastOutputAt);
    await answer("sudo-a"); // a stray line at the shell prompt, just output
    expect(await bannerWasSeen()).toBe(false);

    await type("sudo-a", PROMPT);
    await waitVisible(banner("sudo-a"));
    await snap("sudo-touchid-banner.png");
    expect(await browser.execute((sel) => document.querySelector(sel)?.textContent, banner("sudo-a")))
      .toContain("Would you like to enable Touch ID for sudo?");

    await answer("sudo-a");
    await waitGone(banner("sudo-a"));
  });

  it("dismiss hides it for this prompt, the next prompt raises it again", async () => {
    await type("sudo-a", PROMPT);
    await waitVisible(banner("sudo-a"));
    await browser.execute((sel) => (document.querySelector(`${sel} [data-testid="sudo-touchid-dismiss"]`) as HTMLElement).click(), banner("sudo-a"));
    await waitGone(banner("sudo-a"));

    // Answering prints a newline while perl is still the foreground job:
    // output during the same sudo run must not bring it back.
    await watchForBanner("sudo-a");
    await answer("sudo-a");
    expect(await bannerWasSeen()).toBe(false);

    await type("sudo-a", PROMPT);
    await waitVisible(banner("sudo-a"));
    await answer("sudo-a");
    await waitGone(banner("sudo-a"));
  });

  it("copy command puts the sudo line on the clipboard", async () => {
    await type("sudo-a", PROMPT);
    await waitVisible(banner("sudo-a"));
    await browser.execute((sel) => (document.querySelector(`${sel} [data-testid="sudo-touchid-copy"]`) as HTMLElement).click(), banner("sudo-a"));
    await waitForText("Copied command");
    await waitGone(banner("sudo-a"));
    const command = await browser.execute(async () => (await window.__termic!.invoke("sudo_touchid_script")) as any);
    expect(command.command).toMatch(/^sudo '.*\/bin\/enable-touchid-sudo\.sh'$/);
    await answer("sudo-a");
  });

  it("run in new tab types the script into a shell that never offers", async () => {
    await type("sudo-a", PROMPT);
    await waitVisible(banner("sudo-a"));
    const before = await browser.execute((id) => (window.__termic!.useApp.getState().tabs[id] ?? []).map((t: any) => t.id), taskId);
    await browser.execute((sel) => (document.querySelector(`${sel} [data-testid="sudo-touchid-run"]`) as HTMLElement).click(), banner("sudo-a"));

    let installId = "";
    await browser.waitUntil(async () => {
      installId = await browser.execute(
        (id: string, b: string[]) => ((window.__termic!.useApp.getState().tabs[id] ?? []) as any[])
          .find(t => !b.includes(t.id) && t.title === "Touch ID for sudo")?.id ?? "",
        taskId, before as string[],
      );
      return !!installId;
    }, { timeout: 10_000, timeoutMsg: "the install tab never opened" });
    const install = await tab(installId);
    expect(install.cli).toBe("shell");

    // The line is typed once at the first prompt and then cleared, so a
    // respawn can't type it again. The stub script (e2e) just echoes.
    await browser.waitUntil(async () => (await tab(installId)).sudoTouchIdInstall === "", {
      timeout: 20_000, timeoutMsg: "the script line was never typed",
    });

    // The install tab is where the user answers the offer: a prompt in it
    // must not raise another one.
    await waitForShellPrompt(installId);
    await watchForBanner(installId);
    await type(installId, PROMPT);
    await answer(installId);
    expect(await bannerWasSeen()).toBe(false);

    await browser.execute((id, t) => window.__termic!.useApp.getState().closeTab(id, t), taskId, installId);
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTabId(id, "sudo-a"), taskId);
    await answer("sudo-a");
  });

  it("don't ask again turns it off everywhere, and Settings turns it back on", async () => {
    await type("sudo-a", PROMPT);
    await waitVisible(banner("sudo-a"));
    await browser.execute((sel) => (document.querySelector(`${sel} [data-testid="sudo-touchid-never"]`) as HTMLElement).click(), banner("sudo-a"));
    await waitGone(banner("sudo-a"));
    await waitForText("Touch ID for sudo won't be offered again.");
    await answer("sudo-a");

    await watchForBanner("sudo-a");
    await type("sudo-a", PROMPT);
    await answer("sudo-a");
    expect(await bannerWasSeen()).toBe(false);

    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    const toggle = '#setting-offer-touchid-sudo [role="switch"]';
    await waitVisible(toggle);
    expect(await browser.execute((s) => document.querySelector(s)?.getAttribute("aria-checked"), toggle)).toBe("false");
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), toggle);
    await browser.waitUntil(async () =>
      (await browser.execute((s) => document.querySelector(s)?.getAttribute("aria-checked"), toggle)) === "true");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await waitGone(toggle);

    await type("sudo-a", PROMPT);
    await waitVisible(banner("sudo-a"));
    await answer("sudo-a");
    await waitGone(banner("sudo-a"));
  });
});
