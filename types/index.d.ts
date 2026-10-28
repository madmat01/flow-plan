export type Tier = 'builtin' | 'standard' | 'premium' | 'custom' | 'unknown'

export type PlanNode = {
  key?: string // the action name the model will use in the definition
  action: string
  connector?: string
  tier?: Tier // filled by the hook, never trusted from the model
  short: string
  runAfter?: string
  details?: {
    // shown by the pane's Details button; the design checks read them when present
    inputs?: Record<string, string>
    expressions?: string[]
    variables?: string[]
    note?: string
  }
  branches?: { label: string; nodes: PlanNode[] }[]
}
export type Finding = {
  id: string // rule id, e.g. "LICENCE-PREMIUM-IN-STANDARD"
  severity: 'invalid' | 'warn' // invalid = cannot be acknowledged
  path: string // e.g. "nodes[3].branches[0].nodes[1]"
  message: string
  source: string
}

export type PlanTarget =
  | { mode: 'create'; name: string; env?: string }
  | { mode: 'update'; flowId: string; env?: string }
export type FlowPlan = {
  title: string
  target: PlanTarget
  trigger: string
  triggerConnector?: string
  triggerTier?: Tier // filled by the hook
  triggerKind?: 'automated' | 'instant' | 'scheduled' // required by the tool schema
  nodes: PlanNode[]
  status: 'pending' | 'approved' | 'rejected' | 'built'
  builtFlowId?: string // set after create_flow; the gate reads it
  flowUrl?: string // maker-portal link after a create/update/edit
  rejectReason?: string // what the user typed when rejecting
  findings?: Finding[] // design checks at proposal time
  acknowledged?: string[] // rule ids of warn findings the user acknowledged
}

declare module 'claude-code' {
  interface PluginState {
    'flow-plan': {
      plans: Record<string, FlowPlan[]>
      active: string | null
      style: 'designer' | 'cards'
      notice: string | null // pane warning, e.g. Approve couldn't notify the session
      tierNote: string | null // quiet pane note when the tier lookup failed
      licenceMode: 'premium' | 'standard' // standard = standard and built-in connectors only
      rejecting: boolean // the pane shows the reject reason Input
      showDetails: boolean // the pane draws each node's details
    }
  }
}
