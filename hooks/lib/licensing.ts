import type { Finding, FlowPlan, PlanNode, Tier } from '../../types'

// Licensing rules from MS Learn:
// https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs
// https://learn.microsoft.com/power-automate/error-reference#licensing-errors
const FAQ = 'https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs'

// The badge drawn beside a node of this tier; standard and built-in carry none.
export const badge = (tier: Tier | undefined) =>
  tier === 'premium' ? '◆ Premium' : tier === 'custom' ? 'Custom' : tier === 'unknown' ? '?' : undefined

const isPaid = (tier: Tier | undefined) => tier === 'premium' || tier === 'custom'
export const LICENCE_FINDING = 'LICENCE-PREMIUM-IN-STANDARD'

type Step = { path: string; label: string; connector?: string; tier?: Tier }

// The trigger, then every node depth-first through its branches, each with its path in the plan.
const steps = (plan: Pick<FlowPlan, 'trigger' | 'triggerConnector' | 'triggerTier' | 'nodes'>): Step[] => {
  const walk = (nodes: readonly PlanNode[], at: string): Step[] =>
    nodes.flatMap((n, i) => [
      { path: `${at}[${i}]`, label: n.action, connector: n.connector, tier: n.tier },
      ...(n.branches ?? []).flatMap((b, j) => walk(b.nodes, `${at}[${i}].branches[${j}].nodes`)),
    ])
  return [
    { path: 'trigger', label: `Trigger "${plan.trigger}"`, connector: plan.triggerConnector, tier: plan.triggerTier },
    ...walk(plan.nodes, 'nodes'),
  ]
}

// What the plan means for licences: a premium or custom connector anywhere needs Premium, for the
// owner of an automated or scheduled flow and for every user of an instant one (or a Process licence).
export const banners = (plan: Pick<FlowPlan, 'trigger' | 'triggerConnector' | 'triggerTier' | 'triggerKind' | 'nodes'>) => {
  if (!steps(plan).some(s => isPaid(s.tier))) return []
  return [
    ...(plan.triggerKind === 'automated' || plan.triggerKind === 'scheduled'
      ? ['Flow owner needs Power Automate Premium (or a Process licence on the flow).']
      : plan.triggerKind === 'instant'
        ? ['Every user who runs it needs Premium, or license the flow with a Process licence.']
        : []),
    'Microsoft 365 seeded licences cover standard connectors only.',
  ]
}

// In standard licence mode every premium or custom step is a finding that blocks Approve.
export const licenceFindings = (
  plan: Pick<FlowPlan, 'trigger' | 'triggerConnector' | 'triggerTier' | 'nodes'>,
  mode: 'premium' | 'standard',
): Finding[] =>
  mode !== 'standard'
    ? []
    : steps(plan)
        .filter(s => isPaid(s.tier))
        .map(s => ({
          id: LICENCE_FINDING,
          severity: 'invalid',
          path: s.path,
          message: `${s.label} uses ${s.connector ?? 'a connector'} (${s.tier}) but the licence mode is standard: switch the mode or change the design`,
          source: FAQ,
        }))
