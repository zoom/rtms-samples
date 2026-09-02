export type McpServerConfig = {
  id: string;
  url: URL;
  accessToken: string;
  allowedTools: Set<string>;
};

type RawMcpServerConfig = {
  id?: unknown;
  url?: unknown;
  bearerTokenEnv?: unknown;
  allowedTools?: unknown;
};

const SERVER_ID_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function nonEmptyString(value: unknown, field: string, serverIndex: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`MCP_SERVERS_JSON[${serverIndex}].${field} must be a non-empty string`);
  }
  return value.trim();
}

export function routedToolName(serverId: string, upstreamToolName: string): string {
  const name = `${serverId}__${upstreamToolName}`;
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Namespaced MCP tool name is invalid or longer than 64 characters: ${name}`);
  }
  return name;
}

export function loadMcpServerConfigs(
  rawValue: string | undefined,
  environment: NodeJS.ProcessEnv = process.env
): McpServerConfig[] {
  if (!rawValue?.trim()) throw new Error('MCP_SERVERS_JSON is required');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error('MCP_SERVERS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('MCP_SERVERS_JSON must be a non-empty array');
  }

  const ids = new Set<string>();
  return parsed.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`MCP_SERVERS_JSON[${index}] must be an object`);
    }
    const raw = entry as RawMcpServerConfig;
    const id = nonEmptyString(raw.id, 'id', index);
    if (!SERVER_ID_PATTERN.test(id)) {
      throw new Error(`MCP_SERVERS_JSON[${index}].id must match ${SERVER_ID_PATTERN}`);
    }
    if (ids.has(id)) throw new Error(`MCP server id is duplicated: ${id}`);
    ids.add(id);

    const url = new URL(nonEmptyString(raw.url, 'url', index));
    if (url.protocol !== 'https:') {
      throw new Error(`MCP server ${id} must use HTTPS`);
    }

    const bearerTokenEnv = nonEmptyString(raw.bearerTokenEnv, 'bearerTokenEnv', index);
    if (!ENV_NAME_PATTERN.test(bearerTokenEnv)) {
      throw new Error(`MCP server ${id} has an invalid bearerTokenEnv name`);
    }
    const accessToken = environment[bearerTokenEnv]?.trim();
    if (!accessToken) throw new Error(`${bearerTokenEnv} is required for MCP server ${id}`);

    if (!Array.isArray(raw.allowedTools) || raw.allowedTools.length === 0) {
      throw new Error(`MCP server ${id} must define a non-empty allowedTools array`);
    }
    const allowedTools = new Set(raw.allowedTools.map((tool, toolIndex) => {
      const name = nonEmptyString(tool, `allowedTools[${toolIndex}]`, index);
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw new Error(`MCP server ${id} has an invalid allowed tool name: ${name}`);
      }
      routedToolName(id, name);
      return name;
    }));

    return { id, url, accessToken, allowedTools };
  });
}
