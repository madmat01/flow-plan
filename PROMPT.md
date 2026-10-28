# Build your own flow-plan

These are the prompts I'd give Claude Code to build flow-plan from scratch. They describe behaviour, not code, so Claude writes every line and you can read and change all of it.

Run them **in order, one per session**. Start with the core prompt. Get it working and check it in a real session before adding anything else. Each add-on builds on the ones before it.

## Before you start

- **Install Microsoft's power-automate plugin** and check it can see your environments. The mod gates its tools, so it has to be there:

  ```
  /plugin marketplace add microsoft/power-platform-skills
  /plugin install power-automate@power-platform-skills
  ```

- **Read the [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview).** Claude Code also has a built-in skill for making mods. The prompts ask Claude to use it, so it reads the current mod API instead of guessing.
- **Use a dev environment** for every live check. The checks create real flows.
- **Change anything you like.** The tool name, the commands, the rules and the wording are all mine. Make them yours.

---

## Core: the plan, the sidebar and the gate

```text
Make a Claude Code mod as a new plugin called flow-plan. Use the built-in skill for making mods,
and check every API you use against the mod types it points you to. Don't guess an API; if
something isn't in the types, tell me.

Goal: before the power-automate plugin builds or changes a Power Automate cloud flow, Claude must
show me a plan of that flow in a sidebar pane and wait for me to approve it.

1. Register a tool, propose_flow_plan, that takes a plan:
   - title
   - target: either { mode: "create", name, env? } for a new flow, or
     { mode: "update", flowId, env? } for an existing one. Refuse the call if target is missing
     or doesn't match one of these shapes.
   - trigger: the trigger's name and short target
   - triggerKind: "automated", "instant" or "scheduled"
   - nodes: a tree of steps. Each node has action, connector, short (a short target name),
     runAfter (optional) and branches (optional: a list of { label, nodes } for Condition yes/no,
     Switch cases, and the body of Apply to each, Do until and Scope).
   The tool stores the plan as a new pending version and opens the pane. Its result tells Claude
   to wait for approval.

2. Add a rule to Claude's prompt: whenever I ask to design, plan, build or change a Power
   Automate flow, call propose_flow_plan first, one plan per flow, and never call a
   create/update/edit flow tool until I've approved that flow's plan in the sidebar.

3. Keep plans in session state (not persistent storage), keyed by flow: a create plan by its
   trimmed, lower-cased name, an update plan by its flow ID. Each key holds a list of versions;
   the latest version decides. Each version has a status: pending, approved or rejected.

4. Gate these tools from the power-automate plugin:
   mcp__plugin_power-automate_flowagent__create_flow, __update_flow, __edit_flow and __copy_flow.
   Let a call through only when the latest plan for the flow it names is approved:
   create_flow and copy_flow match by the new flow's name, update_flow and edit_flow by flow ID.
   If the plan names an env, the call must name the same env. Otherwise deny it with a reason
   Claude can act on: no plan, plan still pending, plan rejected, or no plan for this flow.

5. Draw a pane titled "Flow plan" with the latest plan for the flow on show: the target, the
   trigger, then the node tree with branches indented under their parent, and each node's
   connector. Add two buttons:
   - Approve: sets the latest version to approved. When that changes it from pending or
     rejected, submit one message to the session, as me, saying the plan for <flow> is approved
     and to build it now.
   - Reject: sets it to rejected.

6. Add a /flow-plan command that opens the pane.

7. Write unit tests with the mod test runner for: the plan key, versions, every gate decision
   above (including a different flow, a different env and a stale version), and Approve sending
   exactly one message. Run them and the plugin validator, and show me the output.

Acceptance, checked live by me: ask for a flow, the plan appears and Claude stops; a build before
Approve is denied; after Approve, the build for that flow goes through and a build for any other
flow is still denied.
```

---

## Add-on 1: single-use create approval and the flow link

```text
Extend flow-plan:
- After a create_flow call succeeds, read the new flow's ID from the result text. It's JSON, and
  the ID is the "name" property, not "id". Mark the plan built and store the ID. Guard the parse;
  if it fails, still mark the plan built and show a warning in the pane.
- A built create plan allows update_flow and edit_flow for that flow ID only, and no second
  create_flow. Another create with that name needs a new plan.
- After a successful create, update or edit, build the maker-portal link
  https://make.powerautomate.com/environments/<env>/flows/<flowId>/details from the call's env and
  the flow ID. Add it to the tool result for Claude and show it in the pane as a link. If the call
  names no env, show no link and say why. Don't guess an env.
- A failed build changes nothing.
Add unit tests that stub the build tool's result, then run them.
```

## Add-on 2: Reject with a reason

```text
Extend flow-plan: Reject opens a text input in the pane. Pressing Enter rejects the plan and
submits one message to the session, as me, quoting my reason and asking Claude to revise the plan.
An empty reason just rejects. Pressing Reject again cancels. Where the pane can't show an input
(mobile), Reject rejects at once. Make sure the keystroke that opens the input doesn't land in it.
Add unit tests, then run them.
```

## Add-on 3: connector tiers and licensing

```text
Extend flow-plan:
- Don't trust Claude for connector tiers. After a proposal, look up each connector with the
  power-automate plugin's list_connectors tool (pass the plan's env if it has one) and store the
  tier on each node: builtin, standard, premium, custom or unknown. Cache lookups for the session.
  If a lookup fails, mark the tiers unknown and show "tier lookup failed" in the pane.
- Built-in actions (Control, Data Operation, Schedule, Manual and so on) need no lookup.
- HTTP, HTTP + Swagger and "When an HTTP request is received" count as premium without a lookup.
- Show a Premium or Custom badge on those nodes, and a banner saying which licence the flow needs
  for its trigger kind. Check the wording against Microsoft's Power Automate licensing FAQ and cite
  it in a code comment.
- Add a licence mode, premium (default) or standard, kept per session. Set it with
  /flow-plan-licence premium|standard and a pane button. In standard mode, any premium or custom
  step is a blocking finding and Approve is dimmed as "Approve (blocked)". Tell Claude the mode in
  the prompt rule.
Add unit tests, then run them.
```

## Add-on 4: design checks

```text
Extend flow-plan with design checks that run on every proposal. Each finding has a rule id, a
severity (invalid or warning), the node path and a message, and the propose_flow_plan result lists
them so Claude can fix them before I review. Mark the affected nodes in the pane.
- Invalid findings block Approve until the plan is fixed and proposed again.
- Warnings block Approve until I press "Acknowledge warnings (n)". Store acknowledgements per rule
  id on that version.
Start with these rules, as plain functions in their own file so I can change them:
- PA-TERMINATE-IN-LOOP (invalid): Terminate inside Apply to each or Do until, at any depth.
- PA-SINGLE-RECORD-LOOP: a loop over a top-1 list or a single record.
- PA-NESTED-LOOP: a loop inside a loop.
- PA-NO-TRY-CATCH: no Try scope with a Catch scope.
- PA-CATCH-RUNAFTER: a Catch scope that doesn't run after failure or timeout.
- PA-TRIGGER-NO-FILTER: an automated Dataverse or SharePoint trigger with no filter or condition.
- PA-CHILD-NO-RESPOND: a path through a [child] flow that doesn't end with Respond.
Add unit tests for each rule, then run them.
```

## Add-on 5: node details

```text
Extend flow-plan:
- Add optional fields to each node: key (the action name Claude will use in the definition) and
  details { inputs (field to value or expression), expressions, variables, note }.
- Change the prompt rule: include details for every data action, including the target site, list
  or table, and for an HTTP request trigger say who can call it in the trigger text.
- Add a Details button that shows or hides the details in the pane.
- Add a design check, PA-LIST-NO-FILTER: List rows or Get items with details but no filter or
  select.
Add unit tests, then run them.
```

## Add-on 6: Plan mode and the hidden pane

```text
Extend flow-plan:
- propose_flow_plan writes nothing outside the session, so allow it in Claude's Plan mode, and
  tell Claude in the prompt rule to use it there too. The build tools stay blocked by Plan mode.
- /flow-plan opens the pane focused. A proposal opens it without focus, so it never takes the
  keyboard while I'm typing.
- If opening the pane reports it isn't placed on screen, say so in the propose_flow_plan result
  and tell Claude to ask me to run /flow-plan.
Add unit tests, then run them.
```

## Add-on 7: the designer picture

```text
Extend flow-plan with a designer style that looks like the Power Automate designer, where the
surface can draw an Svg (Desktop, VS Code, mobile):
- Draw the whole plan as one generated Svg: a card per node with a connector chip, links between
  cards, Condition and Switch branches side by side with label pills that rejoin, and Scope, Apply
  to each and Do until as dashed containers with a header like "Scope - Try".
- Put tier badges, finding markers, run-after and details inside the cards.
- Follow light and dark mode.
- The terminal, and any plan whose Svg would go over the size limit in the types, keep the text
  drawing.
- Add /flow-plan-style designer|cards and a Style button to switch.
Add unit tests that check the Svg's structure, then run them. I'll check the look live.
```
