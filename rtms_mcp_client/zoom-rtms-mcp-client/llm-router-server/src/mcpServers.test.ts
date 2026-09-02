import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMcpServerConfigs, routedToolName } from './mcpServers.js';

const serverJson = JSON.stringify([{
  id: 'zoom_meeting',
  url: 'https://zoom.us/mcp/meeting/streamable',
  bearerTokenEnv: 'ZOOM_MEETING_MCP_ACCESS_TOKEN',
  allowedTools: ['search_meetings', 'recordings_list']
}]);

test('loads MCP servers and resolves access tokens from named environment variables', () => {
  const servers = loadMcpServerConfigs(serverJson, {
    ZOOM_MEETING_MCP_ACCESS_TOKEN: 'secret-token'
  });

  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 'zoom_meeting');
  assert.equal(servers[0].url.toString(), 'https://zoom.us/mcp/meeting/streamable');
  assert.equal(servers[0].accessToken, 'secret-token');
  assert.deepEqual([...servers[0].allowedTools], ['search_meetings', 'recordings_list']);
  assert.equal(routedToolName('zoom_meeting', 'search_meetings'), 'zoom_meeting__search_meetings');
});

test('allows multiple servers to expose the same upstream tool without a collision', () => {
  const first = JSON.parse(serverJson)[0];
  const servers = loadMcpServerConfigs(JSON.stringify([
    first,
    {
      id: 'company_search',
      url: 'https://mcp.example.com/streamable',
      bearerTokenEnv: 'COMPANY_MCP_ACCESS_TOKEN',
      allowedTools: ['search_meetings']
    }
  ]), {
    ZOOM_MEETING_MCP_ACCESS_TOKEN: 'zoom-token',
    COMPANY_MCP_ACCESS_TOKEN: 'company-token'
  });

  assert.equal(servers.length, 2);
  assert.notEqual(
    routedToolName(servers[0].id, 'search_meetings'),
    routedToolName(servers[1].id, 'search_meetings')
  );
});

test('rejects insecure endpoints, missing tokens, duplicate IDs, and empty allowlists', () => {
  assert.throws(
    () => loadMcpServerConfigs(serverJson.replace('https://', 'http://'), {
      ZOOM_MEETING_MCP_ACCESS_TOKEN: 'secret-token'
    }),
    /must use HTTPS/
  );
  assert.throws(() => loadMcpServerConfigs(serverJson, {}), /ZOOM_MEETING_MCP_ACCESS_TOKEN is required/);
  assert.throws(
    () => loadMcpServerConfigs(JSON.stringify([
      JSON.parse(serverJson)[0],
      JSON.parse(serverJson)[0]
    ]), { ZOOM_MEETING_MCP_ACCESS_TOKEN: 'secret-token' }),
    /duplicated/
  );
  assert.throws(
    () => loadMcpServerConfigs(JSON.stringify([{
      ...JSON.parse(serverJson)[0],
      allowedTools: []
    }]), { ZOOM_MEETING_MCP_ACCESS_TOKEN: 'secret-token' }),
    /non-empty allowedTools/
  );
});
