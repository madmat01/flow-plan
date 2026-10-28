import type { FlowPlan, PlanTarget } from '../../types'

export type Plans = Record<string, FlowPlan[]>

// Flow key: one approval per flow. create:<name lower-cased, trimmed> | update:<flowId>
export const flowKey = (t: PlanTarget) =>
  t.mode === 'create' ? `create:${t.name.trim().toLowerCase()}` : `update:${t.flowId}`

export const isTarget = (t: unknown): t is PlanTarget => {
  const o = (t ?? {}) as Record<string, unknown>
  if (o.env !== undefined && typeof o.env !== 'string') return false
  return o.mode === 'create'
    ? typeof o.name === 'string' && o.name.trim() !== ''
    : o.mode === 'update' && typeof o.flowId === 'string' && o.flowId.trim() !== ''
}

// New version appended under its flow key; other flows untouched.
export const appendPlan = (plans: Plans, plan: FlowPlan): Plans => {
  const key = flowKey(plan.target)
  return { ...plans, [key]: [...(plans[key] ?? []), plan] }
}

export const patchVersion = (plans: Plans, key: string, index: number, patch: Partial<FlowPlan>): Plans => {
  const versions = plans[key]
  if (versions?.[index] === undefined) return plans
  return { ...plans, [key]: versions.map((p, i) => (i === index ? { ...p, ...patch } : p)) }
}

export const setStatus = (plans: Plans, key: string, index: number, status: FlowPlan['status']): Plans =>
  patchVersion(plans, key, index, { status })

// Approve the drawn version. isNew: this press moved the latest version from pending or rejected to approved.
// A built version stays built: its approval was used up by create_flow.
export const approve = (plans: Plans, key: string, index: number) => {
  const versions = plans[key] ?? []
  const was = versions[index]?.status
  if (was === 'built') return { plans, isNew: false }
  const isNew = (was === 'pending' || was === 'rejected') && index === versions.length - 1
  return { plans: setStatus(plans, key, index, 'approved'), isNew }
}

export const targetLabel = (t: PlanTarget) =>
  `${t.mode === 'create' ? `New flow: ${t.name}` : `Update: ${t.flowId}`}${t.env ? ` (env ${t.env})` : ''}`

// A build tool's call as the gate reads it: the envelope's tool name plus the arguments it checks.
export type BuildCall = { tool: string; name?: unknown; flow?: unknown; env?: unknown; targetEnv?: unknown }

const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const toolName = (call: BuildCall) => call.tool.slice(call.tool.lastIndexOf('__') + 2)

// The flow a build call writes to, and the key of the plan that covers it: the call's own key, or for an
// update the create plan that built that flow ID.
const match = (plans: Plans, call: BuildCall) => {
  const isUpdate = ['update_flow', 'edit_flow'].includes(toolName(call))
  const id = text(isUpdate ? call.flow : call.name)
  if (id === undefined) return { isUpdate }
  const want: PlanTarget = isUpdate ? { mode: 'update', flowId: id } : { mode: 'create', name: id }
  const own = flowKey(want)
  const built = isUpdate
    ? Object.keys(plans).find(k => k.startsWith('create:') && plans[k]?.at(-1)?.builtFlowId === id)
    : undefined
  const key = (plans[own]?.length ?? 0) > 0 ? own : built
  return { isUpdate, want, key, isBuiltMatch: key !== undefined && key === built }
}

// The version a build call is checked against, so its result can be written back to that version.
export const planFor = (plans: Plans, call: BuildCall) => {
  const { key } = match(plans, call)
  const index = key === undefined ? -1 : (plans[key]?.length ?? 0) - 1
  return key === undefined || index < 0 ? undefined : { key, index }
}

// Why the gate blocks a build call, or null to let it through: the call must name the flow of an approved plan.
export const blockReason = (plans: Plans, active: string | null, call: BuildCall): string | null => {
  const { isUpdate, want, key, isBuiltMatch } = match(plans, call)
  if (want === undefined) {
    return isUpdate ? 'the call has no flow ID' : 'pass an explicit name so the call can be matched to an approved plan'
  }

  const plan = key === undefined ? undefined : plans[key]?.at(-1)
  if (plan === undefined) {
    const shown = active === null ? undefined : plans[active]?.at(-1)
    if (shown?.status === 'approved') {
      return `the approved plan is for "${targetLabel(shown.target)}", not "${targetLabel(want)}"`
    }
    return Object.keys(plans).length === 0
      ? 'no plan has been shown yet: call propose_flow_plan first'
      : `no plan has been proposed for "${targetLabel(want)}": call propose_flow_plan with that target first`
  }

  const label = targetLabel(plan.target)
  if (plan.status === 'pending') return `the plan for "${label}" is awaiting approval in the Flow plan pane`
  if (plan.status === 'rejected') {
    return `the user rejected the plan for "${label}": revise it and call propose_flow_plan again`
  }
  if (plan.status === 'built' && !isBuiltMatch) return `"${label}" was already built from this approval: propose a new plan`

  // copy_flow writes the new flow to targetEnv, which defaults to env.
  const env = toolName(call) === 'copy_flow' ? (text(call.targetEnv) ?? text(call.env)) : text(call.env)
  const planned = plan.target.env
  if (planned === undefined || env === planned) return null
  return env === undefined
    ? `the approved plan is for environment "${planned}": pass env "${planned}"`
    : `the approved plan is for environment "${planned}", not "${env}"`
}

// create_flow's result text is JSON whose `name` is the new flow's ID.
export const parseFlowId = (result: string | undefined) => {
  try {
    return text((JSON.parse(result ?? '') as { name?: unknown } | null)?.name)
  } catch {
    return undefined
  }
}

export const flowUrl = (env: string, flowId: string) =>
  `https://make.powerautomate.com/environments/${encodeURIComponent(env)}/flows/${encodeURIComponent(flowId)}/details`

// What a successful build writes back to its plan, and the line the model reads with the result.
// create_flow uses up its approval; copy_flow is left alone (its result shape is unknown).
export const afterBuild = (call: BuildCall, result: string | undefined) => {
  const tool = toolName(call)
  if (tool === 'copy_flow') return undefined
  const isCreate = tool === 'create_flow'
  const flowId = isCreate ? parseFlowId(result) : text(call.flow)
  const env = text(call.env)
  const url = flowId === undefined || env === undefined ? undefined : flowUrl(env, flowId)
  const patch: Partial<FlowPlan> = {
    ...(isCreate ? { status: 'built' as const } : {}),
    ...(isCreate && flowId !== undefined ? { builtFlowId: flowId } : {}),
    ...(url === undefined ? {} : { flowUrl: url }),
  }
  const context =
    url !== undefined
      ? `Flow link: ${url}`
      : flowId === undefined
        ? "no flow link: the new flow's ID could not be read from the result, so updates need a new plan"
        : 'no flow link: the call named no environment'
  return { patch, context, warning: isCreate && flowId === undefined ? 'flow ID unknown — updates need a new plan' : undefined }
}
