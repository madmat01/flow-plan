import type { FlowPlan, PlanNode } from '../../types'

// The designer-style canvas: the plan drawn as one SVG string for surfaces that have the Svg element
// (desktop, VS Code, mobile). layout() places boxes and edges; toSvg() only turns them into markup, so
// the geometry is testable without parsing SVG. The terminal keeps the Box/Text drawing in flow-plan.tsx.

// Connector -> chip colour and glyph, shared with the Box/Text designer style.
export const brand = (connector = '', action = '') => {
  const k = `${connector} ${action}`.toLowerCase()
  if (/outlook|office 365|mail/.test(k)) return { c: '#0078d4', g: '✉' }
  if (/sharepoint/.test(k)) return { c: '#03a9a9', g: '◈' }
  if (/excel/.test(k)) return { c: '#107c41', g: '▦' }
  if (/teams/.test(k)) return { c: '#6264a7', g: '◉' }
  if (/approval/.test(k)) return { c: '#0b6a0b', g: '✔' }
  if (/dataverse|common data/.test(k)) return { c: '#0b6a0b', g: '▤' }
  if (/data op|compose|variable|json|select|filter|parse/.test(k)) return { c: '#8c6cff', g: '{/}' }
  if (/schedule|recurrence/.test(k)) return { c: '#0078d4', g: '⏰' }
  if (/http/.test(k)) return { c: '#ca5010', g: '⇄' }
  if (/control|condition|scope|apply|terminate|switch/.test(k)) return { c: '#8b3a00', g: '▣' }
  return { c: 'gray', g: '●' }
}

// The size limit of SvgProps.source; over it the pane falls back to the Box/Text drawing.
export const MAX_SVG = 131072

export type Tone = 'red' | 'yellow' | 'magenta' | 'muted'
export type Extra = { text: string; tone: Tone }
export type Box = {
  kind: 'card' | 'container' | 'empty'
  x: number
  y: number
  w: number
  h: number
  title: string
  sub: string
  color: string
  glyph: string
  extras: Extra[]
  isTrigger?: boolean
  headH?: number // container only: the solid header strip above its lanes
}
export type Edge = { points: [number, number][]; isArrow: boolean }
export type Pill = { x: number; y: number; w: number; text: string; tone: 'yes' | 'no' | 'case' }
export type Layout = { width: number; height: number; boxes: Box[]; edges: Edge[]; plus: [number, number][]; pills: Pill[] }
// The lines under a card's title (tier badge, finding markers, run-after, details); the pane supplies them.
export type Ctx = { extras: (n: PlanNode, path: string) => Extra[] }

const CARD_W = 240
const PAD = 16
const V_GAP = 40 // link between steps; the ⊕ sits at its middle
const H_GAP = 16 // between side-by-side branches
const LINE = 15
const SPLIT = 20 // condition card to the branch bar
const LANE_HEAD = 40 // branch bar to the lane's first card; the label pill sits on this line
const JOIN = 20
const C_PAD = 12
const PILL_H = 18
const EMPTY_W = 120
const EMPTY_H = 28

const cardH = (extras: number) => 44 + extras * LINE + 8
const pillW = (text: string) => Math.min(CARD_W, Math.round(16 + text.length * 6.5))
const pillTone = (label: string): Pill['tone'] =>
  /^(yes|true)/i.test(label) ? 'yes' : /^(no|false)/i.test(label) ? 'no' : 'case'
const isSplit = (n: PlanNode) => /^(condition|switch)/i.test(n.action)
const subOf = (n: PlanNode) => [n.connector, n.short].filter(s => s !== undefined && s !== '').join(' · ')
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// A measured subtree: its size, and a function that draws it with its top-left corner at (x, y).
// isOpen: it ends in a branch join bar, so whatever encloses it must carry the line on from its centre.
type M = { w: number; h: number; isOpen?: boolean; place: (x: number, y: number, out: Layout) => void }

const link = (out: Layout, cx: number, y1: number, y2: number) => {
  out.edges.push({ points: [[cx, y1], [cx, y2]], isArrow: true })
  out.plus.push([cx, (y1 + y2) / 2])
}

const card = (title: string, sub: string, look: { c: string; g: string }, extras: Extra[], isTrigger = false): M => {
  const h = cardH(extras.length)
  return {
    w: CARD_W,
    h,
    place: (x, y, out) => {
      out.boxes.push({ kind: 'card', x, y, w: CARD_W, h, title, sub, color: look.c, glyph: look.g, extras, isTrigger })
    },
  }
}

const empty: M = {
  w: EMPTY_W,
  h: EMPTY_H,
  place: (x, y, out) => {
    out.boxes.push({ kind: 'empty', x, y, w: EMPTY_W, h: EMPTY_H, title: '(no actions)', sub: '', color: 'gray', glyph: '', extras: [] })
  },
}

const seq = (nodes: PlanNode[], at: string, ctx: Ctx): M => {
  if (nodes.length === 0) return empty
  const items = nodes.map((n, i) => measure(n, `${at}[${i}]`, ctx))
  const w = Math.max(...items.map(it => it.w))
  const h = sum(items.map(it => it.h)) + V_GAP * (items.length - 1)
  return {
    w,
    h,
    isOpen: items[items.length - 1]?.isOpen,
    place: (x, y, out) => {
      let top = y
      items.forEach((it, i) => {
        if (i > 0) link(out, x + w / 2, top - V_GAP, top)
        it.place(x + (w - it.w) / 2, top, out)
        top += it.h + V_GAP
      })
    },
  }
}

// Condition / Switch: the card, then its branches side by side, rejoining below.
const split = (n: PlanNode, path: string, ctx: Ctx): M => {
  const head = card(n.action, subOf(n), brand(n.connector, n.action), ctx.extras(n, path))
  const lanes = (n.branches ?? []).map((b, i) => ({ label: b.label, body: seq(b.nodes, `${path}.branches[${i}].nodes`, ctx) }))
  const laneW = lanes.map(l => Math.max(l.body.w, pillW(l.label)))
  const lanesW = sum(laneW) + H_GAP * (lanes.length - 1)
  const w = Math.max(head.w, lanesW)
  const bodyH = Math.max(...lanes.map(l => l.body.h))
  const h = head.h + SPLIT + LANE_HEAD + bodyH + JOIN
  return {
    w,
    h,
    isOpen: true,
    place: (x, y, out) => {
      const cx = x + w / 2
      head.place(cx - head.w / 2, y, out)
      const splitY = y + head.h + SPLIT
      const laneTop = splitY + LANE_HEAD
      const joinY = laneTop + bodyH + JOIN
      const centers: number[] = []
      let lx = x + (w - lanesW) / 2
      lanes.forEach((l, i) => {
        const lc = lx + (laneW[i] ?? 0) / 2
        centers.push(lc)
        out.edges.push({ points: [[lc, splitY], [lc, laneTop]], isArrow: true })
        const pw = pillW(l.label)
        out.pills.push({ x: lc - pw / 2, y: splitY + (LANE_HEAD - PILL_H) / 2, w: pw, text: l.label, tone: pillTone(l.label) })
        l.body.place(lc - l.body.w / 2, laneTop, out)
        out.edges.push({ points: [[lc, laneTop + l.body.h], [lc, joinY]], isArrow: false })
        lx += (laneW[i] ?? 0) + H_GAP
      })
      out.edges.push({ points: [[cx, y + head.h], [cx, splitY]], isArrow: false })
      const lo = Math.min(cx, ...centers)
      const hi = Math.max(cx, ...centers)
      if (hi > lo) {
        out.edges.push({ points: [[lo, splitY], [hi, splitY]], isArrow: false })
        out.edges.push({ points: [[lo, joinY], [hi, joinY]], isArrow: false })
      }
    },
  }
}

// Scope / Apply to each / Do until (and anything else with branches): a dashed container around its lanes.
const container = (n: PlanNode, path: string, ctx: Ctx): M => {
  const extras = ctx.extras(n, path)
  const look = brand(n.connector, n.action)
  const headH = 44 + extras.length * LINE + 6
  const branches = n.branches ?? []
  // Same rule as the Box/Text designer style: a lone "Body" lane needs no label.
  const showLabel = branches.length > 1 || branches[0]?.label !== 'Body'
  const lanes = branches.map((b, i) => ({ label: b.label, body: seq(b.nodes, `${path}.branches[${i}].nodes`, ctx) }))
  const laneH = lanes.map(l => (showLabel ? PILL_H + 8 : 0) + l.body.h)
  const innerW = Math.max(...lanes.map(l => Math.max(l.body.w, showLabel ? pillW(l.label) : 0)))
  const w = Math.max(CARD_W, innerW + 2 * C_PAD)
  const h = headH + sum(laneH) + 16 * (lanes.length - 1) + C_PAD
  return {
    w,
    h,
    place: (x, y, out) => {
      // Named like the designer's "Scope - Try", so two Scopes are told apart by their title.
      const title = n.short === '' ? n.action : `${n.action} - ${n.short}`
      out.boxes.push({ kind: 'container', x, y, w, h, title, sub: n.connector ?? '', color: look.c, glyph: look.g, extras, headH })
      let top = y + headH
      lanes.forEach((l, i) => {
        if (showLabel) {
          const pw = pillW(l.label)
          out.pills.push({ x: x + (w - pw) / 2, y: top, w: pw, text: l.label, tone: pillTone(l.label) })
          top += PILL_H + 8
        }
        l.body.place(x + (w - l.body.w) / 2, top, out)
        // A Condition/Switch last in the container rejoins at its bar; carry that line to the border,
        // where the link to the next step starts, instead of leaving the bar ending in nothing.
        if (i === lanes.length - 1 && l.body.isOpen === true) {
          out.edges.push({ points: [[x + w / 2, top + l.body.h], [x + w / 2, y + h]], isArrow: false })
        }
        top += l.body.h + 16
      })
    },
  }
}

const measure = (n: PlanNode, path: string, ctx: Ctx): M =>
  (n.branches?.length ?? 0) === 0
    ? card(n.action, subOf(n), brand(n.connector, n.action), ctx.extras(n, path))
    : isSplit(n)
      ? split(n, path, ctx)
      : container(n, path, ctx)

type Drawn = Pick<FlowPlan, 'trigger' | 'triggerConnector' | 'triggerTier' | 'nodes'>

export const layout = (plan: Drawn, ctx: Ctx): Layout => {
  const trigNode: PlanNode = { action: 'Trigger', short: plan.trigger, connector: plan.triggerConnector, tier: plan.triggerTier }
  const trigSub = ['Trigger', plan.triggerConnector].filter(s => s !== undefined && s !== '').join(' · ')
  const trig = card(plan.trigger, trigSub, brand(plan.triggerConnector, 'Trigger'), ctx.extras(trigNode, 'trigger'), true)
  const body = plan.nodes.length > 0 ? seq(plan.nodes, 'nodes', ctx) : undefined
  const innerW = Math.max(trig.w, body?.w ?? 0)
  const out: Layout = {
    width: innerW + 2 * PAD,
    height: PAD + trig.h + (body === undefined ? 0 : V_GAP + body.h) + PAD,
    boxes: [],
    edges: [],
    plus: [],
    pills: [],
  }
  trig.place(PAD + (innerW - trig.w) / 2, PAD, out)
  if (body !== undefined) {
    link(out, PAD + innerW / 2, PAD + trig.h, PAD + trig.h + V_GAP)
    body.place(PAD + (innerW - body.w) / 2, PAD + trig.h + V_GAP, out)
  }
  return out
}

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

// SVG text never wraps, so cut by an estimated character width (about 7px bold 13px, 6.3px at 12px).
const fit = (s: string, width: number, charW: number) => {
  const max = Math.max(4, Math.floor(width / charW))
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
const f = (n: number) => Math.round(n * 10) / 10

const TONE: Record<Exclude<Tone, 'muted'>, string> = { red: '#d13438', yellow: '#c87800', magenta: '#b4009e' }
const PILL = {
  yes: { fill: '#dff6dd', stroke: '#107c10', text: '#0e5c0e' },
  no: { fill: '#fde7e9', stroke: '#a4262c', text: '#a4262c' },
  case: { fill: '#deecf9', stroke: '#0078d4', text: '#004e8c' },
}
// Card surface, borders and text follow the OS theme. Chip and pill colours are mid-tones fixed in both.
const CSS =
  '.fp-s{fill:#fff;stroke:#c8c8c8}.fp-t{fill:#242424}.fp-m{fill:#616161}.fp-e{fill:none;stroke:#8a8a8a}.fp-p{fill:#fff;stroke:#8a8a8a}' +
  '@media (prefers-color-scheme: dark){.fp-s{fill:#2b2b2b;stroke:#505050}.fp-t{fill:#f3f3f3}.fp-m{fill:#b4b4b4}.fp-p{fill:#2b2b2b}}'

const head = (b: Box, out: string[]) => {
  const tx = b.x + 44
  out.push(
    `<rect x="${f(b.x + 10)}" y="${f(b.y + 10)}" width="24" height="24" rx="4" fill="${b.color}"/>`,
    `<text x="${f(b.x + 22)}" y="${f(b.y + 22)}" fill="#fff" font-size="11" text-anchor="middle" dominant-baseline="central">${escapeXml(b.glyph)}</text>`,
    `<text class="fp-t" x="${f(tx)}" y="${f(b.y + 19)}" font-size="13" font-weight="600" dominant-baseline="central">${escapeXml(fit(b.title, b.w - 54, 7.2))}</text>`,
  )
  if (b.sub !== '') {
    out.push(
      `<text class="fp-m" x="${f(tx)}" y="${f(b.y + 36)}" font-size="12" dominant-baseline="central">${escapeXml(fit(b.sub, b.w - 54, 6.3))}</text>`,
    )
  }
  b.extras.forEach((e, i) => {
    const paint = e.tone === 'muted' ? 'class="fp-m"' : `fill="${TONE[e.tone]}"`
    out.push(
      `<text ${paint} x="${f(b.x + 10)}" y="${f(b.y + 44 + LINE / 2 + i * LINE)}" font-size="11" dominant-baseline="central">${escapeXml(fit(e.text, b.w - 20, 6))}</text>`,
    )
  })
}

export const toSvg = (l: Layout, title: string) => {
  const W = f(l.width)
  const H = f(l.height)
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, system-ui, sans-serif">`,
    `<title>${escapeXml(title)}</title>`,
    `<style>${CSS}</style>`,
    '<defs><marker id="a" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L8 4L0 8z" fill="#8a8a8a"/></marker></defs>',
  ]
  for (const b of l.boxes.filter(b => b.kind === 'container')) {
    // The header sits on the card surface, as the designer's scope header does: on the bare pane
    // background its title came out barely readable (seen live on desktop, dark theme).
    // style= rather than stroke="none", since the class's stroke would beat a presentation attribute.
    out.push(
      `<rect class="fp-s" x="${f(b.x + 1)}" y="${f(b.y + 1)}" width="${f(b.w - 2)}" height="${f((b.headH ?? 44) - 2)}" rx="7" style="stroke:none"/>`,
      `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="8" fill="none" stroke="${b.color}" stroke-width="1.2" stroke-dasharray="5 4"/>`,
    )
    head(b, out)
  }
  for (const e of l.edges) {
    const d = e.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${f(x)} ${f(y)}`).join('')
    out.push(`<path class="fp-e" d="${d}" stroke-width="1.2"${e.isArrow ? ' marker-end="url(#a)"' : ''}/>`)
  }
  for (const [x, y] of l.plus) {
    out.push(
      `<circle class="fp-p" cx="${f(x)}" cy="${f(y)}" r="7" stroke-width="1"/>`,
      `<text class="fp-m" x="${f(x)}" y="${f(y)}" font-size="12" text-anchor="middle" dominant-baseline="central">+</text>`,
    )
  }
  for (const b of l.boxes.filter(b => b.kind !== 'container')) {
    if (b.kind === 'empty') {
      out.push(
        `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="6" class="fp-e" stroke-dasharray="4 3"/>`,
        `<text class="fp-m" x="${f(b.x + b.w / 2)}" y="${f(b.y + b.h / 2)}" font-size="11" text-anchor="middle" dominant-baseline="central">${b.title}</text>`,
      )
      continue
    }
    out.push(`<rect class="fp-s" x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="8" stroke-width="1"/>`)
    if (b.isTrigger === true) out.push(`<rect x="${f(b.x)}" y="${f(b.y + 8)}" width="4" height="${f(b.h - 16)}" fill="#f2a900"/>`)
    head(b, out)
  }
  for (const p of l.pills) {
    const c = PILL[p.tone]
    out.push(
      `<rect x="${f(p.x)}" y="${f(p.y)}" width="${f(p.w)}" height="${PILL_H}" rx="9" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1"/>`,
      `<text x="${f(p.x + p.w / 2)}" y="${f(p.y + PILL_H / 2)}" fill="${c.text}" font-size="11" text-anchor="middle" dominant-baseline="central">${escapeXml(fit(p.text, p.w - 12, 6.5))}</text>`,
    )
  }
  out.push('</svg>')
  return out.join('')
}

const countNodes = (nodes: PlanNode[]): number =>
  sum(nodes.map(n => 1 + sum((n.branches ?? []).map(b => countNodes(b.nodes)))))

export const altText = (plan: Pick<FlowPlan, 'title' | 'trigger' | 'nodes'>) => {
  const n = countNodes(plan.nodes)
  return `${plan.title}: trigger "${plan.trigger}", then ${n} action${n === 1 ? '' : 's'}`
}

// The pane's canvas, or undefined when the markup would pass the Svg size limit.
export const flowSvg = (plan: Drawn & Pick<FlowPlan, 'title'>, ctx: Ctx) => {
  const source = toSvg(layout(plan, ctx), plan.title)
  return source.length > MAX_SVG ? undefined : source
}
