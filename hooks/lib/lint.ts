import type { Finding, FlowPlan, PlanNode } from '../../types'

// Design checks: pure rules over the plan tree. These are one maker's standards, not
// Microsoft rules: change them to match your own. Each source names the area of practice it encodes.
const RULES = 'flow-plan design rules'
export const SOURCES = {
  errors: `${RULES}: error handling`,
  performance: `${RULES}: performance and volume`,
  triggers: `${RULES}: triggers`,
  child: `${RULES}: child flows`,
} as const

const isLoop = (n: PlanNode) => /^(apply to each|for each|do until|until)\b/i.test(n.action)
const isScope = (n: PlanNode) => /^scope\b/i.test(n.action)
const isList = (n: PlanNode) => /^(list rows|get items)\b/i.test(n.action)
const isTerminate = (n: PlanNode) => /^terminate\b/i.test(n.action)
const isRespond = (n: PlanNode) => /^respond to a power ?apps? or flow\b/i.test(n.action)
const named = (n: PlanNode, word: string) => new RegExp(`\\b${word}\\b`, 'i').test(`${n.action} ${n.short}`)
// Everything the plan says about a node: its summary, note and inputs.
const said = (n: PlanNode) =>
  [n.short, n.details?.note ?? '', ...Object.entries(n.details?.inputs ?? {}).map(([k, v]) => `${k} ${v}`)].join(' ')

const RUN_AFTER_FAILURE = /fail|timed? ?out/i
const SINGLE = /\b(single|one) (record|row|item)\b|\bonly one\b/i
const TOP_ONE = /\b(top( count)?|row count|first)\s*[:=]?\s*1\b/i
const FILTERED = /filter|select|fetchxml|odata|query/i
const TRIGGER_FILTERED = /filter|condition|select columns|odata|where/i

type Visit = { node: PlanNode; path: string; loops: PlanNode[]; before: PlanNode | undefined }

// Every node depth-first with its path, the loops around it and the node before it in its branch.
const visit = (nodes: readonly PlanNode[], at = 'nodes', loops: PlanNode[] = []): Visit[] =>
  nodes.flatMap((node, i) => [
    { node, path: `${at}[${i}]`, loops, before: nodes[i - 1] },
    ...(node.branches ?? []).flatMap((b, j) =>
      visit(b.nodes, `${at}[${i}].branches[${j}].nodes`, isLoop(node) ? [...loops, node] : loops),
    ),
  ])

// The ends of every path: the last node, or inside each branch of a last Condition/Switch/Scope.
const ends = (nodes: readonly PlanNode[], at: string): { path: string; node?: PlanNode; before?: PlanNode }[] => {
  const i = nodes.length - 1
  const last = nodes[i]
  if (last === undefined) return [{ path: at }]
  const path = `${at}[${i}]`
  return (last.branches?.length ?? 0) > 0 && !isLoop(last)
    ? (last.branches ?? []).flatMap((b, j) => ends(b.nodes, `${path}.branches[${j}].nodes`))
    : [{ path, node: last, before: nodes[i - 1] }]
}

const find = (id: string, severity: Finding['severity'], path: string, message: string, source: string): Finding => ({
  id,
  severity,
  path,
  message,
  source,
})

type Plan = Pick<FlowPlan, 'title' | 'target' | 'trigger' | 'triggerConnector' | 'triggerKind' | 'nodes'>

export const lint = (plan: Plan): Finding[] => {
  const all = visit(plan.nodes)
  const scopes = all.filter(v => isScope(v.node))
  const catches = scopes.filter(v => named(v.node, 'catch'))

  const terminateInLoop = all
    .filter(v => isTerminate(v.node) && v.loops.length > 0)
    .map(v =>
      find(
        'PA-TERMINATE-IN-LOOP',
        'invalid',
        v.path,
        `Terminate inside ${v.loops.at(-1)?.action ?? 'a loop'} is invalid and the flow won't save: append the failure to an array variable in the loop, then Terminate after it`,
        SOURCES.errors,
      ),
    )

  const singleRecordLoop = all
    .filter(
      v =>
        isLoop(v.node) &&
        (SINGLE.test(said(v.node)) ||
          (v.before !== undefined && isList(v.before) && (SINGLE.test(said(v.before)) || TOP_ONE.test(said(v.before))))),
    )
    .map(v =>
      find(
        'PA-SINGLE-RECORD-LOOP',
        'warn',
        v.path,
        `${v.node.action} loops over a single record: set Row count/Top Count to 1 and use first(...) instead`,
        SOURCES.performance,
      ),
    )

  const nestedLoop = all
    .filter(v => isLoop(v.node) && v.loops.length > 0)
    .map(v =>
      find(
        'PA-NESTED-LOOP',
        'warn',
        v.path,
        `${v.node.action} is nested inside ${v.loops.at(-1)?.action ?? 'a loop'}: restructure with Filter array lookups`,
        SOURCES.performance,
      ),
    )

  const hasTryCatch =
    scopes.some(v => named(v.node, 'try')) && catches.some(v => RUN_AFTER_FAILURE.test(v.node.runAfter ?? ''))
  const noTryCatch = hasTryCatch
    ? []
    : [
        find(
          'PA-NO-TRY-CATCH',
          'warn',
          'nodes',
          'No Try scope with a Catch scope run after failed/timed out: wrap the actions in Scope - Try and add Scope - Catch (run after: has failed, has timed out)',
          SOURCES.errors,
        ),
      ]

  const catchRunAfter = catches
    .filter(v => !RUN_AFTER_FAILURE.test(v.node.runAfter ?? ''))
    .map(v =>
      find(
        'PA-CATCH-RUNAFTER',
        'warn',
        v.path,
        `${v.node.action} doesn't run after failed/timed out, so it never catches anything: set its run after to has failed, has timed out`,
        SOURCES.errors,
      ),
    )

  // Only once node details are present: without them the plan says nothing about filters.
  const listNoFilter = all
    .filter(v => isList(v.node) && v.node.details !== undefined && !FILTERED.test(said(v.node)))
    .map(v =>
      find(
        'PA-LIST-NO-FILTER',
        'warn',
        v.path,
        `${v.node.action} has no filter or select: set Filter rows/Filter Query and Select columns`,
        SOURCES.performance,
      ),
    )

  const triggerNoFilter =
    plan.triggerKind !== 'instant' &&
    /dataverse|common data service|sharepoint/i.test(plan.triggerConnector ?? '') &&
    !TRIGGER_FILTERED.test(plan.trigger)
      ? [
          find(
            'PA-TRIGGER-NO-FILTER',
            'warn',
            'trigger',
            `The ${plan.triggerConnector} trigger has no filter or trigger condition, so it runs for every change: filter at the trigger`,
            SOURCES.triggers,
          ),
        ]
      : []

  const isChild = [plan.title, plan.target.mode === 'create' ? plan.target.name : ''].some(t => /^\[child\]/i.test(t.trim()))
  const childNoRespond = isChild
    ? ends(plan.nodes, 'nodes')
        .filter(e => {
          const node = e.node
          if (node === undefined) return true
          return !(isRespond(node) || (isTerminate(node) && e.before !== undefined && isRespond(e.before)))
        })
        .map(e =>
          find(
            'PA-CHILD-NO-RESPOND',
            'warn',
            e.path,
            `This path of a child flow ends with ${e.node?.action ?? 'no action'}: end every path with "Respond to a PowerApp or flow" so the parent doesn't wait until it times out`,
            SOURCES.child,
          ),
        )
    : []

  return [
    ...terminateInLoop,
    ...singleRecordLoop,
    ...nestedLoop,
    ...noTryCatch,
    ...catchRunAfter,
    ...listNoFilter,
    ...triggerNoFilter,
    ...childNoRespond,
  ]
}
