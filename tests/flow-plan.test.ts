import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, Plugin } from 'claude-code/testing'

import {
  afterBuild,
  appendPlan,
  approve,
  blockReason,
  flowKey,
  flowUrl,
  parseFlowId,
  planFor,
  setStatus,
} from '../hooks/lib/plans'
import type { Plans } from '../hooks/lib/plans'
import { badge, banners, licenceFindings } from '../hooks/lib/licensing'
import { altText, escapeXml, flowSvg, layout, MAX_SVG, toSvg } from '../hooks/lib/flow-svg'
import type { Ctx } from '../hooks/lib/flow-svg'
import { lint } from '../hooks/lib/lint'
import { connectorsOf, isBuiltin, knownTier, lookupVerdict, tierNote, tierOf, withTiers } from '../hooks/lib/tiers'
import type { ConnectorRow } from '../hooks/lib/tiers'
import type { FlowPlan, PlanNode, PlanTarget, Tier } from '../types'

const TOOL = 'mcp__flow-plan__propose_flow_plan' as const
const PANE = {
  component: 'Pane',
  requestId: 'flow-plan',
  props: { title: 'Flow plan', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
} as const

// The test's $ has no state noun: an inline plugin reads the mod's state back through a command.
const probe: Plugin = {
  name: 'probe',
  register(on) {
    on('command.run', { command: 'probe' }, async ($, e) => {
      const { value } =
        e.args === 'active'
          ? await $.state.get({ plugin: 'flow-plan', key: 'active' })
          : await $.state.get({ plugin: 'flow-plan', key: 'plans' })
      return { text: JSON.stringify(value ?? null) }
    })
  },
}

const plan = (title: string, target: PlanTarget): FlowPlan => ({
  title,
  target,
  trigger: 'When a row is added - Accounts',
  triggerKind: 'automated',
  nodes: [{ action: 'Send an email', connector: 'Office 365 Outlook', short: 'Owner' }],
  status: 'pending',
})
// propose_flow_plan's call for a plan, with the arguments the model sends.
const proposal = (p: FlowPlan) => ({
  tool: TOOL,
  title: p.title,
  target: p.target,
  trigger: p.trigger,
  ...(p.triggerConnector === undefined ? {} : { triggerConnector: p.triggerConnector }),
  triggerKind: p.triggerKind,
  nodes: p.nodes,
})

const LIST = 'mcp__plugin_power-automate_flowagent__list_connectors'
// A slice of list_connectors' real catalogue (2026-10-09), filtered by query on name or display name as the tool does.
const CATALOG = [
  { name: 'shared_office365', displayName: 'Office 365 Outlook', tier: 'Standard' },
  { name: 'shared_outlook', displayName: 'Outlook.com', tier: 'Standard' },
  { name: 'shared_a365outlookmailmcp', displayName: 'Work IQ Mail MCP', tier: 'Premium' },
  { name: 'shared_commondataserviceforapps', displayName: 'Microsoft Dataverse', tier: 'Premium' },
  { name: 'shared_commondataservice', displayName: 'Microsoft Dataverse', tier: 'Premium' },
  { name: 'shared_teams', displayName: 'Microsoft Teams', tier: 'Standard' },
]
const catalog = (e: unknown) => {
  const q = String((e as { query?: unknown }).query ?? '').toLowerCase()
  const rows = CATALOG.filter(r => r.name.includes(q) || r.displayName.toLowerCase().includes(q))
  return { result: 'ok', text: JSON.stringify(rows) } as never
}
const X: PlanTarget = { mode: 'create', name: '  Expiry Notice ' }
const Y = { mode: 'update', flowId: '1b2c3d4e-0000-4000-8000-000000000001' } as const satisfies PlanTarget

describe('flow key', () => {
  test('create keys on the trimmed, lower-cased name; update on the flow ID', async () => {
    expect(flowKey(X)).toBe('create:expiry notice')
    expect(flowKey({ mode: 'create', name: 'expiry NOTICE' })).toBe('create:expiry notice')
    expect(flowKey(Y)).toBe('update:1b2c3d4e-0000-4000-8000-000000000001')
  })
})

describe('append', () => {
  test('a second proposal for one flow is a new version; another flow gets its own key', async () => {
    const one = appendPlan({}, plan('X v1', X))
    const two = appendPlan(one, plan('X v2', X))
    const three = appendPlan(two, plan('Y v1', Y))
    expect(Object.keys(three).sort()).toEqual([flowKey(X), flowKey(Y)].sort())
    expect(three[flowKey(X)]?.map(p => p.title)).toEqual(['X v1', 'X v2'])
    expect(three[flowKey(Y)]?.map(p => p.title)).toEqual(['Y v1'])
    expect(one[flowKey(X)]?.length).toBe(1)
  })

  test('setStatus changes only the version it names', async () => {
    const all = appendPlan(appendPlan(appendPlan({}, plan('X v1', X)), plan('X v2', X)), plan('Y v1', Y))
    const out = setStatus(all, flowKey(X), 0, 'approved')
    expect(out[flowKey(X)]?.map(p => p.status)).toEqual(['approved', 'pending'])
    expect(out[flowKey(Y)]?.[0]?.status).toBe('pending')
    expect(setStatus(all, 'update:nope', 0, 'approved')).toBe(all)
  })
})

const read = async ($: Engine, what: 'plans' | 'active') => {
  const out = (await $.command.run({ command: 'probe', args: what, origin: 'user' } as never)) as { text: string }
  return JSON.parse(out.text) as unknown
}

test(
  'two proposals make two keys; the pane shows the latest; Approve touches only that flow',
  { plugins: [probe] },
  async ($, on) => {
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('ui.render', async () => h('Text', null, 'engine') as never)
    on('tool.call', { tool: LIST }, async (_$, e) => catalog(e))

    const first = await $.tool.call(proposal(plan('Expiry notice', X)))
    const second = await $.tool.call(proposal(plan('Fix approvals', Y)))
    expect(first.deny).toBeUndefined()
    expect(second.deny).toBeUndefined()

    const stored = (await read($, 'plans')) as Record<string, FlowPlan[]>
    expect(Object.keys(stored).sort()).toEqual([flowKey(X), flowKey(Y)].sort())
    const expected = plan('Expiry notice', X)
    expect(stored[flowKey(X)]).toEqual([
      {
        ...expected,
        nodes: expected.nodes.map(n => ({ ...n, tier: 'standard' as const })),
        findings: [expect.objectContaining({ id: 'PA-NO-TRY-CATCH', severity: 'warn', path: 'nodes' })],
      },
    ])
    expect(await read($, 'active')).toBe(flowKey(Y))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'flow-plan', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: 'Fix approvals' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `Update: ${Y.flowId}` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Expiry notice' })).toBeUndefined()
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
    await ui.press({ key: 'acknowledge' })
    await ui.press({ key: 'approve' })
    expect(await ui.find({ type: 'Text', text: '[approved]' })).toBeDefined()
    await ui.unmount()

    const after = (await read($, 'plans')) as Record<string, FlowPlan[]>
    expect(after[flowKey(Y)]?.[0]?.status).toBe('approved')
    expect(after[flowKey(X)]?.[0]?.status).toBe('pending')
  },
)

test('a proposal without a valid target is refused and stores nothing', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  const out = await $.tool.call({ tool: TOOL, title: 'No target', trigger: 'Manual', nodes: [] })
  expect(out.deny).toMatch(/target is missing or invalid/)
  const blank = { mode: 'create', name: ' ' }
  const bad = await $.tool.call({ tool: TOOL, title: 'Blank', target: blank, trigger: 'Manual', nodes: [] })
  expect(bad.deny).toMatch(/target is missing or invalid/)
  expect(await read($, 'plans')).toBeNull()
})

const FA = 'mcp__plugin_power-automate_flowagent__'
const CREATE = `${FA}create_flow`
const UPDATE = `${FA}update_flow`
const EDIT = `${FA}edit_flow`
const COPY = `${FA}copy_flow`
const OTHER_ID = '9f9f9f9f-0000-4000-8000-000000000009'

// One flow's plan, with the given status (and extra fields).
const only = (target: PlanTarget, status: FlowPlan['status'], extra: Partial<FlowPlan> = {}): Plans => ({
  [flowKey(target)]: [{ ...plan('Some flow', target), status, ...extra }],
})

describe('gate', () => {
  test('approved plan for X: create X passes; create Y and update of an unrelated flow are denied', async () => {
    const all = only(X, 'approved')
    const key = flowKey(X)
    expect(blockReason(all, key, { tool: CREATE, name: 'expiry notice' })).toBeNull()
    expect(blockReason(all, key, { tool: CREATE, name: 'Other flow' })).toBe(
      'the approved plan is for "New flow:   Expiry Notice ", not "New flow: Other flow"',
    )
    expect(blockReason(all, key, { tool: UPDATE, flow: OTHER_ID })).toBe(
      `the approved plan is for "New flow:   Expiry Notice ", not "Update: ${OTHER_ID}"`,
    )
    expect(blockReason(all, key, { tool: EDIT, flow: OTHER_ID })).toMatch(/^the approved plan is for/)
  })

  test('update and edit pass on an approved update plan for that flow ID', async () => {
    const all = only(Y, 'approved')
    expect(blockReason(all, flowKey(Y), { tool: UPDATE, flow: Y.flowId })).toBeNull()
    expect(blockReason(all, flowKey(Y), { tool: EDIT, flow: Y.flowId })).toBeNull()
    expect(blockReason(all, flowKey(Y), { tool: CREATE, name: 'Fix approvals' })).toMatch(/^the approved plan is for/)
  })

  test('the matched plan decides even when another flow is on show', async () => {
    const all = { ...only(X, 'approved'), ...only(Y, 'pending') }
    expect(blockReason(all, flowKey(Y), { tool: CREATE, name: 'Expiry Notice' })).toBeNull()
    expect(blockReason(all, flowKey(Y), { tool: UPDATE, flow: Y.flowId })).toBe(
      `the plan for "Update: ${Y.flowId}" is awaiting approval in the Flow plan pane`,
    )
  })

  test('none, pending, rejected and unmatched give their own reasons', async () => {
    const call = { tool: CREATE, name: 'Expiry Notice' }
    expect(blockReason({}, null, call)).toBe('no plan has been shown yet: call propose_flow_plan first')
    expect(blockReason(only(X, 'pending'), flowKey(X), call)).toMatch(/is awaiting approval/)
    expect(blockReason(only(X, 'rejected'), flowKey(X), call)).toMatch(/^the user rejected the plan for/)
    expect(blockReason(only(Y, 'pending'), flowKey(Y), call)).toBe(
      'no plan has been proposed for "New flow: Expiry Notice": call propose_flow_plan with that target first',
    )
  })

  test('the latest version decides', async () => {
    const all = appendPlan(only(X, 'approved'), plan('X v2', X))
    expect(blockReason(all, flowKey(X), { tool: CREATE, name: 'Expiry Notice' })).toMatch(/is awaiting approval/)
  })

  test('copy_flow is matched by its new name and must pass one', async () => {
    const all = only(X, 'approved')
    expect(blockReason(all, flowKey(X), { tool: COPY, flow: OTHER_ID, name: 'Expiry Notice' })).toBeNull()
    expect(blockReason(all, flowKey(X), { tool: COPY, flow: OTHER_ID })).toBe(
      'pass an explicit name so the call can be matched to an approved plan',
    )
    expect(blockReason(all, flowKey(X), { tool: UPDATE, flow: ' ' })).toBe('the call has no flow ID')
  })

  test('a plan with an env only passes calls to that env', async () => {
    const target: PlanTarget = { mode: 'create', name: 'Expiry Notice', env: 'env-a' }
    const all = only(target, 'approved')
    const key = flowKey(target)
    expect(blockReason(all, key, { tool: CREATE, name: 'Expiry Notice', env: 'env-a' })).toBeNull()
    expect(blockReason(all, key, { tool: CREATE, name: 'Expiry Notice', env: 'env-b' })).toBe(
      'the approved plan is for environment "env-a", not "env-b"',
    )
    expect(blockReason(all, key, { tool: CREATE, name: 'Expiry Notice' })).toBe(
      'the approved plan is for environment "env-a": pass env "env-a"',
    )
    // copy_flow lands in targetEnv when given, else env.
    const copy = { tool: COPY, flow: OTHER_ID, name: 'Expiry Notice' }
    expect(blockReason(all, key, { ...copy, env: 'env-b', targetEnv: 'env-a' })).toBeNull()
    expect(blockReason(all, key, { ...copy, env: 'env-a', targetEnv: 'env-b' })).toMatch(/not "env-b"/)
    expect(blockReason(only(X, 'approved'), flowKey(X), { tool: CREATE, name: 'Expiry Notice', env: 'any' })).toBeNull()
  })

  test('a built create plan allows updates to the built flow ID only, and no second create', async () => {
    const all = only(X, 'built', { builtFlowId: OTHER_ID })
    expect(blockReason(all, flowKey(X), { tool: UPDATE, flow: OTHER_ID })).toBeNull()
    expect(blockReason(all, flowKey(X), { tool: EDIT, flow: OTHER_ID })).toBeNull()
    expect(blockReason(all, flowKey(X), { tool: UPDATE, flow: Y.flowId })).toMatch(/^no plan has been proposed for/)
    expect(blockReason(all, flowKey(X), { tool: CREATE, name: 'Expiry Notice' })).toBe(
      '"New flow:   Expiry Notice " was already built from this approval: propose a new plan',
    )
    // A newer update plan for that flow ID decides over the built approval.
    const revised = { ...all, ...only({ mode: 'update', flowId: OTHER_ID }, 'pending') }
    expect(blockReason(revised, flowKey(X), { tool: UPDATE, flow: OTHER_ID })).toMatch(/is awaiting approval/)
  })
})

test('through the engine: only the approved flow reaches the build tool', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  const reached: string[] = []
  // Stands in for the flowagent MCP tools beneath the gate.
  on('tool.call', async (_$, e) => {
    if (e.tool === LIST) return catalog(e)
    const args = e as unknown as { name?: unknown; flow?: unknown }
    reached.push(`${e.tool}:${String(args.name ?? args.flow)}`)
    return { result: 'ok' } as never
  })

  const none = await $.tool.call({ tool: CREATE, name: 'Expiry Notice', definition: {} })
  expect(none.deny).toBe('flow-plan: build blocked, no plan has been shown yet: call propose_flow_plan first.')

  const p = plan('Expiry notice', X)
  await $.tool.call(proposal(p))
  const pending = await $.tool.call({ tool: CREATE, name: 'Expiry Notice', definition: {} })
  expect(pending.deny).toMatch(/awaiting approval/)

  const ui = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  await ui.press({ key: 'acknowledge' })
  await ui.press({ key: 'approve' })
  await ui.unmount()

  const wrongName = await $.tool.call({ tool: CREATE, name: 'Other flow', definition: {} })
  expect(wrongName.deny).toBe(
    'flow-plan: build blocked, the approved plan is for "New flow:   Expiry Notice ", not "New flow: Other flow".',
  )
  const wrongId = await $.tool.call({ tool: UPDATE, flow: OTHER_ID, definition: {} })
  expect(wrongId.deny).toMatch(/^flow-plan: build blocked, the approved plan is for/)
  const ok = await $.tool.call({ tool: CREATE, name: 'expiry notice', definition: {} })
  expect(ok.deny).toBeUndefined()
  // scaffold_flow writes nothing, so the gate no longer stops it.
  const scaffold = await $.tool.call({ tool: `${FA}scaffold_flow`, name: 'Other flow' })
  expect(scaffold.deny).toBeUndefined()

  expect(reached).toEqual([`${CREATE}:expiry notice`, `${FA}scaffold_flow:Other flow`])
})

describe('approve', () => {
  test('only a press that moves the latest version from pending or rejected to approved is new', async () => {
    const one = appendPlan({}, plan('Y v1', Y))
    const first = approve(one, flowKey(Y), 0)
    expect(first.isNew).toBe(true)
    expect(first.plans[flowKey(Y)]?.[0]?.status).toBe('approved')
    expect(approve(first.plans, flowKey(Y), 0).isNew).toBe(false)
    expect(approve(setStatus(one, flowKey(Y), 0, 'rejected'), flowKey(Y), 0).isNew).toBe(true)
    const built = setStatus(one, flowKey(Y), 0, 'built')
    expect(approve(built, flowKey(Y), 0)).toEqual({ plans: built, isNew: false })
  })

  test('a stale version is not new, though its status is still set as drawn', async () => {
    const two = appendPlan(appendPlan({}, plan('Y v1', Y)), plan('Y v2', Y))
    const stale = approve(two, flowKey(Y), 0)
    expect(stale.isNew).toBe(false)
    expect(stale.plans[flowKey(Y)]?.map(p => p.status)).toEqual(['approved', 'pending'])
  })
})

// Proposes Y, mounts the pane and records each prompt the plugin submits; `answer` stands for the session.
const approvals = async ($: Engine, on: On, answer: (text: string) => Promise<unknown>) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  const sent: { text: string; asUser: unknown }[] = []
  on('prompt.submit', async (_$, e) => {
    sent.push({ text: e.text, asUser: (e.origin as { asUser?: unknown } | undefined)?.asUser })
    return (await answer(e.text)) as never
  })
  const p = plan('Fix approvals', Y)
  await $.tool.call(proposal(p))
  const ui = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  // The plan has no Try/Catch: its design warning is acknowledged so Approve isn't blocked.
  await ui.press({ key: 'acknowledge' })
  return { sent, ui }
}

test('Approve tells the session once per approval; a second press and Reject tell it nothing', { plugins: [probe] }, async ($, on) => {
  const { sent, ui } = await approvals($, on, async text => ({ text }))
  const message = { text: `Flow plan "Fix approvals" approved for Update: ${Y.flowId}. Build it now.`, asUser: true }
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'approve' })
  // Reject with no reason: rejected, nothing sent.
  await ui.press({ key: 'reject' })
  await ui.input({ key: 'reason', text: '' })
  expect(sent).toEqual([message])
  // Changing your mind after a Reject is a new approval.
  await ui.press({ key: 'approve' })
  expect(sent).toEqual([message, message])
  expect(await ui.find({ type: 'Text', text: '[approved]' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /session wasn't notified/ })).toBeUndefined()
  await ui.unmount()
})

for (const [how, answer, reason] of [
  // The engine skips a hook that throws; with nothing beneath it the submit rejects.
  ['rejects', async () => Promise.reject(new Error('session closed')), 'no implementation for prompt.submit'],
  ['drops it', async () => ({ drop: 'blocked by a prompt hook' }), 'blocked by a prompt hook'],
] as const) {
  test(`when the submit ${how}, the plan stays approved and the pane says so`, { plugins: [probe] }, async ($, on) => {
    const { sent, ui } = await approvals($, on, answer)
    await ui.press({ key: 'approve' })
    expect(sent.length).toBe(1)
    expect(await ui.find({ type: 'Text', text: '[approved]' })).toBeDefined()
    const message = `approved, but the session wasn't notified: ${reason} — tell Claude in chat`
    expect(await ui.find({ type: 'Text', text: message })).toBeDefined()
    await ui.unmount()
    const after = (await read($, 'plans')) as Record<string, FlowPlan[]>
    expect(after[flowKey(Y)]?.[0]?.status).toBe('approved')
  })
}

const NEW_ID = '7a7a7a7a-0000-4000-8000-000000000007'
const ENV = '00000000-0000-4000-8000-00000000e0e1'
// create_flow's result text as a real call returns it.
const created = JSON.stringify({ name: NEW_ID, displayName: 'Expiry Notice', state: 'Stopped', createdTime: '2026-10-09' })
const link = (id: string) => `https://make.powerautomate.com/environments/${ENV}/flows/${id}/details`

describe('after a build', () => {
  test("the flow ID is read from create_flow's result text", async () => {
    expect(parseFlowId(created)).toBe(NEW_ID)
    expect(parseFlowId('{"code":"tool-error"}')).toBeUndefined()
    expect(parseFlowId('created')).toBeUndefined()
    expect(parseFlowId('null')).toBeUndefined()
    expect(parseFlowId(undefined)).toBeUndefined()
  })

  test('the link is the maker-portal details page for that env and flow', async () => {
    expect(flowUrl(ENV, NEW_ID)).toBe(
      'https://make.powerautomate.com/environments/00000000-0000-4000-8000-00000000e0e1/flows/7a7a7a7a-0000-4000-8000-000000000007/details',
    )
  })

  test('create uses up the approval and links the new flow; no env or no ID means no link', async () => {
    expect(afterBuild({ tool: CREATE, name: 'Expiry Notice', env: ENV }, created)).toEqual({
      patch: { status: 'built', builtFlowId: NEW_ID, flowUrl: link(NEW_ID) },
      context: `Flow link: ${link(NEW_ID)}`,
      warning: undefined,
    })
    expect(afterBuild({ tool: CREATE, name: 'Expiry Notice' }, created)).toEqual({
      patch: { status: 'built', builtFlowId: NEW_ID },
      context: 'no flow link: the call named no environment',
      warning: undefined,
    })
    expect(afterBuild({ tool: CREATE, name: 'Expiry Notice', env: ENV }, 'created')).toEqual({
      patch: { status: 'built' },
      context: "no flow link: the new flow's ID could not be read from the result, so updates need a new plan",
      warning: 'flow ID unknown — updates need a new plan',
    })
  })

  test('update and edit link the flow they name; copy_flow is left alone', async () => {
    expect(afterBuild({ tool: UPDATE, flow: OTHER_ID, env: ENV }, '{}')).toEqual({
      patch: { flowUrl: link(OTHER_ID) },
      context: `Flow link: ${link(OTHER_ID)}`,
      warning: undefined,
    })
    expect(afterBuild({ tool: EDIT, flow: OTHER_ID }, '{}')).toEqual({
      patch: {},
      context: 'no flow link: the call named no environment',
      warning: undefined,
    })
    expect(afterBuild({ tool: COPY, flow: OTHER_ID, name: 'Expiry Notice', env: ENV }, created)).toBeUndefined()
  })

  test('planFor names the version the gate checked, including the built create plan for an update', async () => {
    const all = appendPlan(only(X, 'approved'), plan('X v2', X))
    expect(planFor(all, { tool: CREATE, name: 'expiry notice' })).toEqual({ key: flowKey(X), index: 1 })
    const built = only(X, 'built', { builtFlowId: NEW_ID })
    expect(planFor(built, { tool: UPDATE, flow: NEW_ID })).toEqual({ key: flowKey(X), index: 0 })
    expect(planFor(built, { tool: UPDATE, flow: OTHER_ID })).toBeUndefined()
  })
})

// Proposes a plan for a new flow "Expiry Notice" (no env) and approves it in the pane.
const approvedCreate = async ($: Engine, on: On) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  const target: PlanTarget = { mode: 'create', name: 'Expiry Notice' }
  const p = plan('Expiry notice', target)
  await $.tool.call(proposal(p))
  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  await pane.press({ key: 'acknowledge' })
  await pane.press({ key: 'approve' })
  const latest = async () => ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.[0]
  return { pane, latest }
}

test('through the engine: create is linked and used up; updates stay allowed; a failed build adds nothing', { plugins: [probe] }, async ($, on) => {
  let fail = false
  // Stands in for the flowagent tools: create_flow answers with a real call's result text.
  on('tool.call', async (_$, e) =>
    e.tool === LIST
      ? catalog(e)
      : ((fail
          ? { result: 'error', text: '{"code":"tool-error"}', isError: true }
          : { result: 'ok', text: e.tool === CREATE ? created : '{}' }) as never),
  )
  const { pane, latest } = await approvedCreate($, on)

  fail = true
  const failed = await $.tool.call({ tool: CREATE, name: 'Expiry Notice', env: ENV, definition: {} })
  expect(failed.isError).toBe(true)
  expect(failed.context).toBeUndefined()
  expect((await latest())?.status).toBe('approved')
  fail = false

  const ok = await $.tool.call({ tool: CREATE, name: 'Expiry Notice', env: ENV, definition: {} })
  expect(ok.deny).toBeUndefined()
  expect(ok.context).toContain(`Flow link: ${link(NEW_ID)}`)
  expect(await latest()).toMatchObject({ status: 'built', builtFlowId: NEW_ID, flowUrl: link(NEW_ID) })
  expect((await pane.find({ type: 'Link' }))?.props.href).toBe(link(NEW_ID))
  expect(await pane.find({ type: 'Text', text: '[built]' })).toBeDefined()

  // Approve on a built plan doesn't reopen it.
  await pane.press({ key: 'approve' })
  expect((await latest())?.status).toBe('built')
  await pane.unmount()

  const again = await $.tool.call({ tool: CREATE, name: 'Expiry Notice', env: ENV, definition: {} })
  expect(again.deny).toBe(
    'flow-plan: build blocked, "New flow: Expiry Notice" was already built from this approval: propose a new plan.',
  )
  const updated = await $.tool.call({ tool: UPDATE, flow: NEW_ID, env: ENV, definition: {} })
  expect(updated.deny).toBeUndefined()
  expect(updated.context).toContain(`Flow link: ${link(NEW_ID)}`)
  const edited = await $.tool.call({ tool: EDIT, flow: NEW_ID, operations: [] })
  expect(edited.deny).toBeUndefined()
  expect(edited.context).toContain('no flow link: the call named no environment')
})

test('through the engine: a create whose flow ID cannot be read is still built, and the pane says so', { plugins: [probe] }, async ($, on) => {
  on('tool.call', async (_$, e) => (e.tool === LIST ? catalog(e) : ({ result: 'ok', text: 'created' } as never)))
  const { pane, latest } = await approvedCreate($, on)

  const out = await $.tool.call({ tool: CREATE, name: 'Expiry Notice', env: ENV, definition: {} })
  expect(out.context).toContain(
    "no flow link: the new flow's ID could not be read from the result, so updates need a new plan",
  )
  expect((await latest())?.status).toBe('built')
  expect(await pane.find({ type: 'Text', text: 'flow ID unknown — updates need a new plan' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '[built]' })).toBeDefined()
  expect(await pane.find({ type: 'Link' })).toBeUndefined()
  await pane.unmount()
})

// The plugin's rule section of the system prompt, as composed now. A test has no session to read the facts
// off, so it passes them all.
const FACTS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const
const rule = async ($: Engine) =>
  (await $.prompt.compose(FACTS)).sections.find(s => s.id === 'flow-plan:flow-plan-rule')?.text ?? ''
const LICENCE = (mode: string) =>
  `Licence mode is ${mode}. In standard mode use only standard and built-in connectors.`

test('licence mode: premium by default; the pane button toggles the header and the prompt rule', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  on('prompt.compose', async () => ({ sections: [] }) as never)
  expect(await rule($)).toContain(LICENCE('premium'))

  const p = plan('Expiry notice', X)
  await $.tool.call(proposal(p))
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'flow-plan', surface, ...PANE })
    const mode = surface === 'terminal' ? 'premium' : 'standard'
    const other = surface === 'terminal' ? 'standard' : 'premium'
    expect(await pane.find({ type: 'Text', text: `Licence mode: ${mode}` })).toBeDefined()
    await pane.press({ key: 'licence' })
    expect(await pane.find({ type: 'Text', text: `Licence mode: ${other}` })).toBeDefined()
    expect(await rule($)).toContain(LICENCE(other))
    await pane.unmount()
  }
})

test('licence mode: /flow-plan-licence sets it; anything else leaves it and says how', async ($, on) => {
  on('prompt.compose', async () => ({ sections: [] }) as never)
  const run = async (args: string) =>
    ((await $.command.run({ command: 'flow-plan-licence', args, origin: 'user' } as never)) as { text: string }).text

  expect(await run(' Standard ')).toBe('Flow plan licence mode: standard.')
  expect(await rule($)).toContain(LICENCE('standard'))
  expect(await run('gold')).toBe('Licence mode is standard. Use /flow-plan-licence premium or standard.')
  expect(await run('')).toBe('Licence mode is standard. Use /flow-plan-licence premium or standard.')
  expect(await rule($)).toContain(LICENCE('standard'))
  expect(await run('premium')).toBe('Flow plan licence mode: premium.')
  expect(await rule($)).toContain(LICENCE('premium'))
})

const rowsFor = (query: string) => JSON.parse((catalog({ query }) as unknown as { text: string }).text) as ConnectorRow[]

describe('tiers', () => {
  test("a connector's tier is the one tier its matching display names agree on", async () => {
    expect(tierOf('Dataverse', rowsFor('dataverse'))).toBe('premium')
    expect(tierOf('Microsoft Dataverse', rowsFor('dataverse'))).toBe('premium')
    expect(tierOf('office 365  outlook', rowsFor('outlook'))).toBe('standard')
    expect(tierOf('Teams', rowsFor('teams'))).toBe('standard')
    // No display name is just "Outlook": unknown rather than a guess between Office 365 and Outlook.com.
    expect(tierOf('Outlook', rowsFor('outlook'))).toBe('unknown')
    expect(tierOf('Excel Online', [{ displayName: 'Excel Online (Business)', tier: 'Standard' }])).toBe('standard')
    expect(tierOf('My API', [{ displayName: 'My API', tier: 'Custom' }])).toBe('custom')
    expect(
      tierOf('Twin', [
        { displayName: 'Twin', tier: 'Standard' },
        { displayName: 'Twin', tier: 'Premium' },
      ]),
    ).toBe('unknown')
    expect(tierOf('Nothing', [])).toBe('unknown')
  })

  test('built-ins need no lookup', async () => {
    for (const c of ['Control', 'data operations', 'Variables', 'Manually trigger a flow', 'Flow button for mobile']) {
      expect(isBuiltin(c)).toBe(true)
    }
    expect(isBuiltin('SharePoint')).toBe(false)
  })

  test('connectors are collected once from the trigger and every branch, and tiers written back in place', async () => {
    const shape = {
      triggerConnector: 'Microsoft Dataverse',
      nodes: [
        { action: 'Send an email', connector: 'Office 365 Outlook', short: 'Owner' },
        {
          action: 'Condition',
          connector: 'Control',
          short: 'Approved?',
          branches: [{ label: 'Yes', nodes: [{ action: 'Update a row', connector: 'Microsoft Dataverse', short: 'Account' }] }],
        },
        { action: 'Compose', short: 'No connector' },
      ],
    }
    expect(connectorsOf(shape)).toEqual(['Microsoft Dataverse', 'Office 365 Outlook', 'Control'])
    const out = withTiers(shape, c => (c === 'Control' ? 'builtin' : c === 'Office 365 Outlook' ? 'standard' : 'premium'))
    expect(out.triggerTier).toBe('premium')
    expect(out.nodes.map(n => n.tier)).toEqual(['standard', 'builtin', undefined])
    expect(out.nodes[1]?.branches?.[0]?.nodes[0]?.tier).toBe('premium')
  })
})

// A plan with Dataverse (trigger and a nested action), Outlook and a Control node.
const tiered = (target: PlanTarget): FlowPlan => ({
  ...plan('Account follow-up', target),
  triggerConnector: 'Dataverse',
  nodes: [
    { action: 'Send an email', connector: 'Office 365 Outlook', short: 'Owner' },
    {
      action: 'Condition',
      connector: 'Control',
      short: 'Approved?',
      branches: [{ label: 'Yes', nodes: [{ action: 'Update a row', connector: 'Dataverse', short: 'Account' }] }],
    },
  ],
})

test('through the engine: Dataverse is premium and Outlook standard; lookups are cached and use the plan env', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  const asked: string[] = []
  on('tool.call', { tool: LIST }, async (_$, e) => {
    const args = e as unknown as { query?: unknown; env?: unknown }
    asked.push(`${String(args.query)}@${String(args.env)}`)
    return catalog(e)
  })
  // A target env of its own keeps this test's lookups out of any other test's cache.
  const target: PlanTarget = { mode: 'create', name: 'Account follow-up', env: 'env-b2-cache' }
  const out = await $.tool.call(proposal(tiered(target)))
  expect(out.deny).toBeUndefined()

  const stored = ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.[0]
  expect(stored?.triggerTier).toBe('premium')
  expect(stored?.nodes[0]?.tier).toBe('standard')
  expect(stored?.nodes[1]?.tier).toBe('builtin')
  expect(stored?.nodes[1]?.branches?.[0]?.nodes[0]?.tier).toBe('premium')
  expect(stored?.triggerKind).toBe('automated')
  expect(asked.sort()).toEqual(['Dataverse@env-b2-cache', 'Office 365 Outlook@env-b2-cache'])

  // A second version for the same flow looks nothing up again, and is tiered too.
  await $.tool.call(proposal({ ...tiered(target), title: 'Account follow-up v2' }))
  expect(asked.length).toBe(2)
  const second = ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.[1]
  expect(second?.nodes[0]?.tier).toBe('standard')
  expect(((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.length).toBe(2)
})

test('through the engine: when the lookup fails, looked-up tiers are unknown and the pane says why quietly', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  let isDown = true
  on('tool.call', { tool: LIST }, async (_$, e) =>
    isDown ? ({ result: 'error', text: 'Flow API 401 Unauthorized', isError: true } as never) : catalog(e),
  )
  const target: PlanTarget = { mode: 'create', name: 'Account follow-up', env: 'env-b2-fail' }
  await $.tool.call(proposal(tiered(target)))

  const stored = ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.[0]
  expect(stored?.triggerTier).toBe('unknown')
  expect(stored?.nodes.map(n => n.tier)).toEqual(['unknown', 'builtin'])
  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  const note = await pane.find({ type: 'Text', text: 'Connector tiers not looked up, so badges show ?. Flow API 401 Unauthorized' })
  expect(note?.props.dimColor).toBe(true)
  expect(note?.props.color).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /tier lookup failed/ })).toBeUndefined()
  await pane.unmount()

  // the next proposal clears the note.
  isDown = false
  await $.tool.call(proposal(tiered({ ...target, env: 'env-b2-fail-then-ok' })))
  const again = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  expect(await again.find({ type: 'Text', text: /Connector tiers not looked up/ })).toBeUndefined()
  await again.unmount()
})

describe('the tier lookup in every permission mode', () => {
  test("the mod's own read-only lookup is allowed over ask (auto, default) and plan mode's deny", async () => {
    expect(lookupVerdict({ decision: 'ask' }, true)).toEqual({ decision: 'allow' })
    expect(lookupVerdict({ decision: 'deny', reason: 'plan mode' }, true)).toEqual({ decision: 'allow' })
  })

  test('a settings rule, a classic hook or another plugin still decides', async () => {
    const rule = { decision: 'deny', rule: LIST } as const
    const hook = { decision: 'deny', hook: 'PreToolUse' } as const
    const plugin = { decision: 'ask', plugin: 'guard' } as const
    expect(lookupVerdict(rule, true)).toBe(rule)
    expect(lookupVerdict(hook, true)).toBe(hook)
    expect(lookupVerdict(plugin, true)).toBe(plugin)
  })

  test("a call that is not the mod's own read keeps the verdict beneath", async () => {
    const ask = { decision: 'ask' } as const
    expect(lookupVerdict(ask, false)).toBe(ask)
  })

  test("through the engine: the model's own list_connectors and every build tool keep core's verdict", async ($, on) => {
    on('tool.check', async () => ({ decision: 'ask' }) as never)
    const tools = [LIST, ...['create_flow', 'update_flow', 'edit_flow', 'copy_flow'].map(t => FA + t)].map(async tool => (await $.tool.check({ tool, input: {}, isReadOnly: true } as never)).decision)
    expect(await Promise.all(tools)).toEqual(['ask', 'ask', 'ask', 'ask', 'ask'])
  })

  test('the quiet note is one short line', async () => {
    expect(tierNote('denied\nIssue the action again')).toBe('Connector tiers not looked up, so badges show ?. denied')
    expect(tierNote('x'.repeat(300)).length).toBeLessThan(220)
  })
})

test('a proposal without a valid triggerKind is refused and stores nothing', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  const { triggerKind: _, ...rest } = proposal(plan('No kind', X))
  expect((await $.tool.call(rest)).deny).toBe(
    'flow-plan: triggerKind is missing or invalid. Pass "automated", "instant" or "scheduled".',
  )
  expect((await $.tool.call({ ...rest, triggerKind: 'manual' })).deny).toMatch(/triggerKind is missing or invalid/)
  expect(await read($, 'plans')).toBeNull()
})

const OWNER = 'Flow owner needs Power Automate Premium (or a Process licence on the flow).'
const EVERY_USER = 'Every user who runs it needs Premium, or license the flow with a Process licence.'
const SEEDED = 'Microsoft 365 seeded licences cover standard connectors only.'

// The plan shape the licensing rules read, with tiers already resolved.
const licensed = (
  kind: FlowPlan['triggerKind'],
  nested: Tier,
  triggerTier: Tier = 'standard',
): Pick<FlowPlan, 'trigger' | 'triggerConnector' | 'triggerTier' | 'triggerKind' | 'nodes'> => ({
  trigger: 'When a row is added',
  triggerConnector: 'Microsoft Dataverse',
  triggerTier,
  triggerKind: kind,
  nodes: [
    { action: 'Send an email', connector: 'Office 365 Outlook', short: 'Owner', tier: 'standard' },
    {
      action: 'Condition',
      connector: 'Control',
      short: 'Approved?',
      tier: 'builtin',
      branches: [{ label: 'Yes', nodes: [{ action: 'Call API', connector: 'Some API', short: 'Post', tier: nested }] }],
    },
  ],
})

describe('licensing', () => {
  test('badges: ◆ Premium, Custom and ? only', async () => {
    expect([badge('premium'), badge('custom'), badge('unknown')]).toEqual(['◆ Premium', 'Custom', '?'])
    expect([badge('standard'), badge('builtin'), badge(undefined)]).toEqual([undefined, undefined, undefined])
  })

  test('banners follow the trigger kind; any premium or custom step, nested or trigger, counts', async () => {
    expect(banners(licensed('automated', 'premium'))).toEqual([OWNER, SEEDED])
    expect(banners(licensed('scheduled', 'premium'))).toEqual([OWNER, SEEDED])
    expect(banners(licensed('instant', 'premium'))).toEqual([EVERY_USER, SEEDED])
    expect(banners(licensed('instant', 'custom'))).toEqual([EVERY_USER, SEEDED])
    expect(banners(licensed('automated', 'standard', 'premium'))).toEqual([OWNER, SEEDED])
    expect(banners(licensed(undefined, 'premium'))).toEqual([SEEDED])
    expect(banners(licensed('automated', 'standard'))).toEqual([])
    expect(banners(licensed('automated', 'unknown'))).toEqual([])
  })

  test('standard mode makes each premium or custom step an invalid finding; premium mode none', async () => {
    expect(licenceFindings(licensed('automated', 'premium', 'premium'), 'premium')).toEqual([])
    expect(licenceFindings(licensed('automated', 'standard'), 'standard')).toEqual([])
    const found = licenceFindings(licensed('automated', 'custom', 'premium'), 'standard')
    expect(found.map(f => [f.path, f.severity, f.id])).toEqual([
      ['trigger', 'invalid', 'LICENCE-PREMIUM-IN-STANDARD'],
      ['nodes[1].branches[0].nodes[0]', 'invalid', 'LICENCE-PREMIUM-IN-STANDARD'],
    ])
    expect(found[1]?.message).toBe(
      'Call API uses Some API (custom) but the licence mode is standard: switch the mode or change the design',
    )
    expect(found[0]?.source).toBe('https://learn.microsoft.com/power-platform/admin/power-automate-licensing/faqs')
  })

  test('HTTP is premium without a lookup; built-ins stay built-in; others need list_connectors', async () => {
    expect(knownTier('HTTP')).toBe('premium')
    expect(knownTier('http + swagger')).toBe('premium')
    expect(knownTier('Control')).toBe('builtin')
    expect(knownTier('Manual')).toBe('builtin')
    expect(knownTier('Request')).toBe('premium')
    expect(isBuiltin('Request')).toBe(false)
    expect(knownTier('SharePoint')).toBeUndefined()
  })
})

// Proposes tiered() for a target of its own env (keeping its lookups out of other tests' cache) with this trigger kind.
const proposeTiered = async ($: Engine, env: string, kind: FlowPlan['triggerKind'], title = 'Account follow-up') => {
  const target: PlanTarget = { mode: 'create', name: 'Account follow-up', env }
  await $.tool.call(proposal({ ...tiered(target), title, triggerKind: kind }))
  return target
}

test('through the engine: badges in both styles and banners per trigger kind', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  on('tool.call', { tool: LIST }, async (_$, e) => catalog(e))
  await proposeTiered($, 'env-b3-banner', 'automated')

  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  for (const style of ['designer', 'cards']) {
    // Dataverse (trigger and nested node) is premium.
    expect(await pane.find({ type: 'Text', text: '◆ Premium' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `⚠ ${OWNER}` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `⚠ ${SEEDED}` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `⚠ ${EVERY_USER}` })).toBeUndefined()
    if (style === 'designer') await pane.press({ key: 'style' })
  }
  await pane.unmount()

  await proposeTiered($, 'env-b3-banner', 'instant', 'Account follow-up v2')
  const again = await $.ui.mount({ plugin: 'flow-plan', surface: 'desktop', ...PANE })
  expect(await again.find({ type: 'Text', text: `⚠ ${EVERY_USER}` })).toBeDefined()
  expect(await again.find({ type: 'Text', text: `⚠ ${OWNER}` })).toBeUndefined()
  await again.unmount()
})

test('through the engine: standard mode blocks Approve until the mode changes', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  on('tool.call', { tool: LIST }, async (_$, e) => catalog(e))
  const sent: string[] = []
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  await $.command.run({ command: 'flow-plan-licence', args: 'standard', origin: 'user' } as never)
  const target = await proposeTiered($, 'env-b3-block', 'automated')
  const status = async () => ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.[0]?.status

  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  expect((await pane.find({ key: 'approve' }))?.props.label).toBe('Approve (blocked)')
  expect(await pane.find({ type: 'Text', text: /^✖ Trigger "When a row is added - Accounts" uses Dataverse \(premium\)/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^✖ Update a row uses Dataverse \(premium\)/ })).toBeDefined()

  await pane.press({ key: 'approve' })
  expect(await status()).toBe('pending')
  expect(sent).toEqual([])
  expect(
    await pane.find({
      type: 'Text',
      text: 'Approve blocked: 2 premium or custom connector(s) in standard licence mode. Switch the mode (l) or change the design.',
    }),
  ).toBeDefined()

  await pane.press({ key: 'licence' })
  // Premium mode clears the licence findings; the plan's no-Try/Catch warning still needs k.
  expect((await pane.find({ key: 'approve' }))?.props.label).toBe('Approve (blocked)')
  await pane.press({ key: 'acknowledge' })
  expect((await pane.find({ key: 'approve' }))?.props.label).toBe('Approve')
  await pane.press({ key: 'approve' })
  expect(await status()).toBe('approved')
  expect(sent.length).toBe(1)
  await pane.unmount()
})

test('through the engine: an HTTP node is premium with no lookup', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  const asked: unknown[] = []
  on('tool.call', { tool: LIST }, async (_$, e) => {
    asked.push((e as unknown as { query?: unknown }).query)
    return catalog(e)
  })
  const target: PlanTarget = { mode: 'create', name: 'Call out', env: 'env-b3-http' }
  const p = { ...plan('Call out', target), nodes: [{ action: 'HTTP', connector: 'HTTP', short: 'POST to API' }] }
  await $.tool.call(proposal(p))
  const stored = ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.[0]
  expect(stored?.nodes[0]?.tier).toBe('premium')
  expect(asked).toEqual([])
})

// Design-check plan pieces: plain nodes, loops and scopes (Control), and a Try/Catch that satisfies PA-NO-TRY-CATCH.
const step = (action: string, short = '', extra: Partial<PlanNode> = {}): PlanNode => ({ action, short, ...extra })
const loop = (action: string, nodes: PlanNode[], short = 'items'): PlanNode =>
  step(action, short, { connector: 'Control', branches: [{ label: 'Body', nodes }] })
const scope = (short: string, nodes: PlanNode[], runAfter?: string): PlanNode =>
  step('Scope', short, { connector: 'Control', branches: [{ label: 'Body', nodes }], ...(runAfter === undefined ? {} : { runAfter }) })
const condition = (yes: PlanNode[], no: PlanNode[] = []): PlanNode =>
  step('Condition', 'check', { connector: 'Control', branches: [{ label: 'Yes', nodes: yes }, { label: 'No', nodes: no }] })
const TRY_CATCH = [
  scope('Try', [step('Send an email')]),
  scope('Catch', [step('Terminate', 'Failed')], 'has failed, has timed out'),
]
const shape = (nodes: PlanNode[], extra: Partial<FlowPlan> = {}) => ({
  title: 'Design check',
  target: { mode: 'create', name: 'Design check' } as PlanTarget,
  trigger: 'Manually trigger a flow',
  triggerConnector: 'Manually trigger a flow',
  triggerKind: 'instant' as const,
  nodes,
  ...extra,
})
const found = (plan: ReturnType<typeof shape>) => lint(plan).map(f => `${f.id}@${f.path}`)

describe('design checks', () => {
  test('PA-TERMINATE-IN-LOOP: Terminate at any depth in Apply to each or Do until is invalid; in Catch it is fine', async () => {
    const plan = shape([loop('Apply to each', [condition([step('Terminate', 'Failed')])]), ...TRY_CATCH])
    expect(found(plan)).toEqual(['PA-TERMINATE-IN-LOOP@nodes[0].branches[0].nodes[0].branches[0].nodes[0]'])
    expect(lint(plan)[0]?.severity).toBe('invalid')
    expect(found(shape([loop('Do until', [step('Terminate')]), ...TRY_CATCH]))).toEqual([
      'PA-TERMINATE-IN-LOOP@nodes[0].branches[0].nodes[0]',
    ])
    expect(found(shape(TRY_CATCH))).toEqual([])
  })

  test('PA-SINGLE-RECORD-LOOP: a loop over a top-1 list or a single record warns; a normal loop does not', async () => {
    const after = (list: PlanNode) => shape([list, loop('Apply to each', [step('Update a row')]), ...TRY_CATCH])
    expect(found(after(step('List rows', 'Accounts, row count 1')))).toEqual(['PA-SINGLE-RECORD-LOOP@nodes[1]'])
    const topOne = { inputs: { 'Filter Query': "Status eq 'Open'", 'Top Count': '1' } }
    expect(found(after(step('Get items', 'Requests', { details: topOne })))).toEqual([
      'PA-SINGLE-RECORD-LOOP@nodes[1]',
    ])
    expect(found(shape([loop('Apply to each', [step('Compose')], 'the one record'), ...TRY_CATCH]))).toEqual([
      'PA-SINGLE-RECORD-LOOP@nodes[0]',
    ])
    expect(found(after(step('List rows', 'Open requests')))).toEqual([])
  })

  test('PA-NESTED-LOOP: a loop inside a loop warns; loops side by side do not', async () => {
    const nested = shape([loop('Apply to each', [loop('Apply to each', [step('Compose')])]), ...TRY_CATCH])
    expect(found(nested)).toEqual(['PA-NESTED-LOOP@nodes[0].branches[0].nodes[0]'])
    const siblings = shape([loop('Apply to each', [step('Compose')]), loop('Apply to each', [step('Compose')]), ...TRY_CATCH])
    expect(found(siblings)).toEqual([])
  })

  test('PA-NO-TRY-CATCH and PA-CATCH-RUNAFTER: Try needs a Catch that runs after failure', async () => {
    expect(found(shape([step('Send an email')]))).toEqual(['PA-NO-TRY-CATCH@nodes'])
    expect(found(shape(TRY_CATCH))).toEqual([])
    const noRunAfter = shape([scope('Try', [step('Send an email')]), scope('Catch', [step('Terminate')])])
    expect(found(noRunAfter)).toEqual(['PA-NO-TRY-CATCH@nodes', 'PA-CATCH-RUNAFTER@nodes[1]'])
    const successOnly = shape([scope('Try', [step('Send an email')]), scope('Catch', [step('Terminate')], 'is successful')])
    expect(found(successOnly)).toEqual(['PA-NO-TRY-CATCH@nodes', 'PA-CATCH-RUNAFTER@nodes[1]'])
  })

  test('PA-LIST-NO-FILTER: only with node details, and only without a filter or select', async () => {
    const list = (details?: PlanNode['details']) =>
      shape([step('List rows', 'Accounts', details === undefined ? {} : { details }), ...TRY_CATCH])
    expect(found(list({ inputs: { Table: 'Accounts' } }))).toEqual(['PA-LIST-NO-FILTER@nodes[0]'])
    expect(found(list({ inputs: { Table: 'Accounts', 'Filter rows': 'statecode eq 0' } }))).toEqual([])
    expect(found(list())).toEqual([])
  })

  test('PA-TRIGGER-NO-FILTER: an automated Dataverse/SharePoint trigger must mention a filter or condition', async () => {
    const trigger = (connector: string, text: string, kind: FlowPlan['triggerKind'] = 'automated') =>
      shape(TRY_CATCH, { triggerConnector: connector, trigger: text, triggerKind: kind })
    expect(found(trigger('Microsoft Dataverse', 'When a row is added - Accounts'))).toEqual(['PA-TRIGGER-NO-FILTER@trigger'])
    expect(found(trigger('SharePoint', 'When an item is created - Requests'))).toEqual(['PA-TRIGGER-NO-FILTER@trigger'])
    expect(found(trigger('Microsoft Dataverse', 'When a row is added - Accounts (filter rows: statecode eq 0)'))).toEqual([])
    expect(found(trigger('SharePoint', 'For a selected item - Requests', 'instant'))).toEqual([])
    expect(found(trigger('Microsoft Teams', 'When a new channel message is added'))).toEqual([])
  })

  test('PA-CHILD-NO-RESPOND: every path of a [child] flow ends with Respond (Terminate after Respond is fine)', async () => {
    const respond = step('Respond to a PowerApp or flow', 'ok')
    const child = (nodes: PlanNode[]) => shape(nodes, { title: '[child] - Stamp metadata' })
    expect(found(child([...TRY_CATCH, step('Compose', 'result')]))).toEqual(['PA-CHILD-NO-RESPOND@nodes[2]'])
    expect(found(child([scope('Try', [step('Send an email')]), scope('Catch', [respond, step('Terminate', 'Failed')], 'has failed'), condition([respond])]))).toEqual([
      'PA-CHILD-NO-RESPOND@nodes[2].branches[1].nodes',
    ])
    expect(found(child([scope('Try', [step('Send an email')]), scope('Catch', [respond, step('Terminate')], 'has failed'), respond]))).toEqual([])
    expect(found(shape([...TRY_CATCH, step('Compose', 'result')]))).toEqual([])
  })
})

test('through the engine: Terminate inside Apply to each blocks Approve and k cannot clear it', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  const p = { ...plan('Terminate in loop', X), ...shape([loop('Apply to each', [step('Terminate', 'Failed')]), ...TRY_CATCH]), status: 'pending' as const }
  const out = await $.tool.call(proposal(p))
  expect(String(out.result)).toContain(
    '- invalid PA-TERMINATE-IN-LOOP at nodes[0].branches[0].nodes[0]: Terminate inside Apply to each is invalid',
  )

  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  expect((await pane.find({ key: 'approve' }))?.props.label).toBe('Approve (blocked)')
  expect(await pane.find({ key: 'acknowledge' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '✖ PA-TERMINATE-IN-LOOP' })).toBeDefined()
  await pane.press({ key: 'approve' })
  expect(
    await pane.find({ type: 'Text', text: 'Approve blocked: 1 finding(s) must be fixed (✖). Change the design and propose it again.' }),
  ).toBeDefined()
  await pane.unmount()
  const stored = ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(p.target)]?.[0]
  expect(stored?.status).toBe('pending')
})

test('through the engine: a nested loop can be approved only after Acknowledge warnings', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  const p = { ...plan('Nested loop', X), ...shape([loop('Apply to each', [loop('Apply to each', [step('Compose')])]), ...TRY_CATCH]), status: 'pending' as const }
  const out = await $.tool.call(proposal(p))
  expect(String(out.result)).toContain('- warn PA-NESTED-LOOP at nodes[0].branches[0].nodes[0]')
  const status = async () => ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(p.target)]?.[0]?.status

  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'desktop', ...PANE })
  // The desktop draws the designer style as one Svg, so the node marker is inside its source.
  const canvas = async () => String((await pane.find({ type: 'Svg' }))?.props.source ?? '')
  expect(await canvas()).toContain('⚠ PA-NESTED-LOOP')
  await pane.press({ key: 'approve' })
  expect(await status()).toBe('pending')
  expect(
    await pane.find({ type: 'Text', text: 'Approve blocked: 1 warning(s) not acknowledged. Click Acknowledge warnings, or change the design.' }),
  ).toBeDefined()

  expect((await pane.find({ key: 'acknowledge' }))?.props.label).toBe('Acknowledge warnings (1)')
  await pane.press({ key: 'acknowledge' })
  expect(await canvas()).not.toContain('⚠ PA-NESTED-LOOP')
  expect(await pane.find({ type: 'Text', text: /^✓ Apply to each is nested inside Apply to each/ })).toBeDefined()
  expect((await pane.find({ key: 'approve' }))?.props.label).toBe('Approve')
  await pane.press({ key: 'approve' })
  expect(await status()).toBe('approved')
  await pane.unmount()
})

const versionY = async ($: Engine) => ((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(Y)]?.[0]
const REJECTED = (reason: string) =>
  `Flow plan "Fix approvals" rejected: ${reason}. Revise it and call propose_flow_plan again.`

test('Reject with a reason stores it and starts a turn quoting it', { plugins: [probe] }, async ($, on) => {
  const { sent, ui } = await approvals($, on, async text => ({ text }))
  expect(await ui.find({ key: 'reason' })).toBeUndefined()
  await ui.press({ key: 'reject' })
  expect((await ui.find({ key: 'reject' }))?.props.label).toBe('Reject (cancel)')
  expect((await ui.find({ key: 'reason' }))?.props.placeholder).toBe('Why? (enter to send, empty = no reason)')

  await ui.input({ key: 'reason', text: '  too many loops ' })
  expect(sent).toEqual([{ text: REJECTED('too many loops'), asUser: true }])
  expect(await versionY($)).toMatchObject({ status: 'rejected', rejectReason: 'too many loops' })
  expect(await ui.find({ type: 'Text', text: 'Rejected: too many loops' })).toBeDefined()
  expect(await ui.find({ key: 'reason' })).toBeUndefined()
  await ui.unmount()
})

test('Reject with no reason only rejects; pressing Reject again cancels', { plugins: [probe] }, async ($, on) => {
  const { sent, ui } = await approvals($, on, async text => ({ text }))
  await ui.press({ key: 'reject' })
  await ui.press({ key: 'reject' })
  expect(await ui.find({ key: 'reason' })).toBeUndefined()
  expect((await versionY($))?.status).toBe('pending')

  await ui.press({ key: 'reject' })
  await ui.input({ key: 'reason', text: '   ' })
  expect(sent).toEqual([])
  const rejected = await versionY($)
  expect(rejected?.status).toBe('rejected')
  expect(rejected?.rejectReason).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Rejected:/ })).toBeUndefined()
  await ui.unmount()
})

test('Reject on mobile (no Input) rejects at once without a reason', { plugins: [probe] }, async ($, on) => {
  const { sent, ui } = await approvals($, on, async text => ({ text }))
  await ui.unmount()
  const mobile = await $.ui.mount({ plugin: 'flow-plan', surface: 'mobile', ...PANE })
  await mobile.press({ key: 'reject' })
  expect((await versionY($))?.status).toBe('rejected')
  expect(await mobile.find({ key: 'reason' })).toBeUndefined()
  expect(sent).toEqual([])
  await mobile.unmount()
})

test('when the reject prompt is dropped, the plan stays rejected and the pane says so', { plugins: [probe] }, async ($, on) => {
  const { ui } = await approvals($, on, async () => ({ drop: 'blocked by a prompt hook' }))
  await ui.press({ key: 'reject' })
  await ui.input({ key: 'reason', text: 'wrong list' })
  expect((await versionY($))?.status).toBe('rejected')
  expect(
    await ui.find({
      type: 'Text',
      text: "rejected, but the session wasn't notified: blocked by a prompt hook — tell Claude in chat",
    }),
  ).toBeDefined()
  await ui.unmount()
})

// pane focus, the hidden-pane notice, and plan mode.
test('/flow-plan opens the pane focused; a proposal opens it without focus', async ($, on) => {
  const opens: { id?: unknown; focus?: unknown }[] = []
  on('ui.open', async (_$, e) => {
    opens.push(e as never)
    return { value: { isPlaced: true } } as never
  })
  on('tool.call', { tool: LIST }, async (_$, e) => catalog(e))

  await $.command.run({ command: 'flow-plan', args: '', origin: 'user' } as never)
  await $.tool.call(proposal(plan('Expiry notice', X)))
  expect(opens.length).toBe(2)
  expect(opens[0]).toMatchObject({ id: 'flow-plan', focus: true })
  expect(opens[1]?.id).toBe('flow-plan')
  expect(opens[1]?.focus).toBeUndefined()
})

test('a proposal whose pane waits undrawn tells the model to ask for /flow-plan', async ($, on) => {
  const reason = 'opened unasked under 144 columns (100 now)'
  let isPlaced = false
  on('ui.open', async () => ({ value: isPlaced ? { isPlaced } : { isPlaced, reason } }) as never)
  on('tool.call', { tool: LIST }, async (_$, e) => catalog(e))
  const WAIT = 'Wait for the user to approve; building is blocked until they do.'

  const hidden = await $.tool.call(proposal(plan('Expiry notice', X)))
  expect(String(hidden.result).split('\n')[0]).toBe(
    `The plan pane is not shown (${reason}). Ask the user to run /flow-plan to open it. ${WAIT}`,
  )
  isPlaced = true
  const shown = await $.tool.call(proposal(plan('Expiry notice', X)))
  expect(String(shown.result).split('\n')[0]).toBe(`Plan shown in the sidebar. ${WAIT}`)
  expect(String(shown.result)).not.toContain('/flow-plan')
})

test('no mode refuses the plan tool, plan mode included; a settings rule or classic hook still decides', async ($, on) => {
  let core: { decision: string; reason?: string; rule?: string; hook?: string } = { decision: 'deny', reason: 'plan mode' }
  on('tool.check', async () => core as never)
  const check = async (tool: string) => (await $.tool.check({ tool, input: {} })).decision

  expect(await check(TOOL)).toBe('allow')
  core = { decision: 'ask' }
  expect(await check(TOOL)).toBe('allow')
  core = { decision: 'deny', rule: TOOL }
  expect(await check(TOOL)).toBe('deny')
  core = { decision: 'deny', hook: 'PreToolUse' }
  expect(await check(TOOL)).toBe('deny')
  core = { decision: 'deny', reason: 'plan mode' }
  expect(await check(LIST)).toBe('deny')
})

test('the prompt rule tells the model to propose in plan mode too', async ($, on) => {
  on('prompt.compose', async () => ({ sections: [] }) as never)
  expect(await rule($)).toContain('propose_flow_plan only shows a plan and changes nothing, so call it in plan mode too.')
})

// "When an HTTP request is received" is premium, so it gets the badge, the banners and, in standard mode, a finding.
test('through the engine: a Request trigger is premium with no lookup', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  const asked: unknown[] = []
  on('tool.call', { tool: LIST }, async (_$, e) => {
    asked.push((e as unknown as { query?: unknown }).query)
    return catalog(e)
  })
  const target: PlanTarget = { mode: 'create', name: 'Inbound', env: 'env-e2-request' }
  const p = {
    ...plan('Inbound', target),
    trigger: 'When an HTTP request is received',
    triggerConnector: 'Request',
    nodes: [step('Compose', 'body', { connector: 'Data Operation' })],
  }
  await $.tool.call(proposal(p))
  expect(((await read($, 'plans')) as Record<string, FlowPlan[]>)[flowKey(target)]?.[0]?.triggerTier).toBe('premium')
  expect(asked).toEqual([])

  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  expect(await pane.find({ type: 'Text', text: '◆ Premium' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: `⚠ ${OWNER}` })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: `⚠ ${SEEDED}` })).toBeDefined()
  await pane.unmount()

  await $.command.run({ command: 'flow-plan-licence', args: 'standard', origin: 'user' } as never)
  const out = await $.tool.call(proposal({ ...p, title: 'Inbound v2' }))
  expect(String(out.result)).toContain('- invalid LICENCE-PREMIUM-IN-STANDARD at trigger')
})

// the prompt rule asks for details on every data action, with the target and, for an HTTP trigger, who can call it.
test('the prompt rule asks for details on every data action', async ($, on) => {
  on('prompt.compose', async () => ({ sections: [] }) as never)
  const text = await rule($)
  expect(text).toContain('Include details for every data action (inputs, and the target site/list/table)')
  expect(text).toContain('for an HTTP request trigger put who can call it in the trigger text')
})

// the Details button shows each node's details in both styles; a plan without details is drawn as before.
test('through the engine: Details toggles inputs, expressions, variables and note, in both styles', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  on('tool.call', { tool: LIST }, async (_$, e) => catalog(e))
  const long = 'x'.repeat(61)
  const target: PlanTarget = { mode: 'create', name: 'Details plan', env: 'env-d4' }
  const p = {
    ...plan('Details plan', target),
    nodes: [
      step('Get items', 'Requests', {
        key: 'Get_items_-_Requests',
        connector: 'SharePoint',
        details: {
          inputs: { Site: 'https://contoso.sharepoint.com/sites/Ops', 'Filter Query': long },
          expressions: ['@{triggerBody()?[\'id\']}'],
          variables: ['varCount', 'varOwner'],
          note: 'Top 1 only',
        },
      }),
      scope('Handle errors', [step('Compose', 'inner', { connector: 'Data Operation', details: { inputs: { Inputs: 'in scope' } } })]),
    ],
  }
  await $.tool.call(proposal(p))
  const plain = plan('Plain plan', { mode: 'create', name: 'Plain plan', env: 'env-d4' })

  for (const style of ['designer', 'cards'] as const) {
    await $.command.run({ command: 'flow-plan-style', args: style, origin: 'user' } as never)
    const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
    expect(await pane.find({ type: 'Button', text: 'Details' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Site:/ })).toBeUndefined()

    await pane.press({ key: 'details' })
    expect(await pane.find({ type: 'Button', text: 'Details: on' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Site: https://contoso.sharepoint.com/sites/Ops' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `Filter Query: ${'x'.repeat(60)}…` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `ƒ @{triggerBody()?['id']}` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Variables: varCount, varOwner' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Top 1 only' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Inputs: in scope' })).toBeDefined()

    await pane.press({ key: 'details' })
    expect(await pane.find({ type: 'Text', text: /^Site:/ })).toBeUndefined()
    await pane.unmount()
  }

  // No details: switched on, the pane shows no detail line.
  await $.tool.call(proposal({ ...plain, title: 'Plain plan' }))
  const pane = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  await pane.press({ key: 'details' })
  expect(await pane.find({ type: 'Text', text: /^(Variables:|ƒ )/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Owner' })).toBeDefined()
  await pane.unmount()
})

describe('flow-svg', () => {
  const none: Ctx = { extras: () => [] }
  const leafNode = (action: string, connector = 'Data Operation'): PlanNode => ({ action, connector, short: action })
  // A Condition with an Apply to each in True and a Switch in False, so lanes nest two levels deep.
  const nested: Pick<FlowPlan, 'title' | 'trigger' | 'triggerConnector' | 'nodes'> = {
    title: 'Nested',
    trigger: 'Manually trigger a flow',
    triggerConnector: 'Manual',
    nodes: [
      leafNode('Get items', 'SharePoint'),
      {
        action: 'Condition',
        connector: 'Control',
        short: 'Status = New',
        branches: [
          { label: 'True', nodes: [{ action: 'Apply to each', connector: 'Control', short: 'items', branches: [{ label: 'Body', nodes: [leafNode('Send an email', 'Office 365 Outlook'), leafNode('Compose')] }] }] },
          {
            label: 'False',
            nodes: [
              {
                action: 'Switch',
                connector: 'Control',
                short: 'Type',
                branches: [
                  { label: 'Case A', nodes: [leafNode('Compose')] },
                  { label: 'Case B', nodes: [] },
                  { label: 'Default', nodes: [leafNode('Terminate', 'Control')] },
                ],
              },
            ],
          },
        ],
      },
      leafNode('Compose'),
    ],
  }

  test('nested branches lay out with no overlapping cards or pills, all inside the canvas', async () => {
    const l = layout(nested, none)
    const rects = [
      ...l.boxes.filter(b => b.kind !== 'container').map(b => ({ ...b, what: `${b.kind} ${b.title}` })),
      ...l.pills.map(p => ({ x: p.x, y: p.y, w: p.w, h: 18, what: `pill ${p.text}` })),
    ]
    for (const [i, a] of rects.entries()) {
      for (const b of rects.slice(i + 1)) {
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlaps ? `${a.what} overlaps ${b.what}` : 'ok').toBe('ok')
      }
    }
    for (const r of [...rects, ...l.boxes]) {
      expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= l.width && r.y + r.h <= l.height).toBe(true)
    }
    for (const e of l.edges) {
      expect(e.points.length).toBeGreaterThanOrEqual(2)
      for (const [x, y] of e.points) expect(x >= 0 && x <= l.width && y >= 0 && y <= l.height).toBe(true)
    }
    // Every card of the plan is drawn once, plus the trigger and the empty Case B lane.
    expect(l.boxes.filter(b => b.kind === 'card').length).toBe(9)
    expect(l.boxes.filter(b => b.kind === 'container').map(b => b.title)).toEqual(['Apply to each - items'])
    expect(l.boxes.filter(b => b.kind === 'empty').length).toBe(1)
    expect(l.pills.map(p => p.text)).toEqual(['True', 'False', 'Case A', 'Case B', 'Default'])
  })

  test('a Scope is titled with its short name, has a header strip, and carries a final rejoin to its border', async () => {
    const tryCatch = {
      ...nested,
      nodes: [
        { action: 'Scope', connector: 'Control', short: 'Try', branches: [{ label: 'Body', nodes: [nested.nodes[1] as PlanNode] }] },
        { action: 'Scope', connector: 'Control', short: 'Catch', branches: [{ label: 'Body', nodes: [leafNode('Terminate', 'Control')] }] },
      ],
    }
    const l = layout(tryCatch, none)
    const titles = l.boxes.filter(b => b.kind === 'container').map(b => b.title)
    expect(titles).toEqual(['Scope - Try', 'Apply to each - items', 'Scope - Catch'])
    const tryBox = l.boxes.find(b => b.title === 'Scope - Try')
    const catchBox = l.boxes.find(b => b.title === 'Scope - Catch')
    expect(tryBox?.sub).toBe('Control')
    // Try ends in a Condition: one line runs from its join bar down to Try's bottom border.
    const bottom = (tryBox?.y ?? 0) + (tryBox?.h ?? 0)
    const cx = (tryBox?.x ?? 0) + (tryBox?.w ?? 0) / 2
    // (The link on to Catch starts there too, so count only lines that end there.)
    const endsAt = (e: { points: [number, number][] }) => e.points[e.points.length - 1]
    expect(l.edges.filter(e => endsAt(e)?.[0] === cx && endsAt(e)?.[1] === bottom).length).toBe(1)
    // Catch ends in a plain card: no such line.
    const catchBottom = (catchBox?.y ?? 0) + (catchBox?.h ?? 0)
    expect(l.edges.some(e => e.points.some(([, y]) => y === catchBottom))).toBe(false)
    expect(toSvg(l, 't').match(/<rect class="fp-s"[^>]*style="stroke:none"/g)?.length).toBe(3)
  })

  test('the markup has explicit size and viewBox, and escapes names', async () => {
    const svg = toSvg(layout({ ...nested, nodes: [leafNode('Set <x> & "y"')] }, none), 'A & B')
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="[\d.]+" height="[\d.]+" viewBox="0 0 [\d.]+ [\d.]+"/)
    expect(svg).toContain('Set &lt;x&gt; &amp; &quot;y&quot;')
    expect(svg).toContain('<title>A &amp; B</title>')
    expect(svg).not.toContain('<x>')
    expect(escapeXml(`<'&">`)).toBe('&lt;&apos;&amp;&quot;&gt;')
  })

  test('extras land on the card at their path; too big a plan returns undefined', async () => {
    const ctx: Ctx = { extras: (_n, path) => (path === 'nodes[1].branches[0].nodes[0]' ? [{ text: '⚠ PA-NESTED-LOOP', tone: 'yellow' }] : []) }
    const l = layout(nested, ctx)
    expect(l.boxes.find(b => b.title === 'Apply to each - items')?.extras).toEqual([{ text: '⚠ PA-NESTED-LOOP', tone: 'yellow' }])
    expect(l.boxes.filter(b => b.extras.length > 0).length).toBe(1)

    const huge = { ...nested, nodes: Array.from({ length: 600 }, (_, i) => leafNode(`Compose ${i}`)) }
    expect(toSvg(layout(huge, none), 'huge').length).toBeGreaterThan(MAX_SVG)
    expect(flowSvg(huge, none)).toBeUndefined()
    expect(flowSvg(nested, none)).toMatch(/^<svg/)
    expect(altText(nested)).toBe('Nested: trigger "Manually trigger a flow", then 9 actions')
  })
})

test('through the engine: desktop designer draws one Svg; terminal and cards style draw none', { plugins: [probe] }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', async () => h('Text', null, 'engine') as never)
  on('tool.call', { tool: LIST }, async (_$, e) => catalog(e))
  await $.tool.call(proposal(plan('Expiry notice', X)))

  const terminal = await $.ui.mount({ plugin: 'flow-plan', surface: 'terminal', ...PANE })
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: 'Owner' })).toBeDefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ plugin: 'flow-plan', surface: 'desktop', ...PANE })
  const svg = await desktop.find({ type: 'Svg' })
  expect(String(svg?.props.source)).toContain('Send an email')
  expect(svg?.props.alt).toBe('Expiry notice: trigger "When a row is added - Accounts", then 1 action')
  await desktop.press({ key: 'style' })
  expect(await desktop.find({ type: 'Svg' })).toBeUndefined()
  expect(await desktop.find({ type: 'Text', text: 'Owner' })).toBeDefined()
  await desktop.unmount()
})
