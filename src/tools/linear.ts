import { LinearClient } from "@linear/sdk";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const NOT_CONFIGURED =
  "Linear is not configured. Set linear.apiKey in ~/.config/frail/config.yaml.";

interface FlatIssue {
  id: string;
  identifier: string;
  title: string;
  state: string | null;
  priority: number | null;
  url: string;
  assigneeId: string | null;
  teamId: string | null;
  description?: string;
}

async function flattenIssue(issue: any, includeDescription = false): Promise<FlatIssue> {
  const state = issue.state ? await issue.state : null;
  const out: FlatIssue = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state: state?.name ?? null,
    priority: issue.priority ?? null,
    url: issue.url,
    assigneeId: issue.assigneeId ?? null,
    teamId: issue.teamId ?? null,
  };
  if (includeDescription) {
    out.description = issue.description ?? "";
  }
  return out;
}

async function resolveTeamId(client: LinearClient, teamKey: string): Promise<string> {
  const teams = await client.teams({ filter: { key: { eq: teamKey } }, first: 1 });
  const team = teams.nodes[0];
  if (!team) {
    throw new Error(`No team with key "${teamKey}". Use a valid team key (e.g., "ENG").`);
  }
  return team.id;
}

async function resolveIssueByIdOrIdentifier(client: LinearClient, idOrIdentifier: string) {
  // Try as identifier first (e.g. ENG-123) — both are accepted by issue(id)
  return await client.issue(idOrIdentifier);
}

export function createLinearTools(apiKey: string | undefined): ToolDefinition<any, any, any>[] {
  const client = apiKey ? new LinearClient({ apiKey }) : null;
  const requireClient = (): LinearClient => {
    if (!client) throw new Error(NOT_CONFIGURED);
    return client;
  };

  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

  const listMyIssues: ToolDefinition<any, any, any> = {
    name: "linear_list_my_issues",
    label: "Linear · My Issues",
    description:
      "List issues assigned to the authenticated Linear user. Optionally filter by workflow state name and/or team id.",
    parameters: Type.Object({
      state: Type.Optional(Type.String({ description: "State name, e.g. 'In Progress'" })),
      teamId: Type.Optional(Type.String()),
    }),
    execute: async (_id, params: any) => {
      const c = requireClient();
      const me = await c.viewer;
      const filter: Record<string, any> = {};
      if (params.state) filter.state = { name: { eq: params.state } };
      if (params.teamId) filter.team = { id: { eq: params.teamId } };
      const issues = await me.assignedIssues({ filter, first: 50 });
      const flat = await Promise.all(issues.nodes.map((i) => flattenIssue(i)));
      return text(JSON.stringify(flat, null, 2));
    },
  };

  const searchIssues: ToolDefinition<any, any, any> = {
    name: "linear_search_issues",
    label: "Linear · Search",
    description:
      "Fuzzy search across the Linear workspace by title/description. Optional team/state/label filters.",
    parameters: Type.Object({
      query: Type.String({ description: "Search term", minLength: 1 }),
      teamId: Type.Optional(Type.String()),
      teamKey: Type.Optional(Type.String({ description: "Team key like 'ENG'; resolved if teamId not given." })),
      state: Type.Optional(Type.String()),
      label: Type.Optional(Type.String({ description: "Label name" })),
    }),
    execute: async (_id, params: any) => {
      const c = requireClient();
      let teamId = params.teamId;
      if (!teamId && params.teamKey) teamId = await resolveTeamId(c, params.teamKey);
      const filter: Record<string, any> = {};
      if (teamId) filter.team = { id: { eq: teamId } };
      if (params.state) filter.state = { name: { eq: params.state } };
      if (params.label) filter.labels = { name: { eq: params.label } };
      const result = await c.searchIssues(params.query, {
        first: 25,
        ...(Object.keys(filter).length ? { filter } : {}),
      });
      const flat = await Promise.all(result.nodes.map((i) => flattenIssue(i)));
      return text(JSON.stringify(flat, null, 2));
    },
  };

  const viewIssue: ToolDefinition<any, any, any> = {
    name: "linear_view_issue",
    label: "Linear · View Issue",
    description:
      "Fetch one Linear issue by id or identifier (e.g. 'ENG-123'). Set includeComments to fold comments into the result.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id (uuid) or identifier (e.g. 'ENG-123')" }),
      includeComments: Type.Optional(Type.Boolean({ default: false })),
    }),
    execute: async (_id, params: any) => {
      const c = requireClient();
      const issue = await resolveIssueByIdOrIdentifier(c, params.id);
      const flat = await flattenIssue(issue, true);
      let payload: any = flat;
      if (params.includeComments) {
        const comments = await issue.comments({ first: 50 });
        payload = {
          ...flat,
          comments: comments.nodes.map((cmt: any) => ({
            id: cmt.id,
            body: cmt.body,
            createdAt: cmt.createdAt,
            userId: cmt.userId ?? null,
          })),
        };
      }
      return text(JSON.stringify(payload, null, 2));
    },
  };

  const createIssue: ToolDefinition<any, any, any> = {
    name: "linear_create_issue",
    label: "Linear · Create Issue",
    description:
      "Create a new Linear issue. Provide either teamId or teamKey (e.g. 'ENG'). Returns the new issue identifier and URL.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      teamId: Type.Optional(Type.String()),
      teamKey: Type.Optional(Type.String({ description: "Team key like 'ENG'; resolved if teamId not given." })),
      priority: Type.Optional(
        Type.Number({ description: "0=none, 1=urgent, 2=high, 3=normal, 4=low" }),
      ),
      assigneeSelf: Type.Optional(
        Type.Boolean({ description: "Assign to authenticated user.", default: false }),
      ),
      projectId: Type.Optional(Type.String()),
      labels: Type.Optional(Type.Array(Type.String(), { description: "Label names." })),
    }),
    execute: async (_id, params: any) => {
      const c = requireClient();
      let teamId = params.teamId;
      if (!teamId && params.teamKey) teamId = await resolveTeamId(c, params.teamKey);
      if (!teamId) throw new Error("Provide either teamId or teamKey for linear_create_issue.");

      const input: Record<string, any> = {
        title: params.title,
        teamId,
      };
      if (params.description) input.description = params.description;
      if (typeof params.priority === "number") input.priority = params.priority;
      if (params.projectId) input.projectId = params.projectId;
      if (params.assigneeSelf) {
        const me = await c.viewer;
        input.assigneeId = me.id;
      }
      if (params.labels?.length) {
        const ids: string[] = [];
        for (const name of params.labels) {
          const labels = await c.issueLabels({
            filter: { name: { eq: name }, team: { id: { eq: teamId } } },
            first: 1,
          });
          const label = labels.nodes[0];
          if (label) ids.push(label.id);
        }
        if (ids.length) input.labelIds = ids;
      }

      const payload = await c.createIssue(input as any);
      const created = payload.issue ? await payload.issue : null;
      if (!created) throw new Error("Linear createIssue did not return an issue.");
      const flat = await flattenIssue(created);
      return text(JSON.stringify(flat, null, 2));
    },
  };

  const updateIssue: ToolDefinition<any, any, any> = {
    name: "linear_update_issue",
    label: "Linear · Update Issue",
    description:
      "Update fields on an existing Linear issue by id or identifier (e.g. 'ENG-123'). Provide at least one mutable field; otherwise the call is rejected.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue id (uuid) or identifier (e.g. 'ENG-123')" }),
      title: Type.Optional(Type.String({ minLength: 1 })),
      description: Type.Optional(Type.String()),
      state: Type.Optional(
        Type.String({ description: "Workflow state name on the issue's team, e.g. 'Done'." }),
      ),
      priority: Type.Optional(
        Type.Number({ description: "0=none, 1=urgent, 2=high, 3=normal, 4=low" }),
      ),
      assigneeSelf: Type.Optional(
        Type.Boolean({ description: "Assign to authenticated user.", default: false }),
      ),
      assigneeId: Type.Optional(
        Type.String({
          description: "Explicit assignee user id; takes precedence over assigneeSelf if both given.",
        }),
      ),
      addLabels: Type.Optional(
        Type.Array(Type.String(), { description: "Label names to attach." }),
      ),
      removeLabels: Type.Optional(
        Type.Array(Type.String(), { description: "Label names to detach." }),
      ),
      projectId: Type.Optional(Type.String()),
    }),
    execute: async (_id, params: any) => {
      const c = requireClient();
      const issue = await resolveIssueByIdOrIdentifier(c, params.id);
      if (!issue) throw new Error(`No Linear issue found for "${params.id}".`);

      const input: Record<string, any> = {};
      if (typeof params.title === "string") input.title = params.title;
      if (typeof params.description === "string") input.description = params.description;
      if (typeof params.priority === "number") input.priority = params.priority;
      if (params.projectId) input.projectId = params.projectId;

      if (params.state) {
        const team = await issue.team;
        if (!team) throw new Error("Issue has no team — cannot resolve workflow state.");
        const match = await team.states({
          filter: { name: { eq: params.state } },
          first: 1,
        });
        const state = match.nodes[0];
        if (!state) {
          const all = await team.states({ first: 50 });
          throw new Error(
            `No workflow state "${params.state}" on team ${team.key}. Available: ${all.nodes.map((s: any) => s.name).join(", ")}`,
          );
        }
        input.stateId = state.id;
      }

      if (params.assigneeId) {
        input.assigneeId = params.assigneeId;
      } else if (params.assigneeSelf) {
        const me = await c.viewer;
        input.assigneeId = me.id;
      }

      const teamId = issue.teamId;
      const resolveLabelIds = async (names: string[]): Promise<string[]> => {
        const ids: string[] = [];
        for (const name of names) {
          const labels = await c.issueLabels({
            filter: { name: { eq: name }, team: { id: { eq: teamId } } },
            first: 1,
          });
          const label = labels.nodes[0];
          if (!label) throw new Error(`No label "${name}" on team for issue ${issue.identifier}.`);
          ids.push(label.id);
        }
        return ids;
      };
      if (params.addLabels?.length) {
        input.addedLabelIds = await resolveLabelIds(params.addLabels);
      }
      if (params.removeLabels?.length) {
        input.removedLabelIds = await resolveLabelIds(params.removeLabels);
      }

      if (Object.keys(input).length === 0) {
        throw new Error(
          "Provide at least one field to update (title, description, state, priority, assignee, labels, projectId).",
        );
      }

      const payload = await c.updateIssue(issue.id, input as any);
      const updated = payload.issue ? await payload.issue : null;
      if (!updated) throw new Error("Linear updateIssue did not return an issue.");
      const flat = await flattenIssue(updated, true);
      return text(JSON.stringify(flat, null, 2));
    },
  };

  const createComment: ToolDefinition<any, any, any> = {
    name: "linear_create_comment",
    label: "Linear · Create Comment",
    description:
      "Add a comment to a Linear issue, by issue id or identifier (e.g. 'ENG-123'). Markdown is supported.",
    parameters: Type.Object({
      issueId: Type.String({ description: "Issue id (uuid) or identifier (e.g. 'ENG-123')" }),
      body: Type.String({ minLength: 1, description: "Comment body in markdown." }),
    }),
    execute: async (_id, params: any) => {
      const c = requireClient();
      const issue = await resolveIssueByIdOrIdentifier(c, params.issueId);
      if (!issue) throw new Error(`No Linear issue found for "${params.issueId}".`);

      const payload = await c.createComment({ issueId: issue.id, body: params.body });
      const comment = payload.comment ? await payload.comment : null;
      if (!comment) throw new Error("Linear createComment did not return a comment.");

      return text(
        JSON.stringify(
          {
            id: comment.id,
            body: comment.body,
            createdAt: comment.createdAt,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            url: `${issue.url}#comment-${comment.id}`,
          },
          null,
          2,
        ),
      );
    },
  };

  const listComments: ToolDefinition<any, any, any> = {
    name: "linear_list_comments",
    label: "Linear · List Comments",
    description: "List comments on a Linear issue, by issue id or identifier (e.g. 'ENG-123').",
    parameters: Type.Object({
      issueId: Type.String({ description: "Issue id or identifier (e.g. 'ENG-123')" }),
      limit: Type.Optional(Type.Number({ default: 50 })),
    }),
    execute: async (_id, params: any) => {
      const c = requireClient();
      const issue = await resolveIssueByIdOrIdentifier(c, params.issueId);
      const comments = await issue.comments({ first: params.limit ?? 50 });
      const flat = comments.nodes.map((cmt: any) => ({
        id: cmt.id,
        body: cmt.body,
        createdAt: cmt.createdAt,
        userId: cmt.userId ?? null,
      }));
      return text(JSON.stringify(flat, null, 2));
    },
  };

  return [listMyIssues, searchIssues, viewIssue, createIssue, updateIssue, createComment, listComments];
}

export async function pingLinear(apiKey: string | undefined): Promise<{ ok: boolean; user?: string; error?: string }> {
  if (!apiKey) return { ok: false, error: "no api key" };
  try {
    const c = new LinearClient({ apiKey });
    const me = await c.viewer;
    return { ok: true, user: `${me.name} <${me.email}>` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
