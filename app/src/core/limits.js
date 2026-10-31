export const LIMITS = Object.freeze({
  // Business quotas removed by product requirement (0.6.0): these values are
  // effectively unreachable safety guards, not user-facing usage limits.
  modelRequests: 1000000, tools: 1000000, batch: 128, runMs: 86400000, requestMs: 60000, toolMs: 600000,
  requestBytes: 2 * 1024 * 1024, responseBytes: 2 * 1024 * 1024,
  argumentBytes: 8192, resultBytes: 4096, contextMessages: 100, contextBytes: 256 * 1024,
  storageBytes: 256 * 1024, sessions: 32, sessionBytes: 1024 * 1024,
  historyBytes: 4 * 1024 * 1024, toolAuditIds: 8192, schemaDepth: 16, schemaNodes: 2048,
  customTools: 64, customToolBytes: 2048, customCatalogBytes: 131072
});
