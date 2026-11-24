export const meta = {
  name: 'bug-hunt',
  description: 'Find, dedupe, research, verify, plan and align bug fixes for one target; returns a report and issue drafts (files nothing)',
  phases: [
    { title: 'Find', detail: 'finder agent ranks candidate bugs' },
    { title: 'Investigate', detail: 'rounds of dedupe, research, verify' },
    { title: 'Synthesize', detail: 'cluster findings, write contracts' },
    { title: 'Plan', detail: 'one plan per confirmed finding' },
    { title: 'Align', detail: 'fresh reviewer per iteration, rulings, re-plans' },
    { title: 'Draft', detail: 'issue and comment drafts' },
    { title: 'Freshness', detail: 'target/main movement and new issues' },
    { title: 'Report', detail: 'final report' },
  ],
}

// ---------------------------------------------------------------------------
// args: {
//   target, scope, sha, base, targetRef, defaultBranch, startTime,
//   repos: [{name: 'owner/repo', path: '/abs/path'}],
//   seeds: [{claim, location?, severity?}], seedsOnly: bool,
//   limits: {rounds, total, round1, align}
// }
// ---------------------------------------------------------------------------

const A = args || {}
const LIM = Object.assign({ rounds: 3, total: 15, round1: 8, align: 3 }, A.limits || {})
const REF = '~/.claude/skills/bug-hunt/references'
const SEV = { high: 0, medium: 1, low: 2 }

const PRE = [
  `You are one agent in a bug-hunt run. Target: ${A.target} (${A.scope}), pinned at ${A.sha}` +
    (A.base ? ` (base ${A.base})` : '') + '.',
  `Repos: ${(A.repos || []).map(r => `${r.name} at ${r.path}`).join('; ')}.`,
  'Rules:',
  '- Read code at the pinned SHA (`git show <sha>:<path>`, or check it out in your worktree if you have one).',
  "- Do not edit the user's working tree. Do not create, edit or comment on GitHub issues or PRs; read-only `gh` is fine.",
  '- Your deliverable is your final response (the StructuredOutput call). Do not write report, notes or ' +
    'markdown files anywhere; put long markdown in the string fields. Test code in your own worktree is fine.',
  '- If a tool call is blocked, follow the route the block message names (for report files that route is ' +
    'your final response). If it names no route, stop and explain in your output. Never retry a blocked ' +
    'action through a different tool (e.g. Bash heredoc instead of Write).',
  '- Every claim needs file:line evidence; every number needs the command that produced it.',
].join('\n')

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const S = (props, required) => ({ type: 'object', properties: props, required: required || Object.keys(props) })
const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }
const sev = { type: 'string', enum: ['high', 'medium', 'low'] }
const cand = S({ claim: str, location: str, severity: sev, rationale: str, rank: { type: 'number' } }, ['claim', 'location', 'severity', 'rationale'])

const CANDS = S({ candidates: { type: 'array', items: cand } })
const DEDUPE = S({
  decisions: {
    type: 'array',
    items: S({
      id: str,
      status: { type: 'string', enum: ['candidate', 'duplicate'] },
      duplicate_of: str,
      related: strs,
      note: str,
      comment_worthy: { type: 'boolean' },
      searches: strs,
    }, ['id', 'status', 'related', 'note', 'searches']),
  },
})
const RESEARCH = S({
  kind: { type: 'string', enum: ['research'] },
  id: str,
  verdict: { type: 'string', enum: ['CONFIRMED', 'PARTIAL', 'REFUTED'] },
  corrected_claim: str,
  severity: sev,
  evidence: { type: 'string', enum: ['reproduced', 'static', 'inferred'] },
  evidence_locations: strs,
  summary_md: str,
  report_md: str,
  repro_patch: str,
  files_cited: strs,
  new_candidates: { type: 'array', items: cand },
}, ['kind', 'id', 'verdict', 'corrected_claim', 'severity', 'evidence', 'evidence_locations', 'summary_md', 'report_md', 'files_cited', 'new_candidates'])
const VERIFY = S({
  kind: { type: 'string', enum: ['verify'] },
  id: str,
  verdict: { type: 'string', enum: ['confirmed', 'partial', 'refuted'] },
  checks_md: str,
  live_security_or_data_loss: { type: 'boolean' },
  live_impact_evidence: str,
})
const CONTRACTS = S({
  kind: { type: 'string', enum: ['contracts'] },
  clusters: { type: 'array', items: S({ name: str, ids: strs, contract_md: str }) },
  cross_contract_md: str,
  summary_md: str,
  landing_order: strs,
  merges: { type: 'array', items: S({ ids: strs, reason: str }) },
  user_choices: { type: 'array', items: S({ question: str, provisional: str }) },
})
const PLAN = S({
  kind: { type: 'string', enum: ['plan'] },
  id: str,
  plan_md: str,
  plan_summary_md: str,
  files_touched: strs,
  contract_deltas: strs,
})
const ALIGN = S({
  kind: { type: 'string', enum: ['align'] },
  iteration: { type: 'number' },
  items: {
    type: 'array',
    items: S({
      aid: str,
      type: { type: 'string', enum: ['conflict', 'gap', 'delta'] },
      findings: strs,
      evidence: str,
      proposal: str,
      needs_user: { type: 'boolean' },
    }),
  },
  conflicts: { type: 'number' },
})
const DRAFT = S({
  kind: { type: 'string', enum: ['draft'] },
  id: str,
  ids: strs,
  repo: str,
  title: str,
  body: str,
})
const COMMENT = S({
  kind: { type: 'string', enum: ['comment'] },
  id: str,
  target: str,
  body: str,
})
const FRESH = S({
  kind: { type: 'string', enum: ['fresh'] },
  pct_cited_changed: { type: 'number' },
  stale: { type: 'array', items: S({ id: str, reason: str }) },
  new_overlaps: { type: 'array', items: S({ id: str, ref: str, how: str }) },
  summary_md: str,
})
const REPORT = S({ kind: { type: 'string', enum: ['report'] }, markdown: str })

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const ledger = []
let seq = 0
const byId = id => ledger.find(f => f.id === id)
function add(c, source, round) {
  const f = {
    id: 'F' + String(++seq).padStart(2, '0'),
    claim: c.claim,
    location: c.location || '',
    severity: c.severity || 'medium',
    rank: typeof c.rank === 'number' ? c.rank : 99,
    source,
    round,
    status: 'candidate',
    evidence: null,
    verified: null,
    duplicate_of: null,
    related: [],
    note: c.rationale || '',
    cluster: null,
    comment_worthy: false,
    files: [],
  }
  ledger.push(f)
  return f
}
const research = {}
const verifies = {}
const plans = {}
const drafts = {}
const comments = []
const interrupts = []
const openQuestions = []

const ledgerText = list =>
  list.map(f => `${f.id} [${f.status}/${f.severity}] ${f.location} — ${f.claim}`).join('\n')

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const finderPrompt = () => `${PRE}

Find candidate bugs in ${A.scope}. For a PR or branch, review the diff against the base (you may run the
code-review skill) plus pre-existing bugs in touched code; for a package, review the package, its callers
and its tests. Look for correctness, concurrency, lifecycle, error handling, security and tenancy,
config and deploy, and test-validity bugs.
Already recorded (don't repeat): ${ledger.length ? '\n' + ledgerText(ledger) : 'none'}
Return at most 25 candidates. Severity: high = security/tenancy exposure, data loss or corruption, silent
wrong results, outage, permanent failure of a core path; medium = wrong behavior with a visible error or
workaround; low = misleading messages, dead code, test gaps. rank: 1 = most important overall.`

const dedupePrompt = (cands, r) => `${PRE}

Dedupe these round-${r} candidates:
${ledgerText(cands)}

Earlier findings in this run:
${ledgerText(ledger.filter(f => !cands.includes(f))) || 'none'}

1. Same root cause as an earlier finding → status "duplicate", duplicate_of that id.
2. Search GitHub issues AND PRs, open AND closed, in every repo listed above, with several phrasings
   (symbols, error strings, file names, behavior). Read likely matches. Same bug → duplicate,
   duplicate_of "owner/repo#N". A closed-as-fixed issue whose fix isn't in the pinned SHA is a regression:
   keep it "candidate" with the issue in related. Overlapping but not the same → "candidate", issue in
   related, and say how in note.
3. comment_worthy = true when a duplicate's existing issue lacks something this run found (evidence,
   scope, a repro) that is worth a comment there.
List the searches you ran per candidate.`

const researchPrompt = (f, r) => `${PRE}

Research finding ${f.id}: ${f.claim}
Location: ${f.location}. Provisional severity: ${f.severity}. Related: ${f.related.join(', ') || 'none'}.
Notes: ${f.note || 'none'}
You are in a fresh git worktree; use it for reproduction only.

1. Verify the claim from code at the pinned SHA. It may be worse, narrower or different; say so in
   corrected_claim (repeat the claim if unchanged).
2. Research the external semantics involved (Kubernetes, Temporal, SDKs, protocols, cloud APIs) from
   upstream docs or source, citing links or file@version.
3. Reproduce. HIGH severity REQUIRES a failing test or script that demonstrates the bug at the pinned SHA,
   run with the project's test command; put the diff in repro_patch and set evidence "reproduced". If
   that is impossible locally (needs a real cluster, cloud IAM, production data), write a step-by-step
   manual recipe in the report, say exactly why, and set evidence "static". Medium/low: reproduce if
   cheap.
4. Work out fix options; recommend one. Note the coupling and assumptions each bakes in.
5. new_candidates: genuinely new related bugs you noticed (not ones listed under Related or Notes).
report_md follows the "Research report" section of ${REF}/report-schema.md; summary_md follows its
"Summary" section (≤20 lines). evidence_locations: the file:line list a verifier should check.
files_cited: every repo file your report depends on. Use id "${f.id}".`

const verifyPrompt = f => {
  const r = research[f.id]
  return `${PRE}

Independently check finding ${f.id}. You are a skeptic: try to show the claim is wrong.
Claim: ${r ? r.corrected_claim : f.claim}
Evidence locations: ${r ? r.evidence_locations.join('; ') : f.location}
${r && r.repro_patch ? 'Repro patch (apply in a scratch worktree, run at the pinned SHA, and confirm it fails for the stated reason, not an unrelated one):\n```diff\n' + r.repro_patch + '\n```' : 'No repro patch.'}
You are deliberately not given the researcher's reasoning. Check each element of the claim separately and
re-run any counts yourself. live_security_or_data_loss = true only if you confirm a security/tenancy
exposure or data loss that is live in a deployed environment (check deploy config); cite that evidence in
live_impact_evidence. Use id "${f.id}".`
}

const dossier = id => {
  const r = research[id]
  const v = verifies[id]
  return `### ${id}\n${r ? r.report_md : '(no report)'}\n${v ? '\nVerifier: ' + v.verdict + '\n' + v.checks_md : ''}`
}

const synthPrompt = ids => `${PRE}

Cross-reference these confirmed findings and write the contracts that keep their fixes consistent.
Template: ${REF}/contract.md.

${ids.map(dossier).join('\n\n')}

1. Cluster findings that share code, types, error paths, lifecycle or config.
2. Per cluster, pick one fix option per finding so the choices compose. Prefer choices that avoid rigid
   coupling and baked-in assumptions (classify from specs/state, not names; options structs rather than
   growing signatures).
3. Specify concretely, as Go declarations, every type, function signature, constant and interface that
   more than one plan will touch, so planners don't have to invent them. Give every ordering where
   conditions overlap, one error/retry table, an owner for every edge case (including ones no finding
   claims), and what each plan removes that another depends on.
4. merges: findings that should become one issue. landing_order: finding ids in order.
5. user_choices: decisions that are genuinely the user's (product direction, risk acceptance, another
   team's repo), each with the provisional choice you applied.
summary_md ≤30 lines.`

const contractsFor = (c, f) => {
  const cl = c.clusters.find(k => k.ids.includes(f.id))
  return `## Cross-cluster contract\n${c.cross_contract_md}\n\n## Cluster contract: ${cl ? cl.name : 'none'}\n${cl ? cl.contract_md : ''}`
}

const planPrompt = (f, c, extra) => `${PRE}

Write the fix plan for ${f.id}: ${f.claim}

${dossier(f.id)}

${contractsFor(c, f)}
${extra || ''}
plan_md: architecture and code changes per file; mermaid flow/sequence diagrams for changed flows; Go
snippets for new types/functions and key edits; systemic consequences (behavior changes, failure modes,
rollout/compatibility, config/chart/permission changes, operational impact); test plan (the repro test
is the acceptance test; list tests to port from any code you delete). Conform to the contracts; anything
in them that is wrong or missing goes in contract_deltas with the proposed change. No //nolint.
plan_summary_md ≤15 lines. files_touched: repo paths. Use id "${f.id}".`

const alignPrompt = (it, c, ids) => `${PRE}

Alignment review, iteration ${it}. Check these plans against each other and the contracts.

## Contracts
${c.cross_contract_md}
${c.clusters.map(k => `### ${k.name}\n${k.contract_md}`).join('\n')}

## Plans
${ids.map(id => `### ${id}\n${plans[id].plan_md}\n\nContract deltas: ${plans[id].contract_deltas.join(' | ') || 'none'}`).join('\n\n')}

Look for: different shapes or names for the same concept, incompatible signatures, conflicting
precedence, two plans changing one function differently, duplicated helpers, code one plan deletes that
another needs, behavior a deletion drops without porting, landing-order breaks, lint suppressions,
config/permission gaps, and every contract delta. One item each (aid "I${it}-<n>"), type conflict, gap or
delta, with a proposed resolution. needs_user = true only for decisions that are genuinely the user's.
conflicts = number of items of type conflict.`

const rulingPrompt = (c, items) => `${PRE}

Apply these alignment rulings to the contracts. Each item's proposal is accepted as the ruling.
${items.map(i => `- ${i.aid} (${i.type}; ${i.findings.join(', ')}): ${i.proposal}`).join('\n')}

Current contracts:
${JSON.stringify(c)}

Return the full updated contracts. Add each ruling to the relevant contract's "Rulings" section.
Keep user_choices and add any new ones.`

const draftPrompt = (g, c) => `${PRE}

Write one GitHub issue draft covering ${g.ids.join(', ')}. Template: ${REF}/issue-template.md.
Target repo: the repo that owns the code (one of the repos above).

${g.ids.map(id => `${dossier(id)}\n\n#### Plan\n${plans[id] ? plans[id].plan_md : '(none)'}`).join('\n\n')}

## Contracts
${c.cross_contract_md}
${c.clusters.filter(k => k.ids.some(id => g.ids.includes(id))).map(k => k.contract_md).join('\n')}
Landing order: ${c.landing_order.join(' → ')}

Refer to other findings of this run only as placeholders like #F03 (never invent issue numbers); refer
to existing issues as owner/repo#N. title: conventional-commit style. body: everything after the title.
Use id "${g.ids[0]}" and ids ${JSON.stringify(g.ids)}.`

const commentPrompt = f => `${PRE}

Draft a comment for existing issue ${f.duplicate_of}, which this run found already covers ${f.id}
(${f.claim}). Read the issue first. Add only what it lacks: evidence, scope, reproduction, related
findings. Note: ${f.note}
${research[f.id] ? dossier(f.id) : ''}
Keep it short. Use id "${f.id}" and target "${f.duplicate_of}".`

const freshPrompt = () => `${PRE}

Pinned SHA ${A.sha}. Current target ref: ${A.targetRef || 'n/a'}. Default branch: ${A.defaultBranch || 'main'}.
Run start: ${A.startTime || 'unknown'}.
Files cited per finding:
${Object.keys(plans).map(id => `${id}: ${[...new Set([...(byId(id).files || []), ...(plans[id].files_touched || [])])].join(', ')}`).join('\n')}

1. Fetch, then list commits between the pinned SHA and each current head that touch any cited file.
2. For each, name the affected findings: bug already fixed, code a plan changes or deletes was modified,
   new overlapping code, tests a plan must now port. Those findings go in stale with the reason.
3. Search GitHub in every repo above for issues/PRs created or updated since the run start that overlap
   any finding (new_overlaps).
pct_cited_changed: percent of cited files changed.`

// ---------------------------------------------------------------------------
// Phase: Find
// ---------------------------------------------------------------------------

phase('Find')
for (const s of A.seeds || []) add(s, 'seed', 1)
if (!A.seedsOnly) {
  const r = await agent(finderPrompt(), { phase: 'Find', label: 'finder', schema: CANDS })
  for (const c of (r && r.candidates) || []) add(c, 'finder', 1)
}
log(`Find: ${ledger.length} candidates (${['high', 'medium', 'low'].map(s => `${ledger.filter(f => f.severity === s).length} ${s}`).join(', ')})`)

// ---------------------------------------------------------------------------
// Phase: Investigate (rounds)
// ---------------------------------------------------------------------------

let researchedCount = 0
let roundsRun = 0
const needsVerify = f => f.severity === 'high' || (f.status === 'confirmed' && f.evidence !== 'reproduced')

async function runVerify(f) {
  const v = await agent(verifyPrompt(f), { phase: 'Investigate', label: `ver-${f.id}`, schema: VERIFY })
  if (!v) return
  verifies[f.id] = v
  f.verified = v.verdict
  if (v.verdict === 'refuted') f.status = 'refuted'
  else if (f.status === 'refuted') f.status = 'confirmed'
  if (v.verdict === 'confirmed') f.evidence = f.evidence === 'reproduced' ? 'reproduced' : 'verified'
  if (v.verdict !== 'refuted' && v.live_security_or_data_loss) {
    interrupts.push({ id: f.id, claim: f.claim, evidence: v.live_impact_evidence })
    log(`⚠ INTERRUPT ${f.id}: verified live security/data-loss impact — ${f.claim}. Evidence: ${v.live_impact_evidence}. The run continues; nothing is filed.`)
  }
}

for (let r = 1; r <= LIM.rounds; r++) {
  const fresh = ledger.filter(f => f.status === 'candidate' && f.round === r)
  const backlog = ledger.filter(f => f.status === 'backlog')
  if (!fresh.length && !backlog.length) break
  if (researchedCount >= LIM.total) break
  roundsRun = r
  phase('Investigate')

  if (fresh.length) {
    const d = await agent(dedupePrompt(fresh, r), { phase: 'Investigate', label: `dedupe-r${r}`, schema: DEDUPE })
    for (const x of (d && d.decisions) || []) {
      const f = byId(x.id)
      if (!f || !fresh.includes(f)) continue
      f.related = x.related || []
      if (x.note) f.note = x.note
      if (x.status === 'duplicate') {
        f.status = 'duplicate'
        f.duplicate_of = x.duplicate_of || '?'
        f.comment_worthy = !!x.comment_worthy
      }
    }
  }

  // New candidates first, then backlog; highest severity, then finder rank.
  const pool = [
    ...fresh.filter(f => f.status === 'candidate'),
    ...backlog,
  ].sort((a, b) => (SEV[a.severity] - SEV[b.severity]) || (a.round === r ? 0 : 1) - (b.round === r ? 0 : 1) || (a.rank - b.rank))
  const room = Math.max(0, Math.min(r === 1 ? LIM.round1 : LIM.total, LIM.total - researchedCount))
  const go = pool.slice(0, room)
  // Over the round-1 share → backlog (eligible next round). Over the total cap → deferred.
  for (const f of pool.slice(room)) {
    f.status = researchedCount + go.length >= LIM.total ? 'deferred' : 'backlog'
  }
  researchedCount += go.length
  for (const f of go) f.status = 'researching'
  log(`Round ${r}: researching ${go.length} (${go.map(f => f.id).join(', ')}); ${pool.length - go.length} held back; ${researchedCount}/${LIM.total} of cap used`)

  await pipeline(
    go,
    f => agent(researchPrompt(f, r), { phase: 'Investigate', label: `res-${f.id}`, schema: RESEARCH, isolation: 'worktree' }),
    async (res, f) => {
      if (!res) {
        f.status = 'deferred'
        f.note += ' | research agent failed'
        return
      }
      research[f.id] = res
      f.status = res.verdict === 'REFUTED' ? 'refuted' : 'confirmed'
      f.claim = res.corrected_claim || f.claim
      f.severity = res.severity
      f.evidence = res.evidence
      f.files = res.files_cited || []
      for (const c of res.new_candidates || []) add(c, f.id, r + 1)
      if (needsVerify(f)) await runVerify(f)
    },
  )
}
for (const f of ledger) {
  if (f.status === 'candidate' || f.status === 'backlog') {
    f.status = 'deferred'
    f.note += ' | deferred: round or finding cap'
  }
}
const tally = () => ['confirmed', 'refuted', 'duplicate', 'deferred'].map(s => `${ledger.filter(f => f.status === s).length} ${s}`).join(', ')
log(`Investigation done after ${roundsRun} round(s): ${tally()}`)

// ---------------------------------------------------------------------------
// Phase: Synthesize
// ---------------------------------------------------------------------------

const confirmedIds = () => ledger.filter(f => f.status === 'confirmed').map(f => f.id)
let contracts = null
if (confirmedIds().length) {
  phase('Synthesize')
  contracts = await agent(synthPrompt(confirmedIds()), { phase: 'Synthesize', label: 'synth', schema: CONTRACTS })
}
if (contracts) {
  for (const k of contracts.clusters) for (const id of k.ids) if (byId(id)) byId(id).cluster = k.name
  openQuestions.push(...contracts.user_choices)
  // Sample verification: one unverified medium per cluster.
  const sample = contracts.clusters
    .map(k => k.ids.map(byId).find(f => f && f.status === 'confirmed' && f.severity === 'medium' && !f.verified))
    .filter(Boolean)
  if (sample.length) {
    await parallel(sample.map(f => () => runVerify(f)))
    log(`Sample-verified ${sample.length} medium finding(s): ${sample.map(f => `${f.id}=${f.verified}`).join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Phase: Plan + Align
// ---------------------------------------------------------------------------

const alignLog = []
async function planAll(ids, extraFor, label) {
  await pipeline(ids, id =>
    agent(planPrompt(byId(id), contracts, extraFor ? extraFor(id) : ''), { phase: label, label: `plan-${id}`, schema: PLAN })
      .then(p => { if (p) plans[id] = p }))
}

if (contracts) {
  phase('Plan')
  await planAll(confirmedIds(), null, 'Plan')

  phase('Align')
  for (let it = 1; it <= LIM.align; it++) {
    const ids = confirmedIds().filter(id => plans[id])
    const al = await agent(alignPrompt(it, contracts, ids), { phase: 'Align', label: `align-${it}`, schema: ALIGN })
    if (!al) break
    alignLog.push({ iteration: it, conflicts: al.conflicts, items: al.items.length })
    if (!al.items.length) break
    const last = it === LIM.align
    for (const i of al.items.filter(i => i.needs_user)) {
      openQuestions.push({ question: `${i.aid}: ${i.evidence}`, provisional: i.proposal })
    }
    const unresolved = last ? al.items.filter(i => i.type === 'conflict') : []
    for (const i of unresolved) {
      openQuestions.push({ question: `Unresolved conflict ${i.aid} (${i.findings.join(', ')}): ${i.evidence}`, provisional: i.proposal })
    }
    const rule = al.items.filter(i => !unresolved.includes(i))
    if (rule.length) {
      const upd = await agent(rulingPrompt(contracts, rule), { phase: 'Align', label: `rulings-${it}`, schema: CONTRACTS })
      if (upd) contracts = upd
      const affected = [...new Set(rule.flatMap(i => i.findings))].filter(id => plans[id])
      await planAll(affected, id => {
        const mine = rule.filter(i => i.findings.includes(id))
        return `\n## Revise your previous plan\nPrevious plan:\n${plans[id].plan_md}\n\nRulings that affect you (already in the contracts):\n${mine.map(i => `- ${i.aid}: ${i.proposal}`).join('\n')}`
      }, 'Align')
    }
    if (al.conflicts === 0 || last) break
  }
  log(`Alignment: ${alignLog.map(a => `iter ${a.iteration}: ${a.conflicts} conflicts / ${a.items} items`).join('; ')}`)
}

// ---------------------------------------------------------------------------
// Phase: Draft
// ---------------------------------------------------------------------------

function issueGroups() {
  const merged = new Set()
  const groups = []
  for (const m of (contracts && contracts.merges) || []) {
    const ids = m.ids.filter(id => byId(id) && byId(id).status === 'confirmed' && !merged.has(id))
    if (!ids.length) continue
    ids.forEach(id => merged.add(id))
    groups.push({ ids })
  }
  for (const id of confirmedIds()) if (!merged.has(id)) groups.push({ ids: [id] })
  return groups
}

async function draftGroups(groups) {
  await pipeline(groups, g =>
    agent(draftPrompt(g, contracts), { phase: 'Draft', label: `draft-${g.ids[0]}`, schema: DRAFT })
      .then(d => { if (d) drafts[g.ids[0]] = d }))
}

phase('Draft')
const groups = contracts ? issueGroups() : []
await draftGroups(groups)
const commentTargets = ledger.filter(f => f.status === 'duplicate' && f.comment_worthy && /#\d+$/.test(f.duplicate_of || ''))
await pipeline(commentTargets, f =>
  agent(commentPrompt(f), { phase: 'Draft', label: `comment-${f.id}`, schema: COMMENT })
    .then(c => { if (c) comments.push(c) }))

// ---------------------------------------------------------------------------
// Phase: Freshness
// ---------------------------------------------------------------------------

let fresh = null
if (Object.keys(plans).length) {
  phase('Freshness')
  fresh = await agent(freshPrompt(), { phase: 'Freshness', label: 'fresh', schema: FRESH })
  const stale = ((fresh && fresh.stale) || []).map(s => s.id).filter(id => plans[id])
  if (stale.length) {
    await planAll(stale, id => `\n## Update for changes since the pinned SHA\n${fresh.stale.filter(s => s.id === id).map(s => s.reason).join('\n')}\nPrevious plan:\n${plans[id].plan_md}`, 'Freshness')
    await draftGroups(groups.filter(g => g.ids.some(id => stale.includes(id))))
    log(`Freshness: re-planned and re-drafted ${stale.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Phase: Report
// ---------------------------------------------------------------------------

phase('Report')
const ledgerRows = ledger.map(f => ({
  id: f.id, status: f.status, severity: f.severity, evidence: f.evidence, verified: f.verified,
  round: f.round, source: f.source, cluster: f.cluster, duplicate_of: f.duplicate_of,
  related: f.related, claim: f.claim, note: f.note,
}))
const draftIndex = Object.values(drafts).map(d => ({ key: d.id, ids: d.ids, repo: d.repo, title: d.title, chars: d.body.length }))
const commentIndex = comments.map(c => ({ key: c.id, target: c.target, chars: c.body.length }))

const rep = await agent(`${PRE}

Write the final bug-hunt report (markdown, under 150 lines). Nothing has been filed.

Run: ${roundsRun} investigation round(s); limits ${JSON.stringify(LIM)}; alignment ${JSON.stringify(alignLog)}.
Ledger: ${JSON.stringify(ledgerRows)}
Summaries:
${confirmedIds().map(id => `### ${id}\n${research[id].summary_md}\n${plans[id] ? plans[id].plan_summary_md : ''}`).join('\n')}
Contracts summary: ${contracts ? contracts.summary_md : 'none'}
Landing order: ${contracts ? contracts.landing_order.join(' → ') : 'n/a'}
Open questions (provisional choice applied): ${JSON.stringify(openQuestions)}
Interrupts raised: ${JSON.stringify(interrupts)}
Issue drafts: ${JSON.stringify(draftIndex)}
Comment drafts: ${JSON.stringify(commentIndex)}
Freshness: ${fresh ? fresh.summary_md + ' stale=' + JSON.stringify(fresh.stale) + ' overlaps=' + JSON.stringify(fresh.new_overlaps) + ' pct=' + fresh.pct_cited_changed : 'not run'}

Sections: 1. Header (target, SHA, rounds, counts). 2. Needs your attention (interrupts, high findings not
reproduced, open questions with provisional choice, repin suggestion if >30% of cited files changed).
3. Findings table: id | claim (≤12 words) | sev | evidence | verified | cluster | issue key | related.
4. Clusters and landing order. 5. Proposed issues: key, title, repo, findings. 6. Proposed comments:
target, purpose. 7. Refuted and duplicates with reasons. 8. Deferred, one line each with reason.`, { phase: 'Report', label: 'reporter', schema: REPORT })

return {
  report_md: rep ? rep.markdown : '(reporter failed; see ledger)',
  ledger: ledgerRows.map(r => `${r.id} ${r.status} ${r.severity} ${r.evidence || '-'} ${r.verified || '-'} ${r.cluster || '-'} ${r.duplicate_of || ''} — ${r.claim}`),
  landing_order: contracts ? contracts.landing_order : [],
  drafts: draftIndex,
  comments: commentIndex,
  interrupts,
  open_questions: openQuestions,
  rounds_run: roundsRun,
  alignment: alignLog,
}
