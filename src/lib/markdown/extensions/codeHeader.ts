// a header row on every markdown code block: the language label and a Copy
// button. Added after mount as the <pre>'s previous sibling, so it sits
// inside a breakout wrapper with the block but outside the <pre>'s own
// horizontal scroll, and the fence renderer's html stays as it was.
//
// The header is app chrome (SLOT_ATTR), and it holds no text nodes: the
// label and the button caption are CSS `content: attr()`, so find, ⌘C and a
// selection's plain text never pick them up.

import type { MdExtension } from "../extension";
import { SLOT_ATTR } from "@/lib/markdown/trust";
import { copyToClipboard } from "@/lib/clipboard";
import { i18n } from "@/lib/i18n";

const HEAD = "md-code-head";
const COPY = "md-code-copy";
const WARN = "md-code-warn";
// characters the preview draws as nothing, or that reorder what is drawn, so
// the copied bytes are not the command on screen ("Trojan Source"). Source
// view shows them (highlightSpecialChars); the preview, where Copy lives,
// would not. ZWJ and ZWNJ are left out: emoji and Persian text use them.
export const HIDDEN_CHARS = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;

export const codeHeader: MdExtension = {
  name: "codeHeader",
  hydrate(host) {
    const label = i18n.t("panels:mdExt.code.copy");
    const tip = i18n.t("panels:mdExt.code.copyTip");
    const warnLabel = i18n.t("panels:mdExt.code.hidden");
    const warnTip = i18n.t("panels:mdExt.code.hiddenTip");
    // stamped = a markdown fence or indented block; a document's raw <pre>
    // cannot carry a stamp, and a mermaid fence is not a <pre> at all.
    for (const pre of Array.from(host.querySelectorAll<HTMLElement>("pre[data-src-line]"))) {
      const code = pre.firstElementChild;
      if (code?.tagName !== "CODE") continue;
      const head = document.createElement("div");
      head.setAttribute(SLOT_ATTR, "");
      head.className = HEAD;
      head.dataset.lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1] ?? "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = COPY;
      btn.dataset.label = label;
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
      if (HIDDEN_CHARS.test(code.textContent ?? "")) {
        const warn = head.appendChild(document.createElement("span"));
        warn.className = WARN;
        warn.dataset.label = warnLabel;
        warn.title = warnTip;
      }
      head.appendChild(btn);
      // a <pre> under an open block editor is hidden, and its header with it
      head.hidden = pre.hidden;
      pre.before(head);
    }
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.(`.${COPY}`);
      const head = btn?.parentElement;
      if (!head?.hasAttribute(SLOT_ATTR) || !host.contains(head)) return;
      const pre = head.nextElementSibling;
      if (pre?.tagName !== "PRE") return;
      void copyToClipboard((pre.textContent ?? "").replace(/\n$/, ""), i18n.t("panels:mdExt.code.label"));
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  },
};
