// The last hook reports one agent sent, grouped per tab, newest first, under
// its state source in Settings. The question it answers is "did the hook fire
// at all", which is the first thing to ask when a badge reads wrong, and until
// now the only place to ask it was termic-workstate.log in the OS temp dir.
// Measured case: a tab parked on a usage limit reads here as "working", then
// usage heartbeats at 100 and nothing else, which is the whole diagnosis.
//
// Per tab, because the first version was one list per agent and two tabs'
// rows interleaved: a reader could not tell which tab had gone quiet. The
// signal column is what termic MADE of the body (lib/agentSignalLog
// `hookSignal`), so a body routed nowhere says "unrecognised" instead of
// looking fine. Same ring buffer as the title inspector, so recording costs
// nothing while this is closed.

import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { getSignalLogVersion, hooksAsText, hooksFor, subscribeSignalLog, type HookSignal } from "@/lib/agentSignalLog";
import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

const SIGNAL_TONE: Partial<Record<HookSignal, string>> = {
  working: "text-[var(--color-warn)]",
  done: "text-[var(--color-ok-fg)]",
  delegated: "text-[var(--color-accent)]",
  attention: "text-[var(--color-err)]",
  other: "text-[var(--color-err)]",
};

export function RecentHooks({ agentId }: { agentId: string }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useSyncExternalStore(subscribeSignalLog, getSignalLogVersion, getSignalLogVersion);
  const groups = open ? hooksFor(agentId) : [];
  const copy = () => {
    copyToClipboard(hooksAsText(agentId), "hook reports");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div data-testid="agent-recent-hooks">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-[12.5px] text-[var(--color-accent)] hover:underline"
        >
          {open ? t("agents.hooksRecent.hide") : t("agents.hooksRecent.show")}
        </button>
        {open && groups.length > 0 && (
          <Button variant="ghost" onClick={copy} data-testid="agent-recent-hooks-copy">
            <Copy className="h-3.5 w-3.5" />
            {copied ? t("agents.hooksRecent.copied") : t("agents.hooksRecent.copy")}
          </Button>
        )}
      </div>
      {open && (groups.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[12px] text-[var(--color-fg-dim)]">
          {t("agents.hooksRecent.empty")}
        </div>
      ) : (
        <div className="mt-2 max-h-[320px] overflow-y-auto rounded-md border border-[var(--color-border-soft)]">
          {groups.map(g => (
            <div key={g.tabId} data-testid="agent-recent-hooks-tab" className="border-b border-[var(--color-border-soft)] last:border-b-0">
              <div className="truncate bg-[var(--color-bg-2)] px-2 py-1 text-[12px] font-medium text-[var(--color-fg)]">{g.tabLabel}</div>
              <table className="w-full text-[12px]">
                <tbody>
                  {g.rows.map(r => (
                    <tr key={r.at + r.body}>
                      <td className="whitespace-nowrap px-2 py-0.5 font-mono text-[var(--color-fg-faint)]">
                        {new Date(r.at).toLocaleTimeString([], { hour12: false })}
                      </td>
                      <td className={cn("whitespace-nowrap px-2 py-0.5", SIGNAL_TONE[r.signal] ?? "text-[var(--color-fg-dim)]")} data-signal={r.signal}>
                        {t(`agents.hooksRecent.sig_${r.signal}`)}
                      </td>
                      <td className="w-full px-2 py-0.5 font-mono text-[var(--color-fg)]">{r.body}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
