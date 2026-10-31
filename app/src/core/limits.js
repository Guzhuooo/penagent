export const LIMITS = Object.freeze({
  modelRequests: 6, tools: 24, batch: 8, runMs: 120000, requestMs: 20000, toolMs: 10000,
  requestBytes: 2 * 1024 * 1024, responseBytes: 2 * 1024 * 1024,
  argumentBytes: 8192, resultBytes: 4096, contextMessages: 100, contextBytes: 256 * 1024,
  storageBytes: 256 * 1024, sessions: 32, sessionBytes: 1024 * 1024,
  historyBytes: 4 * 1024 * 1024, toolAuditIds: 256, schemaDepth: 16, schemaNodes: 2048,
  customTools: 8, customToolBytes: 2048, customCatalogBytes: 16384
});
