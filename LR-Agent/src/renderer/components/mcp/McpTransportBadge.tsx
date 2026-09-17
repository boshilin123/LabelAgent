import {
  MCP_TRANSPORT_LABELS,
  type McpTransport,
} from '../../../shared/mcpTypes';

export default function McpTransportBadge({
  transport,
}: {
  transport: McpTransport;
}) {
  return (
    <span className={`mcp-transport-badge mcp-transport-badge--${transport}`}>
      {MCP_TRANSPORT_LABELS[transport]}
    </span>
  );
}
