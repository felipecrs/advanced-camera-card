// Triage automation for the "ACC Project Board" (user-owned Projects v2 #6).
//
// Runs in CI only. Two independent phases (phase 2 failing never blocks phase 1):
//   1. fixed-pending-release labelling: find open issues whose fix is already
//      merged to `dev` but not yet in any release, and label them so the real
//      backlog is distinguishable from done-but-awaiting-release work.
//   2. Board sync: mirror triaged issues onto the board and reflect the labels
//      that are curated outside CI (priority/category/target) onto its fields,
//      plus the +1 reactions onto a Votes field.
//
// The board's fields/options are created in the GitHub UI; this script only
// looks them up by name and sets values, so it never mutates board structure.
// An option whose name it can't find is skipped (with a log line), not created.
//
// Executed via `node --experimental-strip-types` (Node 22), so it stays
// dependency-free; only erasable type syntax is used.
//
// Tokens (see .github/workflows/project-triage.yml):
//   GITHUB_TOKEN - repo-scoped (issues: write); used for REST + repo GraphQL.
//   PROJECT_PAT  - classic `project` scope; required because the default
//                  GITHUB_TOKEN cannot write a *user-owned* Projects v2 board.

const OWNER = 'dermotduffy';
const REPO = 'advanced-camera-card';
const PROJECT_OWNER = 'dermotduffy';
const PROJECT_NUMBER = 6;
const DEV_BRANCH = 'dev';

const FIXED_PENDING_LABEL = 'fixed-pending-release';
const RELEASED_NEXT_LABEL = 'released on @next';

// Labels whose name is identical to the board option they select.
const PRIORITY_LABELS = ['P0', 'P1', 'P2', 'P3'];
const TARGET_LABELS = ['v8.0.0-rc.3', 'v8.0.0-rc.4', 'v8.0.0-rc.5', 'v8.0.0', 'v9'];

// Conventional-commit label -> board "Category" option name.
const CATEGORY_BY_LABEL: Record<string, string> = {
  bug: 'Bug',
  feature: 'Feature',
  documentation: 'Documentation',
  performance: 'Performance',
  refactoring: 'Refactoring',
  testing: 'Testing',
  ci: 'CI',
  chore: 'Chore',
};

// Status applied only when an item is first added to the board (so manual board
// moves are never overwritten on later runs).
const ADDED_STATUS_DEFAULT = 'Backlog';
const ADDED_STATUS_FIXED = 'Fixed (Pending Release)';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROJECT_PAT = process.env.PROJECT_PAT;

interface OpenIssue {
  number: number;
  nodeId: string;
  labels: string[];
  votes: number;
}

interface SelectOption {
  id: string;
  name: string;
}

interface ProjectField {
  id: string;
  name: string;
  options?: SelectOption[];
}

interface ProjectItem {
  id: string;
  content: { number?: number } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ProjectV2 {
  id: string;
  title: string;
  fields: { nodes: ProjectField[] };
  items: { nodes: ProjectItem[]; pageInfo: PageInfo };
}

type FieldValue = { singleSelectOptionId: string } | { number: number };

const log = (...a: unknown[]): void => console.log(...a);
const plan = (...a: unknown[]): void => console.log(DRY_RUN ? '[DRY]' : '[RUN]', ...a);

// An issue earns a place on the board once it has been triaged: given a
// priority/target, or detected as fixed-pending-release.
const isTriaged = (labels: string[]): boolean =>
  labels.some(
    (l) =>
      PRIORITY_LABELS.includes(l) ||
      TARGET_LABELS.includes(l) ||
      l === FIXED_PENDING_LABEL,
  );

async function rest<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`REST ${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : ((await res.json()) as T);
}

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors || !json.data)
    throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// All open issues (excluding PRs), with labels, node id and +1 count.
async function openIssues(): Promise<OpenIssue[]> {
  interface RestIssue {
    number: number;
    node_id: string;
    pull_request?: unknown;
    labels: (string | { name: string })[];
    reactions?: { '+1'?: number };
  }
  const out: OpenIssue[] = [];
  for (let page = 1; ; page++) {
    const batch = await rest<RestIssue[]>(
      'GET',
      `/repos/${OWNER}/${REPO}/issues?state=open&per_page=100&page=${page}`,
    );
    if (!batch) break;
    for (const it of batch) {
      if (it.pull_request) continue;
      out.push({
        number: it.number,
        nodeId: it.node_id,
        labels: it.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        votes: it.reactions?.['+1'] ?? 0,
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

// Issue numbers that a merged-to-dev PR closes (via "Closes #" references).
async function devClosedIssueNumbers(): Promise<Set<number>> {
  interface MergedPRs {
    repository: {
      pullRequests: {
        nodes: {
          baseRefName: string;
          closingIssuesReferences: { nodes: { number: number }[] };
        }[];
        pageInfo: PageInfo;
      };
    };
  }
  const closed = new Set<number>();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data: MergedPRs = await graphql<MergedPRs>(
      GITHUB_TOKEN ?? '',
      `
        query ($owner: String!, $repo: String!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequests(
              states: MERGED
              first: 100
              after: $cursor
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              nodes {
                baseRefName
                closingIssuesReferences(first: 20) {
                  nodes {
                    number
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { owner: OWNER, repo: REPO, cursor },
    );
    const prs = data.repository.pullRequests;
    for (const pr of prs.nodes) {
      if (pr.baseRefName !== DEV_BRANCH) continue;
      for (const ref of pr.closingIssuesReferences.nodes) closed.add(ref.number);
    }
    if (!prs.pageInfo.hasNextPage) break;
    cursor = prs.pageInfo.endCursor;
  }
  return closed;
}

async function phaseFixedPendingRelease(issues: OpenIssue[]): Promise<void> {
  log('\n== Phase 1: fixed-pending-release ==');
  const devClosed = await devClosedIssueNumbers();
  let labelled = 0;
  for (const issue of issues) {
    const alreadyMarked =
      issue.labels.includes(FIXED_PENDING_LABEL) ||
      issue.labels.includes(RELEASED_NEXT_LABEL);
    if (!devClosed.has(issue.number) || alreadyMarked) continue;
    plan(
      `label #${issue.number} '${FIXED_PENDING_LABEL}' (merged to ${DEV_BRANCH}, unreleased)`,
    );
    if (!DRY_RUN) {
      await rest('POST', `/repos/${OWNER}/${REPO}/issues/${issue.number}/labels`, {
        labels: [FIXED_PENDING_LABEL],
      });
      issue.labels.push(FIXED_PENDING_LABEL); // so phase 2 places it this run
    }
    labelled++;
  }
  log(`Phase 1: ${labelled} issue(s) ${DRY_RUN ? 'would be' : ''} labelled.`);
}

async function getProject(): Promise<{
  project: ProjectV2;
  onBoard: Map<number, string>;
}> {
  const data = await graphql<{ user: { projectV2: ProjectV2 | null } | null }>(
    PROJECT_PAT ?? '',
    `
      query ($login: String!, $number: Int!) {
        user(login: $login) {
          projectV2(number: $number) {
            id
            title
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon {
                  id
                  name
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
            items(first: 100) {
              nodes {
                id
                content {
                  ... on Issue {
                    number
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `,
    { login: PROJECT_OWNER, number: PROJECT_NUMBER },
  );
  const project = data.user?.projectV2;
  if (!project)
    throw new Error(`Project #${PROJECT_NUMBER} not found for ${PROJECT_OWNER}`);

  const onBoard = new Map<number, string>(); // issue number -> item id
  let nodes = project.items.nodes;
  let pageInfo = project.items.pageInfo;
  for (;;) {
    for (const n of nodes) if (n.content?.number) onBoard.set(n.content.number, n.id);
    if (!pageInfo.hasNextPage) break;
    const more = await graphql<{
      node: { items: { nodes: ProjectItem[]; pageInfo: PageInfo } };
    }>(
      PROJECT_PAT ?? '',
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                nodes {
                  id
                  content {
                    ... on Issue {
                      number
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { id: project.id, cursor: pageInfo.endCursor },
    );
    nodes = more.node.items.nodes;
    pageInfo = more.node.items.pageInfo;
  }
  return { project, onBoard };
}

async function addToBoard(projectId: string, contentNodeId: string): Promise<string> {
  const data = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    PROJECT_PAT ?? '',
    `
      mutation ($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
          item {
            id
          }
        }
      }
    `,
    { project: projectId, content: contentNodeId },
  );
  return data.addProjectV2ItemById.item.id;
}

async function setFieldValue(
  projectId: string,
  itemId: string,
  fieldId: string,
  value: FieldValue,
): Promise<void> {
  await graphql(
    PROJECT_PAT ?? '',
    `
      mutation ($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(
          input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }
        ) {
          projectV2Item {
            id
          }
        }
      }
    `,
    { project: projectId, item: itemId, field: fieldId, value },
  );
}

async function phaseBoardSync(issues: OpenIssue[]): Promise<void> {
  log('\n== Phase 2: board sync ==');
  if (!PROJECT_PAT) {
    log('Phase 2: skipped (PROJECT_PAT not set).');
    return;
  }
  const { project, onBoard } = await getProject();
  log(`Board: "${project.title}" (${onBoard.size} item(s) currently).`);

  const fieldByName = new Map(project.fields.nodes.map((f) => [f.name, f]));
  const priority = fieldByName.get('Priority') ?? null;
  const category = fieldByName.get('Category') ?? null;
  const target = fieldByName.get('Target') ?? null;
  const status = fieldByName.get('Status') ?? null;
  const votes = fieldByName.get('Votes') ?? null;

  // Single-select option id for a wanted name, or null (logging a miss).
  const optionFor = (
    field: ProjectField | null,
    wantedName: string | null,
  ): string | null => {
    if (!field || !wantedName) return null;
    const id = field.options?.find((o) => o.name === wantedName)?.id ?? null;
    if (!id) log(`  (no '${field.name}' option named "${wantedName}")`);
    return id;
  };

  let added = 0;
  for (const issue of issues) {
    if (!isTriaged(issue.labels)) continue;

    const isNew = !onBoard.has(issue.number);
    let itemId = onBoard.get(issue.number) ?? null;
    if (isNew) {
      plan(`add #${issue.number} to board`);
      added++;
      if (!DRY_RUN) itemId = await addToBoard(project.id, issue.nodeId);
    }
    if (DRY_RUN || !itemId) continue;

    const pName = issue.labels.find((l) => PRIORITY_LABELS.includes(l)) ?? null;
    const pOpt = optionFor(priority, pName);
    if (priority && pOpt) {
      await setFieldValue(project.id, itemId, priority.id, {
        singleSelectOptionId: pOpt,
      });
    }

    const catLabel = issue.labels.find((l) => CATEGORY_BY_LABEL[l]) ?? null;
    const cOpt = optionFor(category, catLabel ? CATEGORY_BY_LABEL[catLabel] : null);
    if (category && cOpt) {
      await setFieldValue(project.id, itemId, category.id, {
        singleSelectOptionId: cOpt,
      });
    }

    const tName = issue.labels.find((l) => TARGET_LABELS.includes(l)) ?? null;
    const tOpt = optionFor(target, tName);
    if (target && tOpt) {
      await setFieldValue(project.id, itemId, target.id, { singleSelectOptionId: tOpt });
    }

    if (votes)
      await setFieldValue(project.id, itemId, votes.id, { number: issue.votes });

    // Status only on first add, so manual board moves are never clobbered.
    if (isNew && status) {
      const fixed = issue.labels.includes(FIXED_PENDING_LABEL);
      const sOpt = optionFor(status, fixed ? ADDED_STATUS_FIXED : ADDED_STATUS_DEFAULT);
      if (sOpt)
        await setFieldValue(project.id, itemId, status.id, {
          singleSelectOptionId: sOpt,
        });
    }
  }
  log(`Phase 2: ${added} item(s) ${DRY_RUN ? 'would be' : ''} added; fields synced.`);
}

async function main(): Promise<void> {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
  log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  const issues = await openIssues();
  log(`Fetched ${issues.length} open issue(s).`);
  await phaseFixedPendingRelease(issues);
  try {
    await phaseBoardSync(issues);
  } catch (err) {
    // Board sync is best-effort: never fail the run (and thus phase 1) on it.
    console.error(
      'Phase 2 failed (continuing):',
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
