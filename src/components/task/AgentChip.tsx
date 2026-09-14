// The task footer's agent control: which account it runs as, what that
// account has spent, and one panel behind it (GH #277 + GH #278).
//
// ONE chip, not two. The account pill used to sit immediately left of this
// with its own trigger and its own panel, and its own header said it "forms
// one unit" with the usage chip, because the numbers here are THAT account's
// numbers. Two controls that form one unit are one control: merging them
// answers "which account, and how much is left" in a single click, and
// removed a duplicated auto-switch checkbox that had already caused one
// two-panels-disagree bug.
//
// Subscription usage in the task footer (GH #277).
//
// Two numbers per account, a fill bar, and the agent's own brand icon. It sits
// immediately left of the sandbox status, which stays the rightmost item, and
// it shares that row with the "N blocked" chip, so it is deliberately terse.
// The detail lives in a popover, which is a CLICK: the numbers are what you
// read at a glance, the reset clocks are what you go looking for.
//
// Where the numbers come from differs per agent and is invisible here: claude
// pushes them through its status line on every turn, codex is asked over
// JSON-RPC. See docs/ideas/usage-footer.md.

import { useEffect, useState } from "react";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { CircleSlash, Copy, Check } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils";
import { useAgentUsage, usageKey, costTotal, costChipVisible, type UsageEntry } from "@/store/agentUsage";
import {
  formatPercent, formatReset, formatUsd, usageLevel, drivingWindow, shortWindowWords,
  USAGE_WARN_PERCENT, USAGE_CRITICAL_PERCENT,
  blocksUsageFeed, blockedReason, statusLineAgentPrompt,
  type UsageLevel, type UsageWindow, type StatusLineOwner,
} from "@/lib/agentUsage";
import { builtinBaseId, agentDisplayName } from "@/lib/agents";
import { useAgentAccounts, type AgentAccounts } from "@/hooks/useAgentAccounts";
import { useAccountSwitching } from "@/hooks/useAccountSwitching";
import { AccountSwitcher } from "@/components/task/AccountSwitcher";
import { pillVisible } from "@/lib/accountPill";
import { KeyRound, ArrowRightLeft } from "lucide-react";
import type { AgentAccountsView, TerminalTab } from "@/lib/types";
import { useApp } from "@/store/app";

/** How long a pulled reading stands before the chip asks again.
 *
 *  Each codex refresh SPAWNS `app-server` and waits for a cold start, so this
 *  is not a poll interval to tune downwards. devin's is one HTTPS call and
 *  could be asked more often, but a quota moves at the speed of agent work,
 *  not of polling. It is a ceiling on staleness for the one visible task;
 *  claude pays nothing for the equivalent because its status line pushes on
 *  every turn. */
const POLL_REFRESH_MS = 120_000;

/** A reading older than this is called out as stale, with its age. The claude
 *  feed only speaks while a turn runs, so a task sitting idle overnight would
 *  otherwise present last night's number as current. */
const STALE_AFTER_MS = 15 * 60_000;

/** One footer chip, for ONE of the agents a task runs (GH #277).
 *
 *  Owns that agent's account state rather than taking it from the footer: with
 *  several agents in one task there is no single "the task's account" to lift
 *  any more, and each chip's numbers are keyed by the login ITS agent process
 *  was spawned with. The pill and the usage numbers still share one fetch,
 *  which was the reason `useAgentAccounts` was lifted in the first place -
 *  they are now the same chip, so the shared owner moved down here with them.
 */
export function FooterAgentChip({ taskId, agentId, cwd, docker, visible, secondary }: {
  taskId: string;
  agentId: string;
  cwd?: string;
  docker: boolean;
  visible: boolean;
  /** An agent the user is not currently looking at, in a task that runs more
   *  than one. Dropped when the footer is too narrow to hold every chip, so
   *  what survives is the agent whose tab is on screen. */
  secondary: boolean;
}) {
  // The account THIS agent's process is running as, which is the running one
  // and not the configured one: a switch applies on the next spawn, so between
  // the click and the restart the two differ.
  //
  // Selected as the string, so this chip re-renders when its own agent
  // restarts on another account and not when a sibling agent changes.
  const liveAccount = useApp(s => {
    const tab = (s.tabs[taskId] || []).find(
      t => t.type === "terminal" && (t as TerminalTab).cli === agentId,
    ) as TerminalTab | undefined;
    // `undefined` when nothing has spawned yet; `null` once a process is
    // running on the agent's ordinary login. The distinction is load-bearing:
    // merging them re-keys a running task's usage the moment the user names
    // their first credential set, and the numbers disappear mid-session.
    return tab && "liveAccount" in tab ? (tab.liveAccount ?? null) : undefined;
  });
  const accounts = useAgentAccounts(taskId, agentId, docker, liveAccount, visible);
  return (
    <AgentChip
      taskId={taskId}
      agentId={agentId}
      cwd={cwd}
      docker={docker}
      accounts={accounts}
      visible={visible}
      // The width below which one footer cannot hold every agent's chip.
      // Measured rather than guessed, in the e2e window: a chip with both
      // windows and no account name renders at 174px, the sandbox status
      // beside it takes ~92px, and the queue + Terminal controls on the left
      // take ~214px with their labels. Two chips is 666px of an 894px bar,
      // which is comfortable; 780 keeps a little room for the wider cases (an
      // account name adds up to ~100px, a "N blocked" chip ~80px) before the
      // bar's own label-shedding rules take over at 680 and 560. The two-agent
      // case in e2e/specs/agent.e2e.ts re-measures all of this.
      className={secondary ? "@max-[780px]:hidden" : undefined}
    />
  );
}

export function AgentChip({ taskId, agentId, cwd, docker, accounts, visible, className }: {
  taskId: string;
  /** The agent ENTRY id (a clone keeps its own). Half of the account key: the
   *  other half is `liveAccount`, because one entry can now hold several
   *  logins (GH #278). */
  agentId: string;
  /** The footer's shared account state. `accounts.account` is the login these
   *  numbers were spent on, which is the RUNNING one and not the configured
   *  one: a switch applies on the next spawn, so between the click and the
   *  restart the two differ. */
  accounts: AgentAccounts;
  /** The task's worktree. A project can ship its own status line, which
   *  outranks the one termic installs, so the answer is per TASK. */
  cwd?: string;
  /** Is this task caged in Docker? Its codex logs in INSIDE the container, so
   *  its quota belongs to the config dir termic mounts there, not to the
   *  host's `~/.codex`. Reporting the host's would put another account's
   *  number under this task's name. */
  docker: boolean;
  /** Whether this task is the one on screen. Panes stay MOUNTED when hidden
   *  (they are display:none, never visibility:hidden), so without this every
   *  open task would spawn its own app-server on the same timer. */
  visible: boolean;
  /** Extra classes for the chip itself. The footer uses it to drop a
   *  SECONDARY agent's chip when the bar is too narrow for every agent the
   *  task runs; there is no wrapper element to hang that on, because an empty
   *  one would still spend a flex gap on a chip that rendered nothing. */
  className?: string;
}) {
  const { account: liveAccount, view: accountsView, refresh: refreshAccounts } = accounts;
  const entry = useAgentUsage(s => s.byAgent[usageKey(agentId, liveAccount)]);
  // Everything this account has spent since termic launched. A NUMBER, not the
  // entry, so this chip re-renders when its own total moves and not when some
  // other account's does.
  const spend = useAgentUsage(s => costTotal(s.cost[usageKey(agentId, liveAccount)]));
  const agents = useApp(a => a.agents);
  // A clone of codex runs codex, so the base decides the transport, not the
  // entry id. `docker.rs` documents the same distinction on the Rust side.
  const base = builtinBaseId(agentId, agents);
  const words = shortWindowWords(base);
  // The pull transports: codex spawns `app-server`, devin POSTs its Connect
  // API. claude needs no ask at all: it pushes through the status line.
  const askUsage = base === "codex" ? ipc.agentUsageCodex
    : base === "devin" ? ipc.agentUsageDevin
    : null;

  // Why the feed cannot run, when it cannot. claude ONLY: it is the only
  // agent whose usage arrives through a status line, so it is the only one
  // that can be shadowed by somebody else's. Asked once, and only while there
  // is nothing to show anyway, so a working feed never pays for it.
  const [detailOpen, setDetailOpen] = useState(false);
  // Held HERE rather than in the panel: the automatic switch fires when an
  // account passes its limit, which is exactly a moment nobody has a panel
  // open. The panel is unmounted most of the time; this chip is not.
  const sw = useAccountSwitching(taskId, agentId, accounts, visible);
  const [owner, setOwner] = useState<StatusLineOwner | null>(null);
  const known = !!entry && (!!entry.session || !!entry.weekly);
  useEffect(() => {
    if (base !== "claude" || !visible || !cwd || known) { setOwner(null); return; }
    let cancelled = false;
    ipc.usageStatusLineOwner(agentId, cwd)
      .then(o => { if (!cancelled) setOwner(o); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentId, base, cwd, visible, known]);

  // The pull transports only. claude arrives on its own through the terminal,
  // and asking it as well would spend a request to learn what it already told
  // us.
  useEffect(() => {
    if (!askUsage || !visible) return;
    let cancelled = false;
    const ask = () => {
      askUsage(agentId, docker, liveAccount)
        .then(u => {
          if (cancelled) return;
          // `report` bails on an unchanged reading, so a refresh that moved
          // nothing costs no store write and no re-render.
          useAgentUsage.getState().report(
            agentId, liveAccount,
            // No cost from the pull transports: they answer plan windows, and
            // the agents' own spend data is token counts and ACUs, not
            // dollars. Turning that into USD would mean a per-model price
            // table in termic, which goes silently wrong the day prices move.
            { session: u.session, weekly: u.weekly, sessionCostUsd: null },
            "rpc");
        })
        // No banner: the agent may not be installed, may not be logged in, or
        // may be an older build without the method, and none of those is
        // worth interrupting anyone over a footer number. But it is LOGGED,
        // because a silently swallowed failure here is exactly how a release
        // shipped with the chip never appearing for codex at all (the
        // packaged app's PATH could not find the binary, and nothing anywhere
        // said so).
        .catch(err => console.warn(`[usage] ${base} refused:`, agentId, err));
    };
    ask();
    const id = window.setInterval(ask, POLL_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [agentId, docker, askUsage, liveAccount, visible]);

  // Nothing known yet: render nothing at all rather than a placeholder. An
  // account that has not spoken has no honest number to show, and a row of
  // dashes in the footer reads as a broken feature rather than a quiet one.
  //
  // The ONE exception is a positively detected blocker, below: "we know why
  // this will never report" is a fact worth showing, where "nothing yet" is
  // not.
  // The two halves self-hide independently: an agent with no usage feed still
  // has accounts to switch, and an agent with no named account still has
  // numbers. The chip renders when EITHER has something.
  const hasNumbers = !!entry && (!!entry.session || !!entry.weekly || costChipVisible(entry, spend));
  const hasAccounts = pillVisible(accountsView);
  if (!hasNumbers && !hasAccounts) {
    return blocksUsageFeed(owner) ? <BlockedChip owner={owner!} className={className} /> : null;
  }

  const stale = !!entry && Date.now() - entry.updatedAt > STALE_AFTER_MS;
  // The bar tracks the window closest to its limit, which is not always the
  // session one: 30% of five hours next to 95% of the week has to read as a
  // warning, not as comfort. `drivingWindow` is where that is decided.
  // Both null on an API-key account: it has no plan to be a percentage OF.
  const driver = entry ? drivingWindow(entry) : null;
  const level = driver ? usageLevel(driver.window.usedPercent) : "normal";
  const iconId = resolveIconId(agentId, agents);

  return (
    // Re-read the accounts when this opens: the opt-in below has a second
    // surface (the account pill carries the same checkbox) and nothing pushes
    // a change between them.
    <PopoverRoot
      open={detailOpen}
      onOpenChange={o => {
        setDetailOpen(o);
        // Re-read on OPEN so a set added in Settings is there; clear the
        // notice on CLOSE, never on open, or the one thing the user opened
        // the panel to read is unmounted as they look at it.
        if (o) refreshAccounts(); else sw.clearNotice();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="usage-chip"
          // The values the chip is CLAIMING, so a spec asserts the number the
          // user reads rather than the store field behind it. Percentages are
          // rounded here exactly as they are rendered.
          data-usage-agent={agentId}
          data-usage-session={entry?.session ? String(Math.round(entry.session.usedPercent)) : ""}
          data-usage-weekly={entry?.weekly ? String(Math.round(entry.weekly.usedPercent)) : ""}
          data-usage-source={entry?.source ?? ""}
          data-usage-level={level}
          // The ACCOUNT half's state, on the same element: one chip, so one
          // set of attributes for a spec to read.
          data-testid-account={hasAccounts ? "1" : ""}
          data-account={sw.label ?? ""}
          data-offering={sw.offering ? sw.candidate! : ""}
          data-usage-account={accounts.account ?? ""}
          data-auto={sw.auto ? "on" : "off"}
          title={
            sw.offering
              ? `${sw.shown.now} is nearly out of plan. Switch to ${sw.candidate}.`
              : sw.shown.next
                ? `${agentId} is running as ${sw.shown.now}. It switches to ${sw.shown.next} when it next starts.`
                : hasAccounts
                  ? `${agentDisplayName(agentId, agents)}, signed in as ${sw.shown.now}`
                  : `${agentDisplayName(agentId, agents)} plan usage`
          }
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 tabular-nums",
            "hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]",
            // Deliberately NOT `transition-colors`: a themed colour set from
            // React state never repaints under that shorthand in WKWebView
            // (docs/gotchas.md), which is how this would light up amber
            // everywhere except the machine it ships on.
            sw.alert ? "text-[var(--color-warn)]"
              : stale ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg-dim)]",
            className,
          )}
        >
          {/* The agent's own brand icon, not a generic gauge. Two DIFFERENT
              agents are told apart right here without reading a word, which a
              gauge could never do; two accounts of the SAME agent are told
              apart in the popover. Sized to the sandbox status icon beside it
              rather than to the 3.5 the text sits at, because a brand mark at
              3.5 is a smudge. */}
          <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
            <CliIcon cli={iconId} className="h-4 w-4" />
          </span>
          {/* The account, when there is one to name. A key glyph only while
              something needs attention: the brand icon already says which
              agent this is, so a second permanent icon would be width spent
              on nothing. */}
          {hasAccounts && (
            <>
              {sw.alert && <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />}
              <span className="max-w-[14ch] truncate">{sw.shown.now}</span>
              {hasNumbers && <span className="text-[var(--color-fg-faint)]">·</span>}
            </>
          )}
          {/* ONE GAUGE PER WINDOW, each touching the number it belongs to.
              There used to be a single bar here, showing whichever window was
              closest to its limit (`drivingWindow`). The reasoning was sound,
              30% of five hours beside 95% of the week has to read as a
              warning, but the bar sat hard against the 5h number and silently
              displayed the OTHER one, so it read as that number's gauge and
              was wrong most of the time. Reported by someone looking straight
              at it, which is the only evidence that counts for a footer you
              are meant to take at a glance.

              Two bars instead, each with its OWN level and colour, so a red
              week bar beside a calm 5h one says both things at once and
              neither borrows the other's identity. `drivingWindow` stays: it
              is still the right question for `autoSwitch`, which wants to know
              which limit will stop you, and for the popover's own colouring.
              Narrower than the old single bar (24px against 32px) so two of
              them cost the footer 16px rather than 36.
              Two fixed labels rather than one adaptive string, unchanged: the
              footer must not reflow as the numbers tick, and "58% 5h" next to
              "41% wk" is read as two things where "58/41" is read as neither. */}
          {entry?.session && (
            <UsageWindowReadout
              window={entry.session} unit={words.chip} stale={stale} testid="5h"
            />
          )}
          {entry?.session && entry?.weekly && <span className="text-[var(--color-fg-faint)]">·</span>}
          {entry?.weekly && (
            <UsageWindowReadout
              window={entry.weekly} unit="wk" stale={stale} testid="wk"
            />
          )}
          {/* Spend since launch, and ONLY for an account with no plan, which
              is the case this feed exists for. On a subscription the
              percentages are the readout: a dollar figure beside them is a
              second number competing for the same glance, and showing it
              before the first `rate_limits` arrives made the chip flip from
              money to a bar mid-turn. The popover still carries the spend. */}
          {costChipVisible(entry, spend) && (
            <>
              {(entry?.session || entry?.weekly) && <span className="text-[var(--color-fg-faint)]">·</span>}
              <span data-usage-spend={spend.toFixed(4)}>{formatUsd(spend)}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-0"
        // Nothing in here is interactive, so taking focus would be pure theft:
        // the user is typing at an agent, and Radix's default is to move focus
        // into the panel on open. Escape still closes it (the dismissable
        // layer listens on the document), and the caret never leaves the
        // terminal. Same reasoning on the way out.
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <UsageDetail
          agentId={agentId} entry={entry} level={level} driver={driver} spend={spend}
          accountsView={accountsView} refreshAccounts={refreshAccounts}
          onNavigate={() => setDetailOpen(false)}
        />
        {/* The credentials half of the same panel. Rendered here rather than
            in its own popover: one control, one panel. */}
        {hasAccounts && accountsView && (
          <AccountSwitcher
            agentId={agentId}
            view={accountsView}
            sw={sw}
            onNavigate={() => setDetailOpen(false)}
          />
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

/** The popover: everything the chip has to leave out, laid out as ROWS.
 *
 *  This was a tooltip first, and a tooltip renders a multi-line string as one
 *  run of prose ("Session window: 19% used, resets 17:00 Weekly window: 14%
 *  used, resets Wed 10:00 Reported by the agent as it works."), which is
 *  unreadable at exactly the moment you went looking for it. Rows, a bar per
 *  window, and the reset clock in its own column. */
function UsageDetail({ agentId, entry, level, driver, spend, accountsView, refreshAccounts, onNavigate }: {
  agentId: string;
  /** Undefined for an account that has never reported: the panel is then
   *  purely the credentials half, and the usage rows are skipped rather than
   *  rendered as blanks. */
  entry: UsageEntry | undefined;
  level: UsageLevel;
  /** `null` on an account with no plan windows, which has no driving one. */
  driver: { window: UsageWindow; label: "5h" | "wk" } | null;
  /** USD spent on this account since launch. */
  spend: number;
  accountsView: AgentAccountsView | null;
  refreshAccounts: () => void;
  /** Close the popover: a row that navigates away must not leave it hanging
   *  over the page it just opened. */
  onNavigate: () => void;
}) {
  const agents = useApp(a => a.agents);
  const iconId = resolveIconId(agentId, agents);
  const age = entry ? Date.now() - entry.updatedAt : 0;
  const stale = !!entry && age > STALE_AFTER_MS;
  const display = agentDisplayName(agentId, agents);
  const words = shortWindowWords(builtinBaseId(agentId, agents));

  return (
    <div data-testid="usage-detail" className="text-[12.5px]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
          <CliIcon cli={iconId} className="h-4 w-4" />
        </span>
        <span className="truncate font-medium text-[var(--color-fg)]">{display}</span>
        {/* The ACCOUNT, spelled out, when it is not just the agent's own name.
            Two clones of one agent put two chips in the window with two
            different numbers, and this is the only place that says which
            login each belongs to. */}
        {display !== agentId && (
          <span className="ml-auto shrink-0 truncate text-[var(--color-fg-faint)]">{agentId}</span>
        )}
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        {!entry ? null : (entry.session || entry.weekly) ? (
          <>
            <UsageRow label={words.label} sub={words.sub} window={entry.session}
              driving={driver?.label === "5h"} level={level} source={entry.source} />
            <UsageRow label="Weekly" sub="rolling 7 days" window={entry.weekly}
              driving={driver?.label === "wk"} level={level} source={entry.source} />
          </>
        ) : (
          // No plan at all: say so, rather than showing two empty bars. This
          // is the API-key account, and its whole readout is the spend below.
          <div className="text-[var(--color-fg-faint)]">
            This account is billed per token, so it has no plan limits.
          </div>
        )}
        {/* `costChipVisible` as well as a positive figure: on an account
            known to have no plan, zero is a reading (nothing spent yet) and
            hiding the row leaves the panel with a single sentence and no
            number, one turn before it fills in. A PLAN account keeps the
            `spend > 0` rule, because `costChipVisible` is false there. */}
        {(spend > 0 || costChipVisible(entry, spend)) && (
          <div
            data-testid="usage-spend-row"
            className="flex items-baseline justify-between border-t border-[var(--color-border-soft)] pt-2.5"
          >
            {/* The label turns on whether this account has a PLAN, because
                the same number means two different things.

                claude reports `total_cost_usd` on every account, subscription
                included, so a Max account shows plan windows AND a dollar
                figure. On that account the money was never spent: it is what
                the tokens would have cost at API rates, and the subscription
                covered them. Calling it "Spent" there states a charge that
                did not happen, which is exactly how it read to the first
                person who saw both on one panel. */}
            <span className="text-[var(--color-fg-dim)]">
              {entry?.sawPlan ? "Would have cost" : "Spent since launch"}
              {/* The reset is said out loud either way, because the number
                  goes back to zero when termic does and someone comparing it
                  against a provider dashboard needs to know that first. */}
              <span className="block text-[11px] text-[var(--color-fg-faint)]">
                {entry?.sawPlan
                  ? "at API rates since launch. Your plan covers it."
                  : "this agent, this account"}
              </span>
            </span>
            <span className="tabular-nums font-medium text-[var(--color-fg)]">{formatUsd(spend)}</span>
          </div>
        )}
      </div>

      {entry && (
      <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[var(--color-fg-faint)]">
        {level !== "normal" && driver && (
          <div className={cn("mb-1", LEVEL_TEXT[level])}>
            Over {level === "critical" ? USAGE_CRITICAL_PERCENT : USAGE_WARN_PERCENT}% of the{" "}
            {driver.label === "5h" ? words.limit : "weekly"} limit.
          </div>
        )}
        {/* Where it came from, and how old. Both matter: the claude feed only
            speaks while a turn runs, so a number can be hours stale and look
            exactly like a fresh one. */}
        <div>
          {entry.source === "statusline"
            ? "Reported by the agent as it works."
            : `Read from ${display} in the background.`}
          {stale ? ` Last updated ${describeAge(age)} ago.` : ""}
        </div>
      </div>
      )}
      {/* Only the "add a second set" nudge survives here: once accounts exist
          the switcher below IS the credentials UI, and the auto-switch
          checkbox lives there. Two copies of that checkbox is what the merge
          removed. */}
      <AccountRow agentId={agentId} view={accountsView} refresh={refreshAccounts} onNavigate={onNavigate} />
    </div>
  );
}

/** The account row under the numbers: the one discovery vector that fires at
 *  the moment of need (GH #278).
 *
 *  Someone opens this popover when they are near a limit, which is exactly
 *  when a second account becomes interesting. It is the only surface where
 *  that thought and this affordance meet, and it shows whichever of the two
 *  steps the user has not taken yet:
 *
 *    no second account  ->  add one
 *    a second account   ->  let termic move to it on its own
 *
 *  Never both, and never a disabled control for the step that is not reachable
 *  yet. An always-visible toggle that cannot do anything until some other
 *  thing exists teaches people to ignore the row.
 *
 *  It cannot be the ONLY vector, and that is why the agent card carries one
 *  too: this chip renders nothing until an account has actually reported
 *  usage, which today means claude and codex alone. The other six built-ins
 *  never show it. The footer pill carries the same toggle, for the user who
 *  reaches for the account menu rather than the numbers.
 */
function AccountRow({ agentId, view, refresh, onNavigate }: {
  agentId: string;
  view: AgentAccountsView | null;
  refresh: () => void;
  onNavigate: () => void;
}) {
  // Only the nudge toward a SECOND set. Once one exists the switcher section
  // below is the credentials UI, and the auto-switch checkbox lives there:
  // this row used to carry its own copy, and toggling one left the other
  // stale until something remounted it.
  if (!view || !view.supported || view.accounts.length >= 1) return null;

  return (
    <button
      type="button"
      data-testid="usage-add-credentials"
      onClick={() => {
        // Close first, then navigate: the panel is fixed-position and would
        // otherwise sit over the page it just opened. And carry the AGENT, so
        // Settings lands on the right card with the control focused.
        onNavigate();
        useApp.getState().openSettings("agents", undefined, `${agentId}:accounts`);
      }}
      className="w-full border-t border-[var(--color-border-soft)] px-3 py-2 text-left text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
    >
      Running low? Add a second account...
    </button>
  );
}

/** One window: name, percentage, its own full-width bar, and when it resets. */
function UsageRow({ label, sub, window: w, driving, level, source }: {
  label: string;
  sub: string;
  window: UsageWindow | null;
  /** Is this the window the chip's colour is about? Only that one is coloured
   *  here too, so the popover and the footer never disagree. */
  driving: boolean;
  level: UsageLevel;
  /** Which transport reported it. Decides what a MISSING window means, and
   *  the two meanings are not interchangeable. */
  source: UsageEntry["source"];
}) {
  // A window that is not here. Said in WORDS, because an omitted row reads as
  // a rendering bug, and the wording has to match the REASON.
  //
  // For codex it is a plan fact: a free plan genuinely has no session window
  // and never will, so "on this plan" is the useful thing to say.
  //
  // For claude it is never a plan fact. Claude always has both windows, so a
  // missing one means this particular payload did not carry it: measured, a
  // `used_percentage` of null (or a null `five_hour`) drops the window, and
  // the likely moment for that is just after the window resets. Telling a
  // Claude Max user their plan has no session limit is simply wrong, and it
  // is what this said until someone read it on their own screen.
  if (!w) {
    return (
      <div className="flex items-baseline justify-between text-[var(--color-fg-faint)]">
        <span>{label}</span>
        <span>{source === "rpc" ? "not reported on this plan" : "not in the last report"}</span>
      </div>
    );
  }
  const rowLevel = driving ? level : "normal";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[var(--color-fg)]">{label}</span>
        <span className={cn("tabular-nums", LEVEL_TEXT[rowLevel] ?? "text-[var(--color-fg-dim)]")}>
          {formatPercent(w)}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-3)]">
        <div
          className={cn("h-full rounded-full", LEVEL_FILL[rowLevel])}
          style={{ width: `${Math.max(2, Math.round(w.usedPercent))}%` }}
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[var(--color-fg-faint)]">
        <span>{sub}</span>
        <span>{formatReset(w) || "reset time not reported"}</span>
      </div>
    </div>
  );
}

/**
 * Shown when termic KNOWS the usage feed cannot run, never when it merely has
 * nothing yet.
 *
 * The whole point is that this failure is otherwise invisible: a project that
 * ships its own status line outranks termic's, so termic's script never runs,
 * no OSC is written, and the footer is empty with nothing logged anywhere. The
 * user is left to work out why one repo reports usage and another does not.
 *
 * Deliberately quiet: faint, no colour, no badge. It is an explanation for
 * someone who went looking, not a defect to be alarmed about, and the thing
 * blocking it is usually a status line the user wants more than this one.
 */
function BlockedChip({ owner, className }: { owner: StatusLineOwner; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="usage-blocked-chip"
          data-usage-owner={owner.owner}
          title="Plan usage is not being reported"
          className={cn(
            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5",
            "text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg-dim)]",
            className,
          )}
        >
          <CircleSlash className="h-3.5 w-3.5" />
          <span>usage n/a</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-0"
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <div data-testid="usage-blocked-detail" className="text-[12.5px]">
          <div className="border-b border-[var(--color-border-soft)] px-3 py-2 font-medium text-[var(--color-fg)]">
            Plan usage is not being reported
          </div>
          <div className="flex flex-col gap-2 px-3 py-2.5 text-[var(--color-fg-dim)]">
            <p>{blockedReason(owner)}</p>
            {/* Name the FILE. Without it the user has to go and find which of
                three settings files is in force, and the answer is not
                obvious: a local one outranks a committed one. */}
            <p className="break-all text-[var(--color-fg-faint)]">
              <code className="font-mono">{owner.path}</code>
            </p>
            <p>
              Termic reads plan usage from Claude's status line, so it gets
              nothing while another one is in place. Your own status line is
              left exactly as it is.
            </p>
          </div>
          <div className="border-t border-[var(--color-border-soft)] px-3 py-2">
            {/* The way out, as work someone else does. The user does not have
                to learn the wire format: they paste this at the agent that
                owns the script and it makes the edit. */}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(statusLineAgentPrompt(owner))
                  .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
                  .catch(() => {});
              }}
              className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-dim)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg)]"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy a prompt to fix it"}
            </button>
            <p className="mt-1 text-[12px] text-[var(--color-fg-faint)]">
              Paste it into the agent that owns that status line. It adds the
              reporting and changes nothing else.
            </p>
          </div>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/** Fill colour per level. Tokens only: a hex outside `@theme` in index.css is
 *  a theme that cannot be themed (CLAUDE.md).
 *
 *  `normal` is NEUTRAL, not green. This number only goes up, so green is not
 *  good news, and a window of green bars trains you to ignore the one that
 *  turns amber. */
const LEVEL_FILL: Record<UsageLevel, string> = {
  // `--color-fg-dim`, not `--color-fg-faint`: faint against the new track was
  // two greys a shade apart, which is not a reading you can take at a glance.
  normal:   "bg-[var(--color-fg-dim)]",
  warn:     "bg-[var(--color-warn)]",
  critical: "bg-[var(--color-err)]",
};

/** Text colour for the driving window's percentage. `normal` is undefined so
 *  it inherits, which is what keeps the quiet case quiet. */
const LEVEL_TEXT: Record<UsageLevel, string | undefined> = {
  normal:   undefined,
  warn:     "text-[var(--color-warn)]",
  critical: "text-[var(--color-err)]",
};

/**
 * The chip's fill bar.
 *
 * FIXED width, always, whatever the number: the track is the same width at 3%
 * and at 97%, and only the fill inside it moves. A bar sized to its value
 * would reflow the two percentages and the sandbox status beside it on every
 * turn, which in this footer is a visible twitch rather than a layout detail.
 *
 * No transition either. The value changes about once per turn, seconds apart,
 * so an animation has nothing to smooth: it would only ever be caught
 * mid-flight by a screenshot or by someone glancing over.
 */
/** One window's gauge and its number, as a single unit so they cannot drift
 *  apart on a reflow. The percentage takes the bar's colour, which is what
 *  makes a warn/critical bar unambiguous about which window it is about. */
function UsageWindowReadout({ window: w, unit, stale, testid }: {
  window: UsageWindow; unit: string; stale: boolean; testid: string;
}) {
  const level = usageLevel(w.usedPercent);
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-usage-window={testid}>
      <UsageBar percent={w.usedPercent} level={level} stale={stale} />
      <span className={LEVEL_TEXT[level]}>
        {formatPercent(w)} <Unit>{unit}</Unit>
      </span>
    </span>
  );
}

function UsageBar({ percent, level, stale }: {
  percent: number; level: UsageLevel; stale: boolean;
}) {
  return (
    <span
      aria-hidden
      // SHORT and THICK: 10px tall, 32px wide. It shares the chip with an
      // account name now, so length is the wrong axis to spend on, and a long
      // thin bar reads as a divider rather than as a gauge.
      //
      // The track is `--color-border`, not `--color-bg-3`: against the footer
      // the old track was nearly invisible, so a low percentage looked like a
      // bar that had failed to render rather than one that was nearly empty. A
      // gauge has to show its EMPTY part too, or the fill has nothing to be a
      // fraction of.
      // 24px, not the 32px this was when it was the only gauge on the chip:
      // there are two now, and width is the axis the footer is short of.
      className="h-2.5 w-6 shrink-0 overflow-hidden rounded-full bg-[var(--color-border)]"
    >
      <span
        data-testid="usage-bar-fill"
        className={cn("block h-full rounded-full", LEVEL_FILL[level], stale && "opacity-50")}
        // Width is genuinely dynamic, so it cannot be a Tailwind class. The
        // value was clamped to 0-100 on the way in, and is never a string from
        // the payload.
        //
        // Floored at 2% so a barely-used account still shows a sliver: an
        // empty track is indistinguishable from a bar that failed to render,
        // and the exact figure is spelled out in words right beside it.
        style={{ width: `${Math.max(2, Math.round(percent))}%` }}
      />
    </span>
  );
}

/** The unit beside a percentage, one step dimmer than the number.
 *
 *  The number is the DATA and the unit is the label, and at 12.5px in a footer
 *  they otherwise read as one four-character word.
 *
 *  OPACITY, not its own colour. A fixed `--color-fg-faint` kept the unit quiet
 *  in the wrong way: it did not brighten with the chip on hover, so pointing
 *  at the control made the numbers step forward and left "5h" and "wk"
 *  behind, and it was too dim to read at rest besides. Opacity subdues it
 *  RELATIVE to whatever the number is doing, which also keeps a unit from
 *  ever being the thing that turned amber or red. */
function Unit({ children }: { children: string }) {
  return <span className="opacity-70">{children}</span>;
}

function describeAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
