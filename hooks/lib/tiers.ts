import type { FlowPlan, PlanNode, Tier } from '../../types'

// Compared ignoring case, spacing, a leading "Microsoft" and a bracketed suffix:
// "Dataverse" = "Microsoft Dataverse", "Excel Online" = "Excel Online (Business)".
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^microsoft /, '')

// Built-in connectors need no lookup.
const BUILTIN = new Set(
  [
    'Control',
    'Data Operation',
    'Data Operations',
    'Variables',
    'Schedule',
    'Date Time',
    'Number Functions',
    'Text Functions',
    'Flow button for mobile',
    'Manually trigger a flow',
    // The manual trigger's connector as the model names it; list_connectors has no row for it.
    'Manual',
    'Manual trigger',
  ].map(norm),
)
export const isBuiltin = (connector: string) => BUILTIN.has(norm(connector))

// Built into Power Automate but premium, and missing from list_connectors' catalogue.
// MS Learn: "The Premium HTTP connection is built into ... Power Automate"
// (https://learn.microsoft.com/training/modules/http-connectors/1-introduction).
// "When an HTTP request is received" (Request) is premium too: the Power Automate designer labels it
// Premium. The Microsoft Learn pages checked do not state its tier.
const PREMIUM_BUILTIN = new Set(['HTTP', 'HTTP + Swagger', 'Request'].map(norm))

// A tier the hook knows without a lookup, or undefined when list_connectors must answer.
export const knownTier = (connector: string): Tier | undefined =>
  isBuiltin(connector) ? 'builtin' : PREMIUM_BUILTIN.has(norm(connector)) ? 'premium' : undefined

// One row of list_connectors' result: { name, displayName, tier }.
export type ConnectorRow = { name?: unknown; displayName?: unknown; tier?: unknown }

const asTier = (tier: unknown): Tier => {
  const t = typeof tier === 'string' ? tier.toLowerCase() : ''
  return t === 'premium' || t === 'standard' || t === 'custom' ? t : 'unknown'
}

// The tier of a connector by name: the rows whose display name matches it must agree on one tier.
export const tierOf = (connector: string, rows: readonly ConnectorRow[]): Tier => {
  const want = norm(connector)
  const tiers = new Set(
    rows.filter(r => typeof r.displayName === 'string' && norm(r.displayName) === want).map(r => asTier(r.tier)),
  )
  const [only] = tiers
  return tiers.size === 1 && only !== undefined ? only : 'unknown'
}

// Every connector the plan names (trigger and nodes, branches included), once each.
export const connectorsOf = (plan: Pick<FlowPlan, 'triggerConnector' | 'nodes'>) => {
  const all = new Set<string>()
  const walk = (nodes: readonly PlanNode[]) =>
    nodes.forEach(n => {
      if (n.connector !== undefined && n.connector.trim() !== '') all.add(n.connector)
      n.branches?.forEach(b => walk(b.nodes))
    })
  if (plan.triggerConnector !== undefined && plan.triggerConnector.trim() !== '') all.add(plan.triggerConnector)
  walk(plan.nodes)
  return [...all]
}

// The plan's nodes and trigger with each named connector's tier written in.
export const withTiers = (plan: Pick<FlowPlan, 'triggerConnector' | 'nodes'>, tierFor: (connector: string) => Tier) => {
  const mark = (nodes: readonly PlanNode[]): PlanNode[] =>
    nodes.map(n => ({
      ...n,
      ...(n.connector === undefined || n.connector.trim() === '' ? {} : { tier: tierFor(n.connector) }),
      ...(n.branches === undefined ? {} : { branches: n.branches.map(b => ({ ...b, nodes: mark(b.nodes) })) }),
    }))
  return {
    nodes: mark(plan.nodes),
    ...(plan.triggerConnector === undefined || plan.triggerConnector.trim() === ''
      ? {}
      : { triggerTier: tierFor(plan.triggerConnector) }),
  }
}

// The engine's verdict on a list_connectors call, as far as the lookup reads it.
export type LookupVerdict = { decision: 'allow' | 'ask' | 'deny'; rule?: string; hook?: string; plugin?: string }

// The mod's own read-only lookup runs without asking: auto mode's classifier has no user request to judge a mod's
// call by, so it gives no verdict. A settings rule, a classic hook or another plugin's ask still decides; any other
// call (the model's, another plugin's, one not shown to be a read) keeps the verdict beneath.
export const lookupVerdict = <V extends LookupVerdict>(beneath: V, isOwnRead: boolean): V | { decision: 'allow' } =>
  !isOwnRead || beneath.rule !== undefined || beneath.hook !== undefined || beneath.plugin !== undefined
    ? beneath
    : { decision: 'allow' }

// The pane's quiet note when the lookup fails: one line, cut short.
export const tierNote = (reason: string) => {
  const line = reason.split('\n')[0]?.trim() ?? ''
  const cut = line.length > 160 ? `${line.slice(0, 157)}...` : line
  return `Connector tiers not looked up, so badges show ?. ${cut}`.trim()
}
