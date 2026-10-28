import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, StateDollar } from 'claude-code'

import type { Finding, FlowPlan, PlanNode, Tier } from '../types'
import {
  afterBuild,
  appendPlan,
  approve,
  blockReason,
  flowKey,
  isTarget,
  patchVersion,
  planFor,
  targetLabel,
} from './lib/plans'
import type { BuildCall } from './lib/plans'
import { badge, banners, licenceFindings, LICENCE_FINDING } from './lib/licensing'
import { altText, brand, flowSvg } from './lib/flow-svg'
import type { Extra } from './lib/flow-svg'
import { lint } from './lib/lint'
import { connectorsOf, knownTier, lookupVerdict, tierNote, tierOf, withTiers } from './lib/tiers'
import type { ConnectorRow } from './lib/tiers'

const PANE = 'flow-plan'
const TOOL = 'mcp__flow-plan__propose_flow_plan'
const plans = atom({ plugin: 'flow-plan', key: 'plans' } as const, {})
const active = atom({ plugin: 'flow-plan', key: 'active' } as const, null)
const style = atom({ plugin: 'flow-plan', key: 'style' } as const, 'designer')
const notice = atom({ plugin: 'flow-plan', key: 'notice' } as const, null)
const tierWarning = atom({ plugin: 'flow-plan', key: 'tierNote' } as const, null)
const licence = atom({ plugin: 'flow-plan', key: 'licenceMode' } as const, 'premium')
const rejecting = atom({ plugin: 'flow-plan', key: 'rejecting' } as const, false)
const showDetails = atom({ plugin: 'flow-plan', key: 'showDetails' } as const, false)

const BUILD_TOOLS = [
  'mcp__plugin_power-automate_flowagent__create_flow',
  'mcp__plugin_power-automate_flowagent__update_flow',
  'mcp__plugin_power-automate_flowagent__edit_flow',
  'mcp__plugin_power-automate_flowagent__copy_flow',
] as const

const nodeSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'The action name you will use in the definition, e.g. "List_rows_-_Open_requests"' },
    action: { type: 'string', description: 'Action name, e.g. "List rows"' },
    connector: {
      type: 'string',
      description:
        'Connector display name as Power Automate shows it, e.g. "Office 365 Outlook", "SharePoint", "Microsoft Dataverse", "Control", "Data Operation", "Excel Online (Business)", "Schedule"',
    },
    short: { type: 'string', description: 'Short target name, e.g. "Accounts"' },
    runAfter: { type: 'string', description: 'Run-after / error handling, e.g. "on failure of previous"' },
    details: {
      type: 'object',
      description:
        'Key input fields and values/expressions, variables used. For a data action include the target site/list/table.',
      properties: {
        inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Field → value or expression' },
        expressions: { type: 'array', items: { type: 'string' } },
        variables: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
    },
    branches: {
      type: 'array',
      description: 'Condition (Yes/No), Switch (cases), Apply to each / Scope (body) branches',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          nodes: { type: 'array', items: { $ref: '#/properties/nodes/items' } },
        },
        required: ['label', 'nodes'],
      },
    },
  },
  required: ['action', 'short'],
}

const env = { type: 'string', description: 'Environment ID (optional)' }
const targetSchema = {
  description: 'The one flow this plan is for',
  oneOf: [
    {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['create'] },
        name: { type: 'string', description: 'Display name of the new flow' },
        env,
      },
      required: ['mode', 'name'],
    },
    {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['update'] },
        flowId: { type: 'string', description: 'ID of the existing flow (from list_flows/get_flow)' },
        env,
      },
      required: ['mode', 'flowId'],
    },
  ],
}

const LIST_CONNECTORS = 'mcp__plugin_power-automate_flowagent__list_connectors'
const TRIGGER_KINDS = ['automated', 'instant', 'scheduled'] as const

// Connector tiers looked up this session, by env and name; a reload starts it over.
const tierCache = new Map<string, Tier>()
const cacheKey = (env: string | undefined, connector: string) => `${env ?? ''}|${connector.trim().toLowerCase()}`

// Looks up each connector that is neither built in nor cached; rejects with the first failure.
const lookUpTiers = async ($: EngineInterface, connectors: readonly string[], env: string | undefined) => {
  const missing = connectors.filter(c => knownTier(c) === undefined && !tierCache.has(cacheKey(env, c)))
  await Promise.all(
    missing.map(async c => {
      const out = await $.tool.call({ tool: LIST_CONNECTORS, query: c, ...(env === undefined ? {} : { env }) })
      if (out.deny !== undefined) throw new Error(out.deny)
      if (out.isError === true) throw new Error(out.text ?? 'list_connectors failed')
      const rows: unknown = JSON.parse(out.text ?? '')
      if (!Array.isArray(rows)) throw new Error('list_connectors did not return a list')
      tierCache.set(cacheKey(env, c), tierOf(c, rows as ConnectorRow[]))
    }),
  )
}

// Latest version of the plan on show.
const latest = async ($: StateDollar) => {
  const key = await read($, active)
  if (key === null) return null
  const versions = (await read($, plans))[key] ?? []
  const plan = versions.at(-1)
  return plan === undefined ? null : { key, index: versions.length - 1, plan }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'flow-plan',
      description: 'Draft a visual plan of a Power Automate flow before building it',
    })
    await $.command.register({
      name: 'flow-plan-style',
      description: 'Switch the flow plan pane style: designer or cards',
    })
    await $.command.register({
      name: 'flow-plan-licence',
      description: 'Set the flow plan licence mode: premium or standard',
    })
    await $.tool.register({
      name: 'propose_flow_plan',
      description:
        'Show the proposed Power Automate flow as a sidebar diagram for the user to approve. Call this BEFORE any create/update/edit flow tool. target identifies the one flow this plan is for; for an existing flow use its flow ID (get it with list_flows/get_flow). Nodes are in run order; nest Condition/Switch/Apply to each/Scope content under branches. Give every node its connector.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          target: targetSchema,
          trigger: { type: 'string', description: 'Trigger name and short target' },
          triggerConnector: { type: 'string', description: 'Connector of the trigger' },
          triggerKind: {
            type: 'string',
            enum: TRIGGER_KINDS,
            description: 'automated (an event), instant (manual, button or Power Apps) or scheduled (recurrence)',
          },
          nodes: { type: 'array', items: nodeSchema },
        },
        required: ['title', 'target', 'trigger', 'triggerKind', 'nodes'],
      },
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const mode = await read($, licence)

    return {
      sections: [
        ...out.sections,
        {
          id: 'flow-plan:flow-plan-rule',
          scope: 'session',
          text: 'Whenever the user asks you to design, plan, build or change a Power Automate flow, FIRST call the mcp__flow-plan__propose_flow_plan tool with its target (create + the new flow\'s name, or update + the existing flow\'s ID from list_flows/get_flow) and the full node tree (trigger, actions each with its connector, conditions/switch/apply-to-each branches, run-after). Include details for every data action (inputs, and the target site/list/table), and for an HTTP request trigger put who can call it in the trigger text. One plan per flow. Do not call any create/update/edit flow tool until the user has approved that flow\'s plan in the sidebar. Licence mode is ' +
            mode +
            '. In standard mode use only standard and built-in connectors. propose_flow_plan only shows a plan and changes nothing, so call it in plan mode too.',
        },
      ],
    }
  })

  // the plan tool writes nothing outside the session, so no mode (plan mode included) refuses it;
  // a settings rule or a classic hook still decides.
  on('tool.check', { tool: TOOL }, async ($, e, next) => {
    const out = await next(e)
    return out.rule !== undefined || out.hook !== undefined ? out : { decision: 'allow' }
  })

  // the mod's own tier lookup only reads the connector catalogue, so it runs without a prompt in every mode;
  // only that tool, only this mod's call, only when the tool holds it read-only.
  on('tool.check', { tool: LIST_CONNECTORS }, async ($, e, next) =>
    lookupVerdict(await next(e), next.origin.plugin === 'flow-plan' && e.isReadOnly === true),
  )

  // the person asked for the pane, so it takes the keyboard and a/r/k work at once.
  on('command.run', { command: 'flow-plan' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Flow plan', focus: true })
    const ask = e.args.trim()
    if (ask !== '') {
      void $.prompt.submit({
        text: `Call propose_flow_plan to draft a plan for this flow (do not build it yet): ${ask}`,
        asUser: true,
      })
    }

    return { text: ask === '' ? 'Flow plan pane opened.' : 'Drafting plan…' }
  })

  on('command.run', { command: 'flow-plan-style' }, async ($, e) => {
    const chosen = e.args.trim() === 'cards' ? 'cards' : 'designer'
    await update($, style, () => chosen)

    return { text: `Flow plan style: ${chosen}.` }
  })

  on('command.run', { command: 'flow-plan-licence' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    if (asked !== 'premium' && asked !== 'standard') {
      return { text: `Licence mode is ${await read($, licence)}. Use /flow-plan-licence premium or standard.` }
    }
    await update($, licence, () => asked)

    return { text: `Flow plan licence mode: ${asked}.` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Omit<FlowPlan, 'status'>
    if (!isTarget(input.target)) {
      return {
        deny: 'flow-plan: target is missing or invalid. Pass { mode: "create", name } for a new flow or { mode: "update", flowId } for an existing one.',
      }
    }
    if (!TRIGGER_KINDS.some(k => k === input.triggerKind)) {
      return {
        deny: 'flow-plan: triggerKind is missing or invalid. Pass "automated", "instant" or "scheduled".',
      }
    }
    const plan: FlowPlan = {
      title: input.title,
      target: input.target,
      trigger: input.trigger,
      ...(input.triggerConnector === undefined ? {} : { triggerConnector: input.triggerConnector }),
      triggerKind: input.triggerKind,
      nodes: input.nodes,
      status: 'pending',
    }
    plan.findings = lint(plan)
    const key = flowKey(plan.target)
    const stored = await update($, plans, all => appendPlan(all, plan))
    const index = (stored[key]?.length ?? 1) - 1
    await update($, active, () => key)
    await update($, notice, () => null)
    await update($, tierWarning, () => null)
    await update($, rejecting, () => false)
    const opened = await $.ui.open({ id: PANE, title: 'Flow plan' })

    // tiers come from list_connectors, not the model, and enrich this same version.
    const env = plan.target.env
    const failed = await lookUpTiers($, connectorsOf(plan), env).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    const tierFor = (c: string): Tier =>
      knownTier(c) ?? (failed === undefined ? (tierCache.get(cacheKey(env, c)) ?? 'unknown') : 'unknown')
    const tiered = withTiers(plan, tierFor)
    await update($, plans, all => patchVersion(all, key, index, tiered))
    if (failed !== undefined) await update($, tierWarning, () => tierNote(failed))

    // the model sees the findings, so it can fix them before the user reviews.
    const findings = [...plan.findings, ...licenceFindings({ ...plan, ...tiered }, await read($, licence))]
    // an unasked pane can wait undrawn (a narrow terminal), so the model asks the user to open it.
    const shown = opened.isPlaced
      ? 'Plan shown in the sidebar.'
      : `The plan pane is not shown (${opened.reason}). Ask the user to run /flow-plan to open it.`
    return {
      result: [
        `${shown} Wait for the user to approve; building is blocked until they do.`,
        ...(findings.length === 0
          ? []
          : [
              'Findings (fix invalid ones and propose again; warnings block Approve until the user acknowledges them with the Acknowledge warnings button):',
              ...findings.map(f => `- ${f.severity} ${f.id} at ${f.path}: ${f.message}`),
            ]),
      ].join('\n'),
    }
  })

  // A build passes only when its arguments name the flow of an approved plan; a successful one is written back
  // to that plan (built, flow ID, link) and the model gets the flow link with the result.
  on('tool.call', { tool: BUILD_TOOLS }, async ($, e, next) => {
    const call = e as unknown as BuildCall
    const before = await read($, plans)
    const why = blockReason(before, await read($, active), call)
    if (why !== null) {
      void $.ui.open({ id: PANE, title: 'Flow plan' })
      return { deny: `flow-plan: build blocked, ${why}.` }
    }

    const out = await next(e)
    if (out.deny !== undefined || out.isError === true) return out
    const built = afterBuild(call, out.text)
    const at = planFor(before, call)
    if (built === undefined || at === undefined) return out

    await update($, plans, all => patchVersion(all, at.key, at.index, built.patch))
    if (built.warning !== undefined) await update($, notice, () => built.warning ?? null)
    return { ...out, context: [...(out.context ?? []), built.context] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    // Mobile draws no Input yet (its table still names one): there Reject rejects without a reason.
    const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
    // The terminal has no Svg and refuses a tree holding one, so it keeps the Box/Text designer style.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const shown = await latest($)
    if (shown === null) {
      return <Text dimColor>No plan yet. Run /flow-plan &lt;description&gt;.</Text>
    }
    const { key, index, plan: current } = shown

    const mode = await read($, style)
    const isContainer = (n: PlanNode) => (n.branches?.length ?? 0) > 0

    const kindColor = (action: string, isTrigger = false) =>
      isTrigger
        ? 'yellow'
        : /^(condition|switch)/i.test(action)
          ? 'magenta'
          : /^(scope|apply to each|do until)/i.test(action)
            ? 'blue'
            : /^terminate/i.test(action)
              ? 'red'
              : 'green'

    const licenceMode = await read($, licence)
    // Design findings stored at proposal, licence findings from the current mode.
    const findings = [...(current.findings ?? []), ...licenceFindings(current, licenceMode)]
    const acked = current.acknowledged ?? []
    const isOpen = (f: Finding) => f.severity === 'invalid' || !acked.includes(f.id)
    const invalid = findings.filter(f => f.severity === 'invalid')
    const unacked = findings.filter(f => f.severity === 'warn' && !acked.includes(f.id))
    const isBlocked = invalid.length > 0 || unacked.length > 0
    const icon = (f: Finding) => (f.severity === 'invalid' ? '✖' : isOpen(f) ? '⚠' : '✓')

    // the rule ids of the open findings at this step of the plan.
    const openAt = (path: string) => {
      const here = findings.filter(f => f.path === path && isOpen(f))
      if (here.length === 0) return null
      const isInvalid = here.some(f => f.severity === 'invalid')
      return { isInvalid, text: `${isInvalid ? '✖' : '⚠'} ${[...new Set(here.map(f => f.id))].join(', ')}` }
    }
    const marker = (path: string) => {
      const m = openAt(path)
      return m === null ? null : <Text color={m.isInvalid ? 'red' : 'yellow'}>{m.text}</Text>
    }

    // ◆ Premium / Custom / ? beside a node, in both styles.
    const tierBadge = (tier: Tier | undefined) => {
      const text = badge(tier)
      return text === undefined ? null : <Text color={tier === 'unknown' ? 'gray' : 'magenta'}>{text}</Text>
    }

    // inputs as `field: value` (values over 60 characters cut), then expressions, variables and note.
    const showing = await read($, showDetails)
    const clip = (v: string) => (v.length > 60 ? `${v.slice(0, 60)}…` : v)
    const detailText = (n: PlanNode) => {
      const d = n.details
      if (!showing || d === undefined) return []
      return [
        ...Object.entries(d.inputs ?? {}).map(([k, v]) => `${k}: ${clip(v)}`),
        ...(d.expressions ?? []).map(x => `ƒ ${clip(x)}`),
        ...((d.variables?.length ?? 0) > 0 ? [`Variables: ${(d.variables ?? []).join(', ')}`] : []),
        ...(d.note === undefined ? [] : [d.note]),
      ]
    }
    const detailLines = (n: PlanNode, key: string) =>
      detailText(n).map((l, i) => (
        <Text key={`${key}-d${i}`} dimColor>
          {l}
        </Text>
      ))

    // The same lines for the SVG canvas: tier badge, open findings, run-after, then details.
    const extras = (n: PlanNode, path: string): Extra[] => {
      const tier = badge(n.tier)
      const m = openAt(path)
      return [
        ...(tier === undefined ? [] : [{ text: tier, tone: n.tier === 'unknown' ? ('muted' as const) : ('magenta' as const) }]),
        ...(m === null ? [] : [{ text: m.text, tone: m.isInvalid ? ('red' as const) : ('yellow' as const) }]),
        ...(n.runAfter ? [{ text: `↳ ${n.runAfter}`, tone: 'yellow' as const }] : []),
        ...detailText(n).map(text => ({ text, tone: 'muted' as const })),
      ]
    }
    const canvas = mode === 'designer' && Svg !== undefined ? flowSvg(current, { extras }) : undefined

    // ---- cards style ----
    const arrow = (key: string) => (
      <Box key={key} flexDirection="column" alignItems="center">
        <Text dimColor>│</Text>
        <Text dimColor>▼</Text>
      </Box>
    )

    const card = (n: PlanNode, key: string, path: string, isTrigger = false) => {
      const c = kindColor(n.action, isTrigger)
      const lanes = n.branches ?? []
      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor={c} paddingX={1}>
          <Text bold color={c}>
            {isTrigger ? '⚡ ' : ''}
            {n.action}
          </Text>
          {tierBadge(n.tier)}
          {marker(path)}
          <Text>{n.short}</Text>
          {n.runAfter && <Text dimColor>↳ {n.runAfter}</Text>}
          {detailLines(n, key)}
          {lanes.map((b, i) => (
            <Box key={`${key}-${i}`} flexDirection="column" marginTop={1}>
              <Text color={c} bold>
                ◆ {b.label}
              </Text>
              {b.nodes.length === 0 ? <Text dimColor>  (no actions)</Text> : chain(b.nodes, `${key}-${i}-`, `${path}.branches[${i}].nodes`)}
            </Box>
          ))}
        </Box>
      )
    }

    const chain = (nodes: PlanNode[], prefix: string, at: string): unknown[] =>
      nodes.flatMap((n, i) => [...(i > 0 ? [arrow(`${prefix}a${i}`)] : []), card(n, `${prefix}${i}`, `${at}[${i}]`)])

    // ---- designer style ----
    const plus = (key: string) => (
      <Box key={key} flexDirection="column" alignItems="center">
        <Text dimColor>│</Text>
        <Text color="#3b82f6">⊕</Text>
        <Text dimColor>│</Text>
      </Box>
    )

    const leaf = (n: PlanNode, key: string, path: string, isTrigger = false) => {
      const { c, g } = brand(n.connector ?? (isTrigger ? current.triggerConnector : undefined), n.action)
      return (
        <Box key={key} borderStyle="single" borderColor="gray">
          <Text color={c} bold>
            ▌
          </Text>
          <Box flexDirection="column" paddingX={1}>
            <Text bold>
              {g} {n.action}
            </Text>
            {tierBadge(n.tier)}
            {marker(path)}
            <Text dimColor>{n.short}</Text>
            {n.runAfter && <Text color="yellow">↳ {n.runAfter}</Text>}
            {detailLines(n, key)}
          </Box>
        </Box>
      )
    }

    const group = (n: PlanNode, key: string, path: string) => {
      const { c } = brand(n.connector, n.action)
      const lanes = n.branches ?? []
      return (
        <Box key={key} flexDirection="column">
          <Box backgroundColor={c} justifyContent="space-between" paddingX={1}>
            <Text bold color="white">
              ▣ {n.action} - {n.short}
            </Text>
            <Text color="white">⌃</Text>
          </Box>
          {tierBadge(n.tier)}
          {marker(path)}
          {n.runAfter && <Text color="yellow">↳ {n.runAfter}</Text>}
          {detailLines(n, key)}
          <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
            {lanes.map((b, i) => (
              <Box key={`${key}-${i}`} flexDirection="column">
                {lanes.length > 1 || b.label !== 'Body' ? (
                  <Text
                    bold
                    color={/^(yes|true)/i.test(b.label) ? 'green' : /^(no|false)/i.test(b.label) ? 'red' : 'cyan'}
                  >
                    {b.label}
                  </Text>
                ) : null}
                {b.nodes.length === 0 ? <Text dimColor>(no actions)</Text> : dchain(b.nodes, `${key}-${i}-`, `${path}.branches[${i}].nodes`)}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    const dchain = (nodes: PlanNode[], prefix: string, at: string): unknown[] =>
      nodes.flatMap((n, i) => [
        ...(i > 0 ? [plus(`${prefix}p${i}`)] : []),
        isContainer(n) ? group(n, `${prefix}${i}`, `${at}[${i}]`) : leaf(n, `${prefix}${i}`, `${at}[${i}]`),
      ])

    const color =
      current.status === 'approved' || current.status === 'built'
        ? 'green'
        : current.status === 'rejected'
          ? 'red'
          : 'yellow'
    const warning = await read($, notice)
    const quiet = await read($, tierWarning)
    const licensed = invalid.filter(f => f.id === LICENCE_FINDING).length
    const blockedBy =
      licensed > 0
        ? `Approve blocked: ${licensed} premium or custom connector(s) in standard licence mode. Switch the mode (l) or change the design.`
        : invalid.length > 0
          ? `Approve blocked: ${invalid.length} finding(s) must be fixed (✖). Change the design and propose it again.`
          : `Approve blocked: ${unacked.length} warning(s) not acknowledged. Click Acknowledge warnings, or change the design.`

    const isRejecting = await read($, rejecting)

    // Reject with a reason tells the session, so the model can revise; an empty reason only rejects.
    const onReject = async (value: string) => {
      const reason = value.trim()
      await update($, plans, all =>
        patchVersion(all, key, index, { status: 'rejected', rejectReason: reason === '' ? undefined : reason }),
      )
      await update($, rejecting, () => false)
      if (reason === '') return

      const text = `Flow plan "${current.title}" rejected: ${reason}. Revise it and call propose_flow_plan again.`
      const failed = await $.prompt
        .submit({ text, asUser: true })
        .then(out => out.drop, (err: unknown) => (err instanceof Error ? err.message : String(err)))
      await update($, notice, () =>
        failed === undefined ? null : `rejected, but the session wasn't notified: ${failed} — tell Claude in chat`,
      )
    }

    // only a press that newly approves the latest version (pending or rejected before) tells the session.
    // an invalid finding blocks Approve until it's fixed; a warning until it's acknowledged.
    const onApprove = async () => {
      if (isBlocked) {
        await update($, notice, () => blockedBy)
        return
      }
      let isNew = false
      await update($, plans, all => {
        const out = approve(all, key, index)
        isNew = out.isNew
        return out.plans
      })
      if (!isNew) return

      const text = `Flow plan "${current.title}" approved for ${targetLabel(current.target)}. Build it now.`
      const failed = await $.prompt
        .submit({ text, asUser: true })
        .then(out => out.drop, (err: unknown) => (err instanceof Error ? err.message : String(err)))
      await update($, notice, () =>
        failed === undefined ? null : `approved, but the session wasn't notified: ${failed} — tell Claude in chat`,
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>{current.title}</Text>
        <Text dimColor>{targetLabel(current.target)}</Text>
        <Text dimColor>Licence mode: {licenceMode}</Text>
        {current.flowUrl !== undefined && <Link key="flow-link" href={current.flowUrl} label="Open in Power Automate" />}
        <Text color={color}>[{current.status}]</Text>
        {current.status === 'rejected' && current.rejectReason !== undefined && (
          <Text color="red">Rejected: {current.rejectReason}</Text>
        )}
        {warning !== null && <Text color="red">{warning}</Text>}
        {quiet !== null && <Text dimColor>{quiet}</Text>}
        {banners(current).map((b, i) => (
          <Text key={`banner-${i}`} color="yellow">
            ⚠ {b}
          </Text>
        ))}
        {findings.map((f, i) => (
          <Text key={`finding-${i}`} color={f.severity === 'invalid' ? 'red' : 'yellow'} dimColor={!isOpen(f)}>
            {icon(f)} {f.message} [{f.id} at {f.path}]
          </Text>
        ))}
        {mode === 'cards' ? (
          <Box flexDirection="column">
            {card({ action: 'Trigger', short: current.trigger, tier: current.triggerTier }, 'trigger', 'trigger', true)}
            {current.nodes.length > 0 && arrow('t')}
            {chain(current.nodes, 'n', 'nodes')}
          </Box>
        ) : canvas !== undefined && Svg !== undefined ? (
          <Svg key="canvas" source={canvas} alt={altText(current)} />
        ) : (
          <Box flexDirection="column">
            {leaf({ action: 'Trigger', short: current.trigger, tier: current.triggerTier }, 'trigger', 'trigger', true)}
            {current.nodes.length > 0 && plus('t')}
            {dchain(current.nodes, 'n', 'nodes')}
          </Box>
        )}
        {/* key + index: a press acts on the version drawn, so a newer proposal stays pending */}
        <Box>
          <Button
            key="approve"
            label={isBlocked ? 'Approve (blocked)' : 'Approve'}
            variant="primary"
            dimColor={isBlocked}
            onPress={onApprove}
          />
          {unacked.length > 0 && (
            <Button
              key="acknowledge"
              label={`Acknowledge warnings (${unacked.length})`}
              onPress={() =>
                update($, plans, all =>
                  patchVersion(all, key, index, {
                    acknowledged: [...new Set([...(all[key]?.[index]?.acknowledged ?? []), ...unacked.map(f => f.id)])],
                  }),
                )
              }
            />
          )}
          <Button
            key="reject"
            label={isRejecting ? 'Reject (cancel)' : 'Reject'}
            onPress={() => (Input === undefined ? onReject('') : update($, rejecting, r => !r))}
          />
          <Button
            key="style"
            label={mode === 'cards' ? 'Style: cards' : 'Style: designer'}
            onPress={() => update($, style, m => (m === 'cards' ? 'designer' : 'cards'))}
          />
          <Button
            key="details"
            label={showing ? 'Details: on' : 'Details'}
            onPress={() => update($, showDetails, v => !v)}
          />
          <Button
            key="licence"
            label={`Licence: ${licenceMode}`}
            onPress={() => update($, licence, m => (m === 'standard' ? 'premium' : 'standard'))}
          />
        </Box>
        {isRejecting && Input !== undefined && (
          <Input
            key="reason"
            label="Reject"
            placeholder="Why? (enter to send, empty = no reason)"
            submitLabel="Reject"
            autoFocus
            onSubmit={onReject}
          />
        )}
      </Box>
    )
  })
}
