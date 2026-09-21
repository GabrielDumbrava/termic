/** The most agents whose chips can carry their full readout side by side.
 *  Two full chips are ~350px of an ~894px bar, which the 780px hide rule
 *  already covers; a third leaves no width for the account name and the
 *  sandbox status beside them, and a fifth ran the group off the end of the
 *  bar entirely. Measured in the e2e window, same as the 780 above it. */
export const FULL_CHIP_AGENT_LIMIT = 2;

/** How `id`'s footer chip renders, given every agent the task runs and the one
 *  whose tab is on screen. Pure so the shedding order is testable without a
 *  window: the ACTIVE agent always keeps its full chip, and secondary agents
 *  compact before anything is hidden, so the bar degrades by losing detail
 *  rather than by losing agents. */
export function footerChipMode(agentIds: readonly string[], activeAgent: string | undefined, id: string): {
  secondary: boolean;
  compact: boolean;
} {
  const secondary = agentIds.length > 1 && id !== activeAgent;
  return { secondary, compact: secondary && agentIds.length > FULL_CHIP_AGENT_LIMIT };
}
